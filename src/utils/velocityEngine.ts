export type TrapKind = 'start' | 'split' | 'finish';
export type TrackMode = 'point-to-point' | 'circuit';

export interface VelocityTrap {
  id: string;
  name: string;
  kind: TrapKind;
  lat: number;
  lon: number;
  bearingDeg: number; // 0..360 direction of travel perpendicular to the gate line
  widthM: number; // Configurable 20m..50m gate width
}

export interface VelocitySample {
  lat: number;
  lon: number;
  speedKmh: number;
  accuracyM: number | null;
  headingDeg: number | null;
  altitudeM: number | null;
  timestampMs: number;
  distKm: number;
  stageElapsedMs: number;
}

export interface VelocityRun {
  id: string;
  trackId: string;
  runNumber: number;
  startedAtMs: number;
  finishedAtMs: number;
  totalMs: number;
  splitTimesMs: Record<string, number>; // trapId -> elapsed ms from Start
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  distanceKm: number;
  samples: VelocitySample[];
}

export interface VelocityTrack {
  id: string;
  name: string;
  mode: TrackMode;
  traps: VelocityTrap[];
  createdAtMs: number;
  referenceDistanceKm: number;
  baseTrace?: VelocitySample[];
}

export interface SectorOptimalEntry {
  sectorIndex: number;
  label: string;
  fromTrapId: string;
  toTrapId: string;
  bestMs: number | null;
  bestRunNumber: number | null;
}

export interface OptimalStageSummary {
  optimalTotalMs: number | null;
  bestRunTotalMs: number | null;
  bestRunId: string | null;
  lastRunTotalMs: number | null;
  sectors: SectorOptimalEntry[];
}

export interface TrapCrossingResult {
  crossed: boolean;
  t: number; // 0..1 interpolation factor between prev and curr
  crossTimestampMs: number;
  lateralOffsetM: number;
  headingDiffDeg: number;
}

const TRACKS_STORAGE_KEY = 'pitstop_velocity_tracks_v1';
const RUNS_STORAGE_KEY = 'pitstop_velocity_runs_v1';

export function haversineMetersVel(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function bearingBetweenDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const deg = (toDeg(Math.atan2(y, x)) + 360) % 360;
  return Math.round(deg);
}

export function angleDiffDeg(a: number, b: number): number {
  const diff = ((a - b + 540) % 360) - 180;
  return Math.abs(diff);
}

/**
 * Vector segment intersection between vehicle movement (prev -> curr)
 * and a virtual Trap gate centered at (trap.lat, trap.lon) with perpendicular width `trap.widthM`
 * and travel direction `trap.bearingDeg`.
 */
export function detectTrapCrossing(
  prev: { lat: number; lon: number; timestampMs: number },
  curr: { lat: number; lon: number; timestampMs: number },
  trap: VelocityTrap
): TrapCrossingResult | null {
  if (prev.lat === curr.lat && prev.lon === curr.lon) return null;

  const metersPerLat = 111320;
  const metersPerLon = 111320 * Math.cos((trap.lat * Math.PI) / 180);

  const toLocalXY = (lat: number, lon: number) => ({
    x: (lon - trap.lon) * metersPerLon,
    y: (lat - trap.lat) * metersPerLat,
  });

  const a = toLocalXY(prev.lat, prev.lon);
  const b = toLocalXY(curr.lat, curr.lon);

  const rad = (trap.bearingDeg * Math.PI) / 180;
  // Unit vector along trap travel direction (0 deg = North/+y, 90 deg = East/+x)
  const fx = Math.sin(rad);
  const fy = Math.cos(rad);
  // Unit vector perpendicular to travel direction (along the gate line)
  const px = Math.cos(rad);
  const py = -Math.sin(rad);

  const aForward = a.x * fx + a.y * fy;
  const bForward = b.x * fx + b.y * fy;

  // Must cross from behind (<= 0) to ahead (> 0) or strictly across forward=0
  if (!(aForward <= 0 && bForward > 0)) {
    return null;
  }

  const denom = bForward - aForward;
  if (Math.abs(denom) < 1e-6) return null;
  const t = Math.max(0, Math.min(1, -aForward / denom));

  const crossX = a.x + t * (b.x - a.x);
  const crossY = a.y + t * (b.y - a.y);
  const lateralOffsetM = crossX * px + crossY * py;
  const halfWidth = Math.max(5, trap.widthM / 2);

  if (Math.abs(lateralOffsetM) > halfWidth) {
    return null;
  }

  const moveBearing = bearingBetweenDeg(prev.lat, prev.lon, curr.lat, curr.lon);
  const headingDiffDeg = angleDiffDeg(moveBearing, trap.bearingDeg);
  if (headingDiffDeg > 75) {
    return null;
  }

  const crossTimestampMs = Math.round(
    prev.timestampMs + t * (curr.timestampMs - prev.timestampMs)
  );

  return {
    crossed: true,
    t,
    crossTimestampMs,
    lateralOffsetM,
    headingDiffDeg,
  };
}

/**
 * Predictive Time Delta (Time Delta in seconds) comparing current distance & elapsed ms
 * against the reference best run saved on the same Special Stage.
 * Negative = faster than best (Green); Positive = slower than best (Red).
 */
export function computePredictiveDeltaSec(
  currentDistKm: number,
  currentElapsedMs: number,
  bestRun: VelocityRun | null
): number | null {
  if (!bestRun || bestRun.samples.length < 2) return null;
  const samples = bestRun.samples;
  if (currentDistKm <= 0.005) return 0;

  // Binary / linear search by distKm on reference trace
  for (let i = 1; i < samples.length; i += 1) {
    const s0 = samples[i - 1];
    const s1 = samples[i];
    if (currentDistKm <= s1.distKm) {
      const spanKm = s1.distKm - s0.distKm;
      const frac = spanKm > 1e-6 ? Math.max(0, Math.min(1, (currentDistKm - s0.distKm) / spanKm)) : 0;
      const refElapsedAtDist = s0.stageElapsedMs + frac * (s1.stageElapsedMs - s0.stageElapsedMs);
      return (currentElapsedMs - refElapsedAtDist) / 1000;
    }
  }

  const last = samples[samples.length - 1];
  return (currentElapsedMs - last.stageElapsedMs) / 1000;
}

export function getOrderedTrackTraps(track: VelocityTrack): VelocityTrap[] {
  const start = track.traps.filter((t) => t.kind === 'start');
  const splits = track.traps.filter((t) => t.kind === 'split');
  const finish = track.traps.filter((t) => t.kind === 'finish');
  return [...start, ...splits, ...finish];
}

export function computeOptimalStage(
  track: VelocityTrack,
  runs: VelocityRun[]
): OptimalStageSummary {
  const trackRuns = runs
    .filter((r) => r.trackId === track.id && r.totalMs > 0)
    .sort((a, b) => a.startedAtMs - b.startedAtMs);

  if (trackRuns.length === 0) {
    return {
      optimalTotalMs: null,
      bestRunTotalMs: null,
      bestRunId: null,
      lastRunTotalMs: null,
      sectors: [],
    };
  }

  const bestRun = [...trackRuns].sort((a, b) => a.totalMs - b.totalMs)[0];
  const lastRun = trackRuns[trackRuns.length - 1];

  const ordered = getOrderedTrackTraps(track);
  const startTrap = ordered.find((t) => t.kind === 'start');
  const finishTrap = ordered.find((t) => t.kind === 'finish');
  const checkpoints = ordered.filter((t) => t.kind === 'split' || t.kind === 'finish');

  const sectors: SectorOptimalEntry[] = [];
  if (startTrap && finishTrap && checkpoints.length > 0) {
    let prevTrapId = startTrap.id;
    checkpoints.forEach((cp, idx) => {
      let bestSectorMs: number | null = null;
      let bestSectorRunNum: number | null = null;

      for (const r of trackRuns) {
        const endT =
          cp.kind === 'finish'
            ? r.splitTimesMs[cp.id] ?? r.totalMs
            : r.splitTimesMs[cp.id];
        const startT = prevTrapId === startTrap.id ? 0 : r.splitTimesMs[prevTrapId];
        if (
          typeof endT === 'number' &&
          typeof startT === 'number' &&
          endT > startT
        ) {
          const dur = endT - startT;
          if (bestSectorMs === null || dur < bestSectorMs) {
            bestSectorMs = dur;
            bestSectorRunNum = r.runNumber;
          }
        }
      }

      sectors.push({
        sectorIndex: idx + 1,
        label: cp.kind === 'finish' ? `S${idx + 1} (Chegada)` : `S${idx + 1} (${cp.name})`,
        fromTrapId: prevTrapId,
        toTrapId: cp.id,
        bestMs: bestSectorMs,
        bestRunNumber: bestSectorRunNum,
      });

      prevTrapId = cp.id;
    });
  }

  const allSectorsHaveBest = sectors.length > 0 && sectors.every((s) => s.bestMs !== null);
  const optimalTotalMs = allSectorsHaveBest
    ? sectors.reduce((acc, s) => acc + (s.bestMs ?? 0), 0)
    : bestRun.totalMs;

  return {
    optimalTotalMs,
    bestRunTotalMs: bestRun.totalMs,
    bestRunId: bestRun.id,
    lastRunTotalMs: lastRun.totalMs,
    sectors,
  };
}

export function formatStageDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return '--:--.-';
  }
  const totalTenths = Math.floor(ms / 100);
  const tenths = totalTenths % 10;
  const totalSec = Math.floor(totalTenths / 10);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hours = Math.floor(totalMin / 60);
  if (hours > 0) {
    return `${hours}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${tenths}`;
  }
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${tenths}`;
}

export function formatDeltaSeconds(deltaSec: number | null): string {
  if (deltaSec === null || !Number.isFinite(deltaSec)) return '--.-s';
  if (Math.abs(deltaSec) < 0.05) return '0.0s';
  const sign = deltaSec < 0 ? '-' : '+';
  return `${sign}${Math.abs(deltaSec).toFixed(1)}s`;
}

export function loadVelocityTracks(): VelocityTrack[] {
  try {
    const raw = localStorage.getItem(TRACKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as VelocityTrack[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveVelocityTracks(tracks: VelocityTrack[]): void {
  try {
    localStorage.setItem(TRACKS_STORAGE_KEY, JSON.stringify(tracks));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadVelocityRuns(): VelocityRun[] {
  try {
    const raw = localStorage.getItem(RUNS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as VelocityRun[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveVelocityRuns(runs: VelocityRun[]): void {
  try {
    // Cap stored raw sample traces per run for storage safety
    localStorage.setItem(RUNS_STORAGE_KEY, JSON.stringify(runs.slice(0, 40)));
  } catch {
    // Ignore storage quota errors
  }
}

export function exportTrackGeoJson(track: VelocityTrack, trace: VelocitySample[]): string {
  const features: unknown[] = [];

  if (trace.length > 1) {
    features.push({
      type: 'Feature',
      properties: {
        name: track.name,
        mode: track.mode,
        kind: 'route',
      },
      geometry: {
        type: 'LineString',
        coordinates: trace.map((p) => [p.lon, p.lat, p.altitudeM ?? 0]),
      },
    });
  }

  for (const trap of track.traps) {
    features.push({
      type: 'Feature',
      properties: {
        id: trap.id,
        name: trap.name,
        trapKind: trap.kind,
        bearingDeg: trap.bearingDeg,
        widthM: trap.widthM,
      },
      geometry: {
        type: 'Point',
        coordinates: [trap.lon, trap.lat],
      },
    });
  }

  return JSON.stringify(
    {
      type: 'FeatureCollection',
      name: track.name,
      features,
    },
    null,
    2
  );
}

export function exportTrackGpx(track: VelocityTrack, trace: VelocitySample[]): string {
  const escapeXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const wpts = track.traps
    .map(
      (t) =>
        `  <wpt lat="${t.lat.toFixed(6)}" lon="${t.lon.toFixed(6)}">\n    <name>${escapeXml(
          t.name
        )}</name>\n    <type>${t.kind}|${t.bearingDeg}|${t.widthM}</type>\n  </wpt>`
    )
    .join('\n');

  const trkpts = trace
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${(
          p.altitudeM ?? 0
        ).toFixed(1)}</ele><time>${new Date(p.timestampMs).toISOString()}</time></trkpt>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PitStop Sports Velocidade">
  <metadata><name>${escapeXml(track.name)}</name></metadata>
${wpts}
  <trk>
    <name>${escapeXml(track.name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

export function parseGpxOrGeoJsonToTrack(
  content: string,
  fileName: string
): VelocityTrack {
  const cleanName = fileName.replace(/\.(geojson|json|gpx)$/i, '');
  const traps: VelocityTrap[] = [];
  const baseTrace: VelocitySample[] = [];
  const now = Date.now();

  if (content.trim().startsWith('{')) {
    const parsed = JSON.parse(content) as {
      name?: string;
      features?: Array<{
        properties?: Record<string, unknown>;
        geometry?: { type?: string; coordinates?: unknown };
      }>;
    };
    const features = Array.isArray(parsed.features) ? parsed.features : [];
    for (const f of features) {
      const g = f.geometry;
      const props = f.properties || {};
      if (g?.type === 'LineString' && Array.isArray(g.coordinates)) {
        let accKm = 0;
        g.coordinates.forEach((coord: unknown, idx: number) => {
          if (!Array.isArray(coord) || coord.length < 2) return;
          const lon = Number(coord[0]);
          const lat = Number(coord[1]);
          const alt = coord.length > 2 ? Number(coord[2]) : null;
          if (idx > 0 && baseTrace.length > 0) {
            const prev = baseTrace[baseTrace.length - 1];
            accKm += haversineMetersVel(prev.lat, prev.lon, lat, lon) / 1000;
          }
          baseTrace.push({
            lat,
            lon,
            speedKmh: 0,
            accuracyM: 5,
            headingDeg: null,
            altitudeM: alt,
            timestampMs: now + idx * 1000,
            distKm: accKm,
            stageElapsedMs: idx * 1000,
          });
        });
      } else if (g?.type === 'Point' && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
        const lon = Number(g.coordinates[0]);
        const lat = Number(g.coordinates[1]);
        const rawKind = String(props.trapKind || props.kind || 'split');
        const kind: TrapKind =
          rawKind === 'start' || rawKind === 'finish' ? rawKind : 'split';
        traps.push({
          id: String(props.id || `trap_${traps.length + 1}_${now}`),
          name: String(props.name || `${kind.toUpperCase()} ${traps.length + 1}`),
          kind,
          lat,
          lon,
          bearingDeg: Number(props.bearingDeg) || 0,
          widthM: Number(props.widthM) || 30,
        });
      }
    }

    return {
      id: `trk_${now}`,
      name: String(parsed.name || cleanName),
      mode: 'point-to-point',
      traps,
      createdAtMs: now,
      referenceDistanceKm:
        baseTrace.length > 0 ? baseTrace[baseTrace.length - 1].distKm : 0,
      baseTrace: baseTrace.length > 0 ? baseTrace : undefined,
    };
  }

  // GPX XML parse via DOMParser
  const doc = new DOMParser().parseFromString(content, 'application/xml');
  const trkpts = Array.from(doc.querySelectorAll('trkpt'));
  let accKm = 0;
  trkpts.forEach((pt, idx) => {
    const lat = Number(pt.getAttribute('lat'));
    const lon = Number(pt.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const ele = Number(pt.querySelector('ele')?.textContent);
    if (idx > 0 && baseTrace.length > 0) {
      const prev = baseTrace[baseTrace.length - 1];
      accKm += haversineMetersVel(prev.lat, prev.lon, lat, lon) / 1000;
    }
    baseTrace.push({
      lat,
      lon,
      speedKmh: 0,
      accuracyM: 5,
      headingDeg: null,
      altitudeM: Number.isFinite(ele) ? ele : null,
      timestampMs: now + idx * 1000,
      distKm: accKm,
      stageElapsedMs: idx * 1000,
    });
  });

  const wpts = Array.from(doc.querySelectorAll('wpt'));
  wpts.forEach((wpt, idx) => {
    const lat = Number(wpt.getAttribute('lat'));
    const lon = Number(wpt.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const name = wpt.querySelector('name')?.textContent?.trim() || `Trap ${idx + 1}`;
    const typeParts = (wpt.querySelector('type')?.textContent || '').split('|');
    const rawKind = typeParts[0];
    const kind: TrapKind =
      rawKind === 'start' || rawKind === 'finish' ? rawKind : 'split';
    traps.push({
      id: `trap_${idx + 1}_${now}`,
      name,
      kind,
      lat,
      lon,
      bearingDeg: Number(typeParts[1]) || 0,
      widthM: Number(typeParts[2]) || 30,
    });
  });

  if (traps.length === 0 && baseTrace.length >= 2) {
    const first = baseTrace[0];
    const second = baseTrace[1];
    const lastPrev = baseTrace[baseTrace.length - 2];
    const last = baseTrace[baseTrace.length - 1];
    traps.push(
      {
        id: `trap_start_${now}`,
        name: 'Largada (Start)',
        kind: 'start',
        lat: first.lat,
        lon: first.lon,
        bearingDeg: bearingBetweenDeg(first.lat, first.lon, second.lat, second.lon),
        widthM: 30,
      },
      {
        id: `trap_finish_${now}`,
        name: 'Chegada (Finish)',
        kind: 'finish',
        lat: last.lat,
        lon: last.lon,
        bearingDeg: bearingBetweenDeg(lastPrev.lat, lastPrev.lon, last.lat, last.lon),
        widthM: 30,
      }
    );
  }

  return {
    id: `trk_${now}`,
    name: cleanName,
    mode: 'point-to-point',
    traps,
    createdAtMs: now,
    referenceDistanceKm:
      baseTrace.length > 0 ? baseTrace[baseTrace.length - 1].distKm : 0,
    baseTrace: baseTrace.length > 0 ? baseTrace : undefined,
  };
}

/**
 * Creates a realistic ~1.8km Point-to-Point Special Stage (Serra da Graciosa demo)
 * with Start, Split 1, Split 2, Finish traps and base trace for simulator / testing.
 */
export function createDemoSpecialStage(): {
  track: VelocityTrack;
  baseSamples: VelocitySample[];
  simWaypoints: { lat: number; lon: number; speedKmh: number; altM: number }[];
} {
  const waypoints: { lat: number; lon: number; speedKmh: number; altM: number }[] = [
    { lat: -25.33500, lon: -48.91200, speedKmh: 45, altM: 820 },
    { lat: -25.33410, lon: -48.91140, speedKmh: 78, altM: 826 },
    { lat: -25.33320, lon: -48.91070, speedKmh: 96, altM: 834 },
    { lat: -25.33245, lon: -48.90980, speedKmh: 68, altM: 842 },
    { lat: -25.33180, lon: -48.90870, speedKmh: 88, altM: 850 },
    { lat: -25.33105, lon: -48.90785, speedKmh: 104, altM: 858 },
    { lat: -25.33020, lon: -48.90730, speedKmh: 72, altM: 865 },
    { lat: -25.32935, lon: -48.90650, speedKmh: 84, altM: 874 },
    { lat: -25.32860, lon: -48.90555, speedKmh: 112, altM: 883 },
    { lat: -25.32775, lon: -48.90475, speedKmh: 62, altM: 890 },
    { lat: -25.32680, lon: -48.90435, speedKmh: 90, altM: 897 },
    { lat: -25.32590, lon: -48.90360, speedKmh: 108, altM: 906 },
    { lat: -25.32510, lon: -48.90265, speedKmh: 92, altM: 915 },
    { lat: -25.32435, lon: -48.90175, speedKmh: 116, altM: 922 },
  ];

  const baseSamples: VelocitySample[] = [];
  let accKm = 0;
  let elapsedMs = 0;
  const now = Date.now() - 3600000;

  waypoints.forEach((wp, idx) => {
    if (idx > 0) {
      const prev = waypoints[idx - 1];
      const segM = haversineMetersVel(prev.lat, prev.lon, wp.lat, wp.lon);
      accKm += segM / 1000;
      const avgMs = ((prev.speedKmh + wp.speedKmh) / 2) / 3.6;
      elapsedMs += Math.round((segM / Math.max(4, avgMs)) * 1000);
    }
    const nextWp = waypoints[Math.min(waypoints.length - 1, idx + 1)];
    const prevWp = waypoints[Math.max(0, idx - 1)];
    baseSamples.push({
      lat: wp.lat,
      lon: wp.lon,
      speedKmh: wp.speedKmh,
      accuracyM: 4,
      headingDeg: bearingBetweenDeg(prevWp.lat, prevWp.lon, nextWp.lat, nextWp.lon),
      altitudeM: wp.altM,
      timestampMs: now + elapsedMs,
      distKm: accKm,
      stageElapsedMs: elapsedMs,
    });
  });

  const startBearing = bearingBetweenDeg(
    waypoints[0].lat,
    waypoints[0].lon,
    waypoints[2].lat,
    waypoints[2].lon
  );
  const s1Bearing = bearingBetweenDeg(
    waypoints[4].lat,
    waypoints[4].lon,
    waypoints[6].lat,
    waypoints[6].lon
  );
  const s2Bearing = bearingBetweenDeg(
    waypoints[8].lat,
    waypoints[8].lon,
    waypoints[10].lat,
    waypoints[10].lon
  );
  const finBearing = bearingBetweenDeg(
    waypoints[11].lat,
    waypoints[11].lon,
    waypoints[13].lat,
    waypoints[13].lon
  );

  const track: VelocityTrack = {
    id: 'demo_ss_graciosa',
    name: 'SS-01 Serra Velha (Ponto-a-Ponto)',
    mode: 'point-to-point',
    createdAtMs: now,
    referenceDistanceKm: accKm,
    baseTrace: baseSamples,
    traps: [
      {
        id: 'demo_start',
        name: 'Largada SS-01',
        kind: 'start',
        lat: waypoints[1].lat,
        lon: waypoints[1].lon,
        bearingDeg: startBearing,
        widthM: 35,
      },
      {
        id: 'demo_split_1',
        name: 'Parcial 1',
        kind: 'split',
        lat: waypoints[5].lat,
        lon: waypoints[5].lon,
        bearingDeg: s1Bearing,
        widthM: 35,
      },
      {
        id: 'demo_split_2',
        name: 'Parcial 2',
        kind: 'split',
        lat: waypoints[9].lat,
        lon: waypoints[9].lon,
        bearingDeg: s2Bearing,
        widthM: 35,
      },
      {
        id: 'demo_finish',
        name: 'Chegada SS-01',
        kind: 'finish',
        lat: waypoints[12].lat,
        lon: waypoints[12].lon,
        bearingDeg: finBearing,
        widthM: 40,
      },
    ],
  };

  return { track, baseSamples, simWaypoints: waypoints };
}
