export type TulipaType = 'D' | 'V' | 'N' | '';

export interface RoadbookTulipa {
  tulipa: number;
  totalKm: number;
  displayKm?: number;
  resetsOdometer?: boolean;
  interKm: number;
  lat: number;
  lon: number;
  rawLat?: string;
  rawLon?: string;
  cap: number | null;
  idealTimeStr: string;
  idealTimeMs: number | null;
  type: TulipaType;
  section: number | null;
  avgSpeedKmh?: number | null;
  tdnMs?: number | null;
  sectionDurationMs?: number | null;
  sectionStartTimeMs?: number | null;
  sectionEndTimeMs?: number | null;
  notes?: string;
  imageDataUrl?: string;
  notesImageDataUrl?: string;
  imageIsComposite?: boolean;
}

export interface RoadbookRaceParameters {
  category?: string;
  estimatedDurationMs?: number | null;
  speedsKmh: number[];
  notesCount: number;
  sectionsCount: number;
  imagesCount: number;
  rawHeaderLines?: string[];
}

export interface ParsedRoadbook {
  id?: string;
  eventName: string;
  fileName: string;
  sourceFormat?: string;
  convertedAtMs?: number;
  tulipas: RoadbookTulipa[];
  countV: number;
  countD: number;
  countN: number;
  totalKm: number;
  raceParameters?: RoadbookRaceParameters;
}

export type PassageStatus =
  | 'PASSOU'
  | 'PASSOU_ISENTO'
  | 'NAO_PASSOU'
  | 'NAO_PASSOU_ISENTO';

export interface PassageRecord {
  tulipa: number;
  type: TulipaType;
  section: number | null;
  totalKm: number;
  idealTimeStr: string;
  idealTimeMs: number | null;
  idealAbsoluteMs: number | null;
  idealHoraStr?: string;
  realHoraStr?: string;
  actualTimestampMs: number | null;
  actualLat: number | null;
  actualLon: number | null;
  actualAccuracyM: number | null;
  minDistanceM: number | null;
  diffSec: number | null;
  points: number;
  status: PassageStatus;
}

export interface SectionSummary {
  section: number | null;
  type: TulipaType;
  totalTulipas: number;
  recordedCount: number;
  points: number;
  earlySeconds: number;
  lateSeconds: number;
}

export interface PendingCandidate {
  tulipaIndex: number;
  minDistanceM: number;
  bestTimestampMs: number;
  bestLat: number;
  bestLon: number;
  bestAccuracyM: number | null;
}

export interface RallySessionConfig {
  carNumber: string;
  crewName: string;
  raceDate: string; // YYYY-MM-DD
  startTimeStr: string; // HH:MM:SS
  detectionRadiusM: number;
}

export interface CompetitorResultFile {
  id: string;
  fileName: string;
  eventName: string;
  carNumber: string;
  crewName: string;
  raceDate: string;
  startTimeStr: string;
  detectionRadiusM: number;
  recordedAt: string;
  passages: PassageRecord[];
}

export interface CompetitorSummary {
  result: CompetitorResultFile;
  totalV: number;
  recordedV: number;
  missedV: number;
  earlySecondsTotal: number;
  lateSecondsTotal: number;
  pointsFromV: number;
  missedPenaltyPoints: number;
  finalTotalPoints: number;
}

export type ActiveTab = 'inicial' | 'competidor' | 'navegacao' | 'apuracao' | 'instalar';
