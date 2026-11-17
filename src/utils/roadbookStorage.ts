import type { ParsedRoadbook } from '../types/rally';
import { enrichRoadbookForNavigation } from './roadbookFormats';

const DB_NAME = 'RallyChronoInternalDB';
const DB_VERSION = 1;
const STORE_NAME = 'roadbooks';
const ACTIVE_ID_KEY = 'rallychrono_active_roadbook_id_v1';
const MEMORY_FALLBACK = new Map<string, ParsedRoadbook>();

function normalizeStoredRoadbook(raw: ParsedRoadbook): ParsedRoadbook {
  const enriched = enrichRoadbookForNavigation(raw);
  return {
    ...enriched,
    id: raw.id ?? buildRoadbookId(raw),
    eventName: raw.eventName || enriched.eventName,
    fileName: raw.fileName || enriched.fileName,
    sourceFormat: raw.sourceFormat || enriched.sourceFormat,
    convertedAtMs: raw.convertedAtMs ?? enriched.convertedAtMs,
  };
}

function buildRoadbookId(rb: ParsedRoadbook): string {
  if (rb.id) return rb.id;
  const base = `${rb.fileName || rb.eventName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return `rb_${base || 'planilha'}`;
}

function openRoadbookDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function getLastActiveRoadbookId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_ID_KEY);
  } catch {
    return null;
  }
}

export function setLastActiveRoadbookId(id: string | null): void {
  try {
    if (id) {
      window.localStorage.setItem(ACTIVE_ID_KEY, id);
    } else {
      window.localStorage.removeItem(ACTIVE_ID_KEY);
    }
  } catch {
    // Ignore storage quota / private mode issues
  }
}

export async function saveConvertedRoadbook(
  roadbook: ParsedRoadbook
): Promise<ParsedRoadbook> {
  const enriched = normalizeStoredRoadbook({
    ...roadbook,
    id: buildRoadbookId(roadbook),
    convertedAtMs: roadbook.convertedAtMs ?? Date.now(),
  });

  MEMORY_FALLBACK.set(enriched.id!, enriched);
  setLastActiveRoadbookId(enriched.id!);

  const db = await openRoadbookDb();
  if (!db) return enriched;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(enriched);
      tx.oncomplete = () => {
        db.close();
        resolve(enriched);
      };
      tx.onerror = () => {
        db.close();
        resolve(enriched);
      };
    } catch {
      db.close();
      resolve(enriched);
    }
  });
}

export async function listSavedRoadbooks(): Promise<ParsedRoadbook[]> {
  const db = await openRoadbookDb();
  if (!db) {
    return Array.from(MEMORY_FALLBACK.values())
      .map(normalizeStoredRoadbook)
      .sort((a, b) => (b.convertedAtMs ?? 0) - (a.convertedAtMs ?? 0));
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        db.close();
        const rawItems = (req.result as ParsedRoadbook[] | undefined) ?? [];
        const items = rawItems
          .map(normalizeStoredRoadbook)
          .sort((a, b) => (b.convertedAtMs ?? 0) - (a.convertedAtMs ?? 0));
        resolve(items);
      };
      req.onerror = () => {
        db.close();
        resolve(Array.from(MEMORY_FALLBACK.values()).map(normalizeStoredRoadbook));
      };
    } catch {
      db.close();
      resolve(Array.from(MEMORY_FALLBACK.values()).map(normalizeStoredRoadbook));
    }
  });
}

export async function getLastActiveRoadbook(): Promise<ParsedRoadbook | null> {
  const activeId = getLastActiveRoadbookId();
  if (!activeId) return null;

  const list = await listSavedRoadbooks();
  const match = list.find((rb) => rb.id === activeId);
  return match ? normalizeStoredRoadbook(match) : null;
}

export async function deleteSavedRoadbook(id: string): Promise<void> {
  MEMORY_FALLBACK.delete(id);
  if (getLastActiveRoadbookId() === id) {
    setLastActiveRoadbookId(null);
  }

  const db = await openRoadbookDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
