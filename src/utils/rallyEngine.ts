import type {
  PassageRecord,
  PendingCandidate,
  RoadbookTulipa,
  TulipaType,
} from '../types/rally';

const EARTH_RADIUS_M = 6371000;

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * Anchors a wall-clock time string (`HH:MM:SS`) to a race date (`YYYY-MM-DD`) in local time.
 */
export function parseRaceStartTimestampMs(dateStr: string, timeStr: string): number {
  const [year, month, day] = dateStr.split('-').map((n) => parseInt(n, 10));
  const [hour, min, sec] = timeStr.split(':').map((n) => parseInt(n, 10));
  const dt = new Date(
    year || new Date().getFullYear(),
    (month || 1) - 1,
    day || new Date().getDate(),
    hour || 0,
    min || 0,
    sec || 0,
    0
  );
  return dt.getTime();
}

export function formatClockMs(timestampMs: number, includeCentis = true): string {
  const d = new Date(timestampMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  if (!includeCentis) return `${hh}:${mm}:${ss}`;
  const cc = String(Math.floor(d.getMilliseconds() / 10)).padStart(2, '0');
  return `${hh}:${mm}:${ss}.${cc}`;
}

export function formatElapsedMs(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  const totalSec = Math.floor(abs / 1000);
  const hh = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}:${ss}`;
}

/**
 * Scoring rule:
 * - Only type === 'V' (Velocidade média) counts points.
 * - Types 'D' (Deslocamento) and 'N' (Neutralização) or blank always score 0 points.
 * - For 'V': 1 point per second early OR late (Math.round(Math.abs(diffSec))).
 */
export function computePassageScore(
  type: TulipaType,
  idealAbsoluteMs: number | null,
  actualTimestampMs: number
): { diffSec: number | null; points: number } {
  if (idealAbsoluteMs === null) {
    return { diffSec: null, points: 0 };
  }

  const diffSec = Number(((actualTimestampMs - idealAbsoluteMs) / 1000).toFixed(2));
  if (type !== 'V') {
    return { diffSec, points: 0 };
  }

  const points = Math.round(Math.abs(diffSec));
  return { diffSec, points };
}

export function createInitialPassages(
  tulipas: RoadbookTulipa[],
  startTimestampMs: number
): PassageRecord[] {
  return tulipas.map((t) => {
    const idealAbsoluteMs =
      t.idealTimeMs !== null ? startTimestampMs + t.idealTimeMs : null;
    const isExempt = t.type !== 'V';
    return {
      tulipa: t.tulipa,
      type: t.type,
      section: t.section,
      totalKm: t.totalKm,
      idealTimeStr: t.idealTimeStr,
      idealTimeMs: t.idealTimeMs,
      idealAbsoluteMs,
      actualTimestampMs: null,
      actualLat: null,
      actualLon: null,
      actualAccuracyM: null,
      minDistanceM: null,
      diffSec: null,
      points: 0,
      status: isExempt ? 'NAO_PASSOU_ISENTO' : 'NAO_PASSOU',
    };
  });
}

function commitCandidate(
  passage: PassageRecord,
  candidate: PendingCandidate
): PassageRecord {
  const { diffSec, points } = computePassageScore(
    passage.type,
    passage.idealAbsoluteMs,
    candidate.bestTimestampMs
  );
  const isExempt = passage.type !== 'V';
  return {
    ...passage,
    actualTimestampMs: candidate.bestTimestampMs,
    actualLat: candidate.bestLat,
    actualLon: candidate.bestLon,
    actualAccuracyM: candidate.bestAccuracyM,
    minDistanceM: Number(candidate.minDistanceM.toFixed(1)),
    diffSec,
    points,
    status: isExempt ? 'PASSOU_ISENTO' : 'PASSOU',
  };
}

export interface GpsFixInput {
  lat: number;
  lon: number;
  accuracyM: number | null;
  timestampMs: number;
}

export interface TrackerStepResult {
  passages: PassageRecord[];
  pending: Record<number, PendingCandidate>;
  nextExpectedIndex: number;
  newlyCommittedCount: number;
}

/**
 * Closest-Point-of-Approach (CPA) GPS matcher with sequential lookahead window (+12 tulipas).
 * Prevents false triggers on route loops/shared intersections while recovering gracefully if a PC is skipped.
 */
export function processGpsFix(
  tulipas: RoadbookTulipa[],
  passages: PassageRecord[],
  pending: Record<number, PendingCandidate>,
  nextExpectedIndex: number,
  detectionRadiusM: number,
  fix: GpsFixInput
): TrackerStepResult {
  const updatedPassages = [...passages];
  const updatedPending: Record<number, PendingCandidate> = { ...pending };
  let updatedNextIdx = nextExpectedIndex;
  let newlyCommittedCount = 0;

  const windowEnd = Math.min(tulipas.length - 1, updatedNextIdx + 12);

  // 1. Check all existing pending candidates first
  for (const key of Object.keys(updatedPending)) {
    const idx = Number(key);
    const cand = updatedPending[idx];
    const target = tulipas[idx];
    if (!target || updatedPassages[idx].actualTimestampMs !== null) {
      delete updatedPending[idx];
      continue;
    }

    const dist = haversineMeters(fix.lat, fix.lon, target.lat, target.lon);
    if (dist <= cand.minDistanceM) {
      // Closer approach found inside radius
      updatedPending[idx] = {
        tulipaIndex: idx,
        minDistanceM: dist,
        bestTimestampMs: fix.timestampMs,
        bestLat: fix.lat,
        bestLon: fix.lon,
        bestAccuracyM: fix.accuracyM,
      };
    } else if (dist > detectionRadiusM || dist > cand.minDistanceM + 8) {
      // Exited radius or passed apex -> lock passage at closest approach
      updatedPassages[idx] = commitCandidate(updatedPassages[idx], cand);
      delete updatedPending[idx];
      newlyCommittedCount += 1;
      if (idx >= updatedNextIdx) {
        updatedNextIdx = idx + 1;
      }
    }
  }

  // 2. Scan sequential lookahead window for entering a tulipa radius
  for (let idx = updatedNextIdx; idx <= windowEnd; idx++) {
    if (updatedPassages[idx].actualTimestampMs !== null) continue;
    if (updatedPending[idx]) continue;

    const target = tulipas[idx];
    const dist = haversineMeters(fix.lat, fix.lon, target.lat, target.lon);

    if (dist <= detectionRadiusM) {
      // If we just entered a later tulipa, commit any earlier pending candidates first
      for (const pKey of Object.keys(updatedPending)) {
        const pIdx = Number(pKey);
        if (pIdx < idx) {
          updatedPassages[pIdx] = commitCandidate(
            updatedPassages[pIdx],
            updatedPending[pIdx]
          );
          delete updatedPending[pIdx];
          newlyCommittedCount += 1;
        }
      }

      updatedPending[idx] = {
        tulipaIndex: idx,
        minDistanceM: dist,
        bestTimestampMs: fix.timestampMs,
        bestLat: fix.lat,
        bestLon: fix.lon,
        bestAccuracyM: fix.accuracyM,
      };

      // Only enter the earliest matching unrecorded tulipa in this fix to avoid double-matching tight loops
      break;
    }
  }

  // Advance nextExpectedIndex past already-recorded passages
  while (
    updatedNextIdx < updatedPassages.length &&
    updatedPassages[updatedNextIdx].actualTimestampMs !== null
  ) {
    updatedNextIdx += 1;
  }

  return {
    passages: updatedPassages,
    pending: updatedPending,
    nextExpectedIndex: updatedNextIdx,
    newlyCommittedCount,
  };
}

/**
 * Commits any still-pending candidates when the competitor finishes the rally inside a tulipa radius.
 */
export function finalizePendingPassages(
  passages: PassageRecord[],
  pending: Record<number, PendingCandidate>
): PassageRecord[] {
  const finalized = [...passages];
  for (const key of Object.keys(pending)) {
    const idx = Number(key);
    const cand = pending[idx];
    if (cand && finalized[idx] && finalized[idx].actualTimestampMs === null) {
      finalized[idx] = commitCandidate(finalized[idx], cand);
    }
  }
  return finalized;
}
