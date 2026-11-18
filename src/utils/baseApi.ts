import type {
  CompetitorResultFile,
  PublishedStandingsSnapshot,
  PublicStandingRow,
} from '../types/rally';
import { getNavSettings } from './navSettings';

const PENDING_UPLOADS_KEY = 'pitstop_pending_uploads_v1';

export interface PendingSubmissionPayload extends CompetitorResultFile {
  rawTxt?: string;
}

export function resolveApiBaseUrl(overrideUrl?: string): string {
  const envDefault = (import.meta.env.VITE_BASE_SERVER_URL as string | undefined) || '';
  const raw = (overrideUrl ?? getNavSettings().baseServerUrl ?? envDefault ?? '').trim();
  if (!raw) {
    // On web host, relative `/api` hits the PitStop Base Express server directly.
    return '';
  }
  return raw.replace(/\/+$/, '');
}

export async function checkBaseServerHealth(overrideUrl?: string): Promise<{
  ok: boolean;
  submissionsCount?: number;
  error?: string;
}> {
  try {
    const base = resolveApiBaseUrl(overrideUrl);
    const res = await fetch(`${base}/api/health`, {
      method: 'GET',
      cache: 'no-store',
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { ok?: boolean; submissionsCount?: number };
    return {
      ok: Boolean(data.ok),
      submissionsCount: data.submissionsCount,
    };
  } catch {
    return {
      ok: false,
      error: 'Base de apuração inacessível neste endereço.',
    };
  }
}

export function getPendingSubmissions(): PendingSubmissionPayload[] {
  try {
    const raw = window.localStorage.getItem(PENDING_UPLOADS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePendingSubmissions(items: PendingSubmissionPayload[]): void {
  try {
    window.localStorage.setItem(PENDING_UPLOADS_KEY, JSON.stringify(items));
  } catch {
    // Ignore quota errors
  }
}

export function queuePendingSubmission(payload: PendingSubmissionPayload): void {
  const current = getPendingSubmissions().filter((x) => x.id !== payload.id);
  current.unshift(payload);
  savePendingSubmissions(current.slice(0, 20));
}

export function removePendingSubmission(id: string): void {
  const next = getPendingSubmissions().filter((x) => x.id !== id);
  savePendingSubmissions(next);
}

export async function submitCollectorResultToBase(
  payload: PendingSubmissionPayload,
  overrideUrl?: string
): Promise<{ ok: boolean; queuedOffline?: boolean; id?: string; error?: string }> {
  try {
    const base = resolveApiBaseUrl(overrideUrl);
    const res = await fetch(`${base}/api/results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      queuePendingSubmission(payload);
      return {
        ok: false,
        queuedOffline: true,
        error: `Servidor respondeu com HTTP ${res.status}. Envios salvos na fila local.`,
      };
    }
    const data = (await res.json()) as { ok?: boolean; id?: string };
    removePendingSubmission(payload.id);
    return { ok: Boolean(data.ok), id: data.id };
  } catch {
    queuePendingSubmission(payload);
    return {
      ok: false,
      queuedOffline: true,
      error: 'Sem conexão com a base agora. Registro salvo localmente para reenvio posterior.',
    };
  }
}

export async function fetchBaseResults(overrideUrl?: string): Promise<CompetitorResultFile[]> {
  const base = resolveApiBaseUrl(overrideUrl);
  const res = await fetch(`${base}/api/results`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Falha ao buscar registros da base (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { results?: CompetitorResultFile[] };
  return Array.isArray(data.results) ? data.results : [];
}

export async function deleteBaseResult(id: string, overrideUrl?: string): Promise<void> {
  const base = resolveApiBaseUrl(overrideUrl);
  await fetch(`${base}/api/results/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function clearBaseResults(overrideUrl?: string): Promise<void> {
  const base = resolveApiBaseUrl(overrideUrl);
  await fetch(`${base}/api/results`, { method: 'DELETE' });
}

export async function publishPublicStandings(
  payload: {
    eventName: string;
    missedPenaltyPts: number;
    rows: PublicStandingRow[];
    txtReport: string;
    csvReport: string;
  },
  overrideUrl?: string
): Promise<{ slug: string; path: string }> {
  const base = resolveApiBaseUrl(overrideUrl);
  const res = await fetch(`${base}/api/public-standings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Não foi possível publicar a classificação (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as { slug: string; path: string };
  return data;
}

export async function fetchPublicStandings(
  slug: string,
  overrideUrl?: string
): Promise<PublishedStandingsSnapshot> {
  const base = resolveApiBaseUrl(overrideUrl);
  const res = await fetch(`${base}/api/public-standings/${encodeURIComponent(slug)}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error('Link de classificação não encontrado ou expirado.');
  }
  const data = (await res.json()) as { snapshot: PublishedStandingsSnapshot };
  return data.snapshot;
}
