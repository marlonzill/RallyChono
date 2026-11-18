import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Geolocation } from '@capacitor/geolocation';
import { Share } from '@capacitor/share';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Compass,
  Copy,
  Database,
  Download,
  FileSearch,
  FileText,
  Gauge,
  Link2,
  MapPin,
  Mic,
  Navigation,
  Pause,
  PenTool,
  Play,
  RefreshCw,
  RotateCcw,
  Satellite,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { ParsedRoadbook, RoadbookTulipa } from '../types/rally';
import {
  extractDesenhoSquare,
  extractObservationRectangle,
} from '../utils/imageCrop';
import {
  calibrationPctFromWValue,
  type HighlightTheme,
  useNavSettings,
  wValueFromCalibrationPct,
} from '../utils/navSettings';
import {
  connectPairingRoom,
  type PairingConnection,
  type PairingPresenceState,
  type PairingTelemetryPayload,
} from '../utils/pairingClient';
import {
  formatClockMs,
  formatElapsedMs,
  haversineMeters,
  parseRaceStartTimestampMs,
} from '../utils/rallyEngine';
import {
  extractRoadbookDiagnosticDataTxt,
  findActiveTulipaIndexByKm,
  inspectRoadbookFileStructure,
  interpolateIdealTimeAtKm,
  interpolateKmAtElapsedMs,
  parseNavigationBuffer,
} from '../utils/roadbookFormats';
import {
  getLastActiveRoadbook,
  saveConvertedRoadbook,
  setLastActiveRoadbookId,
} from '../utils/roadbookStorage';
import {
  listMarkingsForRoadbook,
  type TulipaMarkup,
} from '../utils/tulipaMarkings';
import { TulipaMarkupModal } from './TulipaMarkupModal';

interface NavigationCockpitProps {
  onOpenRoadbookSettings?: () => void;
}

type DriveSource = 'gps' | 'simulator';
type ScreenScenario = 'navegador' | 'piloto';

function getLocalTodayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLocalNowTime(): string {
  const now = new Date();
  return [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join(':');
}

function formatTnavReadout(deltaSec: number | null): string {
  if (deltaSec === null) return '--:--';
  if (Math.abs(deltaSec) < 0.5) return '00:00';
  const sign = deltaSec < 0 ? '-' : '+';
  const total = Math.round(Math.abs(deltaSec));
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return `${sign}${h}h:${String(m).padStart(2, '0')}`;
  }
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatHmsDuration(ms?: number | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '0:00:00';
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTdnOrTime(ms?: number | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '00.00.00';
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}.${String(m).padStart(2, '0')}.${String(s).padStart(2, '0')}`;
}

function formatKm3(km?: number | null): string {
  const val = km !== undefined && km !== null && Number.isFinite(km) ? km : 0;
  return val.toFixed(3).replace('.', ',');
}

function typeShortLabel(type: RoadbookTulipa['type']): string {
  if (type === 'D') return 'Des';
  if (type === 'V') return 'Vel';
  if (type === 'N') return 'Neu';
  return '-';
}

function hasHazardKeyword(notes?: string): boolean {
  if (!notes) return false;
  return /\b(pare|perigo|radar|semaforo|sem[aá]foro|preferencial|valeta|ponte|lombada|aten[cç][aã]o|buraco|trilho|mata-burro|perigoso)\b/i.test(
    notes
  );
}

function playBeep(freq = 920, durationMs = 110, doubleBeep = false) {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    const triggerTone = (delayMs: number, f: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.value = 0.14;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const startAt = ctx.currentTime + delayMs / 1000;
      osc.start(startAt);
      osc.stop(startAt + durationMs / 1000);
    };

    triggerTone(0, freq);
    if (doubleBeep) {
      triggerTone(durationMs + 70, freq * 1.18);
    }

    window.setTimeout(() => {
      ctx.close().catch(() => {});
    }, durationMs * 2 + 250);
  } catch {
    // Ignore audio context restriction
  }
}

function speakPtBr(text: string) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'pt-BR';
    utter.rate = 1.12;
    window.speechSynthesis.speak(utter);
  } catch {
    // Ignore speech synthesis restriction
  }
}

function formatVelTdnBadge(t: RoadbookTulipa): { primary: string; secondary?: string } {
  if (t.type === 'D' || t.type === 'N') {
    const ms = t.tdnMs ?? 0;
    if (ms > 0 && ms < 60000) {
      return { primary: `${t.type}${Math.round(ms / 1000)}s`, secondary: t.type === 'N' ? 'Neutro' : 'Desloc' };
    }
    if (ms > 0 && ms % 60000 === 0 && ms <= 3600000) {
      return { primary: `${t.type}${Math.round(ms / 60000)}'`, secondary: formatTdnOrTime(ms) };
    }
    return { primary: formatTdnOrTime(ms), secondary: t.type === 'N' ? 'Neutro' : 'Desloc' };
  }
  if (t.avgSpeedKmh !== null && t.avgSpeedKmh !== undefined && t.avgSpeedKmh > 0) {
    const rounded = Number.isInteger(t.avgSpeedKmh)
      ? String(t.avgSpeedKmh)
      : t.avgSpeedKmh.toFixed(1).replace('.', ',');
    return { primary: `v${rounded}`, secondary: 'km/h' };
  }
  return { primary: '--' };
}

const CroppedObsImage: React.FC<{
  src: string;
  alt: string;
  className?: string;
}> = ({ src, alt, className = '' }) => {
  const [croppedSrc, setCroppedSrc] = useState<string>(src);

  useEffect(() => {
    let active = true;
    setCroppedSrc(src);
    extractObservationRectangle(src).then((out) => {
      if (active) setCroppedSrc(out);
    });
    return () => {
      active = false;
    };
  }, [src]);

  return <img src={croppedSrc} alt={alt} className={className} />;
};

const CroppedDesenhoImage: React.FC<{
  src: string;
  isComposite?: boolean;
  alt: string;
  className?: string;
}> = ({ src, isComposite, alt, className = '' }) => {
  const [croppedSrc, setCroppedSrc] = useState<string>(src);

  useEffect(() => {
    let active = true;
    setCroppedSrc(src);
    if (isComposite) {
      extractDesenhoSquare(src).then((out) => {
        if (active) setCroppedSrc(out);
      });
    }
    return () => {
      active = false;
    };
  }, [src, isComposite]);

  return <img src={croppedSrc} alt={alt} className={className} />;
};

/**
 * Bi-directional Vertical TNAV Meter (Red top = + delayed, Center grey = 00:00, Green bottom = - ahead)
 */
const TnavVerticalBar: React.FC<{
  deltaSec: number | null;
  disabled?: boolean;
}> = ({ deltaSec, disabled = false }) => {
  const level =
    disabled || deltaSec === null || Math.abs(deltaSec) < 0.5
      ? 0
      : Math.min(5, Math.max(1, Math.ceil(Math.abs(deltaSec) / 3)));
  const isLate = !disabled && deltaSec !== null && deltaSec >= 0.5;
  const isAhead = !disabled && deltaSec !== null && deltaSec <= -0.5;

  return (
    <div
      className="flex h-full w-6 shrink-0 flex-col justify-between rounded-lg border-2 border-slate-600 bg-black p-0.5 sm:w-7"
      title={
        disabled
          ? 'Trecho isento (D/N)'
          : deltaSec === null
            ? 'Aguardando largada'
            : deltaSec >= 0.5
              ? `Atrasado +${deltaSec.toFixed(1)}s (Acelere)`
              : deltaSec <= -0.5
                ? `Adiantado ${deltaSec.toFixed(1)}s (Reduza)`
                : 'No Tempo Ideal (00:00)'
      }
      aria-label="Barra vertical de regularidade TNAV"
    >
      {/* Top 5 segments: Red (+ Atrasado) */}
      <div className="flex flex-1 flex-col justify-end gap-[2px]">
        {[5, 4, 3, 2, 1].map((idx) => (
          <div
            key={`red-${idx}`}
            className={`w-full flex-1 rounded-[1px] transition-colors ${
              isLate && idx <= level ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.85)]' : 'bg-red-950/35'
            }`}
          />
        ))}
      </div>

      {/* Center Grey Crosshair Line (00:00) */}
      <div className="my-[2px] flex items-center justify-center">
        <div
          className={`h-[3px] w-full rounded-full ${
            !disabled && deltaSec !== null && Math.abs(deltaSec) < 0.5
              ? 'bg-slate-200 shadow-[0_0_6px_rgba(255,255,255,0.9)]'
              : 'bg-slate-500'
          }`}
        />
      </div>

      {/* Bottom 5 segments: Green (- Adiantado) */}
      <div className="flex flex-1 flex-col justify-start gap-[2px]">
        {[1, 2, 3, 4, 5].map((idx) => (
          <div
            key={`grn-${idx}`}
            className={`w-full flex-1 rounded-[1px] transition-colors ${
              isAhead && idx <= level
                ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.85)]'
                : 'bg-emerald-950/35'
            }`}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * Bi-directional Horizontal TNAV Color Bar (Green = Adiantado, Grey center = 00:00, Red = Atrasado)
 */
const TnavHorizontalColorBar: React.FC<{
  deltaSec: number | null;
  disabled?: boolean;
}> = ({ deltaSec, disabled = false }) => {
  const isZero = !disabled && deltaSec !== null && Math.abs(deltaSec) <= 0.5;
  const isAhead = !disabled && deltaSec !== null && deltaSec < -0.5;
  const isLate = !disabled && deltaSec !== null && deltaSec > 0.5;
  // Percentage from center (0..50%)
  const pct =
    disabled || deltaSec === null
      ? 0
      : Math.min(50, Math.max(8, (Math.abs(deltaSec) / 15) * 50));

  const statusLabel = disabled
    ? 'Trecho isento (D/N)'
    : deltaSec === null
      ? 'Aguardando largada'
      : isZero
        ? 'NO TEMPO IDEAL · 00:00'
        : isAhead
          ? `ADIANTADO ${Math.abs(deltaSec).toFixed(1)}s · REDUZA`
          : `ATRASADO +${deltaSec.toFixed(1)}s · ACELERE`;

  return (
    <div className="space-y-1.5" aria-label="Barra de cores de regularidade">
      <div className="flex items-center justify-between text-[10px] font-bold tracking-wider uppercase">
        <span className={isAhead ? 'text-emerald-400' : 'text-zinc-500'}>
          − Adiantado
        </span>
        <span
          className={
            isZero
              ? 'text-slate-200'
              : isAhead
                ? 'text-emerald-400'
                : isLate
                  ? 'text-[#FF2A2A]'
                  : 'text-zinc-400'
          }
        >
          {statusLabel}
        </span>
        <span className={isLate ? 'text-[#FF2A2A]' : 'text-zinc-500'}>
          Atrasado +
        </span>
      </div>

      <div className="relative h-4 w-full overflow-hidden rounded-full border border-zinc-700 bg-black">
        {/* Left side fill: Green for Adiantado */}
        {isAhead && (
          <div
            className="absolute top-0 bottom-0 right-1/2 bg-gradient-to-l from-emerald-500 to-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.75)] transition-all duration-150"
            style={{ width: `${pct}%` }}
          />
        )}
        {/* Right side fill: Red for Atrasado */}
        {isLate && (
          <div
            className="absolute top-0 bottom-0 left-1/2 bg-gradient-to-r from-[#E10600] to-[#FF2A2A] shadow-[0_0_12px_rgba(225,6,0,0.8)] transition-all duration-150"
            style={{ width: `${pct}%` }}
          />
        )}
        {/* Center Grey 00:00 Crosshair Marker */}
        <div
          className={`absolute left-1/2 top-0 bottom-0 z-10 w-1.5 -translate-x-1/2 ${
            isZero ? 'bg-white shadow-[0_0_8px_rgba(255,255,255,0.95)]' : 'bg-zinc-400'
          }`}
        />
      </div>
    </div>
  );
};

const TulipVectorIcon: React.FC<{
  cap: number | null;
  imageDataUrl?: string;
  imageIsComposite?: boolean;
  active?: boolean;
  passed?: boolean;
  compact?: boolean;
  highlightTheme?: HighlightTheme;
  size?: 'md' | 'lg';
}> = ({
  cap,
  imageDataUrl,
  imageIsComposite = false,
  active = false,
  passed = false,
  compact = false,
  highlightTheme = 'yellow',
  size = 'md',
}) => {
  const angle = cap ?? 0;
  const boxClass =
    size === 'lg'
      ? 'h-14 w-14 sm:h-20 sm:w-20'
      : compact
        ? 'h-8 w-8 sm:h-10 sm:w-10'
        : 'h-11 w-11 sm:h-14 sm:w-14 md:h-16 md:w-16';
  const svgClass =
    size === 'lg'
      ? 'h-11 w-11 sm:h-16 sm:w-16'
      : compact
        ? 'h-6 w-6 sm:h-8 sm:w-8'
        : 'h-8 w-8 sm:h-11 sm:w-11 md:h-12 md:w-12';

  const activeBgClass =
    highlightTheme === 'blue'
      ? 'border-slate-950/60 bg-sky-300'
      : highlightTheme === 'green'
        ? 'border-slate-950/60 bg-emerald-300'
        : 'border-slate-950/60 bg-[#fde047]';

  if (imageDataUrl) {
    return (
      <div
        className={`relative flex ${boxClass} shrink-0 items-center justify-center overflow-hidden rounded-md border p-0.5 ${
          active
            ? activeBgClass
            : passed
              ? 'border-sky-300 bg-sky-100/95'
              : 'border-slate-200 bg-white'
        }`}
      >
        <CroppedDesenhoImage
          src={imageDataUrl}
          isComposite={imageIsComposite}
          alt="Tulipa"
          className="h-full w-full object-contain"
        />
      </div>
    );
  }

  return (
    <div
      className={`relative flex ${boxClass} shrink-0 items-center justify-center rounded-lg border ${
        active
          ? `${activeBgClass} text-slate-950`
          : 'border-slate-200 bg-white text-slate-900'
      }`}
    >
      <svg viewBox="0 0 64 64" className={svgClass} aria-hidden="true">
        <circle
          cx="32"
          cy="32"
          r="26"
          fill="none"
          stroke={active ? '#334155' : '#CBD5E1'}
          strokeWidth="1.75"
          strokeDasharray="3 4"
        />
        <g transform={`rotate(${angle} 32 32)`}>
          <path
            d="M32 9 L42 29 L35 27 L35 51 L29 51 L29 27 L22 29 Z"
            fill="#09090B"
          />
          <circle cx="32" cy="51" r="4.5" fill={active ? '#09090B' : '#E10600'} />
        </g>
      </svg>
    </div>
  );
};

const DigitalSpeedometer: React.FC<{
  speedKmh: number;
  targetSpeedKmh?: number | null;
  sectionType?: RoadbookTulipa['type'];
  tdnMs?: number | null;
}> = ({ speedKmh, targetSpeedKmh, sectionType, tdnMs }) => {
  const maxSpeed = 160;
  const clamped = Math.max(0, Math.min(maxSpeed, speedKmh));
  const fillPct = (clamped / maxSpeed) * 100;
  const targetPct =
    targetSpeedKmh && targetSpeedKmh > 0
      ? Math.min(100, (targetSpeedKmh / maxSpeed) * 100)
      : null;

  const diff =
    targetSpeedKmh && targetSpeedKmh > 0 ? speedKmh - targetSpeedKmh : null;
  const speedColor =
    diff === null
      ? 'text-white'
      : Math.abs(diff) <= 1.5
        ? 'text-emerald-400'
        : diff > 0
          ? 'text-[#FF2A2A]'
          : 'text-[#C0C4C9]';

  return (
    <div className="flex h-full flex-col justify-between rounded-xl border border-zinc-800 bg-[#111214] p-4 text-white">
      <div className="flex items-center justify-between gap-2 text-[10px] font-bold tracking-widest text-[#B5B5B5] uppercase">
        <span>Velocímetro Digital</span>
        <span className="font-mono text-[#E10600]">
          {sectionType === 'D' || sectionType === 'N'
            ? `${sectionType} ${tdnMs ? formatTdnOrTime(tdnMs) : ''}`.trim()
            : targetSpeedKmh
              ? `Vel/TDN ${Math.round(targetSpeedKmh)} km/h`
              : 'Sem meta'}
        </span>
      </div>

      <div className="my-3 flex flex-col items-center justify-center rounded-lg border border-zinc-800 bg-[#080B0D] px-4 py-4">
        <div
          className={`font-mono text-6xl font-black leading-none tracking-tight tabular-nums sm:text-7xl ${speedColor}`}
          aria-label={`Velocímetro ${Math.round(speedKmh)} km/h`}
        >
          {String(Math.round(speedKmh)).padStart(2, '0')}
        </div>
        <span className="mt-1.5 font-mono text-xs font-bold tracking-[0.22em] text-[#B5B5B5] uppercase">
          KM/H
        </span>
      </div>

      <div>
        <div className="relative h-2.5 w-full overflow-hidden rounded-full border border-zinc-800 bg-[#080B0D]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#C0C4C9] via-amber-400 to-[#E10600] transition-all duration-150"
            style={{ width: `${fillPct}%` }}
          />
          {targetPct !== null && (
            <div
              className="absolute top-0 bottom-0 w-1 -translate-x-1/2 bg-emerald-400"
              style={{ left: `${targetPct}%` }}
              title={`Meta ${Math.round(targetSpeedKmh ?? 0)} km/h`}
            />
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-zinc-500 tabular-nums">
          <span>0</span>
          <span>
            {diff === null
              ? 'Livre'
              : Math.abs(diff) <= 1.5
                ? 'Na Média'
                : diff > 0
                  ? `+${diff.toFixed(0)} km/h`
                  : `${diff.toFixed(0)} km/h`}
          </span>
          <span>{maxSpeed}</span>
        </div>
      </div>
    </div>
  );
};

export const NavigationCockpit: React.FC<NavigationCockpitProps> = ({
  onOpenRoadbookSettings,
}) => {
  const [roadbook, setRoadbook] = useState<ParsedRoadbook | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);
  const [fileStructureReport, setFileStructureReport] = useState<string | null>(null);
  const [diagnosticTxtData, setDiagnosticTxtData] = useState<{
    fileName: string;
    content: string;
  } | null>(null);
  const [showStructureReport, setShowStructureReport] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);

  // Shared PitStop Sports settings
  const [navSettings, updateNavSettings] = useNavSettings();
  const calibrationPct = navSettings.calibrationPct;
  const transitionAdvanceM = navSettings.transitionAdvanceM;
  const raceDate = navSettings.raceDate;
  const startTimeStr = navSettings.startTimeStr;

  const setCalibrationPct = (val: number) => updateNavSettings({ calibrationPct: val });
  const setTransitionAdvanceM = (val: number) =>
    updateNavSettings({ transitionAdvanceM: val });
  const setRaceDate = (val: string) => updateNavSettings({ raceDate: val });
  const setStartTimeStr = (val: string) => updateNavSettings({ startTimeStr: val });

  // Totem-style scenario & functions
  const [scenario, setScenario] = useState<ScreenScenario>('navegador');
  const [isRunning, setIsRunning] = useState(false);
  const [driveSource, setDriveSource] = useState<DriveSource>('gps');
  const [simSpeedKmh, setSimSpeedKmh] = useState(44);
  const [manualStepKm, setManualStepKm] = useState<number>(0.01);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [showPassedRows, setShowPassedRows] = useState(false);

  // Time & Odometers
  const [startTimestampMs, setStartTimestampMs] = useState<number>(() =>
    parseRaceStartTimestampMs(navSettings.raceDate, navSettings.startTimeStr)
  );
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const lastGpsFixTsRef = useRef<number | null>(null);

  const [odometerKm, setOdometerKm] = useState(0);
  const [partialBaseKm, setPartialBaseKm] = useState(0);
  const [currentSpeedKmh, setCurrentSpeedKmh] = useState(0);
  const [activeTulipaIdx, setActiveTulipaIdx] = useState(0);

  // Functions modal, W Fino direct edit, Tulipa Context Menu & Markings
  const [functionsOpen, setFunctionsOpen] = useState(false);
  const [officialMarcoKm, setOfficialMarcoKm] = useState('');
  const [jumpTulipaNum, setJumpTulipaNum] = useState('');
  const [editingWModal, setEditingWModal] = useState(false);
  const [wModalInput, setWModalInput] = useState('');
  const [clockSyncMsg, setClockSyncMsg] = useState<string | null>(null);

  const [markingsMap, setMarkingsMap] = useState<Map<number, TulipaMarkup>>(
    () => new Map()
  );
  const [contextMenuIdx, setContextMenuIdx] = useState<number | null>(null);
  const [markupTargetTulipa, setMarkupTargetTulipa] =
    useState<RoadbookTulipa | null>(null);

  const [gpsStatus, setGpsStatus] = useState<{
    state: 'idle' | 'waiting' | 'active' | 'error';
    accuracyM: number | null;
    message?: string;
  }>({ state: 'idle', accuracyM: null });

  const lastGpsCoordRef = useRef<{ lat: number; lon: number; ts: number } | null>(null);
  const webWatchIdRef = useRef<number | null>(null);
  const capWatchIdRef = useRef<string | null>(null);
  const lastAlertedTulipaRef = useRef<number>(-1);
  const approachBeepedIdxRef = useRef<number>(-1);
  const spokenThresholdsRef = useRef<Set<string>>(new Set());
  const longPressTimerRef = useRef<number | null>(null);
  const rowLongPressTimerRef = useRef<number | null>(null);
  const rowPressStartPtRef = useRef<{ x: number; y: number } | null>(null);
  const rowLongPressTriggeredRef = useRef(false);

  // Real-time Navigator <-> Pilot pairing state
  const [pairedTelemetry, setPairedTelemetry] = useState<PairingTelemetryPayload | null>(null);
  const [pairingPresence, setPairingPresence] = useState<PairingPresenceState>({
    status: 'disconnected',
    navigators: 0,
    pilots: 0,
    transport: 'none',
  });
  const pairingConnRef = useRef<PairingConnection | null>(null);
  const lastBroadcastMsRef = useRef<number>(0);

  const roadbookStorageKey = roadbook?.id || roadbook?.fileName || 'default';

  const activateRoadbook = useCallback((rb: ParsedRoadbook) => {
    setRoadbook(rb);
    if (rb.id) {
      setLastActiveRoadbookId(rb.id);
    }
    const startKm = rb.tulipas[0]?.totalKm ?? 0;
    setOdometerKm(startKm);
    setPartialBaseKm(startKm);
    setActiveTulipaIdx(0);
    setIsRunning(false);
    spokenThresholdsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!roadbook) {
      setMarkingsMap(new Map());
      return;
    }
    let active = true;
    listMarkingsForRoadbook(roadbookStorageKey).then((map) => {
      if (active) setMarkingsMap(map);
    });
    return () => {
      active = false;
    };
  }, [roadbook, roadbookStorageKey]);

  // Load active offline roadbook on mount and listen for activations from Settings
  useEffect(() => {
    let active = true;
    const syncActive = async () => {
      const last = await getLastActiveRoadbook();
      if (!active) return;
      if (last) {
        activateRoadbook(last);
      } else {
        setRoadbook(null);
      }
    };
    syncActive();
    const onActivated = () => {
      syncActive();
    };
    window.addEventListener('pitstop:roadbook-activated', onActivated);
    return () => {
      active = false;
      window.removeEventListener('pitstop:roadbook-activated', onActivated);
    };
  }, [activateRoadbook]);

  const handleFileUpload = async (file: File) => {
    setParseError(null);
    setCopiedReport(false);
    try {
      const buffer = await file.arrayBuffer();
      const [report, txtSample, parsed] = await Promise.all([
        inspectRoadbookFileStructure(buffer, file.name).catch(() => null),
        extractRoadbookDiagnosticDataTxt(buffer, file.name).catch(() => null),
        parseNavigationBuffer(buffer, file.name, 'nbp'),
      ]);
      if (report) setFileStructureReport(report);
      if (txtSample) {
        const cleanStem = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
        setDiagnosticTxtData({ fileName: `dados_${cleanStem}.txt`, content: txtSample });
      }
      const stored = await saveConvertedRoadbook(parsed);
      if ((stored.raceParameters?.notesCount ?? 0) === 0 || stored.totalKm < 0.5) {
        setShowStructureReport(true);
      }
      activateRoadbook(stored);
    } catch (err) {
      try {
        const buffer = await file.arrayBuffer();
        const [report, txtSample] = await Promise.all([
          inspectRoadbookFileStructure(buffer, file.name),
          extractRoadbookDiagnosticDataTxt(buffer, file.name).catch(() => null),
        ]);
        setFileStructureReport(report);
        if (txtSample) {
          const cleanStem = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
          setDiagnosticTxtData({ fileName: `dados_${cleanStem}.txt`, content: txtSample });
        }
        setShowStructureReport(true);
      } catch {
        // Ignore diagnostic fallback error
      }
      setParseError(
        err instanceof Error
          ? err.message
          : 'Não foi possível ler o arquivo de planilha.'
      );
    }
  };

  const handleInspectFileOnly = async (file: File) => {
    setCopiedReport(false);
    try {
      const buffer = await file.arrayBuffer();
      const [report, txtSample] = await Promise.all([
        inspectRoadbookFileStructure(buffer, file.name),
        extractRoadbookDiagnosticDataTxt(buffer, file.name).catch(() => null),
      ]);
      setFileStructureReport(report);
      if (txtSample) {
        const cleanStem = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
        setDiagnosticTxtData({ fileName: `dados_${cleanStem}.txt`, content: txtSample });
      }
      setShowStructureReport(true);
    } catch {
      setFileStructureReport(`Não foi possível inspecionar "${file.name}".`);
      setDiagnosticTxtData(null);
      setShowStructureReport(true);
    }
  };

  const handleCopyStructureReport = async () => {
    if (!fileStructureReport) return;
    try {
      await navigator.clipboard.writeText(fileStructureReport);
      setCopiedReport(true);
      window.setTimeout(() => setCopiedReport(false), 2000);
    } catch {
      // Ignore clipboard restriction
    }
  };

  const handleDownloadDiagnosticTxt = async () => {
    const content = diagnosticTxtData?.content || fileStructureReport;
    if (!content) return;
    const outName = diagnosticTxtData?.fileName || 'diagnostico_nbp.txt';
    if (Capacitor.isNativePlatform()) {
      try {
        const written = await Filesystem.writeFile({
          path: outName,
          data: content,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });
        await Share.share({
          title: outName,
          text: 'Diagnóstico da planilha .NBP/.ZIP para mapeamento',
          url: written.uri,
        });
        return;
      } catch {
        // Fallback to web download
      }
    }
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleLoadSample = async () => {
    setParseError(null);
    setLoadingSample(true);
    try {
      const res = await fetch('/assets/aistudio/rally_escoteiros_merged_66a34567.txt');
      if (!res.ok) throw new Error('Planilha modelo não encontrada.');
      const buffer = await res.arrayBuffer();
      const parsed = await parseNavigationBuffer(buffer, 'rally_escoteiros_merged.txt');
      const stored = await saveConvertedRoadbook(parsed);
      activateRoadbook(stored);
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : 'Erro ao carregar planilha modelo.'
      );
    } finally {
      setLoadingSample(false);
    }
  };

  const handleStartNavigation = () => {
    const normalized =
      startTimeStr.length === 5 ? `${startTimeStr}:00` : startTimeStr;
    setStartTimeStr(normalized);
    setStartTimestampMs(parseRaceStartTimestampMs(raceDate, normalized));
    lastGpsCoordRef.current = null;
    setIsRunning(true);
  };

  // Clock + Simulator Loop
  useEffect(() => {
    if (!isRunning) {
      const id = window.setInterval(() => setNowMs(Date.now()), 500);
      return () => window.clearInterval(id);
    }

    let prevTick = Date.now();
    const id = window.setInterval(() => {
      const now = Date.now();
      const dtHours = (now - prevTick) / 3600000;
      prevTick = now;
      setNowMs(now);

      if (driveSource === 'simulator') {
        setCurrentSpeedKmh(simSpeedKmh);
        const deltaKm = simSpeedKmh * dtHours * (calibrationPct / 100);
        if (deltaKm > 0) {
          setOdometerKm((prev) => Number((prev + deltaKm).toFixed(4)));
        }
      }
    }, 200);

    return () => window.clearInterval(id);
  }, [isRunning, driveSource, simSpeedKmh, calibrationPct]);

  // Real GPS Watcher
  useEffect(() => {
    let cancelled = false;
    const cleanup = () => {
      if (webWatchIdRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(webWatchIdRef.current);
        webWatchIdRef.current = null;
      }
      if (capWatchIdRef.current !== null) {
        const id = capWatchIdRef.current;
        capWatchIdRef.current = null;
        Geolocation.clearWatch({ id }).catch(() => {});
      }
    };

    if (!isRunning || driveSource !== 'gps') {
      cleanup();
      if (driveSource === 'simulator') {
        setGpsStatus({ state: 'idle', accuracyM: null });
      }
      return;
    }

    setGpsStatus({ state: 'waiting', accuracyM: null });

    const onPosition = (
      lat: number,
      lon: number,
      accuracy: number | null,
      speedMs: number | null,
      ts: number
    ) => {
      if (cancelled) return;
      lastGpsFixTsRef.current = ts || Date.now();
      const acc = accuracy !== null && Number.isFinite(accuracy) ? Math.round(accuracy) : null;
      setGpsStatus({ state: 'active', accuracyM: acc });

      if (speedMs !== null && Number.isFinite(speedMs) && speedMs >= 0) {
        setCurrentSpeedKmh(Number((speedMs * 3.6).toFixed(1)));
      }

      const prev = lastGpsCoordRef.current;
      if (prev) {
        const distM = haversineMeters(prev.lat, prev.lon, lat, lon);
        const dtSec = Math.max(0.2, (ts - prev.ts) / 1000);
        const impliedSpeedKmh = (distM / 1000) / (dtSec / 3600);
        if (distM >= 3.5 && impliedSpeedKmh <= 190) {
          const calibratedKm = (distM / 1000) * (calibrationPct / 100);
          setOdometerKm((curr) => Number((curr + calibratedKm).toFixed(4)));
          lastGpsCoordRef.current = { lat, lon, ts };
          if (speedMs === null || !Number.isFinite(speedMs)) {
            setCurrentSpeedKmh(Number(impliedSpeedKmh.toFixed(1)));
          }
        }
      } else {
        lastGpsCoordRef.current = { lat, lon, ts };
      }
    };

    if (Capacitor.isNativePlatform()) {
      (async () => {
        try {
          const perm = await Geolocation.requestPermissions();
          if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
            if (!cancelled) {
              setGpsStatus({
                state: 'error',
                accuracyM: null,
                message: 'Permissão de localização negada no Android.',
              });
            }
            return;
          }
          const id = await Geolocation.watchPosition(
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 },
            (pos, err) => {
              if (err) {
                setGpsStatus({
                  state: 'error',
                  accuracyM: null,
                  message: 'Aguardando sinal GPS...',
                });
                return;
              }
              if (pos) {
                onPosition(
                  pos.coords.latitude,
                  pos.coords.longitude,
                  pos.coords.accuracy ?? null,
                  pos.coords.speed ?? null,
                  pos.timestamp || Date.now()
                );
              }
            }
          );
          if (cancelled) {
            Geolocation.clearWatch({ id }).catch(() => {});
          } else {
            capWatchIdRef.current = id;
          }
        } catch {
          if (!cancelled) {
            setGpsStatus({
              state: 'error',
              accuracyM: null,
              message: 'Erro ao iniciar GPS nativo.',
            });
          }
        }
      })();
      return () => {
        cancelled = true;
        cleanup();
      };
    }

    if (!('geolocation' in navigator)) {
      setGpsStatus({
        state: 'error',
        accuracyM: null,
        message: 'Geolocalização não disponível neste navegador.',
      });
      return;
    }

    webWatchIdRef.current = navigator.geolocation.watchPosition(
      (pos) =>
        onPosition(
          pos.coords.latitude,
          pos.coords.longitude,
          pos.coords.accuracy ?? null,
          pos.coords.speed ?? null,
          pos.timestamp || Date.now()
        ),
      (err) => {
        setGpsStatus({
          state: 'error',
          accuracyM: null,
          message:
            err.code === 1
              ? 'Permissão GPS negada no navegador.'
              : 'Sinal GPS indisponível. Use o Simulador para treinar.',
        });
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [isRunning, driveSource, calibrationPct]);

  // Auto-advance with configurable Totem transition advance (meters before next tulipa)
  useEffect(() => {
    if (!roadbook || !autoAdvance) return;
    const startKm = roadbook.tulipas[0]?.totalKm ?? 0;
    // Before start or right at Tulipa 1, do not pre-advance past Tulipa 1
    const applyAdvanceKm =
      isRunning && odometerKm > startKm + 0.005 ? transitionAdvanceM / 1000 : 0;
    const effectiveKm = odometerKm + applyAdvanceKm;
    const idx = findActiveTulipaIndexByKm(roadbook.tulipas, effectiveKm);

    if (idx !== activeTulipaIdx) {
      setActiveTulipaIdx(idx);
      const prevT = roadbook.tulipas[activeTulipaIdx];
      const nextT = roadbook.tulipas[idx];
      const isPmmChange =
        prevT &&
        nextT &&
        (prevT.type !== nextT.type ||
          Math.abs((prevT.avgSpeedKmh ?? 0) - (nextT.avgSpeedKmh ?? 0)) >= 2);

      if (soundEnabled && isRunning && lastAlertedTulipaRef.current !== idx) {
        lastAlertedTulipaRef.current = idx;
        playBeep(isPmmChange ? 1180 : 920, 110, Boolean(isPmmChange));
      }
    }
  }, [
    roadbook,
    odometerKm,
    transitionAdvanceM,
    autoAdvance,
    activeTulipaIdx,
    soundEnabled,
    isRunning,
  ]);

  const currentTulipa: RoadbookTulipa | null =
    roadbook?.tulipas[activeTulipaIdx] ?? null;
  const nextTulipa: RoadbookTulipa | null =
    roadbook?.tulipas[activeTulipaIdx + 1] ?? null;

  const isNonTimedSection =
    currentTulipa?.type === 'D' || currentTulipa?.type === 'N';

  const distToNextKm = useMemo(() => {
    if (!nextTulipa) return 0;
    return Math.max(0, nextTulipa.totalKm - odometerKm);
  }, [nextTulipa, odometerKm]);

  // Approach cue < 50m before next tulipa (honors selected alertStyle)
  useEffect(() => {
    if (!isRunning || !soundEnabled || !nextTulipa) return;
    const distM = distToNextKm * 1000;
    if (
      distM > 0 &&
      distM <= 50 &&
      approachBeepedIdxRef.current !== activeTulipaIdx + 1
    ) {
      approachBeepedIdxRef.current = activeTulipaIdx + 1;
      if (navSettings.alertStyle === 'vibration') {
        if ('vibrate' in navigator) navigator.vibrate([120, 60, 120]);
      } else if (navSettings.alertStyle === 'beep_long') {
        playBeep(820, 280, false);
      } else {
        playBeep(760, 80, false);
      }
    }
  }, [
    isRunning,
    soundEnabled,
    nextTulipa,
    distToNextKm,
    activeTulipaIdx,
    navSettings.alertStyle,
  ]);

  // Cantada Regressiva de Distância (honors voice | beep_short | beep_long | vibration)
  useEffect(() => {
    if (!isRunning || !soundEnabled || !navSettings.voiceEnabled || !nextTulipa) {
      return;
    }
    const distM = distToNextKm * 1000;
    if (distM <= 0) return;

    const unit = navSettings.voiceUnit;
    const thresholds = navSettings.voiceThresholds;
    if (thresholds.length === 0) return;

    let currentMetric = distM;
    if (unit === 'seconds') {
      const speedMps = currentSpeedKmh / 3.6;
      if (speedMps < 0.8) return;
      currentMetric = distM / speedMps;
    }

    const sortedAsc = [...thresholds].sort((a, b) => a - b);
    for (const threshold of sortedAsc) {
      if (currentMetric <= threshold && currentMetric > Math.max(0.5, threshold * 0.12)) {
        const key = `${activeTulipaIdx + 1}:${unit}:${threshold}`;
        if (!spokenThresholdsRef.current.has(key)) {
          spokenThresholdsRef.current.add(key);
          if (navSettings.alertStyle === 'voice') {
            const unitLabel = unit === 'seconds' ? 'segundos' : 'metros';
            speakPtBr(`${threshold} ${unitLabel}`);
          } else if (navSettings.alertStyle === 'beep_short') {
            playBeep(980, 75, false);
          } else if (navSettings.alertStyle === 'beep_long') {
            playBeep(860, 320, false);
          } else if (navSettings.alertStyle === 'vibration' && 'vibrate' in navigator) {
            navigator.vibrate([130, 50, 130]);
          }
        }
        break;
      }
    }
  }, [
    isRunning,
    soundEnabled,
    navSettings.voiceEnabled,
    navSettings.voiceUnit,
    navSettings.voiceThresholds,
    navSettings.alertStyle,
    nextTulipa,
    distToNextKm,
    currentSpeedKmh,
    activeTulipaIdx,
  ]);

  const partialKm = Math.max(0, odometerKm - partialBaseKm);
  const officialNowMs = nowMs + navSettings.clockOffsetMs;
  const elapsedMs = officialNowMs - startTimestampMs;

  const idealAtCurrentKmMs = useMemo(() => {
    if (!roadbook) return null;
    return interpolateIdealTimeAtKm(roadbook.tulipas, odometerKm);
  }, [roadbook, odometerKm]);

  const idealKmAtNow = useMemo(() => {
    if (!roadbook || !isRunning) return null;
    return interpolateKmAtElapsedMs(roadbook.tulipas, elapsedMs);
  }, [roadbook, isRunning, elapsedMs]);

  // Regularity delta in seconds (+ = atrasado, - = adiantado); null inside Deslocamento (D) / Neutro (N)
  const deltaSec = useMemo(() => {
    if (!isRunning || isNonTimedSection || idealAtCurrentKmMs === null) return null;
    return Number(((elapsedMs - idealAtCurrentKmMs) / 1000).toFixed(1));
  }, [isRunning, isNonTimedSection, elapsedMs, idealAtCurrentKmMs]);

  // Knav delta in meters (+ = adiantado em metros à frente, - = atrasado em metros atrás)
  const deltaMeters = useMemo(() => {
    if (!isRunning || isNonTimedSection || idealKmAtNow === null) return null;
    return Math.round((odometerKm - idealKmAtNow) * 1000);
  }, [isRunning, isNonTimedSection, odometerKm, idealKmAtNow]);

  const sectionRemainingMs =
    isRunning && isNonTimedSection && currentTulipa?.sectionEndTimeMs != null
      ? currentTulipa.sectionEndTimeMs - elapsedMs
      : null;

  // Locate current block end & next transition (D -> V, N -> V, V -> D/N, or speed change)
  const blockTelemetry = useMemo(() => {
    if (!roadbook || roadbook.tulipas.length === 0 || !currentTulipa) {
      return null;
    }
    const list = roadbook.tulipas;
    let blockEndIdx = activeTulipaIdx;
    while (
      blockEndIdx + 1 < list.length &&
      list[blockEndIdx + 1].type === currentTulipa.type &&
      (currentTulipa.section === null ||
        list[blockEndIdx + 1].section === null ||
        list[blockEndIdx + 1].section === currentTulipa.section)
    ) {
      blockEndIdx += 1;
    }
    const nextBlockStartTulipa = list[blockEndIdx + 1] ?? null;
    const distToBlockEndKm = nextBlockStartTulipa
      ? Math.max(0, nextBlockStartTulipa.totalKm - odometerKm)
      : Math.max(0, (list[blockEndIdx]?.totalKm ?? 0) - odometerKm);

    // Find next PMM speed change or type transition after activeTulipaIdx
    let nextChangeTulipa: RoadbookTulipa | null = null;
    for (let i = activeTulipaIdx + 1; i < list.length; i++) {
      const cand = list[i];
      if (
        cand.type !== currentTulipa.type ||
        (currentTulipa.type === 'V' &&
          Math.abs((cand.avgSpeedKmh ?? 0) - (currentTulipa.avgSpeedKmh ?? 0)) >= 2)
      ) {
        nextChangeTulipa = cand;
        break;
      }
    }

    return {
      nextBlockStartTulipa,
      distToBlockEndKm,
      nextChangeTulipa,
      distToNextChangeKm: nextChangeTulipa
        ? Math.max(0, nextChangeTulipa.totalKm - odometerKm)
        : null,
    };
  }, [roadbook, currentTulipa, activeTulipaIdx, odometerKm]);

  // Countdown beeps during final 5 seconds of Deslocamento (D) or Neutralização (N)
  const lastCountdownSecRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isRunning || !soundEnabled || !isNonTimedSection || sectionRemainingMs === null) {
      lastCountdownSecRef.current = null;
      return;
    }
    const secLeft = Math.ceil(sectionRemainingMs / 1000);
    if (secLeft >= 0 && secLeft <= 5 && lastCountdownSecRef.current !== secLeft) {
      lastCountdownSecRef.current = secLeft;
      playBeep(secLeft === 0 ? 1400 : 980, secLeft === 0 ? 220 : 90, secLeft === 0);
    }
  }, [isRunning, soundEnabled, isNonTimedSection, sectionRemainingMs]);

  // Active Row Positioning: Linha 1 (Topo) vs Linha 2 (1 passada acima)
  const planilhaStartIdx = showPassedRows
    ? 0
    : navSettings.activeRowLine === 1
      ? activeTulipaIdx
      : activeTulipaIdx > 0
        ? activeTulipaIdx - 1
        : 0;
  const planilhaRows = useMemo(() => {
    if (!roadbook) return [];
    return roadbook.tulipas.slice(planilhaStartIdx);
  }, [roadbook, planilhaStartIdx]);

  // Direct comparison of live chrono against current tulipa's ideal passage time (for Vel or arrival check)
  const activeTulipaDeltaSec = useMemo(() => {
    if (!isRunning || !currentTulipa || currentTulipa.idealTimeMs === null) return null;
    return Number(((elapsedMs - currentTulipa.idealTimeMs) / 1000).toFixed(1));
  }, [isRunning, currentTulipa, elapsedMs]);

  const adjustOdometer = (deltaKm: number) => {
    setOdometerKm((prev) => Math.max(0, Number((prev + deltaKm).toFixed(3))));
  };

  const syncToTulipa = useCallback(
    (idx: number) => {
      if (!roadbook || !roadbook.tulipas[idx]) return;
      setActiveTulipaIdx(idx);
      const km = roadbook.tulipas[idx].totalKm;
      setOdometerKm(km);
      setPartialBaseKm(km);
    },
    [roadbook]
  );

  const syncHereAndIdealTime = useCallback(
    (idx: number) => {
      if (!roadbook || !roadbook.tulipas[idx]) return;
      const targetTulipa = roadbook.tulipas[idx];
      syncToTulipa(idx);
      if (targetTulipa.idealTimeMs !== null) {
        const nowOfficial = Date.now() + navSettings.clockOffsetMs;
        const newStartMs = nowOfficial - targetTulipa.idealTimeMs;
        setStartTimestampMs(newStartMs);
        const startD = new Date(newStartMs);
        const formattedStart = [
          String(startD.getHours()).padStart(2, '0'),
          String(startD.getMinutes()).padStart(2, '0'),
          String(startD.getSeconds()).padStart(2, '0'),
        ].join(':');
        setStartTimeStr(formattedStart);
        setIsRunning(true);
      }
    },
    [roadbook, syncToTulipa, navSettings.clockOffsetMs]
  );

  // Press-and-hold handler on odometer display (Totem signature interaction)
  const startLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
    }
    longPressTimerRef.current = window.setTimeout(() => {
      setFunctionsOpen(true);
    }, 650);
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // Row Long-Press (850ms) for Reference Context Menu (cancels cleanly when scrolling)
  const cancelRowLongPress = () => {
    if (rowLongPressTimerRef.current !== null) {
      window.clearTimeout(rowLongPressTimerRef.current);
      rowLongPressTimerRef.current = null;
    }
    rowPressStartPtRef.current = null;
  };

  const startRowLongPress = (realIdx: number, e: React.PointerEvent) => {
    cancelRowLongPress();
    rowLongPressTriggeredRef.current = false;
    rowPressStartPtRef.current = { x: e.clientX, y: e.clientY };
    rowLongPressTimerRef.current = window.setTimeout(() => {
      rowLongPressTriggeredRef.current = true;
      setContextMenuIdx(realIdx);
    }, 850);
  };

  const moveRowLongPress = (e: React.PointerEvent) => {
    const startPt = rowPressStartPtRef.current;
    if (!startPt) return;
    if (Math.hypot(e.clientX - startPt.x, e.clientY - startPt.y) > 10) {
      cancelRowLongPress();
    }
  };

  const handleCalibrateByMarco = () => {
    const targetKm = parseFloat(officialMarcoKm.replace(',', '.'));
    if (!Number.isFinite(targetKm) || targetKm <= 0 || odometerKm <= 0) return;
    const newFactor = Number(
      Math.min(130, Math.max(70, (targetKm / odometerKm) * calibrationPct)).toFixed(2)
    );
    setCalibrationPct(newFactor);
    setOdometerKm(targetKm);
    setOfficialMarcoKm('');
  };

  const handleAdjustWFino = (deltaPct: number) => {
    const next = Math.min(130, Math.max(70, Number((calibrationPct + deltaPct).toFixed(2))));
    setCalibrationPct(next);
  };

  const handleOpenWModalEdit = () => {
    const activeW = wValueFromCalibrationPct(calibrationPct, navSettings.wBaseValue);
    setWModalInput(
      navSettings.sensorMode === 'blue' ? String(activeW) : calibrationPct.toFixed(2)
    );
    setEditingWModal(true);
  };

  const handleCommitWModalEdit = () => {
    const parsed = parseFloat(wModalInput.replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0) {
      if (navSettings.sensorMode === 'blue') {
        setCalibrationPct(calibrationPctFromWValue(parsed, navSettings.wBaseValue));
      } else {
        setCalibrationPct(Math.min(130, Math.max(70, Number(parsed.toFixed(2)))));
      }
    }
    setEditingWModal(false);
  };

  const handleSyncGpsClock = () => {
    if (lastGpsFixTsRef.current) {
      const offset = Math.round(lastGpsFixTsRef.current - Date.now());
      updateNavSettings({ clockOffsetMs: offset });
      setClockSyncMsg(`Sincronizado pelo GPS (offset ${(offset / 1000).toFixed(1)}s).`);
    } else {
      updateNavSettings({ clockOffsetMs: 0 });
      setClockSyncMsg('Sincronizado com o relógio do aparelho.');
    }
    window.setTimeout(() => setClockSyncMsg(null), 3500);
  };

  const handleJumpToTulipa = () => {
    if (!roadbook) return;
    const target = parseInt(jumpTulipaNum, 10);
    const idx = roadbook.tulipas.findIndex((t) => t.tulipa === target);
    if (idx >= 0) {
      syncToTulipa(idx);
      setJumpTulipaNum('');
      setFunctionsOpen(false);
    }
  };

  const lastPilotAlertTulRef = useRef<number>(-1);
  const lastPilotApproachTulRef = useRef<number>(-1);

  // Real-time Pairing Room lifecycle
  useEffect(() => {
    if (!navSettings.pairing.enabled || !navSettings.pairing.roomCode) {
      if (pairingConnRef.current) {
        pairingConnRef.current.close();
        pairingConnRef.current = null;
      }
      setPairedTelemetry(null);
      setPairingPresence({
        status: 'disconnected',
        navigators: 0,
        pilots: 0,
        transport: 'none',
      });
      return;
    }

    const conn = connectPairingRoom({
      roomCode: navSettings.pairing.roomCode,
      role: navSettings.pairing.role,
      onTelemetry: (payload) => {
        setPairedTelemetry(payload);
        // Trigger audio/vibration alerts on the Pilot device when enabled
        if (navSettings.pairing.role === 'pilot' && soundEnabled && payload.isRunning) {
          if (lastPilotAlertTulRef.current !== payload.tulipaNum) {
            lastPilotAlertTulRef.current = payload.tulipaNum;
            playBeep(960, 100, false);
          }
          const distM = payload.distToNextKm * 1000;
          if (
            distM > 0 &&
            distM <= 50 &&
            lastPilotApproachTulRef.current !== payload.tulipaNum
          ) {
            lastPilotApproachTulRef.current = payload.tulipaNum;
            if (navSettings.alertStyle === 'vibration' && 'vibrate' in navigator) {
              navigator.vibrate([120, 60, 120]);
            } else if (navSettings.alertStyle === 'beep_long') {
              playBeep(820, 280, false);
            } else {
              playBeep(1120, 110, true);
            }
          }
        }
      },
      onPresence: (p) => setPairingPresence(p),
    });
    pairingConnRef.current = conn;
    if (navSettings.pairing.role === 'pilot') {
      setScenario('piloto');
    }

    return () => {
      conn.close();
      pairingConnRef.current = null;
    };
  }, [
    navSettings.pairing.enabled,
    navSettings.pairing.role,
    navSettings.pairing.roomCode,
    navSettings.alertStyle,
    soundEnabled,
  ]);

  // Global Hotkeys (Bluetooth buttons / Keyboard)
  useEffect(() => {
    if (!roadbook) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const tag = activeEl?.tagName?.toUpperCase() || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const sc = navSettings.shortcuts;
      if (sc.syncHere && e.key === sc.syncHere) {
        e.preventDefault();
        syncToTulipa(activeTulipaIdx);
      } else if (sc.odoPlus && e.key === sc.odoPlus) {
        e.preventDefault();
        adjustOdometer(manualStepKm);
      } else if (sc.odoMinus && e.key === sc.odoMinus) {
        e.preventDefault();
        adjustOdometer(-manualStepKm);
      } else if (sc.nextTulipa && e.key === sc.nextTulipa) {
        e.preventDefault();
        setActiveTulipaIdx((i) => Math.min(roadbook.tulipas.length - 1, i + 1));
      } else if (sc.prevTulipa && e.key === sc.prevTulipa) {
        e.preventDefault();
        setActiveTulipaIdx((i) => Math.max(0, i - 1));
      } else if (sc.toggleRun && e.key === sc.toggleRun) {
        e.preventDefault();
        if (isRunning) setIsRunning(false);
        else handleStartNavigation();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Navigator -> Pilot Real-Time WebSocket Broadcast
  useEffect(() => {
    if (
      !roadbook ||
      !navSettings.pairing.enabled ||
      navSettings.pairing.role !== 'navigator' ||
      !pairingConnRef.current
    ) {
      return;
    }
    const now = Date.now();
    if (now - lastBroadcastMsRef.current < 150) return;
    lastBroadcastMsRef.current = now;
    const targetRef = nextTulipa ?? currentTulipa;
    pairingConnRef.current.sendTelemetry({
      roomCode: navSettings.pairing.roomCode,
      odometerKm,
      partialKm,
      speedKmh: currentSpeedKmh,
      targetSpeedKmh: isNonTimedSection ? null : currentTulipa?.avgSpeedKmh ?? null,
      deltaSec: isNonTimedSection ? null : deltaSec,
      deltaMeters: isNonTimedSection ? null : deltaMeters,
      clockTimeStr: formatClockMs(officialNowMs, false),
      elapsedMs,
      activeTulipaIdx,
      tulipaNum: targetRef?.tulipa ?? activeTulipaIdx + 1,
      distToNextKm,
      cap: targetRef?.cap ?? null,
      type: targetRef?.type ?? '',
      section: targetRef?.section ?? null,
      tdnMs: targetRef?.tdnMs ?? targetRef?.sectionDurationMs ?? null,
      sectionRemainingMs,
      notes: targetRef?.notes,
      imageDataUrl: targetRef?.imageDataUrl,
      notesImageDataUrl: targetRef?.notesImageDataUrl,
      imageIsComposite: targetRef?.imageIsComposite,
      isRunning,
      eventName: roadbook.eventName,
      updatedAtMs: now,
    });
  }, [
    roadbook,
    navSettings.pairing.enabled,
    navSettings.pairing.role,
    navSettings.pairing.roomCode,
    odometerKm,
    partialKm,
    currentSpeedKmh,
    isNonTimedSection,
    currentTulipa,
    nextTulipa,
    deltaSec,
    deltaMeters,
    officialNowMs,
    elapsedMs,
    activeTulipaIdx,
    distToNextKm,
    sectionRemainingMs,
    isRunning,
  ]);

  const renderPilotDashboard = (opts: {
    tulNum: number | string;
    distKm: number;
    odoKm: number;
    speed: number;
    targetSpeed: number | null;
    pDeltaSec: number | null;
    pDeltaMeters: number | null;
    pClockStr: string;
    pCap: number | null;
    pType: RoadbookTulipa['type'];
    pSection: number | null;
    pSectionRemMs: number | null;
    pNotes?: string;
    pImage?: string;
    pNotesImg?: string;
    pIsComposite?: boolean;
    pairedHeader?: { roomCode: string; connected: boolean } | null;
  }) => {
    const pd = navSettings.pilotDisplay;
    const obsImg = opts.pNotesImg || (opts.pIsComposite ? opts.pImage : undefined);
    const nonTimed = opts.pType === 'D' || opts.pType === 'N';
    const hasLeft =
      pd.showDistance ||
      pd.showOdometer ||
      pd.showSpeed ||
      pd.showTargetSpeed ||
      pd.showTnav ||
      pd.showColorBar ||
      pd.showDeltaMeters ||
      pd.showClock;
    const hasRight = pd.showDesenho || pd.showCap || pd.showObs;

    const metricCount = [pd.showSpeed, pd.showTargetSpeed, pd.showTnav].filter(Boolean).length;
    const metricsGridClass =
      metricCount === 1
        ? 'grid-cols-1'
        : metricCount === 2
          ? 'grid-cols-2'
          : 'grid-cols-3';

    return (
      <div className="space-y-3">
        {opts.pairedHeader && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-[#111214] px-3.5 py-2.5 text-white">
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-[#E10600]" />
              <span className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
                Piloto Pareado · Sala {opts.pairedHeader.roomCode}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSoundEnabled((s) => !s)}
                title={soundEnabled ? 'Desativar alertas' : 'Ativar alertas'}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-[#080B0D] text-[#C0C4C9] hover:text-white"
              >
                {soundEnabled ? (
                  <Volume2 className="h-4 w-4 text-[#E10600]" />
                ) : (
                  <VolumeX className="h-4 w-4" />
                )}
              </button>
              <span
                className={`font-mono text-xs font-bold ${
                  opts.pairedHeader.connected ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {opts.pairedHeader.connected ? 'Navegador Online' : 'Aguardando Navegador'}
              </span>
            </div>
          </div>
        )}

        <section className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-12">
          {hasLeft && (
            <div
              className={`rounded-xl border border-zinc-800 bg-[#111214] p-4 text-white sm:p-5 space-y-4 ${
                hasRight ? 'md:col-span-7' : 'md:col-span-12'
              }`}
            >
              {(pd.showDistance || pd.showOdometer || pd.showClock || pd.showDeltaMeters) && (
                <div className="flex flex-wrap items-end justify-between gap-3">
                  {pd.showDistance && (
                    <div>
                      <p className="text-[11px] font-bold tracking-wider text-[#B5B5B5] uppercase sm:text-xs">
                        {nonTimed && opts.pSectionRemMs !== null
                          ? opts.pSectionRemMs >= 0
                            ? `${opts.pType === 'N' ? 'Neutro' : 'Deslocamento'} · V em ${formatHmsDuration(opts.pSectionRemMs)}`
                            : `Tempo excedido (+${formatHmsDuration(-opts.pSectionRemMs)})`
                          : `Falta para Referência #${opts.tulNum}`}
                      </p>
                      <p className="mt-0.5 font-mono text-5xl font-black leading-none tracking-tight text-amber-300 tabular-nums sm:text-6xl">
                        {opts.distKm < 1
                          ? `${Math.round(opts.distKm * 1000)} m`
                          : `${opts.distKm.toFixed(2)} km`}
                      </p>
                    </div>
                  )}

                  <div className="flex flex-col items-start gap-1 text-left font-mono text-xs text-[#C0C4C9] sm:items-end sm:text-right">
                    {pd.showOdometer && (
                      <span>
                        Hodômetro: <strong className="text-white text-sm">{opts.odoKm.toFixed(3)} km</strong>
                      </span>
                    )}
                    {pd.showDeltaMeters && opts.pDeltaMeters !== null && (
                      <span>
                        Diferença:{' '}
                        <strong className={opts.pDeltaMeters >= 0 ? 'text-emerald-400' : 'text-[#FF2A2A]'}>
                          {opts.pDeltaMeters >= 0 ? '+' : ''}
                          {opts.pDeltaMeters} m
                        </strong>
                      </span>
                    )}
                    {pd.showClock && (
                      <span>
                        Hora: <strong className="text-white">{opts.pClockStr}</strong>
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Big VELOCIDADE · MÉDIA · TNAV cards */}
              {metricCount > 0 && (
                <div className={`grid ${metricsGridClass} gap-2.5 border-t border-zinc-800 pt-3.5 text-center font-mono tabular-nums`}>
                  {pd.showSpeed && (
                    <div className="rounded-xl border border-zinc-800 bg-[#080B0D] px-2 py-3 sm:py-4">
                      <span className="block text-[10px] font-bold tracking-widest text-[#B5B5B5] uppercase sm:text-xs">
                        Velocidade
                      </span>
                      <strong className="mt-1 block text-4xl font-black leading-none text-white sm:text-5xl md:text-6xl">
                        {Math.round(opts.speed)}
                      </strong>
                      <span className="mt-1 block text-[10px] text-zinc-500 uppercase">km/h</span>
                    </div>
                  )}

                  {pd.showTargetSpeed && (
                    <div className="rounded-xl border border-zinc-800 bg-[#080B0D] px-2 py-3 sm:py-4">
                      <span className="block text-[10px] font-bold tracking-widest text-[#B5B5B5] uppercase sm:text-xs">
                        Média
                      </span>
                      <strong className="mt-1 block text-4xl font-black leading-none text-[#E10600] sm:text-5xl md:text-6xl">
                        {nonTimed ? opts.pType : opts.targetSpeed ?? '--'}
                      </strong>
                      <span className="mt-1 block text-[10px] text-zinc-500 uppercase">
                        {nonTimed ? 'Isento' : 'km/h'}
                      </span>
                    </div>
                  )}

                  {pd.showTnav && (
                    <div className="rounded-xl border border-zinc-800 bg-[#080B0D] px-2 py-3 sm:py-4">
                      <span className="block text-[10px] font-bold tracking-widest text-[#B5B5B5] uppercase sm:text-xs">
                        TNAV
                      </span>
                      <strong
                        className={`mt-1 block text-3xl font-black leading-none sm:text-4xl md:text-5xl ${
                          nonTimed
                            ? 'text-[#C0C4C9]'
                            : opts.pDeltaSec === null
                              ? 'text-zinc-500'
                              : Math.abs(opts.pDeltaSec) <= 0.5
                                ? 'text-white'
                                : opts.pDeltaSec < 0
                                  ? 'text-emerald-400'
                                  : 'text-[#FF2A2A]'
                        }`}
                      >
                        {nonTimed ? 'n.e.' : formatTnavReadout(opts.pDeltaSec)}
                      </strong>
                      <span className="mt-1 block text-[10px] text-zinc-500 uppercase">
                        {nonTimed ? 'Livre' : 'Segundos'}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Bi-directional Regularity Color Bar (Verde = Adiantado | Cinza = 00:00 | Vermelho = Atrasado) */}
              {pd.showColorBar && (
                <div className="border-t border-zinc-800 pt-3">
                  <TnavHorizontalColorBar deltaSec={opts.pDeltaSec} disabled={nonTimed} />
                </div>
              )}
            </div>
          )}

          {hasRight && (
            <div
              className={`flex flex-col justify-between gap-3 rounded-xl border border-zinc-800 bg-[#111214] p-4 text-white sm:p-5 ${
                hasLeft ? 'md:col-span-5' : 'md:col-span-12'
              }`}
            >
              {(pd.showDesenho || pd.showCap) && (
                <div className="flex items-center gap-3.5">
                  {pd.showDesenho && (
                    <TulipVectorIcon
                      cap={opts.pCap}
                      imageDataUrl={opts.pImage}
                      imageIsComposite={opts.pIsComposite}
                      highlightTheme={navSettings.highlightTheme}
                      active
                      size="lg"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-bold text-[#E10600] uppercase sm:text-xs">
                      Próxima Direção · Tulipa #{opts.tulNum}
                    </p>
                    {pd.showCap && (
                      <p className="mt-0.5 font-['Barlow_Condensed'] text-3xl font-bold text-white sm:text-4xl">
                        {opts.pCap !== null ? `CAP ${opts.pCap}°` : `Trecho ${opts.pSection ?? '-'}`}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {pd.showObs && (
                <div className="w-full flex-1 flex flex-col justify-center">
                  {obsImg && (
                    <div className="flex w-full items-center justify-center rounded-lg bg-white p-2">
                      <CroppedObsImage
                        src={obsImg}
                        alt={`Observação tulipa ${opts.tulNum}`}
                        className="h-20 sm:h-24 w-auto max-w-full object-contain object-center"
                      />
                    </div>
                  )}
                  {(opts.pNotes || !obsImg) && (
                    <p className="mt-2 text-center text-base font-extrabold text-white whitespace-pre-line break-words uppercase sm:text-lg">
                      {opts.pNotes || `Trecho ${opts.pType || '-'}`}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    );
  };

  // --- NO ROADBOOK LOADED STATE (OR PAIRED PILOT SCREEN WITHOUT LOCAL FILE) ---
  if (!roadbook) {
    if (navSettings.pairing.enabled && navSettings.pairing.role === 'pilot') {
      if (!pairedTelemetry) {
        return (
          <div className="mx-auto max-w-2xl space-y-3">
            <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-[#111214] px-4 py-3 text-white">
              <div className="flex items-center gap-2">
                <Link2 className="h-4 w-4 text-[#E10600]" />
                <span className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
                  Piloto Pareado · Sala {navSettings.pairing.roomCode}
                </span>
              </div>
              <span
                className={`font-mono text-xs font-bold ${
                  pairingPresence.navigators > 0 ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {pairingPresence.navigators > 0 ? 'Navegador Online' : 'Aguardando...'}
              </span>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-[#111214] p-8 text-center text-sm text-[#B5B5B5]">
              Aguardando envio de telemetria do celular Navegador na sala{' '}
              <strong className="font-mono text-white">{navSettings.pairing.roomCode}</strong>...
            </div>
          </div>
        );
      }

      return (
        <div className="mx-auto max-w-4xl">
          {renderPilotDashboard({
            tulNum: pairedTelemetry.tulipaNum,
            distKm: pairedTelemetry.distToNextKm,
            odoKm: pairedTelemetry.odometerKm,
            speed: pairedTelemetry.speedKmh,
            targetSpeed: pairedTelemetry.targetSpeedKmh,
            pDeltaSec: pairedTelemetry.deltaSec,
            pDeltaMeters: pairedTelemetry.deltaMeters ?? null,
            pClockStr: pairedTelemetry.clockTimeStr || formatClockMs(officialNowMs, false),
            pCap: pairedTelemetry.cap,
            pType: pairedTelemetry.type,
            pSection: pairedTelemetry.section,
            pSectionRemMs: pairedTelemetry.sectionRemainingMs,
            pNotes: pairedTelemetry.notes,
            pImage: pairedTelemetry.imageDataUrl,
            pNotesImg: pairedTelemetry.notesImageDataUrl,
            pIsComposite: pairedTelemetry.imageIsComposite,
            pairedHeader: {
              roomCode: navSettings.pairing.roomCode,
              connected: pairingPresence.navigators > 0,
            },
          })}
        </div>
      );
    }

    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <section className="relative overflow-hidden rounded-xl border border-zinc-800 bg-[#111214] text-[#F4F4F4] shadow-xl">
          <div className="p-6 text-center sm:p-8">
            <Compass className="mx-auto h-10 w-10 text-[#E10600]" />
            <h2 className="mt-3 font-['Barlow_Condensed'] text-2xl font-bold italic text-white uppercase sm:text-3xl">
              Nenhuma Planilha Ativa
            </h2>
            <p className="mt-1.5 text-sm text-[#B5B5B5]">
              Importe ou selecione seu livro de bordo em{' '}
              <strong className="text-white">Configurações &gt; Planilhas &amp; Livros de Bordo</strong>.
            </p>

            {parseError && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-800/70 bg-red-950/50 p-3 text-left text-xs text-red-200">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#FF2A2A]" />
                <span>{parseError}</span>
              </div>
            )}

            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
              {onOpenRoadbookSettings && (
                <button
                  type="button"
                  onClick={onOpenRoadbookSettings}
                  className="pitstop-btn-red inline-flex min-h-[48px] items-center justify-center gap-2 rounded-lg px-6 text-sm font-extrabold tracking-wide text-white uppercase"
                >
                  <Database className="h-4 w-4" />
                  <span>Abrir Planilhas em Configurações</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleLoadSample}
                disabled={loadingSample}
                className="pitstop-btn-metal inline-flex min-h-[48px] items-center justify-center gap-2 rounded-lg px-5 text-sm font-bold"
              >
                <FileText className="h-4 w-4 text-[#E10600]" />
                <span>{loadingSample ? 'Carregando...' : 'Testar com Modelo'}</span>
              </button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  // Regularity bar positioning (-15s..+15s centered at 50%)
  // Left = Adiantado (-s), Right = Atrasado (+s)
  const gaugePercent =
    deltaSec === null ? 50 : Math.max(4, Math.min(96, 50 + (deltaSec / 15) * 46));

  const regTone = isNonTimedSection
    ? {
        text: 'text-[#C0C4C9]',
        label:
          currentTulipa?.type === 'D'
            ? `Deslocamento ${formatHmsDuration(currentTulipa?.sectionDurationMs)}`
            : `Neutralização ${formatHmsDuration(currentTulipa?.sectionDurationMs)}`,
        bg: 'bg-[#C0C4C9]',
      }
    : deltaSec === null
      ? { text: 'text-[#B5B5B5]', label: 'Aguardando largada', bg: 'bg-zinc-600' }
      : Math.abs(deltaSec) <= 0.5
        ? { text: 'text-emerald-400', label: 'NO TEMPO IDEAL', bg: 'bg-emerald-500' }
        : deltaSec < 0
          ? { text: 'text-emerald-400', label: 'ADIANTADO · TIRE O PÉ', bg: 'bg-emerald-500' }
          : { text: 'text-[#FF2A2A]', label: 'ATRASADO · ACELERE', bg: 'bg-[#E10600]' };

  const hasPmmChangeSoon =
    currentTulipa &&
    nextTulipa &&
    (currentTulipa.type !== nextTulipa.type ||
      Math.abs((currentTulipa.avgSpeedKmh ?? 0) - (nextTulipa.avgSpeedKmh ?? 0)) >= 2);

  return (
    <div className="space-y-2.5 sm:space-y-3">
      {/* Slim Clean Cockpit Action Bar (Event details moved into Funções) */}
      <section className="overflow-hidden rounded-xl border border-zinc-800 bg-[#111214] text-white shadow-lg">
        <div className="flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-2 sm:px-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Layout Scenario: Navegador vs Piloto */}
            <div className="inline-flex rounded-lg border border-zinc-800 bg-[#080B0D] p-0.5">
              <button
                type="button"
                onClick={() => setScenario('navegador')}
                className={`min-h-[32px] rounded-md px-2.5 text-[11px] font-semibold transition-colors sm:text-xs ${
                  scenario === 'navegador'
                    ? 'bg-zinc-800 text-white'
                    : 'text-[#B5B5B5] hover:text-white'
                }`}
              >
                Navegador
              </button>
              <button
                type="button"
                onClick={() => setScenario('piloto')}
                className={`min-h-[32px] rounded-md px-2.5 text-[11px] font-semibold transition-colors sm:text-xs ${
                  scenario === 'piloto'
                    ? 'bg-zinc-800 text-white'
                    : 'text-[#B5B5B5] hover:text-white'
                }`}
              >
                Piloto
              </button>
            </div>

            {/* Source: GPS vs Simulator */}
            <div className="inline-flex rounded-lg border border-zinc-800 bg-[#080B0D] p-0.5">
              <button
                type="button"
                onClick={() => setDriveSource('gps')}
                className={`min-h-[32px] rounded-md px-2.5 text-[11px] font-semibold transition-colors sm:text-xs ${
                  driveSource === 'gps'
                    ? 'bg-[#E10600] text-white'
                    : 'text-[#B5B5B5] hover:text-white'
                }`}
              >
                GPS
              </button>
              <button
                type="button"
                onClick={() => setDriveSource('simulator')}
                className={`min-h-[32px] rounded-md px-2.5 text-[11px] font-semibold transition-colors sm:text-xs ${
                  driveSource === 'simulator'
                    ? 'bg-[#E10600] text-white'
                    : 'text-[#B5B5B5] hover:text-white'
                }`}
              >
                Simulador
              </button>
            </div>

            {navSettings.pairing.enabled && (
              <span
                className={`hidden sm:inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-[#080B0D] px-2 py-1 font-mono text-[10px] font-bold ${
                  pairingPresence.status === 'connected' ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                <Link2 className="h-3 w-3 text-[#E10600]" />
                <span>{navSettings.pairing.roomCode}</span>
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSoundEnabled((s) => !s)}
              title={soundEnabled ? 'Desativar bipes e voz' : 'Ativar bipes e voz'}
              className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-zinc-700 bg-[#080B0D] text-[#C0C4C9] hover:text-white"
            >
              {soundEnabled ? (
                <Volume2 className="h-4 w-4 text-[#E10600]" />
              ) : (
                <VolumeX className="h-4 w-4" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setFunctionsOpen(true)}
              className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 text-[11px] font-semibold text-[#F4F4F4] hover:bg-zinc-800 whitespace-nowrap shrink-0 sm:text-xs"
            >
              <Settings2 className="h-3.5 w-3.5 text-[#C0C4C9]" />
              <span>Funções</span>
            </button>

            {!isRunning ? (
              <button
                type="button"
                onClick={handleStartNavigation}
                className="pitstop-btn-red inline-flex min-h-[34px] items-center gap-1.5 rounded-lg px-3.5 text-[11px] font-extrabold tracking-wide text-white uppercase whitespace-nowrap sm:text-xs"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                <span>Largada</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIsRunning(false)}
                className="pitstop-btn-metal inline-flex min-h-[34px] items-center gap-1.5 rounded-lg px-3.5 text-[11px] font-extrabold tracking-wide text-white uppercase whitespace-nowrap sm:text-xs"
              >
                <Pause className="h-3.5 w-3.5 text-[#E10600]" />
                <span>Pausar</span>
              </button>
            )}
          </div>
        </div>

        {!isRunning &&
          ((roadbook.raceParameters?.notesCount ?? 0) === 0 &&
            !roadbook.tulipas.some((t) =>
              Boolean((t.notes && t.notes.trim()) || t.notesImageDataUrl || t.imageIsComposite)
            ) ||
            roadbook.totalKm < 0.5) && (
          <div className="border-t border-amber-500/30 bg-amber-950/25 px-4 py-2 text-xs text-amber-200 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FileSearch className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                <span>
                  {(roadbook.raceParameters?.notesCount ?? 0) === 0 &&
                  !roadbook.tulipas.some((t) =>
                    Boolean((t.notes && t.notes.trim()) || t.notesImageDataUrl || t.imageIsComposite)
                  )
                    ? 'Nenhuma observação encontrada neste arquivo.'
                    : 'Distância total abaixo de 0,5 km.'}{' '}
                  Inspecione a estrutura do .NBP para mapear colunas/tags:
                </span>
              </div>
              <div className="flex items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-amber-500/40 bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-amber-300 hover:bg-slate-800">
                  <FileSearch className="h-3 w-3" />
                  <span>Inspecionar .NBP</span>
                  <input
                    type="file"
                    accept=".nbp,.zip,.txt,.csv,.xml,.gpx,.json,.db,.sqlite,.sqlite3,application/zip"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleInspectFileOnly(f);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
                {fileStructureReport && (
                  <button
                    type="button"
                    onClick={() => setShowStructureReport((v) => !v)}
                    className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-800"
                  >
                    {showStructureReport ? 'Ocultar' : 'Ver Estrutura'}
                  </button>
                )}
              </div>
            </div>
            {showStructureReport && fileStructureReport && (
              <div className="mt-2 rounded-lg border border-slate-800 bg-black p-3">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[10px] font-bold text-sky-400 uppercase">
                    Estrutura do Arquivo
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handleDownloadDiagnosticTxt}
                      className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] font-semibold text-sky-300 hover:bg-slate-800"
                    >
                      <Download className="h-3 w-3" />
                      <span>Baixar .TXT p/ Enviar</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCopyStructureReport}
                      className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] font-semibold text-slate-200 hover:bg-slate-800"
                    >
                      {copiedReport ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-400" />
                          <span>Copiado</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3 text-sky-400" />
                          <span>Copiar</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-slate-300">
                  {fileStructureReport}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Simulator Speed Control Bar */}
        {driveSource === 'simulator' && (
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-zinc-800 bg-[#080B0D] px-4 py-2 sm:px-5">
            <div className="flex flex-1 items-center gap-3 min-w-[220px]">
              <Gauge className="h-4 w-4 text-[#E10600] shrink-0" />
              <span className="text-xs font-medium text-[#C0C4C9] whitespace-nowrap">
                Simulador:
              </span>
              <input
                type="range"
                min={0}
                max={120}
                step={1}
                value={simSpeedKmh}
                onChange={(e) => setSimSpeedKmh(Number(e.target.value))}
                className="h-1.5 flex-1 cursor-pointer appearance-none rounded bg-zinc-700 accent-[#E10600]"
              />
              <span className="font-mono text-sm font-bold text-white tabular-nums w-20 text-right">
                {simSpeedKmh} km/h
              </span>
            </div>
            {currentTulipa?.type === 'V' && currentTulipa?.avgSpeedKmh ? (
              <button
                type="button"
                onClick={() => setSimSpeedKmh(Math.round(currentTulipa.avgSpeedKmh ?? 40))}
                className="rounded-lg border border-zinc-700 bg-[#1E1E22] px-3 py-1 text-xs font-medium text-[#F4F4F4] hover:bg-zinc-800 whitespace-nowrap"
              >
                Cravar na Média ({currentTulipa.avgSpeedKmh} km/h)
              </button>
            ) : null}
          </div>
        )}
      </section>

      {/* --- VELOCÍMETRO DIGITAL + VISOR DE PROVA TOTEM CLUSTER + CONTEXTO (APENAS NAVEGADOR) --- */}
      {scenario === 'navegador' && (
        <>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
            <div className="hidden lg:block lg:col-span-4">
              <DigitalSpeedometer
                speedKmh={currentSpeedKmh}
                targetSpeedKmh={
                  isNonTimedSection ? null : currentTulipa?.avgSpeedKmh
                }
                sectionType={currentTulipa?.type}
                tdnMs={currentTulipa?.tdnMs ?? currentTulipa?.sectionDurationMs}
              />
            </div>
            <section className="overflow-hidden rounded-xl border border-zinc-800 bg-[#080B0D] p-2 text-white sm:p-3.5 lg:col-span-8">
            {/* Row 1: HODÔMETRO (GPS) + TNAV + Barra Vertical de Regularidade */}
            <div className="grid grid-cols-12 gap-1.5 sm:gap-2">
              <div
                onMouseDown={startLongPress}
                onMouseUp={cancelLongPress}
                onMouseLeave={cancelLongPress}
                onTouchStart={startLongPress}
                onTouchEnd={cancelLongPress}
                className="col-span-6 min-w-0 overflow-hidden flex flex-col justify-between rounded-lg border border-zinc-800 bg-[#111214] px-2.5 py-1.5 select-none sm:col-span-7 sm:px-3 sm:py-2"
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span className="truncate text-[9px] font-bold tracking-wider text-[#C0C4C9] uppercase sm:text-xs">
                    Hodômetro ({navSettings.sensorMode === 'blue' ? 'Blue' : 'GPS'})
                  </span>
                  <span className="font-mono text-[9px] text-[#E10600] tabular-nums shrink-0 sm:text-[10px]">
                    {navSettings.sensorMode === 'blue'
                      ? `W${wValueFromCalibrationPct(calibrationPct, navSettings.wBaseValue)}`
                      : `${calibrationPct.toFixed(1)}%`}
                  </span>
                </div>
                <div
                  className={`mt-0.5 font-mono text-2xl font-extrabold leading-none tracking-tight tabular-nums sm:text-4xl lg:text-5xl ${
                    isRunning ? 'text-[#FF2A2A]' : 'text-[#C0C4C9]'
                  }`}
                >
                  {(() => {
                    const sectionResetBase = currentTulipa
                      ? currentTulipa.totalKm - (currentTulipa.displayKm ?? currentTulipa.totalKm)
                      : 0;
                    const displayOdo = Math.max(0, odometerKm - sectionResetBase);
                    return displayOdo.toFixed(3).replace('.', ',');
                  })()}
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[9px] text-zinc-400 sm:text-[10px]">
                  <span className="hidden sm:inline">Segure p/ Funções</span>
                  <span className="truncate font-mono text-[#C0C4C9]">
                    Parc {partialKm.toFixed(3).replace('.', ',')} · Acum {odometerKm.toFixed(2)}km
                  </span>
                </div>
              </div>

              <div className="col-span-6 min-w-0 overflow-hidden flex items-stretch gap-1.5 rounded-lg border border-zinc-800 bg-[#111214] px-2 py-1.5 sm:col-span-5 sm:gap-2 sm:px-2.5 sm:py-2">
                <div className="flex min-w-0 flex-1 flex-col justify-between">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[9px] font-bold tracking-wider text-[#C0C4C9] uppercase sm:text-xs">
                      TNAV
                    </span>
                    {deltaMeters !== null && (
                      <span className="font-mono text-[9px] text-zinc-400 tabular-nums shrink-0 sm:text-[10px]">
                        {deltaMeters > 0 ? '+' : ''}
                        {deltaMeters} m
                      </span>
                    )}
                  </div>
                  <div
                    className={`mt-0.5 font-mono text-2xl font-extrabold leading-none tracking-tight tabular-nums sm:text-4xl lg:text-5xl ${
                      isNonTimedSection
                        ? 'text-[#C0C4C9]'
                        : deltaSec === null
                          ? 'text-zinc-500'
                          : Math.abs(deltaSec) <= 0.5
                            ? 'text-emerald-400'
                            : deltaSec < 0
                              ? 'text-emerald-400'
                              : 'text-[#E10600]'
                    }`}
                  >
                    {isNonTimedSection ? 'n.e.' : formatTnavReadout(deltaSec)}
                  </div>
                  <div className={`mt-1 truncate text-[9px] font-bold tracking-wide uppercase sm:text-xs ${regTone.text}`}>
                    {isNonTimedSection
                      ? sectionRemainingMs !== null
                        ? sectionRemainingMs >= 0
                          ? `V em ${formatHmsDuration(sectionRemainingMs)}`
                          : `Exced +${formatHmsDuration(-sectionRemainingMs)}`
                        : currentTulipa?.type === 'D'
                          ? `Desl. ${formatHmsDuration(currentTulipa?.sectionDurationMs)}`
                          : `Neutro ${formatHmsDuration(currentTulipa?.sectionDurationMs)}`
                      : deltaSec === null
                        ? 'Aguardando'
                        : Math.abs(deltaSec) <= 0.5
                          ? 'No Tempo'
                          : deltaSec < 0
                            ? `Adiantado (${Math.abs(deltaSec).toFixed(0)}s)`
                            : `Atrasado (+${deltaSec.toFixed(0)}s)`}
                  </div>
                </div>

                <TnavVerticalBar deltaSec={deltaSec} disabled={isNonTimedSection} />
              </div>
            </div>

            {/* Row 2: REGR PROX REF + VEL + MEDIA + KM REGR */}
            <div className="mt-1.5 grid grid-cols-4 gap-1.5 sm:mt-2 sm:grid-cols-12 sm:gap-2">
              <div className="min-w-0 overflow-hidden flex flex-col justify-between rounded-lg border border-zinc-800 bg-[#111214] px-1.5 py-1.5 text-center sm:col-span-4 sm:px-2.5 sm:py-2">
                <span className="truncate text-[9px] font-bold tracking-tight text-[#C0C4C9] uppercase sm:text-[10px]">
                  <span className="sm:hidden">Regr Próx</span>
                  <span className="hidden sm:inline">Regr Próx Ref</span>
                </span>
                <div className="my-0.5 font-mono text-base font-extrabold leading-tight text-amber-300 tabular-nums sm:my-1 sm:text-3xl">
                  {distToNextKm.toFixed(3).replace('.', ',')}
                </div>
                <span className="truncate font-mono text-[9px] text-zinc-400 sm:text-[10px]">
                  Tul #{nextTulipa?.tulipa ?? currentTulipa?.tulipa ?? '-'}
                </span>
              </div>

              <div className="min-w-0 overflow-hidden flex flex-col justify-between rounded-lg border border-zinc-800 bg-[#111214] px-1.5 py-1.5 text-center sm:col-span-3 sm:px-2 sm:py-2">
                <span className="truncate text-[9px] font-bold tracking-tight text-[#C0C4C9] uppercase sm:text-[10px]">
                  Vel
                </span>
                <div className="my-0.5 font-mono text-lg font-extrabold leading-tight text-[#FF2A2A] tabular-nums sm:my-1 sm:text-3xl">
                  {currentSpeedKmh.toFixed(0)}
                </div>
                <span className="font-mono text-[9px] text-zinc-400 sm:text-[10px]">km/h</span>
              </div>

              <div className="min-w-0 overflow-hidden flex flex-col justify-between rounded-lg border border-zinc-800 bg-[#111214] px-1.5 py-1.5 text-center sm:col-span-3 sm:px-2 sm:py-2">
                <span className="truncate text-[9px] font-bold tracking-tight text-[#C0C4C9] uppercase sm:text-[10px]">
                  <span className="sm:hidden">Média</span>
                  <span className="hidden sm:inline">Média (Vel/TDN)</span>
                </span>
                <div className="my-0.5 font-mono text-lg font-extrabold leading-tight text-[#FF2A2A] tabular-nums sm:my-1 sm:text-3xl">
                  {currentTulipa
                    ? isNonTimedSection
                      ? currentTulipa.type
                      : currentTulipa.avgSpeedKmh !== null &&
                          currentTulipa.avgSpeedKmh !== undefined
                        ? Number.isInteger(currentTulipa.avgSpeedKmh)
                          ? String(currentTulipa.avgSpeedKmh)
                          : currentTulipa.avgSpeedKmh.toFixed(1).replace('.', ',')
                        : '--'
                    : '--'}
                </div>
                <span className="truncate font-mono text-[8.5px] text-zinc-400 sm:text-[10px]">
                  {currentTulipa?.type === 'D'
                    ? `D ${formatTdnOrTime(currentTulipa.tdnMs ?? currentTulipa.sectionDurationMs)}`
                    : currentTulipa?.type === 'N'
                      ? `N ${formatTdnOrTime(currentTulipa.tdnMs ?? currentTulipa.sectionDurationMs)}`
                      : 'km/h'}
                </span>
              </div>

              <button
                type="button"
                onClick={() => syncToTulipa(activeTulipaIdx)}
                title="Sincronizar / Zerar Hodômetro na Referência Atual"
                className="min-w-0 overflow-hidden flex flex-col items-center justify-center gap-0.5 rounded-lg border-2 border-amber-200 bg-amber-400 px-1 py-1.5 text-zinc-950 transition-colors hover:bg-amber-300 active:bg-amber-500 sm:col-span-2 sm:gap-1 sm:py-2"
              >
                <RefreshCw className="h-4 w-4 stroke-[2.5] sm:h-6 sm:w-6" />
                <span className="text-[8.5px] font-extrabold leading-tight tracking-tight uppercase sm:text-[10px]">
                  KM Regr
                </span>
              </button>
            </div>

            {/* Row 3: CRONO (PROVA / HORA DO DIA) + GPS Signal Bars */}
            <div className="mt-1.5 grid grid-cols-12 gap-1.5 sm:mt-2 sm:gap-2">
              <div className="col-span-7 min-w-0 overflow-hidden flex items-center justify-between gap-1.5 rounded-lg border border-zinc-800 bg-[#111214] px-2.5 py-1.5 sm:px-3 sm:py-2">
                <div className="min-w-0">
                  <span className="block truncate text-[8.5px] font-bold tracking-wider text-zinc-400 uppercase sm:text-[9px]">
                    {isRunning ? `Crono · Hora ${formatClockMs(officialNowMs, false)}` : 'Hora do Dia (Oficial)'}
                  </span>
                  <div className="truncate font-mono text-base font-extrabold leading-tight tracking-tight text-white tabular-nums sm:text-2xl">
                    {isRunning ? `R${formatElapsedMs(elapsedMs)}` : formatClockMs(officialNowMs, false)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setPartialBaseKm(odometerKm)}
                  className="shrink-0 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2 py-1 text-[9px] font-bold text-[#C0C4C9] hover:bg-zinc-800 hover:text-white sm:px-2.5 sm:py-1.5 sm:text-[10px]"
                >
                  Zerar
                </button>
              </div>

              <div className="col-span-5 min-w-0 overflow-hidden flex flex-col justify-between rounded-lg border border-zinc-800 bg-[#111214] px-2.5 py-1.5 sm:px-3 sm:py-2">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[9px] font-bold text-[#C0C4C9] uppercase sm:text-[10px]">
                    {driveSource === 'gps' ? 'GPS' : 'SIM'}
                  </span>
                  <div className="flex items-end gap-0.5 shrink-0" aria-hidden="true">
                    {[1, 2, 3, 4].map((bar) => (
                      <span
                        key={bar}
                        className={`w-1 rounded-xs sm:w-1.5 ${
                          driveSource === 'simulator'
                            ? 'bg-[#E10600]'
                            : gpsStatus.state === 'active'
                              ? 'bg-emerald-400'
                              : 'bg-zinc-700'
                        }`}
                        style={{ height: `${bar * 3.5 + 2}px` }}
                      />
                    ))}
                  </div>
                </div>
                <div className="truncate font-mono text-[10px] font-bold tabular-nums text-zinc-200 sm:text-xs">
                  {driveSource === 'simulator'
                    ? `${simSpeedKmh} km/h`
                    : gpsStatus.state === 'active'
                      ? `Ativo ±${gpsStatus.accuracyM ?? '--'}m`
                      : gpsStatus.state === 'waiting'
                        ? 'Buscando...'
                        : 'Sem sinal'}
                </div>
              </div>
            </div>

            {/* Thin Visual Regularity Scale */}
            <div className="mt-2 border-t border-zinc-800 pt-2">
              <div className="relative h-2 w-full overflow-hidden rounded-full border border-zinc-800 bg-[#111214] sm:h-2.5">
                <div className="absolute left-1/2 top-0 bottom-0 z-10 w-0.5 -translate-x-1/2 bg-[#C0C4C9]" />
                <div
                  className={`absolute top-0.5 bottom-0.5 w-3 -translate-x-1/2 rounded-full transition-all duration-150 ${regTone.bg}`}
                  style={{ left: `${gaugePercent}%` }}
                />
              </div>
            </div>
          </section>
          </div>

          {/* --- PAINEL DE CONTEXTO COMPLETO DO TRECHO (D / N / V + PRÓXIMA TRANSIÇÃO) --- */}
          {currentTulipa && blockTelemetry && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#10141d] px-3.5 py-2 text-xs text-slate-200">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span
                  className={`font-mono font-extrabold uppercase ${
                    currentTulipa.type === 'D'
                      ? 'text-sky-400'
                      : currentTulipa.type === 'N'
                        ? 'text-amber-400'
                        : 'text-sky-400'
                  }`}
                >
                  {currentTulipa.section !== null ? `T${currentTulipa.section} · ` : ''}
                  {currentTulipa.type === 'D'
                    ? `Deslocamento (${formatHmsDuration(currentTulipa.sectionDurationMs)})`
                    : currentTulipa.type === 'N'
                      ? `Neutralização (${formatHmsDuration(currentTulipa.sectionDurationMs)})`
                      : `Velocidade Média (${currentTulipa.avgSpeedKmh?.toFixed(1) ?? '--'} km/h)`}
                </span>

                {isNonTimedSection ? (
                  <span className="font-mono text-slate-300 tabular-nums">
                    Falta p/ saída:{' '}
                    <strong className="text-white">
                      {blockTelemetry.distToBlockEndKm < 1
                        ? `${Math.round(blockTelemetry.distToBlockEndKm * 1000)} m`
                        : `${blockTelemetry.distToBlockEndKm.toFixed(2)} km`}
                    </strong>
                    {currentTulipa.sectionEndTimeMs != null && (
                      <>
                        {' '}
                        · Início {blockTelemetry.nextBlockStartTulipa?.type || 'V'} às{' '}
                        <strong className="text-sky-300">
                          {blockTelemetry.nextBlockStartTulipa?.idealTimeStr?.slice(0, 8) ||
                            formatHmsDuration(currentTulipa.sectionEndTimeMs)}
                        </strong>
                      </>
                    )}
                  </span>
                ) : (
                  blockTelemetry.nextChangeTulipa &&
                  blockTelemetry.distToNextChangeKm !== null && (
                    <span className="font-mono text-slate-300 tabular-nums">
                      Próx.{' '}
                      <strong className="text-amber-300">
                        {blockTelemetry.nextChangeTulipa.type === 'D'
                          ? `D ${formatHmsDuration(blockTelemetry.nextChangeTulipa.sectionDurationMs)}`
                          : blockTelemetry.nextChangeTulipa.type === 'N'
                            ? `N ${formatHmsDuration(blockTelemetry.nextChangeTulipa.sectionDurationMs)}`
                            : `${blockTelemetry.nextChangeTulipa.avgSpeedKmh?.toFixed(0) ?? '--'} km/h`}
                      </strong>{' '}
                      em{' '}
                      <strong className="text-white">
                        {blockTelemetry.distToNextChangeKm < 1
                          ? `${Math.round(blockTelemetry.distToNextChangeKm * 1000)} m`
                          : `${blockTelemetry.distToNextChangeKm.toFixed(2)} km`}
                      </strong>{' '}
                      (Tul #{blockTelemetry.nextChangeTulipa.tulipa})
                    </span>
                  )
                )}
              </div>

              <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                Ref {activeTulipaIdx + 1}/{roadbook.tulipas.length} · Antecipação {transitionAdvanceM}m
              </span>
            </div>
          )}
        </>
      )}

      {/* --- SCENARIO: PILOTO (TELA LIMPA SEM CABEÇALHO DO NAVEGADOR + VEL/MÉDIA/TNAV GRANDES + BARRA DE CORES) --- */}
      {scenario === 'piloto' && (pairedTelemetry && navSettings.pairing.enabled && navSettings.pairing.role === 'pilot' || currentTulipa) && (() => {
        const pUseLiveSync = Boolean(
          pairedTelemetry && navSettings.pairing.enabled && navSettings.pairing.role === 'pilot'
        );
        const targetRef = nextTulipa ?? currentTulipa;
        return renderPilotDashboard({
          tulNum: pUseLiveSync ? pairedTelemetry!.tulipaNum : targetRef?.tulipa ?? '-',
          distKm: pUseLiveSync ? pairedTelemetry!.distToNextKm : distToNextKm,
          odoKm: pUseLiveSync ? pairedTelemetry!.odometerKm : odometerKm,
          speed: pUseLiveSync ? pairedTelemetry!.speedKmh : currentSpeedKmh,
          targetSpeed: pUseLiveSync
            ? pairedTelemetry!.targetSpeedKmh
            : isNonTimedSection
              ? null
              : currentTulipa?.avgSpeedKmh ?? null,
          pDeltaSec: pUseLiveSync ? pairedTelemetry!.deltaSec : isNonTimedSection ? null : deltaSec,
          pDeltaMeters: pUseLiveSync ? (pairedTelemetry!.deltaMeters ?? null) : isNonTimedSection ? null : deltaMeters,
          pClockStr: pUseLiveSync
            ? pairedTelemetry!.clockTimeStr || formatClockMs(officialNowMs, false)
            : formatClockMs(officialNowMs, false),
          pCap: pUseLiveSync ? pairedTelemetry!.cap : targetRef?.cap ?? null,
          pType: pUseLiveSync ? pairedTelemetry!.type : targetRef?.type ?? '',
          pSection: pUseLiveSync ? pairedTelemetry!.section : targetRef?.section ?? null,
          pSectionRemMs: pUseLiveSync ? pairedTelemetry!.sectionRemainingMs : sectionRemainingMs,
          pNotes: pUseLiveSync ? pairedTelemetry!.notes : targetRef?.notes,
          pImage: pUseLiveSync ? pairedTelemetry!.imageDataUrl : targetRef?.imageDataUrl,
          pNotesImg: pUseLiveSync ? pairedTelemetry!.notesImageDataUrl : targetRef?.notesImageDataUrl,
          pIsComposite: pUseLiveSync ? pairedTelemetry!.imageIsComposite : targetRef?.imageIsComposite,
          pairedHeader: pUseLiveSync
            ? {
                roomCode: navSettings.pairing.roomCode,
                connected: pairingPresence.navigators > 0,
              }
            : null,
        });
      })()}

      {/* --- SCENARIO: NAVEGADOR (ESPELHO PLANILHA DIGITAL ROLANTE) --- */}
      {scenario === 'navegador' && (
        <div className="space-y-2.5 sm:space-y-3">
          {/* Sub-bar Controls */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-[#111214] px-3 py-2 text-[#F4F4F4] sm:px-3.5">
            <div className="flex items-center gap-2">
              <Compass className="h-4 w-4 text-[#E10600]" />
              <span className="text-xs font-bold text-white">
                Planilha Digital ({activeTulipaIdx + 1}/{roadbook.tulipas.length})
              </span>
              {hasPmmChangeSoon && nextTulipa && (
                <span className="font-mono text-xs font-bold text-amber-400">
                  · Próx:{' '}
                  {nextTulipa.type === 'N'
                    ? 'NEUTRO'
                    : nextTulipa.type === 'D'
                      ? 'DESLOC.'
                      : `${nextTulipa.avgSpeedKmh ?? nextTulipa.type} km/h`}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-[#C0C4C9] mr-1">
                <input
                  type="checkbox"
                  checked={autoAdvance}
                  onChange={(e) => setAutoAdvance(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-600 accent-[#E10600]"
                />
                <span>Troca auto ({transitionAdvanceM}m)</span>
              </label>

              {activeTulipaIdx > 0 && (
                <button
                  type="button"
                  onClick={() => setShowPassedRows((v) => !v)}
                  className={`inline-flex min-h-[34px] items-center rounded-lg border px-2.5 text-xs font-semibold ${
                    showPassedRows
                      ? 'border-[#E10600] bg-[#E10600]/20 text-white'
                      : 'border-zinc-700 bg-[#080B0D] text-[#C0C4C9] hover:text-white'
                  }`}
                >
                  {showPassedRows ? 'Ocultar anteriores' : `Anteriores (${activeTulipaIdx})`}
                </button>
              )}

              <button
                type="button"
                disabled={activeTulipaIdx === 0}
                onClick={() => setActiveTulipaIdx((i) => Math.max(0, i - 1))}
                className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 text-xs font-semibold text-[#F4F4F4] hover:bg-zinc-800 disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                <span>Anterior</span>
              </button>
              <button
                type="button"
                disabled={activeTulipaIdx >= roadbook.tulipas.length - 1}
                onClick={() =>
                  setActiveTulipaIdx((i) =>
                    Math.min(roadbook.tulipas.length - 1, i + 1)
                  )
                }
                className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 text-xs font-semibold text-[#F4F4F4] hover:bg-zinc-800 disabled:opacity-40"
              >
                <span>Próxima</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* PLANILHA DIGITAL ESPELHO: Desenho | Tul | Distância | Vel/TDN | Tempo | Observação */}
          <div className="overflow-hidden rounded-xl border-2 border-slate-900 bg-white text-slate-950 shadow-lg">
            {/* Table Column Header (explicit tracks prevent mobile cell overlap) */}
            <div className="grid grid-cols-[48px_28px_62px_40px_48px_minmax(0,1fr)] sm:grid-cols-[68px_44px_100px_76px_88px_minmax(0,1fr)] md:grid-cols-[84px_52px_118px_88px_104px_minmax(0,1fr)] border-b-2 border-slate-900 bg-slate-200 text-center text-[9px] font-bold text-slate-800 sm:text-xs">
              <div className="min-w-0 overflow-hidden truncate border-r border-slate-400 py-1.5 px-0.5 sm:px-1">
                <span className="sm:hidden">Des.</span>
                <span className="hidden sm:inline">Desenho</span>
              </div>
              <div className="min-w-0 overflow-hidden truncate border-r border-slate-400 py-1.5 px-0.5">Tul</div>
              <div className="min-w-0 overflow-hidden truncate border-r border-slate-400 py-1.5 px-0.5 sm:px-1">Distância</div>
              <div className="min-w-0 overflow-hidden truncate border-r border-slate-400 py-1.5 px-0.5 sm:px-1">Vel/TDN</div>
              <div className="min-w-0 overflow-hidden truncate border-r border-slate-400 py-1.5 px-0.5 sm:px-1">Tempo</div>
              <div className="min-w-0 overflow-hidden truncate py-1.5 px-1">Observação</div>
            </div>

            {/* Scrolling Rows */}
            <div className="max-h-[46vh] sm:max-h-[540px] divide-y-2 divide-slate-800 overflow-y-auto">
              {planilhaRows.length === 0 ? (
                <div className="p-6 text-center text-xs font-medium text-slate-500">
                  Fim da planilha atingido. Use &quot;Anterior&quot; ou &quot;Funções &gt; Ir para Referência&quot; para reposicionar.
                </div>
              ) : (
                planilhaRows.map((t, offset) => {
                  const realIdx = planilhaStartIdx + offset;
                  const isActive = realIdx === activeTulipaIdx;
                  const isNextUpcoming = realIdx === activeTulipaIdx + 1;
                  const isPassed = realIdx < activeTulipaIdx;
                  const compactPassed = isPassed && navSettings.reducePassedRow;
                  const hazard = hasHazardKeyword(t.notes);
                  const markup = markingsMap.get(t.tulipa);
                  const shownKm = t.displayKm ?? t.totalKm;
                  const diffKm = t.interKm;

                  // Remaining distance & regressive slim green bar percentage
                  const barTargetTulipa =
                    t.totalKm > odometerKm
                      ? t
                      : isActive && nextTulipa && nextTulipa.totalKm > odometerKm
                        ? nextTulipa
                        : null;
                  const showCountdownBar =
                    Boolean(barTargetTulipa) && (isActive || isNextUpcoming);
                  let barRemainingKm = 0;
                  let barPercentLeft = 0;
                  if (showCountdownBar && barTargetTulipa) {
                    barRemainingKm = Math.max(0, barTargetTulipa.totalKm - odometerKm);
                    const targetIdx = barTargetTulipa === t ? realIdx : activeTulipaIdx + 1;
                    const prevTulKm = roadbook.tulipas[targetIdx - 1]?.totalKm ?? 0;
                    const segmentSpanKm =
                      barTargetTulipa.interKm > 0.001
                        ? barTargetTulipa.interKm
                        : Math.max(0.01, barTargetTulipa.totalKm - prevTulKm);
                    barPercentLeft = Math.max(
                      0,
                      Math.min(100, (barRemainingKm / segmentSpanKm) * 100)
                    );
                  }
                  const idealFormatted =
                    t.idealTimeMs !== null
                      ? formatTdnOrTime(t.idealTimeMs)
                      : t.idealTimeStr
                        ? t.idealTimeStr.replace(/:/g, '.').slice(0, 8)
                        : '00.00.00';

                  const { primary: velPrimary, secondary: velSecondary } = formatVelTdnBadge(t);

                  const rowDelta = isActive && !isNonTimedSection
                    ? deltaSec ?? activeTulipaDeltaSec
                    : null;
                  const cellBorderClass = isActive
                    ? 'border-slate-900/40'
                    : 'border-slate-300';

                  const activeBgClass =
                    navSettings.highlightTheme === 'blue'
                      ? 'bg-sky-300 text-slate-950 ring-2 ring-inset ring-slate-950'
                      : navSettings.highlightTheme === 'green'
                        ? 'bg-emerald-300 text-slate-950 ring-2 ring-inset ring-slate-950'
                        : 'bg-[#fde047] text-slate-950 ring-2 ring-inset ring-slate-950';

                  const activeCellBgClass =
                    navSettings.highlightTheme === 'blue'
                      ? 'bg-sky-300'
                      : navSettings.highlightTheme === 'green'
                        ? 'bg-emerald-300'
                        : 'bg-[#fde047]';

                  const activePillBgClass =
                    navSettings.highlightTheme === 'blue'
                      ? 'bg-sky-200/90 text-slate-950 border border-slate-900/20'
                      : navSettings.highlightTheme === 'green'
                        ? 'bg-emerald-200/90 text-slate-950 border border-slate-900/20'
                        : 'bg-amber-300/90 text-slate-950 border border-slate-900/20';

                  return (
                    <div
                      key={`${t.tulipa}-${realIdx}`}
                      onPointerDown={(e) => startRowLongPress(realIdx, e)}
                      onPointerMove={moveRowLongPress}
                      onPointerUp={cancelRowLongPress}
                      onPointerCancel={cancelRowLongPress}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        cancelRowLongPress();
                        setContextMenuIdx(realIdx);
                      }}
                      onClick={() => {
                        if (rowLongPressTriggeredRef.current) {
                          rowLongPressTriggeredRef.current = false;
                          return;
                        }
                        syncToTulipa(realIdx);
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          syncToTulipa(realIdx);
                        }
                      }}
                      className={`grid cursor-pointer select-none grid-cols-[48px_28px_62px_40px_48px_minmax(0,1fr)] sm:grid-cols-[68px_44px_100px_76px_88px_minmax(0,1fr)] md:grid-cols-[84px_52px_118px_88px_104px_minmax(0,1fr)] items-stretch transition-colors ${
                        isActive
                          ? activeBgClass
                          : isPassed
                            ? `bg-sky-100/95 text-slate-900 hover:bg-sky-100 ${compactPassed ? 'opacity-85' : ''}`
                            : 'bg-white text-slate-950 hover:bg-sky-50/70'
                      }`}
                    >
                      {/* Col 1: Desenho */}
                      <div
                        className={`min-w-0 overflow-hidden flex items-center justify-center border-r ${
                          compactPassed ? 'p-0.5' : 'p-0.5 sm:p-1.5'
                        } ${cellBorderClass} ${
                          isActive
                            ? activeCellBgClass
                            : isPassed
                              ? 'bg-sky-100/95'
                              : 'bg-white'
                        }`}
                      >
                        <TulipVectorIcon
                          cap={t.cap}
                          imageDataUrl={t.imageDataUrl}
                          imageIsComposite={t.imageIsComposite}
                          active={isActive}
                          passed={isPassed}
                          compact={compactPassed}
                          highlightTheme={navSettings.highlightTheme}
                        />
                      </div>

                      {/* Col 2: Tul */}
                      <div
                        className={`min-w-0 overflow-hidden flex flex-col items-center justify-center border-r px-0.5 font-mono font-black text-slate-950 tabular-nums sm:px-1 ${
                          compactPassed
                            ? 'py-0.5 text-[10px] sm:py-1 sm:text-xs'
                            : 'py-1 text-[11px] sm:py-2 sm:text-sm md:text-base'
                        } ${cellBorderClass}`}
                      >
                        <span className="leading-none">{t.tulipa}</span>
                        {isPassed && navSettings.showPassedTick && (
                          <span
                            className="mt-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-600 text-[9px] font-black text-white sm:h-4 sm:w-4 sm:text-[10px]"
                            title="Referência passada"
                          >
                            ✓
                          </span>
                        )}
                        {isActive && (
                          <span className="hidden sm:inline-block mt-0.5 rounded-xs bg-slate-950 px-1 py-0.5 text-[8px] font-black tracking-wide uppercase text-sky-300">
                            VEZ
                          </span>
                        )}
                      </div>

                      {/* Col 3: Distância (Big KM + Diff below + T# | Des/Vel/Neu) */}
                      <div
                        className={`min-w-0 overflow-hidden flex flex-col items-center justify-center border-r px-0.5 text-center font-mono tabular-nums sm:px-1 ${
                          compactPassed ? 'py-0.5' : 'py-1 sm:py-1.5'
                        } ${cellBorderClass}`}
                      >
                        <span
                          className={`max-w-full truncate font-black leading-none tracking-tighter text-slate-950 ${
                            compactPassed ? 'text-[10.5px] sm:text-sm' : 'text-[12px] sm:text-base md:text-lg'
                          }`}
                        >
                          {formatKm3(shownKm)}
                        </span>
                        <div
                          className={`mt-0.5 w-full truncate px-0.5 py-0.5 text-[8.5px] font-bold leading-tight tracking-tighter sm:px-1 sm:text-[11px] ${
                            t.resetsOdometer
                              ? 'rounded-xs bg-lime-400 font-extrabold text-slate-950'
                              : isActive
                                ? 'text-slate-950'
                                : 'text-slate-700'
                          }`}
                        >
                          {t.resetsOdometer ? `${formatKm3(diffKm)} | 0,00` : formatKm3(diffKm)}
                        </div>
                        {!compactPassed && (
                          <div
                            className={`mt-0.5 w-full truncate rounded-xs px-0.5 py-0.5 text-[8.5px] font-bold leading-tight sm:px-1 sm:text-[10px] ${
                              isActive
                                ? activePillBgClass
                                : 'bg-slate-200/80 text-slate-700'
                            }`}
                          >
                            {t.section !== null ? `T${t.section}` : 'T-'} | {typeShortLabel(t.type)}
                          </div>
                        )}
                      </div>

                      {/* Col 4: Vel/TDN */}
                      <div
                        className={`min-w-0 overflow-hidden flex flex-col items-center justify-center border-r px-0.5 text-center font-mono tabular-nums sm:px-1 ${
                          compactPassed ? 'py-0.5' : 'py-1 sm:py-2'
                        } ${cellBorderClass}`}
                      >
                        <span
                          className={`max-w-full truncate leading-none ${
                            t.type === 'V'
                              ? compactPassed
                                ? 'text-[10.5px] font-black text-slate-950 sm:text-sm'
                                : 'text-[12px] font-black text-slate-950 sm:text-base md:text-lg'
                              : 'text-[9px] font-extrabold tracking-tighter text-slate-950 sm:text-sm md:text-base'
                          }`}
                        >
                          {velPrimary}
                        </span>
                        {velSecondary ? (
                          <span className={`mt-0.5 max-w-full truncate text-[8px] font-bold leading-none sm:text-[9px] ${isActive ? 'text-slate-900' : 'text-slate-600'}`}>
                            {velSecondary}
                          </span>
                        ) : null}
                      </div>

                      {/* Col 5: Tempo */}
                      <div
                        className={`min-w-0 overflow-hidden flex flex-col items-center justify-center border-r px-0.5 text-center font-mono tabular-nums sm:px-1 ${
                          compactPassed ? 'py-0.5' : 'py-1 sm:py-1.5'
                        } ${cellBorderClass}`}
                      >
                        <span className="max-w-full truncate text-[9.5px] font-extrabold tracking-tighter text-slate-950 sm:text-xs md:text-sm">
                          {idealFormatted}
                        </span>
                        {isActive && isNonTimedSection && sectionRemainingMs !== null && (
                          <span className="mt-0.5 max-w-full truncate rounded-xs bg-sky-700 px-1 py-0.5 text-[8px] font-extrabold leading-none text-white sm:mt-1 sm:px-1.5 sm:text-[10px]">
                            {sectionRemainingMs >= 0
                              ? `${typeShortLabel(t.type)} ${formatHmsDuration(sectionRemainingMs)}`
                              : `+${formatHmsDuration(-sectionRemainingMs)}`}
                          </span>
                        )}
                        {isActive && !isNonTimedSection && rowDelta !== null && (
                          <span
                            className={`mt-0.5 max-w-full truncate rounded-xs px-1 py-0.5 text-[8px] font-extrabold leading-none uppercase sm:mt-1 sm:px-1.5 sm:text-[10px] ${
                              Math.abs(rowDelta) <= 0.5
                                ? 'bg-emerald-500 text-white'
                                : rowDelta < 0
                                  ? 'bg-emerald-600 text-white'
                                  : 'bg-red-600 text-white'
                            }`}
                          >
                            {Math.abs(rowDelta) <= 0.5
                              ? 'OK'
                              : rowDelta < 0
                                ? `Ad ${Math.abs(rowDelta).toFixed(0)}s`
                                : `At +${rowDelta.toFixed(0)}s`}
                          </span>
                        )}
                      </div>

                      {/* Col 6: Observação (Full readable text height with horizontal whitespace cropped cleanly) */}
                      <div
                        className={`min-w-0 overflow-hidden flex flex-col items-stretch justify-center gap-0.5 px-1 text-left sm:items-center sm:px-1.5 sm:text-center ${
                          compactPassed ? 'py-1' : 'py-1.5 sm:py-2'
                        }`}
                      >
                        {(() => {
                          const obsGraphic =
                            t.notesImageDataUrl ||
                            (!t.notes && t.imageIsComposite ? t.imageDataUrl : undefined);
                          return (
                            <>
                              {obsGraphic && (
                                <div className="w-full flex items-center justify-start sm:justify-center overflow-hidden">
                                  <CroppedObsImage
                                    src={obsGraphic}
                                    alt={`Observação tulipa ${t.tulipa}`}
                                    className={`${
                                      compactPassed ? 'h-9 sm:h-11' : 'h-12 sm:h-14 md:h-16'
                                    } w-auto max-w-full object-contain object-left sm:object-center`}
                                  />
                                </div>
                              )}
                              {(t.notes || !obsGraphic) && (
                                <div className="flex w-full items-start gap-1 sm:justify-center">
                                  <p
                                    className={`w-full font-extrabold leading-snug text-slate-950 whitespace-pre-line break-words uppercase ${
                                      compactPassed ? 'text-[9.5px] sm:text-[11px]' : 'text-[11px] sm:text-xs md:text-[13px]'
                                    }`}
                                  >
                                    {t.notes ||
                                      (t.type === 'D'
                                        ? `Deslocamento ${
                                            t.tdnMs && t.tdnMs > 0 ? formatTdnOrTime(t.tdnMs) : ''
                                          }`.trim()
                                        : t.type === 'N'
                                          ? `Neutralização ${
                                              t.tdnMs && t.tdnMs > 0 ? formatTdnOrTime(t.tdnMs) : ''
                                            }`.trim()
                                          : t.cap !== null
                                            ? `CAP ${t.cap}°`
                                            : `Ref. #${t.tulipa}`)}
                                  </p>
                                  {hazard && (
                                    <AlertTriangle
                                      className="mt-0.5 h-3 w-3 text-red-600 shrink-0 sm:h-3.5 sm:w-3.5"
                                      aria-label="Atenção na referência"
                                    />
                                  )}
                                </div>
                              )}
                            </>
                          );
                        })()}

                        {markup && (
                          <div className="flex w-full flex-wrap items-center gap-1 sm:justify-center">
                            {markup.drawingDataUrl && (
                              <span className="inline-flex items-center gap-0.5 rounded bg-red-600 px-1.5 py-0.5 text-[8px] font-extrabold text-white uppercase sm:text-[9px]">
                                <PenTool className="h-2.5 w-2.5" />
                                <span>Marcado</span>
                              </span>
                            )}
                            {markup.noteText && (
                              <span className="max-w-full truncate rounded bg-slate-900 px-1.5 py-0.5 text-[8px] font-bold text-amber-300 uppercase sm:text-[9px]">
                                {markup.noteText}
                              </span>
                            )}
                            {markup.audioDataUrl && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  try {
                                    const audio = new Audio(markup.audioDataUrl);
                                    audio.play().catch(() => {});
                                  } catch {
                                    // Ignore playback restriction
                                  }
                                }}
                                className="inline-flex items-center gap-0.5 rounded bg-sky-600 px-1.5 py-0.5 text-[8px] font-extrabold text-white hover:bg-sky-500 sm:text-[9px]"
                              >
                                <Mic className="h-2.5 w-2.5" />
                                <span>Ouvir {markup.audioDurationSec ? `${markup.audioDurationSec}s` : 'Áudio'}</span>
                              </button>
                            )}
                          </div>
                        )}

                        {showCountdownBar && barTargetTulipa && (
                          <div className="mt-1 w-full">
                            <div className="mb-0.5 flex items-center justify-between gap-1 font-mono text-[8.5px] font-extrabold leading-none text-emerald-950 tabular-nums sm:text-[10px]">
                              <span className="truncate">
                                {barTargetTulipa === t
                                  ? 'Falta ref.'
                                  : `Próx #${barTargetTulipa.tulipa}`}
                              </span>
                              <span className="shrink-0">
                                {barRemainingKm < 1
                                  ? `${Math.round(barRemainingKm * 1000)} m`
                                  : `${barRemainingKm.toFixed(2).replace('.', ',')} km`}
                              </span>
                            </div>
                            <div
                              className="h-1 w-full overflow-hidden rounded-xs border border-emerald-800 bg-white sm:h-1.5"
                              aria-label={`Distância restante ${Math.round(barRemainingKm * 1000)} metros`}
                            >
                              <div
                                className="h-full bg-emerald-500 transition-all duration-150"
                                style={{ width: `${barPercentLeft}%` }}
                              />
                            </div>
                          </div>
                        )}

                        {isActive && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              syncToTulipa(realIdx);
                            }}
                            className="mt-0.5 rounded bg-slate-950 px-1.5 py-0.5 font-mono text-[8px] font-extrabold tracking-wide text-sky-300 hover:bg-slate-800 sm:mt-1 sm:px-2 sm:text-[9px]"
                          >
                            AQUI / SINC.
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Bottom Manual Odometer Dock: F | - | Hodômetro & Passo | + | OK/Lap */}
          <div className="grid grid-cols-[54px_56px_minmax(0,1fr)_56px_64px] items-stretch gap-1 rounded-xl border border-zinc-800 bg-[#080B0D] p-1 shadow-lg sm:grid-cols-[72px_72px_minmax(0,1fr)_72px_84px] sm:gap-1.5 sm:p-1.5">
            <button
              type="button"
              onClick={() => setFunctionsOpen(true)}
              title="Abrir Funções do Navegador"
              className="flex min-h-[44px] flex-col items-center justify-center rounded-lg border border-zinc-700 bg-[#111214] px-1 text-[#E10600] transition-colors hover:bg-zinc-800 active:bg-zinc-700"
            >
              <span className="text-[8px] font-bold tracking-wider text-[#C0C4C9] uppercase sm:text-[9px]">
                Função
              </span>
              <span className="font-mono text-lg font-black leading-none sm:text-xl">F</span>
            </button>

            <button
              type="button"
              onClick={() => adjustOdometer(-manualStepKm)}
              title={`Diminuir hodômetro manualmente em ${Math.round(manualStepKm * 1000)}m`}
              aria-label={`Diminuir hodômetro em ${Math.round(manualStepKm * 1000)} metros`}
              className="flex min-h-[44px] items-center justify-center rounded-lg border border-zinc-700 bg-[#111214] font-mono text-2xl font-black text-[#C0C4C9] transition-colors hover:bg-zinc-800 hover:text-white active:bg-zinc-700 sm:text-3xl"
            >
              −
            </button>

            <button
              type="button"
              onClick={() =>
                setManualStepKm((s) => (s === 0.01 ? 0.05 : s === 0.05 ? 0.1 : 0.01))
              }
              title="Toque para alternar o incremento manual (±10m, ±50m, ±100m)"
              className="min-w-0 flex min-h-[44px] flex-col items-center justify-center rounded-lg border border-zinc-700 bg-[#1E1E22] px-2 text-center text-white transition-colors hover:border-zinc-500"
            >
              <span className="truncate font-mono text-sm font-black leading-tight tabular-nums text-white sm:text-lg">
                {(() => {
                  const sectionResetBase = currentTulipa
                    ? currentTulipa.totalKm - (currentTulipa.displayKm ?? currentTulipa.totalKm)
                    : 0;
                  const displayOdo = Math.max(0, odometerKm - sectionResetBase);
                  return `${displayOdo.toFixed(3).replace('.', ',')} km`;
                })()}
              </span>
              <span className="font-mono text-[9px] font-bold text-[#C0C4C9] uppercase sm:text-[10px]">
                Passo ±{Math.round(manualStepKm * 1000)}m
              </span>
            </button>

            <button
              type="button"
              onClick={() => adjustOdometer(manualStepKm)}
              title={`Aumentar hodômetro manualmente em ${Math.round(manualStepKm * 1000)}m`}
              aria-label={`Aumentar hodômetro em ${Math.round(manualStepKm * 1000)} metros`}
              className="flex min-h-[44px] items-center justify-center rounded-lg border border-zinc-700 bg-[#111214] font-mono text-2xl font-black text-[#C0C4C9] transition-colors hover:bg-zinc-800 hover:text-white active:bg-zinc-700 sm:text-3xl"
            >
              +
            </button>

            <button
              type="button"
              onClick={() => syncToTulipa(activeTulipaIdx)}
              title="Sincronizar hodômetro com a tulipa atual (OK / Lap)"
              className="pitstop-btn-red flex min-h-[44px] flex-col items-center justify-center rounded-lg px-1 text-white transition-colors active:scale-[0.98]"
            >
              <span className="font-mono text-base font-black leading-none sm:text-lg">OK</span>
              <span className="text-[8px] font-extrabold tracking-wide uppercase sm:text-[9px]">
                Lap
              </span>
            </button>
          </div>
        </div>
      )}

      {/* --- FUNÇÕES DO NAVEGADOR (PITSTOP SPORTS) --- */}
      {functionsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-xs sm:p-4">
          <div className="w-full max-w-xl max-h-[92vh] overflow-y-auto rounded-xl border border-zinc-800 bg-[#111214] text-[#F4F4F4] shadow-2xl">
            <div className="p-4 sm:p-6">
              <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="h-5 w-5 text-[#E10600]" />
                  <h3 className="font-['Barlow_Condensed'] text-2xl font-bold italic text-white uppercase">
                    Funções do Navegador
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setFunctionsOpen(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-[#B5B5B5] hover:bg-zinc-800 hover:text-white"
                  aria-label="Fechar funções"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Dados da Prova (Movidos do cabeçalho para cá) */}
              <div className="mt-4 rounded-xl border border-zinc-800 bg-[#080B0D] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`font-mono text-[10px] font-extrabold tracking-widest uppercase ${
                        isRunning ? 'text-[#FF2A2A]' : 'text-[#C0C4C9]'
                      }`}
                    >
                      {isRunning ? 'EM PROVA' : 'PRONTO'}
                    </span>
                    <span className="truncate font-['Barlow_Condensed'] text-lg font-bold text-white">
                      {roadbook.eventName}
                    </span>
                  </div>
                  <span className="font-mono text-xs font-bold text-[#C0C4C9] tabular-nums">
                    Hora: {formatClockMs(officialNowMs, false)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[11px] text-zinc-400">
                  <span>
                    {driveSource === 'gps' ? 'GPS Real' : 'Simulador'} · Largada{' '}
                    <strong className="text-[#F4F4F4]">{startTimeStr}</strong>
                  </span>
                  <span>
                    · {roadbook.sourceFormat || 'NBP'} ({roadbook.tulipas.length} refs ·{' '}
                    {roadbook.totalKm.toFixed(1)} km ·{' '}
                    {roadbook.raceParameters?.sectionsCount ?? '-'} seç.)
                  </span>
                  {driveSource === 'gps' && gpsStatus.state === 'active' && (
                    <span className="text-emerald-400">· ±{gpsStatus.accuracyM ?? '--'}m</span>
                  )}
                </div>
              </div>

              <div className="mt-4 space-y-5 text-sm">
                {/* 1. Hora de Largada & Sincronização Hora do Dia */}
                <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-3.5">
                  <label className="block text-xs font-semibold text-[#C0C4C9]">
                    Hora Oficial de Largada &amp; Hora do Dia (GPS)
                  </label>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    <input
                      type="time"
                      step="1"
                      value={startTimeStr}
                      onChange={(e) => setStartTimeStr(e.target.value)}
                      className="flex-1 min-w-[140px] min-h-[40px] rounded-xl border border-zinc-700 bg-[#1E1E22] px-3 font-mono text-sm font-semibold text-white focus:border-[#E10600] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const now = getLocalNowTime();
                        const d = getLocalTodayDate();
                        setRaceDate(d);
                        setStartTimeStr(now);
                        setStartTimestampMs(parseRaceStartTimestampMs(d, now));
                      }}
                      className="min-h-[40px] rounded-xl border border-zinc-700 bg-[#1E1E22] px-3 text-xs font-semibold text-[#F4F4F4] hover:bg-zinc-800"
                    >
                      <Clock className="inline h-3.5 w-3.5 mr-1 text-[#C0C4C9]" />
                      Agora
                    </button>
                    <button
                      type="button"
                      onClick={handleSyncGpsClock}
                      className="min-h-[40px] rounded-xl border border-[#E10600]/40 bg-[#E10600]/15 px-3 text-xs font-semibold text-red-300 hover:bg-[#E10600]/25"
                    >
                      <Satellite className="inline h-3.5 w-3.5 mr-1" />
                      Sinc. Hora GPS
                    </button>
                  </div>
                  {clockSyncMsg && (
                    <p className="mt-1.5 text-[11px] font-medium text-emerald-400">
                      {clockSyncMsg}
                    </p>
                  )}
                </div>

                {/* 2. W Fino (Totem Full Rally Calibration) */}
                <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="text-xs font-bold tracking-wide text-white uppercase">
                        W Fino / Fator CAL
                      </span>
                      <p className="text-[11px] text-zinc-400">
                        {navSettings.sensorMode === 'blue'
                          ? 'Sensor Blue: toque no número para digitar W.'
                          : 'Modo GPS: ajuste fino de Fator CAL (%).'}
                      </p>
                    </div>
                    <div className="inline-flex rounded-lg border border-zinc-800 bg-[#111214] p-0.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => updateNavSettings({ sensorMode: 'gps' })}
                        className={`rounded-md px-2.5 py-1 font-semibold ${
                          navSettings.sensorMode === 'gps'
                            ? 'bg-[#E10600] text-white'
                            : 'text-zinc-400'
                        }`}
                      >
                        GPS (CAL%)
                      </button>
                      <button
                        type="button"
                        onClick={() => updateNavSettings({ sensorMode: 'blue' })}
                        className={`rounded-md px-2.5 py-1 font-semibold ${
                          navSettings.sensorMode === 'blue'
                            ? 'bg-[#E10600] text-white'
                            : 'text-zinc-400'
                        }`}
                      >
                        Sensor Blue (W)
                      </button>
                    </div>
                  </div>

                  {/* [-1%] [-0.1%] [ TAP TO EDIT NUMBER ] [+0.1%] [+1%] */}
                  <div className="mt-3 grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleAdjustWFino(-1)}
                      className="min-h-[42px] rounded-xl border border-zinc-700 bg-[#1E1E22] px-2.5 font-mono text-xs font-extrabold text-[#C0C4C9] hover:bg-zinc-800"
                    >
                      -1%
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAdjustWFino(-0.1)}
                      className="min-h-[42px] rounded-xl border border-zinc-700 bg-[#1E1E22] px-3 font-mono text-sm font-black text-white hover:bg-zinc-800"
                    >
                      −
                    </button>

                    {editingWModal ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          inputMode="decimal"
                          autoFocus
                          value={wModalInput}
                          onChange={(e) => setWModalInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCommitWModalEdit();
                            if (e.key === 'Escape') setEditingWModal(false);
                          }}
                          onBlur={handleCommitWModalEdit}
                          className="w-full min-h-[42px] rounded-xl border border-[#E10600] bg-black px-2 text-center font-mono text-base font-black text-white focus:outline-none"
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={handleOpenWModalEdit}
                        title="Toque para digitar manualmente"
                        className="flex min-h-[42px] flex-col items-center justify-center rounded-xl border border-[#E10600]/40 bg-black px-2 hover:border-[#FF2A2A]"
                      >
                        <span className="font-mono text-base font-black text-white tabular-nums">
                          {navSettings.sensorMode === 'blue'
                            ? `W ${wValueFromCalibrationPct(calibrationPct, navSettings.wBaseValue)}`
                            : `${calibrationPct.toFixed(2)}%`}
                        </span>
                        <span className="text-[9px] font-semibold text-zinc-400 uppercase">
                          Toque p/ digitar
                        </span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleAdjustWFino(0.1)}
                      className="min-h-[42px] rounded-xl border border-zinc-700 bg-[#1E1E22] px-3 font-mono text-sm font-black text-white hover:bg-zinc-800"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAdjustWFino(1)}
                      className="min-h-[42px] rounded-xl border border-zinc-700 bg-[#1E1E22] px-2.5 font-mono text-xs font-extrabold text-[#C0C4C9] hover:bg-zinc-800"
                    >
                      +1%
                    </button>
                  </div>

                  <div className="mt-2.5 flex gap-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="Km oficial do marco (ex: 10.00)"
                      value={officialMarcoKm}
                      onChange={(e) => setOfficialMarcoKm(e.target.value)}
                      className="flex-1 min-h-[38px] rounded-xl border border-zinc-700 bg-[#1E1E22] px-3 font-mono text-xs text-white placeholder:text-zinc-500 focus:border-[#E10600] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleCalibrateByMarco}
                      className="min-h-[38px] rounded-xl border border-zinc-700 bg-[#1E1E22] px-3 text-xs font-semibold text-white hover:bg-zinc-800 whitespace-nowrap"
                    >
                      Aferir pelo Marco
                    </button>
                  </div>
                </div>

                {/* 3. Road Book Digital & Cantada Regressiva */}
                <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-3.5 space-y-3">
                  <span className="block text-xs font-bold tracking-wide text-white uppercase">
                    Road Book Digital &amp; Cantada de Voz
                  </span>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => updateNavSettings({ activeRowLine: 1 })}
                      className={`min-h-[36px] rounded-lg px-2.5 text-xs font-semibold ${
                        navSettings.activeRowLine === 1
                          ? 'bg-[#E10600] text-white'
                          : 'border border-zinc-700 bg-[#1E1E22] text-[#C0C4C9]'
                      }`}
                    >
                      Ref. da Vez: Linha 1 (Topo)
                    </button>
                    <button
                      type="button"
                      onClick={() => updateNavSettings({ activeRowLine: 2 })}
                      className={`min-h-[36px] rounded-lg px-2.5 text-xs font-semibold ${
                        navSettings.activeRowLine === 2
                          ? 'bg-[#E10600] text-white'
                          : 'border border-zinc-700 bg-[#1E1E22] text-[#C0C4C9]'
                      }`}
                    >
                      Ref. da Vez: Linha 2
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 text-xs text-[#C0C4C9]">
                    <label className="inline-flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={navSettings.reducePassedRow}
                        onChange={(e) =>
                          updateNavSettings({ reducePassedRow: e.target.checked })
                        }
                        className="h-3.5 w-3.5 accent-[#E10600]"
                      />
                      <span>Reduzir passada</span>
                    </label>
                    <label className="inline-flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={navSettings.showPassedTick}
                        onChange={(e) =>
                          updateNavSettings({ showPassedTick: e.target.checked })
                        }
                        className="h-3.5 w-3.5 accent-[#E10600]"
                      />
                      <span>✓ Verde na passada</span>
                    </label>
                    <label className="inline-flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={navSettings.voiceEnabled}
                        onChange={(e) =>
                          updateNavSettings({ voiceEnabled: e.target.checked })
                        }
                        className="h-3.5 w-3.5 accent-[#E10600]"
                      />
                      <span>Cantada de Voz (pt-BR)</span>
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-zinc-400">
                      Tema da Referência:
                    </span>
                    <div className="flex items-center gap-1.5">
                      {([
                        { id: 'yellow', label: 'Amarelo' },
                        { id: 'blue', label: 'Prata' },
                        { id: 'green', label: 'Verde' },
                      ] as const).map((theme) => (
                        <button
                          key={theme.id}
                          type="button"
                          onClick={() => updateNavSettings({ highlightTheme: theme.id })}
                          className={`rounded-lg px-2.5 py-1 text-[11px] font-bold ${
                            navSettings.highlightTheme === theme.id
                              ? 'bg-[#E10600] text-white'
                              : 'border border-zinc-700 bg-[#1E1E22] text-[#C0C4C9]'
                          }`}
                        >
                          {theme.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 4. Antecipação de Troca de Referência */}
                <div>
                  <div className="flex items-center justify-between text-xs font-semibold text-[#C0C4C9]">
                    <span>Troca Antecipada de Referência</span>
                    <span className="font-mono text-[#FF2A2A]">{transitionAdvanceM}m</span>
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    {[0, 2, 5, 10, 15, 20, 30, 50].map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setTransitionAdvanceM(m)}
                        className={`min-h-[34px] rounded-lg font-mono text-xs font-semibold ${
                          transitionAdvanceM === m
                            ? 'bg-[#E10600] text-white'
                            : 'border border-zinc-700 bg-[#1E1E22] text-[#C0C4C9] hover:bg-zinc-800'
                        }`}
                      >
                        {m}m
                      </button>
                    ))}
                  </div>
                </div>

                {/* 5. Ir para Tulipa / Reposicionar */}
                <div>
                  <span className="block text-xs font-semibold text-[#C0C4C9]">
                    Ir para Referência / Reposicionar
                  </span>
                  <div className="mt-1.5 flex gap-2">
                    <input
                      type="number"
                      placeholder="Nº da tulipa (ex: 27)"
                      value={jumpTulipaNum}
                      onChange={(e) => setJumpTulipaNum(e.target.value)}
                      className="flex-1 min-h-[40px] rounded-xl border border-zinc-700 bg-[#080B0D] px-3 font-mono text-xs text-white placeholder:text-zinc-500 focus:border-[#E10600] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleJumpToTulipa}
                      className="min-h-[40px] rounded-xl border border-zinc-700 bg-[#1E1E22] px-4 text-xs font-semibold text-white hover:bg-zinc-800"
                    >
                      Ir e Sincronizar
                    </button>
                  </div>
                </div>

                {/* 6. Planilhas em Configurações */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setFunctionsOpen(false);
                      onOpenRoadbookSettings?.();
                    }}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-zinc-700 bg-[#1E1E22] px-3.5 text-xs font-semibold text-[#F4F4F4] hover:bg-zinc-800"
                  >
                    <Database className="h-3.5 w-3.5 text-[#E10600]" />
                    <span>Configurações &gt; Planilhas</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setFunctionsOpen(false)}
                    className="pitstop-btn-red min-h-[40px] rounded-xl px-5 text-xs font-extrabold tracking-wide text-white uppercase"
                  >
                    Concluir
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- MENU DA REFERÊNCIA (CLIQUE LONGO NA TULIPA) --- */}
      {contextMenuIdx !== null && roadbook.tulipas[contextMenuIdx] && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-3 backdrop-blur-xs sm:items-center sm:p-4"
          onClick={() => setContextMenuIdx(null)}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-xl border border-zinc-800 bg-[#111214] text-[#F4F4F4] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 sm:p-5">
              {(() => {
                const targetTul = roadbook.tulipas[contextMenuIdx];
                return (
                  <>
                    <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                      <div>
                        <span className="font-mono text-[10px] font-bold tracking-widest text-[#E10600] uppercase">
                          Ações da Referência
                        </span>
                        <h3 className="font-['Barlow_Condensed'] text-2xl font-extrabold italic text-white">
                          Tulipa #{targetTul.tulipa} ·{' '}
                          {(targetTul.displayKm ?? targetTul.totalKm).toFixed(3).replace('.', ',')} km
                        </h3>
                      </div>
                      <button
                        type="button"
                        onClick={() => setContextMenuIdx(null)}
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-white"
                        aria-label="Fechar ações"
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </div>

                    <div className="mt-4 space-y-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          syncToTulipa(contextMenuIdx);
                          setContextMenuIdx(null);
                        }}
                        className="pitstop-btn-red flex min-h-[46px] w-full items-center gap-3 rounded-xl px-4 text-left text-sm font-bold text-white"
                      >
                        <MapPin className="h-5 w-5 shrink-0" />
                        <div>
                          <div>Estou Aqui (AQUI)</div>
                          <div className="text-[11px] font-normal text-red-100">
                            Zera o hodômetro para esta referência mantendo o cronômetro
                          </div>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          syncHereAndIdealTime(contextMenuIdx);
                          setContextMenuIdx(null);
                        }}
                        className="flex min-h-[46px] w-full items-center gap-3 rounded-xl border border-emerald-500/40 bg-emerald-950/40 px-4 py-2 text-left text-sm font-bold text-emerald-200 hover:bg-emerald-950/70"
                      >
                        <Clock className="h-5 w-5 shrink-0 text-emerald-400" />
                        <div>
                          <div>Estou Aqui + Ajustar Tempo Ideal</div>
                          <div className="text-[11px] font-normal text-emerald-300/80">
                            Alinha hodômetro e cronômetro ao tempo ideal desta tulipa
                          </div>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setMarkupTargetTulipa(targetTul);
                          setContextMenuIdx(null);
                        }}
                        className="flex min-h-[46px] w-full items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-950/30 px-4 py-2 text-left text-sm font-bold text-amber-200 hover:bg-amber-950/60"
                      >
                        <PenTool className="h-5 w-5 shrink-0 text-amber-400" />
                        <div>
                          <div>Marcar Roubo / Marcações</div>
                          <div className="text-[11px] font-normal text-amber-200/80">
                            Desenhar na tulipa, anotar texto ou gravar nota de voz
                          </div>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setContextMenuIdx(null)}
                        className="min-h-[42px] w-full rounded-xl border border-zinc-700 bg-[#1E1E22] text-xs font-semibold text-[#C0C4C9] hover:bg-zinc-800"
                      >
                        Cancelar
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL DE MARCAÇÕES / DESENHO / ÁUDIO --- */}
      {markupTargetTulipa && (
        <TulipaMarkupModal
          open={Boolean(markupTargetTulipa)}
          roadbookKey={roadbookStorageKey}
          tulipa={markupTargetTulipa}
          initialMarkup={markingsMap.get(markupTargetTulipa.tulipa)}
          onClose={() => setMarkupTargetTulipa(null)}
          onSaved={(saved) => {
            setMarkingsMap((prev) => {
              const next = new Map(prev);
              next.set(saved.tulipaNum, saved);
              return next;
            });
          }}
          onDeleted={(tulNum) => {
            setMarkingsMap((prev) => {
              const next = new Map(prev);
              next.delete(tulNum);
              return next;
            });
          }}
        />
      )}
    </div>
  );
};

