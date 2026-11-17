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
  Navigation,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
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
  type ImportFormatHint,
} from '../utils/roadbookFormats';
import {
  deleteSavedRoadbook,
  getLastActiveRoadbook,
  listSavedRoadbooks,
  saveConvertedRoadbook,
  setLastActiveRoadbookId,
} from '../utils/roadbookStorage';

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

const IMPORT_FORMAT_OPTIONS: {
  id: ImportFormatHint;
  label: string;
  ext: string;
  hint: string;
}[] = [
  {
    id: 'nbp',
    label: 'Digitais NBP (T15)',
    ext: '.NBP',
    hint: 'Formato padrão T15 Planilha / T15Nav (ZIP, XML, SQLite ou delimitado).',
  },
  {
    id: 'txt',
    label: 'Planilha Aberta',
    ext: '.TXT / .CSV / .XML',
    hint: 'Compatibilidade aberta para testes ou planilhas exportadas em texto.',
  },
];

const TulipVectorIcon: React.FC<{
  cap: number | null;
  imageDataUrl?: string;
  active?: boolean;
  passed?: boolean;
  size?: 'md' | 'lg';
}> = ({ cap, imageDataUrl, active = false, passed = false, size = 'md' }) => {
  const angle = cap ?? 0;
  const boxClass =
    size === 'lg'
      ? 'h-14 w-14 sm:h-20 sm:w-20'
      : 'h-11 w-11 sm:h-14 sm:w-14 md:h-16 md:w-16';
  const svgClass =
    size === 'lg'
      ? 'h-11 w-11 sm:h-16 sm:w-16'
      : 'h-8 w-8 sm:h-11 sm:w-11 md:h-12 md:w-12';

  if (imageDataUrl) {
    return (
      <div
        className={`relative flex ${boxClass} shrink-0 items-center justify-center overflow-hidden rounded-md border p-0.5 ${
          active
            ? 'border-slate-950/60 bg-[#fde047]'
            : passed
              ? 'border-sky-300 bg-sky-100/95'
              : 'border-slate-200 bg-white'
        }`}
      >
        <img
          src={imageDataUrl}
          alt="Tulipa"
          className={`h-full w-full object-contain ${active || passed ? 'mix-blend-multiply' : ''}`}
        />
      </div>
    );
  }

  return (
    <div
      className={`relative flex ${boxClass} shrink-0 items-center justify-center rounded-lg border ${
        active
          ? 'border-slate-950/60 bg-[#fde047] text-slate-950'
          : 'border-slate-200 bg-white text-slate-900'
      }`}
    >
      <svg viewBox="0 0 64 64" className={svgClass} aria-hidden="true">
        <circle
          cx="32"
          cy="32"
          r="26"
          fill="none"
          stroke={active ? '#a16207' : '#CBD5E1'}
          strokeWidth="1.75"
          strokeDasharray="3 4"
        />
        <g transform={`rotate(${angle} 32 32)`}>
          <path
            d="M32 9 L42 29 L35 27 L35 51 L29 51 L29 27 L22 29 Z"
            fill="#09090B"
          />
          <circle cx="32" cy="51" r="4.5" fill={active ? '#09090B' : '#EA580C'} />
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
          ? 'text-red-400'
          : 'text-amber-300';

  return (
    <div className="flex h-full flex-col justify-between rounded-2xl border-2 border-slate-800 bg-[#07090d] p-4 text-white">
      <div className="flex items-center justify-between gap-2 text-[10px] font-bold tracking-widest text-slate-400 uppercase">
        <span>Velocímetro Digital</span>
        <span className="font-mono text-orange-400">
          {sectionType === 'D' || sectionType === 'N'
            ? `${sectionType} ${tdnMs ? formatTdnOrTime(tdnMs) : ''}`.trim()
            : targetSpeedKmh
              ? `Vel/TDN ${Math.round(targetSpeedKmh)} km/h`
              : 'Sem meta'}
        </span>
      </div>

      <div className="my-3 flex flex-col items-center justify-center rounded-xl border border-slate-800 bg-black px-4 py-4">
        <div
          className={`font-mono text-6xl font-black leading-none tracking-tight tabular-nums sm:text-7xl ${speedColor}`}
          aria-label={`Velocímetro ${Math.round(speedKmh)} km/h`}
        >
          {String(Math.round(speedKmh)).padStart(2, '0')}
        </div>
        <span className="mt-1.5 font-mono text-xs font-bold tracking-[0.22em] text-slate-400 uppercase">
          KM/H
        </span>
      </div>

      <div>
        <div className="relative h-2.5 w-full overflow-hidden rounded-full border border-slate-800 bg-slate-900">
          <div
            className="h-full rounded-full bg-gradient-to-r from-amber-400 via-orange-500 to-red-600 transition-all duration-150"
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
        <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-slate-500 tabular-nums">
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

export const NavigationCockpit: React.FC = () => {
  const [roadbook, setRoadbook] = useState<ParsedRoadbook | null>(null);
  const [savedRoadbooks, setSavedRoadbooks] = useState<ParsedRoadbook[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);
  const [importFormat, setImportFormat] = useState<ImportFormatHint>('nbp');
  const [fileStructureReport, setFileStructureReport] = useState<string | null>(null);
  const [diagnosticTxtData, setDiagnosticTxtData] = useState<{
    fileName: string;
    content: string;
  } | null>(null);
  const [showStructureReport, setShowStructureReport] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);

  // Totem-style scenario & functions
  const [scenario, setScenario] = useState<ScreenScenario>('navegador');
  const [isRunning, setIsRunning] = useState(false);
  const [driveSource, setDriveSource] = useState<DriveSource>('gps');
  const [simSpeedKmh, setSimSpeedKmh] = useState(44);
  const [calibrationPct, setCalibrationPct] = useState(100.0);
  const [transitionAdvanceM, setTransitionAdvanceM] = useState(5);
  const [manualStepKm, setManualStepKm] = useState<number>(0.01);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [showPassedRows, setShowPassedRows] = useState(false);

  // Time & Odometers
  const [raceDate, setRaceDate] = useState(getLocalTodayDate);
  const [startTimeStr, setStartTimeStr] = useState(getLocalNowTime);
  const [startTimestampMs, setStartTimestampMs] = useState<number>(() => Date.now());
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [odometerKm, setOdometerKm] = useState(0);
  const [partialBaseKm, setPartialBaseKm] = useState(0);
  const [currentSpeedKmh, setCurrentSpeedKmh] = useState(0);
  const [activeTulipaIdx, setActiveTulipaIdx] = useState(0);

  // Totem Functions Popup Modal (triggered via Funções button or press-and-hold on odometer)
  const [functionsOpen, setFunctionsOpen] = useState(false);
  const [officialMarcoKm, setOfficialMarcoKm] = useState('');
  const [jumpTulipaNum, setJumpTulipaNum] = useState('');

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
  const longPressTimerRef = useRef<number | null>(null);

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
  }, []);

  // Load internal offline roadbook database and restore active roadbook on mount
  useEffect(() => {
    let active = true;
    (async () => {
      const [list, last] = await Promise.all([
        listSavedRoadbooks(),
        getLastActiveRoadbook(),
      ]);
      if (!active) return;
      setSavedRoadbooks(list);
      if (last) {
        activateRoadbook(last);
      }
    })();
    return () => {
      active = false;
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
        parseNavigationBuffer(buffer, file.name, importFormat),
      ]);
      if (report) setFileStructureReport(report);
      if (txtSample) {
        const cleanStem = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
        setDiagnosticTxtData({ fileName: `dados_${cleanStem}.txt`, content: txtSample });
      }
      const stored = await saveConvertedRoadbook(parsed);
      setSavedRoadbooks(await listSavedRoadbooks());
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
      setSavedRoadbooks(await listSavedRoadbooks());
      activateRoadbook(stored);
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : 'Erro ao carregar planilha modelo.'
      );
    } finally {
      setLoadingSample(false);
    }
  };

  const handleDeleteSaved = async (id: string) => {
    await deleteSavedRoadbook(id);
    setSavedRoadbooks(await listSavedRoadbooks());
    if (roadbook?.id === id) {
      setRoadbook(null);
      setIsRunning(false);
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

  // Approach beep < 50m before next tulipa
  useEffect(() => {
    if (!isRunning || !soundEnabled || !nextTulipa) return;
    const distM = distToNextKm * 1000;
    if (
      distM > 0 &&
      distM <= 50 &&
      approachBeepedIdxRef.current !== activeTulipaIdx + 1
    ) {
      approachBeepedIdxRef.current = activeTulipaIdx + 1;
      playBeep(760, 80, false);
    }
  }, [isRunning, soundEnabled, nextTulipa, distToNextKm, activeTulipaIdx]);

  const partialKm = Math.max(0, odometerKm - partialBaseKm);
  const elapsedMs = nowMs - startTimestampMs;

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

  // Keep 1 immediately passed row in pale blue right above the yellow current row (after Tulipa 1),
  // while starting right on Tulipa 1 when activeTulipaIdx === 0
  const planilhaStartIdx = showPassedRows
    ? 0
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

  const handleCalibrateByMarco = () => {
    const targetKm = parseFloat(officialMarcoKm.replace(',', '.'));
    if (!Number.isFinite(targetKm) || targetKm <= 0 || odometerKm <= 0) return;
    const newFactor = Number(
      Math.min(115, Math.max(85, (targetKm / odometerKm) * calibrationPct)).toFixed(2)
    );
    setCalibrationPct(newFactor);
    setOdometerKm(targetKm);
    setOfficialMarcoKm('');
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

  // --- NO ROADBOOK LOADED STATE (CONVERTER + BASE INTERNA) ---
  if (!roadbook) {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <section className="relative overflow-hidden rounded-2xl border border-slate-800 bg-[#12161f] text-slate-100 shadow-2xl">
          <div aria-hidden="true" className="h-1.5 w-full rally-track-stripe" />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute right-0 top-1.5 h-32 w-48 bg-rally-checkered opacity-25 [mask-image:linear-gradient(to_bottom_left,black,transparent)]"
          />
          <div className="relative p-4 sm:p-7">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-['Barlow_Condensed'] text-2xl font-bold italic text-white sm:text-3xl">
                  Navegação — Hodômetro &amp; Road Book Digital
                </h2>
                <p className="mt-1 text-xs text-slate-400 sm:text-sm">
                  Importação dedicada ao padrão{' '}
                  <span className="font-mono text-xs text-orange-400">Digitais NBP (T15)</span>{' '}
                  com suporte aberto para{' '}
                  <span className="font-mono text-xs text-slate-300">.TXT / .CSV / .XML</span>.
                </p>
              </div>

              <button
                type="button"
                onClick={handleLoadSample}
                disabled={loadingSample}
                className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <FileText className="h-4 w-4 text-orange-500" />
                <span>
                  {loadingSample ? 'Convertendo...' : 'Testar com Planilha Rally Escoteiro'}
                </span>
              </button>
            </div>

            {/* Format selector standardized on Digitais NBP (T15) */}
            <div className="mt-5">
              <p className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">
                Formato do Arquivo de Prova
              </p>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {IMPORT_FORMAT_OPTIONS.map((opt) => {
                  const selected = importFormat === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setImportFormat(opt.id);
                        setParseError(null);
                      }}
                      className={`flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
                        selected
                          ? 'border-orange-500 bg-orange-600/20 text-white'
                          : 'border-slate-800 bg-[#0a0d13] text-slate-300 hover:border-slate-700 hover:bg-slate-900'
                      }`}
                    >
                      <div>
                        <div className="text-xs font-bold leading-tight">{opt.label}</div>
                        <div className="mt-0.5 text-[11px] text-slate-400">{opt.hint}</div>
                      </div>
                      <span className="ml-3 font-mono text-[11px] font-bold text-orange-400 shrink-0">
                        {opt.ext}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="mt-4 flex min-h-[156px] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-700 bg-[#0a0d13] px-6 py-7 text-center transition-colors hover:border-orange-500 hover:bg-orange-950/15">
              <Upload className="h-8 w-8 text-orange-500" />
              <span className="mt-3 text-base font-semibold text-white">
                {importFormat === 'nbp'
                  ? 'Importar Planilha Digital .NBP / .NBP.ZIP (T15)'
                  : 'Importar Planilha (.NBP, .ZIP, .TXT, .CSV, .XML ou .SQLite)'}
              </span>
              <span className="mt-1 max-w-md text-xs text-slate-400">
                Converte todas as tulipas (desde 0,00), distâncias, Vel/TDN, tempos ideais e observações para a base interna offline.
              </span>
              <input
                type="file"
                accept=".nbp,.zip,.txt,.csv,.xml,.gpx,.json,.db,.sqlite,.sqlite3,application/zip"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFileUpload(f);
                  e.currentTarget.value = '';
                }}
              />
            </label>

            {parseError && (
              <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-800/70 bg-red-950/50 p-4 text-xs leading-relaxed text-red-200">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                <span>{parseError}</span>
              </div>
            )}

            {/* Diagnostic .NBP structure inspector */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#0b0e14] px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <FileSearch className="h-4 w-4 text-orange-400 shrink-0" />
                <span>Inspeção técnica do .NBP / .NBP.ZIP (colunas, tags XML e 1ª referência)</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] font-semibold text-slate-200 hover:bg-slate-800">
                  <FileSearch className="h-3.5 w-3.5 text-orange-400" />
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
                    className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] font-semibold text-orange-300 hover:bg-slate-800"
                  >
                    {showStructureReport ? 'Ocultar Estrutura' : 'Ver Estrutura'}
                  </button>
                )}
              </div>
            </div>

            {showStructureReport && fileStructureReport && (
              <div className="mt-3 rounded-xl border border-slate-800 bg-black p-3.5">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[11px] font-bold text-orange-400 uppercase">
                    Estrutura Detectada do Arquivo
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handleDownloadDiagnosticTxt}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-sky-300 hover:bg-slate-800"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Baixar .TXT p/ Enviar</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCopyStructureReport}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-800"
                    >
                      {copiedReport ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                          <span>Copiado</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5 text-orange-400" />
                          <span>Copiar</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-slate-300">
                  {fileStructureReport}
                </pre>
              </div>
            )}
          </div>
        </section>

        {/* BASE INTERNA DE ROADBOOKS CONVERTIDOS */}
        {savedRoadbooks.length > 0 && (
          <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#12161f] text-slate-100 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-orange-500" />
                <h3 className="font-['Barlow_Condensed'] text-xl font-bold italic text-white">
                  Base Interna Offline ({savedRoadbooks.length})
                </h3>
              </div>
              <span className="text-[11px] text-slate-400">
                Prontos para navegação na prova
              </span>
            </div>

            <div className="divide-y divide-slate-800/80">
              {savedRoadbooks.map((item) => (
                <div
                  key={item.id ?? item.fileName}
                  className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-['Barlow_Condensed'] text-lg font-bold text-white truncate">
                        {item.eventName}
                      </span>
                      <span className="font-mono text-[10px] font-bold uppercase text-orange-400">
                        {item.sourceFormat || 'TXT'}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-slate-400 tabular-nums">
                      <span>{item.tulipas.length} refs</span>
                      <span>{item.totalKm.toFixed(2)} km</span>
                      <span>
                        V:{item.countV} · D:{item.countD} · N:{item.countN}
                      </span>
                      {item.raceParameters && item.raceParameters.speedsKmh.length > 0 && (
                        <span>
                          Médias: {item.raceParameters.speedsKmh.slice(0, 6).join('/')}
                          {item.raceParameters.speedsKmh.length > 6 ? '...' : ''} km/h
                        </span>
                      )}
                      {item.raceParameters && item.raceParameters.notesCount > 0 && (
                        <span>{item.raceParameters.notesCount} obs</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => activateRoadbook(item)}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3.5 text-xs font-extrabold tracking-wide text-white uppercase rally-btn-orange"
                    >
                      <Navigation className="h-3.5 w-3.5" />
                      <span>Navegar</span>
                    </button>
                    {item.id && (
                      <button
                        type="button"
                        onClick={() => handleDeleteSaved(item.id!)}
                        title="Remover da base interna"
                        className="inline-flex h-[36px] w-[36px] items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-slate-400 hover:border-red-700 hover:text-red-400"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  // Regularity bar positioning (-15s..+15s centered at 50%)
  // Left = Adiantado (-s), Right = Atrasado (+s)
  const gaugePercent =
    deltaSec === null ? 50 : Math.max(4, Math.min(96, 50 + (deltaSec / 15) * 46));

  const regTone = isNonTimedSection
    ? {
        text: 'text-sky-400',
        label:
          currentTulipa?.type === 'D'
            ? `Deslocamento ${formatHmsDuration(currentTulipa?.sectionDurationMs)}`
            : `Neutralização ${formatHmsDuration(currentTulipa?.sectionDurationMs)}`,
        bg: 'bg-sky-500',
      }
    : deltaSec === null
      ? { text: 'text-slate-400', label: 'Aguardando largada', bg: 'bg-slate-600' }
      : Math.abs(deltaSec) <= 0.5
        ? { text: 'text-emerald-400', label: 'NO TEMPO IDEAL', bg: 'bg-emerald-500' }
        : deltaSec < 0
          ? { text: 'text-sky-400', label: 'ADIANTADO · TIRE O PÉ', bg: 'bg-sky-500' }
          : { text: 'text-red-400', label: 'ATRASADO · ACELERE', bg: 'bg-red-500' };

  const hasPmmChangeSoon =
    currentTulipa &&
    nextTulipa &&
    (currentTulipa.type !== nextTulipa.type ||
      Math.abs((currentTulipa.avgSpeedKmh ?? 0) - (nextTulipa.avgSpeedKmh ?? 0)) >= 2);

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Top Totem Control Strip */}
      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#12161f] text-white shadow-xl">
        <div aria-hidden="true" className="h-1.5 w-full rally-track-stripe" />
        <div className="flex flex-col gap-2.5 px-3 py-3 sm:px-5 sm:py-3.5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span
                  className={`font-mono text-[10px] font-extrabold tracking-widest uppercase ${
                    isRunning ? 'text-red-500' : 'text-amber-400'
                  }`}
                >
                  {isRunning ? 'EM PROVA' : 'PRONTO'}
                </span>
                <h2 className="font-['Barlow_Condensed'] text-lg font-bold italic text-white truncate sm:text-2xl">
                  {roadbook.eventName}
                </h2>
                <span className="font-mono text-[11px] text-slate-400 sm:text-xs">
                  · {formatClockMs(nowMs, false)}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-slate-400 sm:text-[11px]">
                <span>
                  {driveSource === 'gps' ? 'GPS Real' : 'Simulador'} · Largada{' '}
                  <strong className="font-mono text-slate-200">{startTimeStr}</strong>
                </span>
                <span className="font-mono text-slate-500">
                  · {roadbook.sourceFormat || 'TXT'} ({roadbook.tulipas.length} refs ·{' '}
                  {roadbook.totalKm.toFixed(1)} km ·{' '}
                  {roadbook.raceParameters?.sectionsCount ?? '-'} seç.)
                </span>
                {driveSource === 'gps' && gpsStatus.state === 'active' && (
                  <span className="font-mono text-emerald-400">
                    · ±{gpsStatus.accuracyM ?? '--'}m
                  </span>
                )}
                {driveSource === 'gps' && gpsStatus.state === 'error' && (
                  <span className="text-red-400">· {gpsStatus.message}</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            {/* Layout Scenario: Navegador vs Piloto */}
            <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-0.5">
              <button
                type="button"
                onClick={() => setScenario('navegador')}
                className={`min-h-[34px] rounded-md px-2.5 text-xs font-semibold transition-colors ${
                  scenario === 'navegador'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Navegador
              </button>
              <button
                type="button"
                onClick={() => setScenario('piloto')}
                className={`min-h-[34px] rounded-md px-2.5 text-xs font-semibold transition-colors ${
                  scenario === 'piloto'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Piloto
              </button>
            </div>

            {/* Source: GPS vs Simulator */}
            <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-0.5">
              <button
                type="button"
                onClick={() => setDriveSource('gps')}
                className={`min-h-[34px] rounded-md px-2.5 text-xs font-semibold transition-colors ${
                  driveSource === 'gps'
                    ? 'bg-orange-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                GPS
              </button>
              <button
                type="button"
                onClick={() => setDriveSource('simulator')}
                className={`min-h-[34px] rounded-md px-2.5 text-xs font-semibold transition-colors ${
                  driveSource === 'simulator'
                    ? 'bg-orange-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Simulador
              </button>
            </div>

            <button
              type="button"
              onClick={() => setSoundEnabled((s) => !s)}
              title={soundEnabled ? 'Desativar bipes' : 'Ativar bipes'}
              className="inline-flex h-[36px] w-[36px] items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-slate-300 hover:text-white"
            >
              {soundEnabled ? (
                <Volume2 className="h-4 w-4 text-orange-400" />
              ) : (
                <VolumeX className="h-4 w-4" />
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                setLastActiveRoadbookId(null);
                setRoadbook(null);
                setIsRunning(false);
              }}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs font-semibold text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Upload className="h-3.5 w-3.5 text-orange-400" />
              <span>Trocar</span>
            </button>

            <button
              type="button"
              onClick={() => setFunctionsOpen(true)}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs font-semibold text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Settings2 className="h-3.5 w-3.5 text-orange-400" />
              <span>Funções</span>
            </button>

            {!isRunning ? (
              <button
                type="button"
                onClick={handleStartNavigation}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-4 text-xs font-extrabold tracking-wide text-white uppercase rally-btn-orange whitespace-nowrap"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                <span>Largada</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIsRunning(false)}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-4 text-xs font-extrabold tracking-wide text-white uppercase rally-btn-red whitespace-nowrap"
              >
                <Pause className="h-3.5 w-3.5" />
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
                  <span className="font-mono text-[10px] font-bold text-orange-400 uppercase">
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
                          <Copy className="h-3 w-3 text-orange-400" />
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
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-800 bg-[#0b0e14] px-4 py-2.5 sm:px-5">
            <div className="flex flex-1 items-center gap-3 min-w-[220px]">
              <Gauge className="h-4 w-4 text-orange-400 shrink-0" />
              <span className="text-xs font-medium text-slate-300 whitespace-nowrap">
                Simulador:
              </span>
              <input
                type="range"
                min={0}
                max={120}
                step={1}
                value={simSpeedKmh}
                onChange={(e) => setSimSpeedKmh(Number(e.target.value))}
                className="h-1.5 flex-1 cursor-pointer appearance-none rounded bg-slate-700 accent-orange-500"
              />
              <span className="font-mono text-sm font-bold text-amber-300 tabular-nums w-20 text-right">
                {simSpeedKmh} km/h
              </span>
            </div>
            {currentTulipa?.type === 'V' && currentTulipa?.avgSpeedKmh ? (
              <button
                type="button"
                onClick={() => setSimSpeedKmh(Math.round(currentTulipa.avgSpeedKmh ?? 40))}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
              >
                Cravar na Média ({currentTulipa.avgSpeedKmh} km/h)
              </button>
            ) : null}
          </div>
        )}
      </section>

      {/* --- VELOCÍMETRO DIGITAL + VISOR DE PROVA TOTEM CLUSTER --- */}
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
        <section className="overflow-hidden rounded-2xl border-2 border-slate-800 bg-black p-2 text-white sm:p-3.5 lg:col-span-8">
        {/* Row 1: HODÔMETRO (GPS) + TNAV (Adiantado / Atrasado) */}
        <div className="grid grid-cols-12 gap-1.5 sm:gap-2">
          <div
            onMouseDown={startLongPress}
            onMouseUp={cancelLongPress}
            onMouseLeave={cancelLongPress}
            onTouchStart={startLongPress}
            onTouchEnd={cancelLongPress}
            className="col-span-7 min-w-0 overflow-hidden flex flex-col justify-between rounded-xl border border-slate-700 bg-slate-950 px-2.5 py-1.5 select-none sm:px-3 sm:py-2"
          >
            <div className="flex items-center justify-between gap-1.5">
              <span className="truncate text-[9px] font-bold tracking-wider text-slate-300 uppercase sm:text-xs">
                Hodômetro (GPS)
              </span>
              <span className="font-mono text-[9px] text-orange-400 tabular-nums shrink-0 sm:text-[10px]">
                {calibrationPct.toFixed(1)}%
              </span>
            </div>
            <div
              className={`mt-0.5 font-mono text-2xl font-extrabold leading-none tracking-tight tabular-nums sm:text-4xl lg:text-5xl ${
                isRunning ? 'text-red-500' : 'text-sky-400'
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
            <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[9px] text-slate-400 sm:text-[10px]">
              <span className="hidden sm:inline">Segure p/ Funções</span>
              <span className="truncate font-mono text-slate-300">
                Parc {partialKm.toFixed(3).replace('.', ',')} · Acum {odometerKm.toFixed(2)}km
              </span>
            </div>
          </div>

          <div className="col-span-5 min-w-0 overflow-hidden flex flex-col justify-between rounded-xl border border-slate-700 bg-slate-950 px-2.5 py-1.5 sm:px-3 sm:py-2">
            <div className="flex items-center justify-between gap-1">
              <span className="text-[9px] font-bold tracking-wider text-slate-300 uppercase sm:text-xs">
                TNAV
              </span>
              {deltaMeters !== null && (
                <span className="font-mono text-[9px] text-slate-400 tabular-nums shrink-0 sm:text-[10px]">
                  {deltaMeters > 0 ? '+' : ''}
                  {deltaMeters} m
                </span>
              )}
            </div>
            <div
              className={`mt-0.5 font-mono text-2xl font-extrabold leading-none tracking-tight tabular-nums sm:text-4xl lg:text-5xl ${
                isNonTimedSection
                  ? 'text-sky-400'
                  : deltaSec === null
                    ? 'text-slate-500'
                    : Math.abs(deltaSec) <= 0.5
                      ? 'text-emerald-400'
                      : deltaSec < 0
                        ? 'text-sky-400'
                        : 'text-red-500'
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
        </div>

        {/* Row 2: REGR PROX REF + VEL + MEDIA + KM REGR */}
        <div className="mt-1.5 grid grid-cols-4 gap-1.5 sm:mt-2 sm:grid-cols-12 sm:gap-2">
          <div className="min-w-0 overflow-hidden flex flex-col justify-between rounded-xl border border-slate-700 bg-slate-950 px-1.5 py-1.5 text-center sm:col-span-4 sm:px-2.5 sm:py-2">
            <span className="truncate text-[9px] font-bold tracking-tight text-slate-300 uppercase sm:text-[10px]">
              <span className="sm:hidden">Regr Próx</span>
              <span className="hidden sm:inline">Regr Próx Ref</span>
            </span>
            <div className="my-0.5 font-mono text-base font-extrabold leading-tight text-amber-300 tabular-nums sm:my-1 sm:text-3xl">
              {distToNextKm.toFixed(3).replace('.', ',')}
            </div>
            <span className="truncate font-mono text-[9px] text-slate-400 sm:text-[10px]">
              Tul #{nextTulipa?.tulipa ?? currentTulipa?.tulipa ?? '-'}
            </span>
          </div>

          <div className="min-w-0 overflow-hidden flex flex-col justify-between rounded-xl border border-slate-700 bg-slate-950 px-1.5 py-1.5 text-center sm:col-span-3 sm:px-2 sm:py-2">
            <span className="truncate text-[9px] font-bold tracking-tight text-slate-300 uppercase sm:text-[10px]">
              Vel
            </span>
            <div className="my-0.5 font-mono text-lg font-extrabold leading-tight text-red-500 tabular-nums sm:my-1 sm:text-3xl">
              {currentSpeedKmh.toFixed(0)}
            </div>
            <span className="font-mono text-[9px] text-slate-400 sm:text-[10px]">km/h</span>
          </div>

          <div className="min-w-0 overflow-hidden flex flex-col justify-between rounded-xl border border-slate-700 bg-slate-950 px-1.5 py-1.5 text-center sm:col-span-3 sm:px-2 sm:py-2">
            <span className="truncate text-[9px] font-bold tracking-tight text-slate-300 uppercase sm:text-[10px]">
              <span className="sm:hidden">Média</span>
              <span className="hidden sm:inline">Média (Vel/TDN)</span>
            </span>
            <div className="my-0.5 font-mono text-lg font-extrabold leading-tight text-red-500 tabular-nums sm:my-1 sm:text-3xl">
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
            <span className="truncate font-mono text-[8.5px] text-slate-400 sm:text-[10px]">
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
            className="min-w-0 overflow-hidden flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 border-amber-200 bg-amber-400 px-1 py-1.5 text-slate-950 transition-colors hover:bg-amber-300 active:bg-amber-500 sm:col-span-2 sm:gap-1 sm:py-2"
          >
            <RefreshCw className="h-4 w-4 stroke-[2.5] sm:h-6 sm:w-6" />
            <span className="text-[8.5px] font-extrabold leading-tight tracking-tight uppercase sm:text-[10px]">
              KM Regr
            </span>
          </button>
        </div>

        {/* Row 3: CRONO (DROID) + GPS Signal Bars + Regularity Bar */}
        <div className="mt-1.5 grid grid-cols-12 gap-1.5 sm:mt-2 sm:gap-2">
          <div className="col-span-7 min-w-0 overflow-hidden flex items-center justify-between gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-2.5 py-1.5 sm:px-3 sm:py-2">
            <div className="min-w-0">
              <span className="block truncate text-[8.5px] font-bold tracking-wider text-slate-400 uppercase sm:text-[9px]">
                Crono (Prova)
              </span>
              <div className="truncate font-mono text-base font-extrabold leading-tight tracking-tight text-white tabular-nums sm:text-2xl">
                {isRunning ? `R${formatElapsedMs(elapsedMs)}` : formatClockMs(nowMs, false)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPartialBaseKm(odometerKm)}
              className="shrink-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-[9px] font-bold text-amber-300 hover:bg-slate-800 sm:px-2.5 sm:py-1.5 sm:text-[10px]"
            >
              Zerar
            </button>
          </div>

          <div className="col-span-5 min-w-0 overflow-hidden flex flex-col justify-between rounded-xl border border-slate-700 bg-slate-950 px-2.5 py-1.5 sm:px-3 sm:py-2">
            <div className="flex items-center justify-between gap-1">
              <span className="text-[9px] font-bold text-slate-300 uppercase sm:text-[10px]">
                {driveSource === 'gps' ? 'GPS' : 'SIM'}
              </span>
              <div className="flex items-end gap-0.5 shrink-0" aria-hidden="true">
                {[1, 2, 3, 4].map((bar) => (
                  <span
                    key={bar}
                    className={`w-1 rounded-xs sm:w-1.5 ${
                      driveSource === 'simulator'
                        ? 'bg-amber-400'
                        : gpsStatus.state === 'active'
                          ? 'bg-emerald-400'
                          : 'bg-slate-700'
                    }`}
                    style={{ height: `${bar * 3.5 + 2}px` }}
                  />
                ))}
              </div>
            </div>
            <div className="truncate font-mono text-[10px] font-bold tabular-nums text-slate-200 sm:text-xs">
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

        {/* Thin Visual Regularity Scale + Quick +/-10m Thumb Bar */}
        <div className="mt-2 flex flex-col gap-1.5 border-t border-slate-800 pt-2 sm:mt-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:pt-2.5">
          <div className="flex-1">
            <div className="relative h-2.5 w-full overflow-hidden rounded-full border border-slate-800 bg-slate-900 sm:h-3">
              <div className="absolute left-1/2 top-0 bottom-0 z-10 w-0.5 -translate-x-1/2 bg-emerald-400" />
              <div
                className={`absolute top-0.5 bottom-0.5 w-3 -translate-x-1/2 rounded-full transition-all duration-150 ${regTone.bg}`}
                style={{ left: `${gaugePercent}%` }}
              />
            </div>
          </div>

          <div className="grid grid-cols-4 gap-1 sm:w-auto sm:gap-1.5">
            <button
              type="button"
              onClick={() => adjustOdometer(-0.1)}
              className="min-h-[32px] rounded-lg border border-slate-700 bg-slate-900 px-1.5 font-mono text-[11px] font-bold text-slate-200 hover:bg-slate-800 sm:min-h-[36px] sm:px-2.5 sm:text-xs"
            >
              -100m
            </button>
            <button
              type="button"
              onClick={() => adjustOdometer(-0.01)}
              className="min-h-[32px] rounded-lg border border-slate-700 bg-slate-900 px-1.5 font-mono text-[11px] font-bold text-slate-200 hover:bg-slate-800 sm:min-h-[36px] sm:px-2.5 sm:text-xs"
            >
              -10m
            </button>
            <button
              type="button"
              onClick={() => adjustOdometer(0.01)}
              className="min-h-[32px] rounded-lg border border-slate-700 bg-slate-900 px-1.5 font-mono text-[11px] font-bold text-slate-200 hover:bg-slate-800 sm:min-h-[36px] sm:px-2.5 sm:text-xs"
            >
              +10m
            </button>
            <button
              type="button"
              onClick={() => adjustOdometer(0.1)}
              className="min-h-[32px] rounded-lg border border-slate-700 bg-slate-900 px-1.5 font-mono text-[11px] font-bold text-slate-200 hover:bg-slate-800 sm:min-h-[36px] sm:px-2.5 sm:text-xs"
            >
              +100m
            </button>
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
                    : 'text-orange-400'
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

      {/* --- SCENARIO: PILOTO (DROID PILOTO COMPACT INSTRUMENTS) --- */}
      {scenario === 'piloto' && currentTulipa && (
        <section className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-12">
          <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4 text-white sm:p-6 md:col-span-6">
            <p className="text-[11px] font-medium text-slate-400 sm:text-xs">
              {isNonTimedSection && sectionRemainingMs !== null
                ? sectionRemainingMs >= 0
                  ? `${currentTulipa.type === 'N' ? 'Neutro' : 'Deslocamento'} · V em ${formatHmsDuration(sectionRemainingMs)}`
                  : `Tempo excedido (+${formatHmsDuration(-sectionRemainingMs)})`
                : `Falta para Referência #${nextTulipa?.tulipa ?? currentTulipa.tulipa}`}
            </p>
            <p className="mt-1.5 font-mono text-4xl font-bold tracking-tight text-amber-300 tabular-nums sm:mt-2 sm:text-5xl lg:text-6xl">
              {distToNextKm < 1
                ? `${Math.round(distToNextKm * 1000)} m`
                : `${distToNextKm.toFixed(2)} km`}
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-3 text-xs sm:mt-4 sm:pt-4 sm:text-sm">
              <span className="text-slate-400">
                Hodômetro Total:{' '}
                <strong className="font-mono text-white">{odometerKm.toFixed(3)} km</strong>
              </span>
              {hasPmmChangeSoon && nextTulipa && (
                <span className="font-mono text-[11px] font-bold text-orange-400 sm:text-xs">
                  PMM Próx: {nextTulipa.type === 'N' ? 'NEUTRO' : nextTulipa.type === 'D' ? 'DESLOCAMENTO' : `${nextTulipa.avgSpeedKmh ?? '--'} km/h`}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3.5 rounded-2xl border border-slate-800 bg-slate-950 p-4 text-white sm:gap-5 sm:p-6 md:col-span-6">
            <TulipVectorIcon
              cap={nextTulipa?.cap ?? currentTulipa.cap}
              imageDataUrl={nextTulipa?.imageDataUrl ?? currentTulipa.imageDataUrl}
              active
              size="lg"
            />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-orange-400 sm:text-xs">
                Próxima Direção · Tulipa #{nextTulipa?.tulipa ?? currentTulipa.tulipa}
              </p>
              <p className="mt-0.5 font-['Barlow_Condensed'] text-2xl font-bold text-white sm:mt-1 sm:text-3xl lg:text-4xl">
                {(nextTulipa?.cap ?? currentTulipa.cap) !== null
                  ? `CAP ${(nextTulipa?.cap ?? currentTulipa.cap)}°`
                  : `Trecho ${(nextTulipa ?? currentTulipa).section ?? '-'}`}
              </p>
              {(() => {
                const targetRef = nextTulipa ?? currentTulipa;
                const obsImg =
                  targetRef.notesImageDataUrl ||
                  (targetRef.imageIsComposite ? targetRef.imageDataUrl : undefined);
                return (
                  <>
                    {obsImg && (
                      <div className="mt-1.5 rounded bg-white p-1">
                        <img
                          src={obsImg}
                          alt={`Observação tulipa ${targetRef.tulipa}`}
                          className="max-h-16 w-full object-contain object-left"
                        />
                      </div>
                    )}
                    {(targetRef.notes || !obsImg) && (
                      <p className="mt-1 text-xs text-slate-200 whitespace-pre-line break-words sm:text-sm">
                        {targetRef.notes || `Trecho ${targetRef.type || '-'}`}
                      </p>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </section>
      )}

      {/* --- SCENARIO: NAVEGADOR (ESPELHO PLANILHA DIGITAL ROLANTE TOTEM) --- */}
      {scenario === 'navegador' && (
        <div className="space-y-3">
          {/* Sub-bar Controls */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#12161f] px-3.5 py-2 text-slate-100">
            <div className="flex items-center gap-2">
              <Compass className="h-4 w-4 text-orange-500" />
              <span className="text-xs font-bold text-white">
                Planilha Digital Rolante ({activeTulipaIdx + 1}/{roadbook.tulipas.length})
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
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-300 mr-1">
                <input
                  type="checkbox"
                  checked={autoAdvance}
                  onChange={(e) => setAutoAdvance(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-600 accent-orange-500"
                />
                <span>Troca auto ({transitionAdvanceM}m)</span>
              </label>

              {activeTulipaIdx > 0 && (
                <button
                  type="button"
                  onClick={() => setShowPassedRows((v) => !v)}
                  className={`inline-flex min-h-[34px] items-center rounded-lg border px-2.5 text-xs font-semibold ${
                    showPassedRows
                      ? 'border-orange-500 bg-orange-600/20 text-orange-300'
                      : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {showPassedRows ? 'Ocultar anteriores' : `Anteriores (${activeTulipaIdx})`}
                </button>
              )}

              <button
                type="button"
                disabled={activeTulipaIdx === 0}
                onClick={() => setActiveTulipaIdx((i) => Math.max(0, i - 1))}
                className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40"
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
                className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40"
              >
                <span>Próxima</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* PLANILHA DIGITAL ESPELHO: Desenho | Tul | Distância | Vel/TDN | Tempo | Observação */}
          <div className="overflow-hidden rounded-xl border-2 border-slate-900 bg-white text-slate-950 shadow-lg">
            {/* Table Column Header (explicit tracks prevent mobile cell overlap) */}
            <div className="grid grid-cols-[48px_24px_62px_40px_48px_minmax(0,1fr)] sm:grid-cols-[68px_40px_100px_76px_88px_minmax(0,1fr)] md:grid-cols-[84px_48px_118px_88px_104px_minmax(0,1fr)] border-b-2 border-slate-900 bg-slate-200 text-center text-[9px] font-bold text-slate-800 sm:text-xs">
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

            {/* Scrolling Rows (Active row starts directly on Tulipa 1 and stays visible!) */}
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
                  const hazard = hasHazardKeyword(t.notes);
                  const shownKm = t.displayKm ?? t.totalKm;
                  const diffKm = t.interKm;

                  // Remaining distance & regressive green bar percentage (T15Nav style)
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

                  // Live regularity indicator on the active row based on Tempo Ideal (Vel) or block countdown (Des/Neu)
                  const rowDelta = isActive && !isNonTimedSection
                    ? deltaSec ?? activeTulipaDeltaSec
                    : null;
                  const cellBorderClass = isActive
                    ? 'border-slate-900/40'
                    : 'border-slate-300';

                  return (
                    <div
                      key={`${t.tulipa}-${realIdx}`}
                      onClick={() => syncToTulipa(realIdx)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          syncToTulipa(realIdx);
                        }
                      }}
                      className={`grid cursor-pointer grid-cols-[48px_24px_62px_40px_48px_minmax(0,1fr)] sm:grid-cols-[68px_40px_100px_76px_88px_minmax(0,1fr)] md:grid-cols-[84px_48px_118px_88px_104px_minmax(0,1fr)] items-stretch transition-colors ${
                        isActive
                          ? 'bg-[#fde047] text-slate-950 ring-2 ring-inset ring-slate-950'
                          : isPassed
                            ? 'bg-sky-100/95 text-slate-900 hover:bg-sky-100'
                            : 'bg-white text-slate-950 hover:bg-amber-50/70'
                      }`}
                    >
                      {/* Col 1: Desenho */}
                      <div
                        className={`min-w-0 overflow-hidden flex items-center justify-center border-r p-0.5 sm:p-1.5 ${cellBorderClass} ${
                          isActive
                            ? 'bg-[#fde047]'
                            : isPassed
                              ? 'bg-sky-100/95'
                              : 'bg-white'
                        }`}
                      >
                        <TulipVectorIcon
                          cap={t.cap}
                          imageDataUrl={t.imageDataUrl}
                          active={isActive}
                          passed={isPassed}
                        />
                      </div>

                      {/* Col 2: Tul */}
                      <div className={`min-w-0 overflow-hidden flex flex-col items-center justify-center border-r px-0.5 py-1 font-mono text-[11px] font-black text-slate-950 tabular-nums sm:px-1 sm:py-2 sm:text-sm md:text-base ${cellBorderClass}`}>
                        <span className="leading-none">{t.tulipa}</span>
                        {isActive && (
                          <span className="hidden sm:inline-block mt-0.5 rounded-xs bg-slate-950 px-1 py-0.5 text-[8px] font-black tracking-wide uppercase text-[#fde047]">
                            VEZ
                          </span>
                        )}
                      </div>

                      {/* Col 3: Distância (Big KM + Diff below + T# | Des/Vel/Neu) */}
                      <div className={`min-w-0 overflow-hidden flex flex-col items-center justify-center border-r px-0.5 py-1 text-center font-mono tabular-nums sm:px-1 sm:py-1.5 ${cellBorderClass}`}>
                        <span className="max-w-full truncate text-[12px] font-black leading-none tracking-tighter text-slate-950 sm:text-base md:text-lg">
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
                        <div
                          className={`mt-0.5 w-full truncate rounded-xs px-0.5 py-0.5 text-[8.5px] font-bold leading-tight sm:px-1 sm:text-[10px] ${
                            isActive
                              ? 'bg-amber-300/90 text-slate-950 border border-slate-900/20'
                              : 'bg-slate-200/80 text-slate-700'
                          }`}
                        >
                          {t.section !== null ? `T${t.section}` : 'T-'} | {typeShortLabel(t.type)}
                        </div>
                      </div>

                      {/* Col 4: Vel/TDN */}
                      <div className={`min-w-0 overflow-hidden flex flex-col items-center justify-center border-r px-0.5 py-1 text-center font-mono tabular-nums sm:px-1 sm:py-2 ${cellBorderClass}`}>
                        <span
                          className={`max-w-full truncate leading-none ${
                            t.type === 'V'
                              ? 'text-[12px] font-black text-slate-950 sm:text-base md:text-lg'
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

                      {/* Col 5: Tempo (Ideal passage time + live Early/Late or D/N countdown badge on active row) */}
                      <div className={`min-w-0 overflow-hidden flex flex-col items-center justify-center border-r px-0.5 py-1 text-center font-mono tabular-nums sm:px-1 sm:py-1.5 ${cellBorderClass}`}>
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
                                  ? 'bg-sky-600 text-white'
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

                      {/* Col 6: Observação */}
                      <div className="min-w-0 overflow-hidden flex flex-col items-start justify-between gap-0.5 px-1.5 py-1 text-left sm:items-center sm:gap-1 sm:px-2 sm:py-1.5 sm:text-center">
                        {(() => {
                          const obsGraphic =
                            t.notesImageDataUrl ||
                            (!t.notes && t.imageIsComposite ? t.imageDataUrl : undefined);
                          return (
                            <>
                              {obsGraphic && (
                                <div className="w-full">
                                  <img
                                    src={obsGraphic}
                                    alt={`Observação tulipa ${t.tulipa}`}
                                    className={`w-full max-h-20 sm:max-h-24 object-contain object-left sm:object-center ${
                                      isActive || isPassed ? 'mix-blend-multiply' : ''
                                    }`}
                                  />
                                </div>
                              )}
                              {(t.notes || !obsGraphic) && (
                                <div className="flex w-full items-start gap-1 sm:justify-center">
                                  <p className="w-full text-[9.5px] font-extrabold leading-snug text-slate-950 whitespace-pre-line break-words uppercase sm:text-xs">
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
                              className="h-2.5 w-full overflow-hidden rounded-xs border-2 border-emerald-800 bg-white sm:h-3"
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
                            className="mt-0.5 rounded bg-slate-950 px-1.5 py-0.5 font-mono text-[8px] font-extrabold tracking-wide text-amber-300 hover:bg-slate-800 sm:mt-1 sm:px-2 sm:text-[9px]"
                          >
                            ZERAR / SINC.
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* T15Nav-inspired Bottom Manual Odometer Dock: F | - | Hodômetro & Passo | + | OK */}
          <div className="grid grid-cols-[54px_56px_minmax(0,1fr)_56px_64px] items-stretch gap-1 rounded-xl border-2 border-slate-800 bg-black p-1 shadow-lg sm:grid-cols-[72px_72px_minmax(0,1fr)_72px_84px] sm:gap-1.5 sm:p-1.5">
            <button
              type="button"
              onClick={() => setFunctionsOpen(true)}
              title="Abrir Funções do Navegador"
              className="flex min-h-[44px] flex-col items-center justify-center rounded-lg border border-slate-700 bg-slate-900 px-1 text-indigo-300 transition-colors hover:bg-slate-800 active:bg-slate-700"
            >
              <span className="text-[8px] font-bold tracking-wider text-slate-300 uppercase sm:text-[9px]">
                Função
              </span>
              <span className="font-mono text-lg font-black leading-none sm:text-xl">F</span>
            </button>

            <button
              type="button"
              onClick={() => adjustOdometer(-manualStepKm)}
              title={`Diminuir hodômetro manualmente em ${Math.round(manualStepKm * 1000)}m`}
              aria-label={`Diminuir hodômetro em ${Math.round(manualStepKm * 1000)} metros`}
              className="flex min-h-[44px] items-center justify-center rounded-lg border border-slate-700 bg-slate-900 font-mono text-2xl font-black text-indigo-300 transition-colors hover:bg-slate-800 active:bg-slate-700 sm:text-3xl"
            >
              −
            </button>

            <button
              type="button"
              onClick={() =>
                setManualStepKm((s) => (s === 0.01 ? 0.05 : s === 0.05 ? 0.1 : 0.01))
              }
              title="Toque para alternar o incremento manual (±10m, ±50m, ±100m)"
              className="min-w-0 flex min-h-[44px] flex-col items-center justify-center rounded-lg border border-slate-700 bg-gradient-to-b from-slate-800 to-slate-950 px-2 text-center text-white transition-colors hover:border-slate-600"
            >
              <span className="truncate font-mono text-sm font-black leading-tight tabular-nums text-sky-300 sm:text-lg">
                {(() => {
                  const sectionResetBase = currentTulipa
                    ? currentTulipa.totalKm - (currentTulipa.displayKm ?? currentTulipa.totalKm)
                    : 0;
                  const displayOdo = Math.max(0, odometerKm - sectionResetBase);
                  return `${displayOdo.toFixed(3).replace('.', ',')} km`;
                })()}
              </span>
              <span className="font-mono text-[9px] font-bold text-slate-300 uppercase sm:text-[10px]">
                Passo ±{Math.round(manualStepKm * 1000)}m
              </span>
            </button>

            <button
              type="button"
              onClick={() => adjustOdometer(manualStepKm)}
              title={`Aumentar hodômetro manualmente em ${Math.round(manualStepKm * 1000)}m`}
              aria-label={`Aumentar hodômetro em ${Math.round(manualStepKm * 1000)} metros`}
              className="flex min-h-[44px] items-center justify-center rounded-lg border border-slate-700 bg-slate-900 font-mono text-2xl font-black text-indigo-300 transition-colors hover:bg-slate-800 active:bg-slate-700 sm:text-3xl"
            >
              +
            </button>

            <button
              type="button"
              onClick={() => syncToTulipa(activeTulipaIdx)}
              title="Sincronizar hodômetro com a tulipa atual (OK / Lap)"
              className="flex min-h-[44px] flex-col items-center justify-center rounded-lg border-2 border-amber-200 bg-amber-400 px-1 text-slate-950 transition-colors hover:bg-amber-300 active:bg-amber-500"
            >
              <span className="font-mono text-base font-black leading-none sm:text-lg">OK</span>
              <span className="text-[8px] font-extrabold tracking-wide uppercase sm:text-[9px]">
                Lap
              </span>
            </button>
          </div>
        </div>
      )}

      {/* --- TOTEM FUNCTIONS POPUP MODAL (FUNÇÕES) --- */}
      {functionsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-xs">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-800 bg-[#12161f] text-slate-100 shadow-2xl">
            <div aria-hidden="true" className="h-1.5 w-full rally-track-stripe" />
            <div className="p-6">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="h-5 w-5 text-orange-500" />
                  <h3 className="font-['Barlow_Condensed'] text-2xl font-bold italic text-white">
                    Funções do Navegador (Totem)
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setFunctionsOpen(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
                  aria-label="Fechar funções"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="mt-5 space-y-5 text-sm">
                {/* 1. Hora de Largada */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300">
                    Hora Oficial de Largada (HH:MM:SS)
                  </label>
                  <div className="mt-1.5 flex gap-2">
                    <input
                      type="time"
                      step="1"
                      value={startTimeStr}
                      onChange={(e) => setStartTimeStr(e.target.value)}
                      className="flex-1 min-h-[42px] rounded-xl border border-slate-700 bg-[#0a0d13] px-3 font-mono text-sm font-semibold text-white focus:border-orange-500 focus:outline-none"
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
                      className="min-h-[42px] rounded-xl border border-slate-700 bg-slate-900 px-3.5 text-xs font-semibold text-slate-200 hover:bg-slate-800"
                    >
                      <Clock className="inline h-3.5 w-3.5 mr-1 text-orange-400" />
                      Agora
                    </button>
                  </div>
                </div>

                {/* 2. Aferição de Pneu / Marco KM */}
                <div>
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                    <span>Aferição de Hodômetro (%)</span>
                    <span className="font-mono text-orange-400">{calibrationPct.toFixed(1)}%</span>
                  </div>
                  <input
                    type="range"
                    min={90}
                    max={110}
                    step={0.1}
                    value={calibrationPct}
                    onChange={(e) => setCalibrationPct(Number(e.target.value))}
                    className="mt-2 h-1.5 w-full cursor-pointer appearance-none rounded bg-slate-800 accent-orange-500"
                  />
                  <div className="mt-2.5 flex gap-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="Km oficial de aferição (ex: 10.00)"
                      value={officialMarcoKm}
                      onChange={(e) => setOfficialMarcoKm(e.target.value)}
                      className="flex-1 min-h-[40px] rounded-xl border border-slate-700 bg-[#0a0d13] px-3 font-mono text-xs text-white placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleCalibrateByMarco}
                      className="min-h-[40px] rounded-xl border border-slate-700 bg-slate-900 px-3.5 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap"
                    >
                      Aferir pelo Marco
                    </button>
                  </div>
                </div>

                {/* 3. Antecipação de Troca de Referência */}
                <div>
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                    <span>Troca Antecipada de Referência (metros antes da tulipa)</span>
                    <span className="font-mono text-orange-400">{transitionAdvanceM}m</span>
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    {[0, 2, 5, 10, 15, 20, 30, 50].map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setTransitionAdvanceM(m)}
                        className={`min-h-[36px] rounded-lg font-mono text-xs font-semibold ${
                          transitionAdvanceM === m
                            ? 'bg-orange-600 text-white'
                            : 'border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                        }`}
                      >
                        {m}m
                      </button>
                    ))}
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={50}
                    step={1}
                    value={transitionAdvanceM}
                    onChange={(e) => setTransitionAdvanceM(Number(e.target.value))}
                    className="mt-2.5 h-1.5 w-full cursor-pointer appearance-none rounded bg-slate-800 accent-orange-500"
                  />
                </div>

                {/* 4. Ir para Tulipa / Reposicionar */}
                <div>
                  <span className="block text-xs font-semibold text-slate-300">
                    Ir para Referência / Reposicionar
                  </span>
                  <div className="mt-1.5 flex gap-2">
                    <input
                      type="number"
                      placeholder="Nº da tulipa (ex: 27)"
                      value={jumpTulipaNum}
                      onChange={(e) => setJumpTulipaNum(e.target.value)}
                      className="flex-1 min-h-[40px] rounded-xl border border-slate-700 bg-[#0a0d13] px-3 font-mono text-xs text-white placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleJumpToTulipa}
                      className="min-h-[40px] rounded-xl border border-slate-700 bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-slate-800"
                    >
                      Ir e Sincronizar
                    </button>
                  </div>
                </div>

                {/* 5. Base Interna / Abrir Outro Arquivo */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setLastActiveRoadbookId(null);
                      setRoadbook(null);
                      setIsRunning(false);
                      setFunctionsOpen(false);
                    }}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3.5 text-xs font-semibold text-slate-200 hover:bg-slate-800"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Base Interna / Outro Arquivo</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setFunctionsOpen(false)}
                    className="min-h-[40px] rounded-xl px-5 text-xs font-extrabold tracking-wide text-white uppercase rally-btn-orange"
                  >
                    Concluir
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
