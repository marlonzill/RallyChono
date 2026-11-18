export interface TulipaMarkup {
  id: string; // `${roadbookKey}:${tulipaNum}`
  roadbookKey: string;
  tulipaNum: number;
  drawingDataUrl?: string;
  noteText?: string;
  audioDataUrl?: string;
  audioDurationSec?: number;
  updatedAtMs: number;
}

const DB_NAME = 'PitStopMarkingsDB';
const DB_VERSION = 1;
const STORE_NAME = 'markings';
const MEMORY_CACHE = new Map<string, TulipaMarkup>();

export function buildMarkupId(roadbookKey: string, tulipaNum: number): string {
  return `${roadbookKey || 'default'}:${tulipaNum}`;
}

function openMarkingsDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
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

export async function listMarkingsForRoadbook(
  roadbookKey: string
): Promise<Map<number, TulipaMarkup>> {
  const result = new Map<number, TulipaMarkup>();
  const db = await openMarkingsDb();
  if (!db) {
    for (const item of MEMORY_CACHE.values()) {
      if (item.roadbookKey === roadbookKey) {
        result.set(item.tulipaNum, item);
      }
    }
    return result;
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        db.close();
        const items = (req.result as TulipaMarkup[] | undefined) ?? [];
        for (const item of items) {
          if (item.roadbookKey === roadbookKey) {
            MEMORY_CACHE.set(item.id, item);
            result.set(item.tulipaNum, item);
          }
        }
        resolve(result);
      };
      req.onerror = () => {
        db.close();
        resolve(result);
      };
    } catch {
      db.close();
      resolve(result);
    }
  });
}

export async function saveTulipaMarkup(markup: TulipaMarkup): Promise<void> {
  MEMORY_CACHE.set(markup.id, markup);
  const db = await openMarkingsDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(markup);
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

export async function deleteTulipaMarkup(
  roadbookKey: string,
  tulipaNum: number
): Promise<void> {
  const id = buildMarkupId(roadbookKey, tulipaNum);
  MEMORY_CACHE.delete(id);
  const db = await openMarkingsDb();
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
