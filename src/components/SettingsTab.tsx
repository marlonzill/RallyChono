import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Geolocation } from '@capacitor/geolocation';
import { Share } from '@capacitor/share';
import {
  ArrowLeft,
  Battery,
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Bluetooth,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  Database,
  Download,
  Eye,
  FileSearch,
  FileText,
  Keyboard,
  Link2,
  Navigation,
  Radio,
  RefreshCw,
  RotateCcw,
  Ruler,
  Satellite,
  Server,
  ShieldAlert,
  Smartphone,
  Trash2,
  Upload,
  UploadCloud,
  Volume2,
} from 'lucide-react';
import type { SettingsSubMenu } from '../App';
import type { ParsedRoadbook } from '../types/rally';
import {
  checkBaseServerHealth,
  getPendingSubmissions,
  submitCollectorResultToBase,
  type PendingSubmissionPayload,
} from '../utils/baseApi';
import {
  type AlertStyle,
  calibrationPctFromWValue,
  getDefaultPilotDisplay,
  getDefaultShortcuts,
  type HighlightTheme,
  type ShortcutBindings,
  useNavSettings,
  wValueFromCalibrationPct,
} from '../utils/navSettings';
import {
  connectPairingRoom,
  generatePairingRoomCode,
  normalizeRoomCode,
  type PairingPresenceState,
} from '../utils/pairingClient';
import {
  extractRoadbookDiagnosticDataTxt,
  inspectRoadbookFileStructure,
  parseNavigationBuffer,
  type ImportFormatHint,
} from '../utils/roadbookFormats';
import {
  deleteSavedRoadbook,
  getLastActiveRoadbookId,
  listSavedRoadbooks,
  saveConvertedRoadbook,
  setLastActiveRoadbookId,
} from '../utils/roadbookStorage';

interface SettingsTabProps {
  initialMenu?: SettingsSubMenu;
  onMenuChange?: (menu: SettingsSubMenu) => void;
  onOpenNavigation?: () => void;
}

interface BatteryManagerLike extends EventTarget {
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
  level: number;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManagerLike>;
  bluetooth?: {
    requestDevice: (opts: { acceptAllDevices?: boolean; optionalServices?: string[] }) => Promise<{
      name?: string;
      id?: string;
    }>;
  };
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
    hint: 'Compatibilidade aberta para planilhas exportadas em texto.',
  },
];

function getGpsQuality(accuracyM: number | null): {
  bars: number;
  label: string;
  toneClass: string;
  barClass: string;
} {
  if (accuracyM === null) {
    return { bars: 0, label: 'Aguardando', toneClass: 'text-[#B5B5B5]', barClass: 'bg-zinc-700' };
  }
  if (accuracyM <= 5) {
    return { bars: 5, label: 'Excelente', toneClass: 'text-emerald-400', barClass: 'bg-emerald-400' };
  }
  if (accuracyM <= 10) {
    return { bars: 4, label: 'Ótimo', toneClass: 'text-emerald-400', barClass: 'bg-emerald-400' };
  }
  if (accuracyM <= 20) {
    return { bars: 3, label: 'Bom', toneClass: 'text-amber-400', barClass: 'bg-amber-400' };
  }
  if (accuracyM <= 40) {
    return { bars: 2, label: 'Fraco', toneClass: 'text-[#C0C4C9]', barClass: 'bg-[#C0C4C9]' };
  }
  return { bars: 1, label: 'Instável', toneClass: 'text-[#FF2A2A]', barClass: 'bg-[#E10600]' };
}

function formatClockOnly(tsMs: number): string {
  const d = new Date(tsMs);
  return [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join(':');
}

function formatKeyLabel(key: string): string {
  if (!key) return 'Não definido';
  if (key === ' ') return 'Espaço';
  if (key === 'ArrowUp') return 'Seta ↑ / Vol+';
  if (key === 'ArrowDown') return 'Seta ↓ / Vol-';
  if (key === 'ArrowRight') return 'Seta →';
  if (key === 'ArrowLeft') return 'Seta ←';
  return key.length === 1 ? key.toUpperCase() : key;
}

function testAlertSound(style: AlertStyle) {
  if (style === 'vibration') {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([140, 60, 140]);
    }
    return;
  }
  if (style === 'voice') {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance('Cinquenta metros, referência a seguir.');
        u.lang = 'pt-BR';
        u.rate = 1.12;
        window.speechSynthesis.speak(u);
      } catch {
        // Ignore TTS blocks
      }
    }
    return;
  }
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = style === 'beep_long' ? 880 : 1040;
    gain.gain.value = 0.16;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const durSec = style === 'beep_long' ? 0.34 : 0.09;
    osc.start();
    osc.stop(ctx.currentTime + durSec);
    window.setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch {
    // Ignore audio context restriction
  }
}

export const SettingsTab: React.FC<SettingsTabProps> = ({
  initialMenu = 'hub',
  onMenuChange,
  onOpenNavigation,
}) => {
  const [settings, updateSettings] = useNavSettings();
  const [activeMenu, setActiveMenu] = useState<SettingsSubMenu>(initialMenu);

  useEffect(() => {
    setActiveMenu(initialMenu);
  }, [initialMenu]);

  const navigateMenu = (menu: SettingsSubMenu) => {
    setActiveMenu(menu);
    onMenuChange?.(menu);
  };

  // Roadbooks management state
  const [savedRoadbooks, setSavedRoadbooks] = useState<ParsedRoadbook[]>([]);
  const [activeRoadbookId, setActiveRoadbookId] = useState<string | null>(() =>
    getLastActiveRoadbookId()
  );
  const [importFormat, setImportFormat] = useState<ImportFormatHint>('nbp');
  const [rbError, setRbError] = useState<string | null>(null);
  const [rbSuccess, setRbSuccess] = useState<string | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);
  const [fileStructureReport, setFileStructureReport] = useState<string | null>(null);
  const [diagnosticTxtData, setDiagnosticTxtData] = useState<{
    fileName: string;
    content: string;
  } | null>(null);
  const [showStructureReport, setShowStructureReport] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);

  const refreshSavedRoadbooks = useCallback(async () => {
    const list = await listSavedRoadbooks();
    setSavedRoadbooks(list);
    setActiveRoadbookId(getLastActiveRoadbookId());
  }, []);

  useEffect(() => {
    refreshSavedRoadbooks();
  }, [refreshSavedRoadbooks]);

  const handleActivateRoadbook = (rb: ParsedRoadbook, goNav = false) => {
    if (rb.id) {
      setLastActiveRoadbookId(rb.id);
      setActiveRoadbookId(rb.id);
      window.dispatchEvent(new CustomEvent('pitstop:roadbook-activated', { detail: rb.id }));
      setRbSuccess(`Planilha "${rb.eventName}" ativada para navegação.`);
      if (goNav) {
        onOpenNavigation?.();
      }
    }
  };

  const handleRoadbookFile = async (file: File) => {
    setRbError(null);
    setRbSuccess(null);
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
      await refreshSavedRoadbooks();
      window.dispatchEvent(new CustomEvent('pitstop:roadbook-activated', { detail: stored.id }));
      setRbSuccess(
        `"${stored.eventName}" importada (${stored.tulipas.length} refs · ${stored.totalKm.toFixed(2)} km) e definida como ativa.`
      );
      if ((stored.raceParameters?.notesCount ?? 0) === 0 || stored.totalKm < 0.5) {
        setShowStructureReport(true);
      }
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
      setRbError(
        err instanceof Error
          ? err.message
          : 'Não foi possível ler o arquivo da planilha.'
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

  const handleLoadSample = async () => {
    setRbError(null);
    setRbSuccess(null);
    setLoadingSample(true);
    try {
      const res = await fetch('/assets/aistudio/rally_escoteiros_merged_66a34567.txt');
      if (!res.ok) throw new Error('Planilha modelo não encontrada.');
      const buffer = await res.arrayBuffer();
      const parsed = await parseNavigationBuffer(buffer, 'rally_escoteiros_merged.txt');
      const stored = await saveConvertedRoadbook(parsed);
      await refreshSavedRoadbooks();
      window.dispatchEvent(new CustomEvent('pitstop:roadbook-activated', { detail: stored.id }));
      setRbSuccess(`Planilha modelo "${stored.eventName}" carregada e ativada.`);
    } catch (err) {
      setRbError(err instanceof Error ? err.message : 'Erro ao carregar modelo.');
    } finally {
      setLoadingSample(false);
    }
  };

  const handleDeleteSaved = async (id: string) => {
    await deleteSavedRoadbook(id);
    await refreshSavedRoadbooks();
    window.dispatchEvent(new CustomEvent('pitstop:roadbook-activated', { detail: getLastActiveRoadbookId() }));
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

  // GPS & Battery state
  const [gps, setGps] = useState<{
    status: 'searching' | 'active' | 'denied' | 'error';
    accuracyM: number | null;
    lat: number | null;
    lon: number | null;
    updatedAtMs: number | null;
    message?: string;
  }>({
    status: 'searching',
    accuracyM: null,
    lat: null,
    lon: null,
    updatedAtMs: null,
  });
  const [refreshingGps, setRefreshingGps] = useState(false);

  const [battery, setBattery] = useState<{
    supported: boolean;
    levelPct: number | null;
    charging: boolean;
  }>({
    supported: true,
    levelPct: null,
    charging: false,
  });

  // W Fino direct edit & pass calculator state
  const [editingW, setEditingW] = useState(false);
  const [wInputText, setWInputText] = useState('');
  const [passOfficialM, setPassOfficialM] = useState('1000');
  const [passMeasuredM, setPassMeasuredM] = useState('');

  // Cantada thresholds
  const [thresholdsInput, setThresholdsInput] = useState(() =>
    settings.voiceThresholds.join(', ')
  );

  // Hotkey capture state
  const [capturingShortcut, setCapturingShortcut] = useState<keyof ShortcutBindings | null>(null);

  // Real-time pairing + Bluetooth + Wake Lock state
  const [pairingPresence, setPairingPresence] = useState<PairingPresenceState>({
    status: 'disconnected',
    navigators: 0,
    pilots: 0,
    transport: 'none',
  });
  const [btStatusMsg, setBtStatusMsg] = useState<string | null>(null);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const wakeLockSentinelRef = useRef<{ release: () => Promise<void> } | null>(null);

  // Clock & Base server state
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [clockSyncFeedback, setClockSyncFeedback] = useState<string | null>(null);
  const [healthState, setHealthState] = useState<{
    checking: boolean;
    ok?: boolean;
    message?: string;
  }>({ checking: false });
  const [pendingQueue, setPendingQueue] = useState<PendingSubmissionPayload[]>(() =>
    getPendingSubmissions()
  );
  const [retryingQueue, setRetryingQueue] = useState(false);

  useEffect(() => {
    setThresholdsInput(settings.voiceThresholds.join(', '));
  }, [settings.voiceThresholds]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  // Battery Monitor
  useEffect(() => {
    const nav = navigator as NavigatorWithBattery;
    if (typeof nav.getBattery !== 'function') {
      setBattery({ supported: false, levelPct: null, charging: false });
      return;
    }
    let mounted = true;
    let manager: BatteryManagerLike | null = null;
    const syncBattery = () => {
      if (!mounted || !manager) return;
      setBattery({
        supported: true,
        levelPct: Math.round(manager.level * 100),
        charging: manager.charging,
      });
    };
    nav
      .getBattery()
      .then((bm) => {
        if (!mounted) return;
        manager = bm;
        syncBattery();
        bm.addEventListener('levelchange', syncBattery);
        bm.addEventListener('chargingchange', syncBattery);
      })
      .catch(() => {
        if (mounted) setBattery({ supported: false, levelPct: null, charging: false });
      });
    return () => {
      mounted = false;
      if (manager) {
        manager.removeEventListener('levelchange', syncBattery);
        manager.removeEventListener('chargingchange', syncBattery);
      }
    };
  }, []);

  // Live GPS Telemetry Monitor
  const readSingleGpsFix = useCallback(async () => {
    setRefreshingGps(true);
    try {
      if (Capacitor.isNativePlatform()) {
        const perm = await Geolocation.requestPermissions();
        if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
          setGps((prev) => ({
            ...prev,
            status: 'denied',
            message: 'Permissão de localização negada no Android.',
          }));
          return;
        }
        const pos = await Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 10000,
        });
        setGps({
          status: 'active',
          accuracyM: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null,
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          updatedAtMs: pos.timestamp || Date.now(),
        });
      } else if ('geolocation' in navigator) {
        await new Promise<void>((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              setGps({
                status: 'active',
                accuracyM: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null,
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                updatedAtMs: pos.timestamp || Date.now(),
              });
              resolve();
            },
            (err) => {
              setGps((prev) => ({
                ...prev,
                status: err.code === 1 ? 'denied' : 'error',
                message:
                  err.code === 1
                    ? 'Permissão de localização bloqueada no navegador.'
                    : 'Sinal GPS indisponível em ambiente fechado.',
              }));
              resolve();
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 1500 }
          );
        });
      }
    } finally {
      setRefreshingGps(false);
    }
  }, []);

  useEffect(() => {
    readSingleGpsFix();
  }, [readSingleGpsFix]);

  // Live Pairing Connection Monitor when pairing enabled
  useEffect(() => {
    if (!settings.pairing.enabled || !settings.pairing.roomCode) {
      setPairingPresence({
        status: 'disconnected',
        navigators: 0,
        pilots: 0,
        transport: 'none',
      });
      return;
    }
    const conn = connectPairingRoom({
      roomCode: settings.pairing.roomCode,
      role: settings.pairing.role,
      onTelemetry: () => {},
      onPresence: (p) => setPairingPresence(p),
    });
    return () => conn.close();
  }, [settings.pairing.enabled, settings.pairing.role, settings.pairing.roomCode]);

  // Global key listener when capturing a shortcut binding
  useEffect(() => {
    if (!capturingShortcut) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturingShortcut(null);
        return;
      }
      updateSettings((prev) => ({
        ...prev,
        shortcuts: {
          ...prev.shortcuts,
          [capturingShortcut]: e.key,
        },
      }));
      setCapturingShortcut(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturingShortcut, updateSettings]);

  const handleSelectBluetoothDevice = async () => {
    setBtStatusMsg(null);
    const nav = navigator as NavigatorWithBattery;
    if (nav.bluetooth && typeof nav.bluetooth.requestDevice === 'function') {
      try {
        const device = await nav.bluetooth.requestDevice({ acceptAllDevices: true });
        const devName = device.name || device.id || 'Dispositivo Bluetooth';
        updateSettings({
          pairing: { ...settings.pairing, bluetoothDeviceName: devName },
        });
        setBtStatusMsg(`Dispositivo selecionado: ${devName}.`);
        return;
      } catch (err) {
        if (err instanceof Error && err.name === 'NotFoundError') {
          setBtStatusMsg('Seleção cancelada.');
          return;
        }
      }
    }
    setBtStatusMsg(
      'No celular Android/iOS, pareie os aparelhos em Ajustes > Bluetooth com "Vínculo Bluetooth (Tethering)" ativo e informe o mesmo Código da Dupla acima.'
    );
  };

  const handleToggleWakeLock = async () => {
    const nav = navigator as NavigatorWithBattery;
    if (wakeLockActive && wakeLockSentinelRef.current) {
      await wakeLockSentinelRef.current.release().catch(() => {});
      wakeLockSentinelRef.current = null;
      setWakeLockActive(false);
      return;
    }
    if (nav.wakeLock && typeof nav.wakeLock.request === 'function') {
      try {
        const sentinel = await nav.wakeLock.request('screen');
        wakeLockSentinelRef.current = sentinel;
        setWakeLockActive(true);
        sentinel.addEventListener('release', () => setWakeLockActive(false));
        return;
      } catch {
        // Ignore unsupported wake lock
      }
    }
    setWakeLockActive((v) => !v);
  };

  const activeW = wValueFromCalibrationPct(settings.calibrationPct, settings.wBaseValue);
  const gpsQuality = getGpsQuality(gps.accuracyM);

  const handleOpenWEditor = () => {
    setWInputText(
      settings.sensorMode === 'blue' ? String(activeW) : settings.calibrationPct.toFixed(2)
    );
    setEditingW(true);
  };

  const handleCommitWEditor = () => {
    const cleaned = Number(wInputText.replace(',', '.').trim());
    if (Number.isFinite(cleaned) && cleaned > 0) {
      if (settings.sensorMode === 'blue') {
        updateSettings({
          calibrationPct: calibrationPctFromWValue(cleaned, settings.wBaseValue),
        });
      } else {
        updateSettings({
          calibrationPct: Number(Math.min(130, Math.max(70, cleaned)).toFixed(2)),
        });
      }
    }
    setEditingW(false);
  };

  const handleAdjustCalPct = (delta: number) => {
    const next = Math.min(130, Math.max(70, Number((settings.calibrationPct + delta).toFixed(2))));
    updateSettings({ calibrationPct: next });
  };

  const handleAddCalibrationPass = () => {
    const offM = Number(passOfficialM.replace(',', '.'));
    const measM = Number(passMeasuredM.replace(',', '.'));
    if (!Number.isFinite(offM) || offM <= 0 || !Number.isFinite(measM) || measM <= 0) return;

    const currentW = wValueFromCalibrationPct(settings.calibrationPct, settings.wBaseValue);
    const suggestedW = Math.round(currentW * (offM / measM));
    const entry = {
      id: `p_${Date.now()}`,
      officialM: offM,
      measuredM: measM,
      suggestedW,
    };
    updateSettings((prev) => ({
      ...prev,
      wPasses: [...prev.wPasses, entry].slice(-3),
    }));
    setPassMeasuredM('');
  };

  const averageCalibrationSuggestion = useMemo(() => {
    if (settings.wPasses.length === 0) return null;
    const totalOff = settings.wPasses.reduce((acc, p) => acc + p.officialM, 0);
    const totalMeas = settings.wPasses.reduce((acc, p) => acc + p.measuredM, 0);
    const avgW = Math.round(
      settings.wPasses.reduce((acc, p) => acc + p.suggestedW, 0) / settings.wPasses.length
    );
    const avgPct = calibrationPctFromWValue(avgW, settings.wBaseValue);
    const errorMPerKm = totalOff > 0 ? ((totalMeas - totalOff) / totalOff) * 1000 : 0;
    return { avgW, avgPct, errorMPerKm };
  }, [settings.wPasses, settings.wBaseValue]);

  const handleApplyAverageW = () => {
    if (!averageCalibrationSuggestion) return;
    updateSettings({ calibrationPct: averageCalibrationSuggestion.avgPct });
  };

  const handleSyncGpsClock = () => {
    setClockSyncFeedback('Buscando pulso de relógio GPS...');
    if (!('geolocation' in navigator)) {
      setClockSyncFeedback('GPS indisponível.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const gpsTs = pos.timestamp || Date.now();
        const offset = gpsTs - Date.now();
        updateSettings({ clockOffsetMs: offset });
        setClockSyncFeedback(
          `Relógio sincronizado (${offset >= 0 ? '+' : ''}${Math.round(offset)} ms)`
        );
      },
      () => {
        updateSettings({ clockOffsetMs: 0 });
        setClockSyncFeedback('Sincronizado com hora oficial do aparelho.');
      },
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 }
    );
  };

  const handleCommitThresholds = (rawText: string) => {
    const parsed = rawText
      .split(/[,;\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => b - a);
    if (parsed.length > 0) {
      updateSettings({ voiceThresholds: parsed });
    }
  };

  const handleTestBaseConnection = async () => {
    setHealthState({ checking: true });
    const res = await checkBaseServerHealth();
    if (res.ok) {
      setHealthState({
        checking: false,
        ok: true,
        message: `Base conectada (${res.submissionsCount ?? 0} coletas recebidas).`,
      });
    } else {
      setHealthState({
        checking: false,
        ok: false,
        message: res.error || 'Base inacessível no momento.',
      });
    }
  };

  const handleRetryQueue = async () => {
    if (pendingQueue.length === 0) return;
    setRetryingQueue(true);
    try {
      for (const item of pendingQueue) {
        await submitCollectorResultToBase(item);
      }
      setPendingQueue(getPendingSubmissions());
    } finally {
      setRetryingQueue(false);
    }
  };

  const renderBatteryIcon = () => {
    if (battery.charging) return <BatteryCharging className="h-4 w-4 text-emerald-400" />;
    if (battery.levelPct === null) return <Battery className="h-4 w-4 text-[#C0C4C9]" />;
    if (battery.levelPct <= 15) return <BatteryWarning className="h-4 w-4 text-[#FF2A2A]" />;
    if (battery.levelPct <= 30) return <BatteryLow className="h-4 w-4 text-amber-400" />;
    if (battery.levelPct <= 70) return <BatteryMedium className="h-4 w-4 text-[#C0C4C9]" />;
    return <BatteryFull className="h-4 w-4 text-emerald-400" />;
  };

  const activeRoadbookItem = savedRoadbooks.find((r) => r.id === activeRoadbookId) ?? null;
  const pilotActiveCount = Object.values(settings.pilotDisplay).filter(Boolean).length;

  const menuTitleMap: Record<Exclude<SettingsSubMenu, 'hub'>, string> = {
    roadbooks: 'Planilhas & Livros de Bordo',
    pairing: 'Pareamento Navegador ↔ Piloto',
    pilot: 'Tela do Piloto (Personalização)',
    calibration: 'Aferição do Hodômetro & W Fino',
    alerts: 'Alertas, Road Book & Atalhos',
    system: 'Sistema, GPS, Bateria & Base',
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 text-[#F4F4F4]">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
        <div className="flex items-center gap-2.5">
          {activeMenu !== 'hub' && (
            <button
              type="button"
              onClick={() => navigateMenu('hub')}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-[#111214] px-3 text-xs font-bold text-[#F4F4F4] hover:border-zinc-500"
            >
              <ArrowLeft className="h-4 w-4 text-[#E10600]" />
              <span>Menus</span>
            </button>
          )}
          <div>
            <p className="font-mono text-[10px] font-bold tracking-[0.2em] text-[#E10600] uppercase">
              Configurações PitStop Sports
            </p>
            <h1 className="font-['Barlow_Condensed'] text-2xl font-extrabold italic tracking-wide text-white uppercase sm:text-3xl">
              {activeMenu === 'hub' ? 'Central de Configurações' : menuTitleMap[activeMenu]}
            </h1>
          </div>
        </div>
        <span className="font-mono text-xs font-semibold text-[#C0C4C9] tabular-nums">
          Hora: {formatClockOnly(nowMs + settings.clockOffsetMs)}
        </span>
      </div>

      {/* MENU HUB */}
      {activeMenu === 'hub' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[
            {
              id: 'roadbooks' as const,
              icon: Database,
              title: 'Planilhas & Livros de Bordo',
              subtitle: activeRoadbookItem
                ? `Ativa: ${activeRoadbookItem.eventName} (${savedRoadbooks.length} salvas)`
                : `${savedRoadbooks.length} planilha(s) offline · Importar .NBP / .TXT`,
            },
            {
              id: 'pairing' as const,
              icon: Link2,
              title: 'Pareamento Navegador ↔ Piloto',
              subtitle: settings.pairing.enabled
                ? `Ativo (${settings.pairing.role === 'navigator' ? 'Mestre' : 'Escravo'}) · Sala ${settings.pairing.roomCode}`
                : 'Desligado · Bluetooth, Wi-Fi / Hotspot & Checklist',
            },
            {
              id: 'pilot' as const,
              icon: Eye,
              title: 'Tela do Piloto (Personalização)',
              subtitle: `${pilotActiveCount}/11 indicadores visíveis · Barra de cores e presets`,
            },
            {
              id: 'calibration' as const,
              icon: Ruler,
              title: 'Aferição Hodômetro & W Fino',
              subtitle:
                settings.sensorMode === 'blue'
                  ? `Sensor Blue · W ${activeW} · Passagens 1/2/3`
                  : `GPS CAL ${settings.calibrationPct.toFixed(2)}% · Passagens 1/2/3`,
            },
            {
              id: 'alerts' as const,
              icon: Volume2,
              title: 'Alertas, Road Book & Atalhos',
              subtitle: `Alerta: ${settings.alertStyle === 'voice' ? 'Voz pt-BR' : settings.alertStyle} · Linha ${settings.activeRowLine} · Bluetooth`,
            },
            {
              id: 'system' as const,
              icon: Satellite,
              title: 'Sistema, GPS, Bateria & Base',
              subtitle: `${gps.status === 'active' ? `GPS ±${gps.accuracyM ?? '--'}m` : 'GPS aguardando'} · Bateria ${battery.levelPct ?? '--'}% · Base PitStop`,
            },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateMenu(item.id)}
                className="flex min-h-[78px] items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-[#111214] p-4 text-left transition-colors hover:border-[#E10600]/70 hover:bg-[#16181c] active:scale-[0.99]"
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-700 bg-[#080B0D] text-[#E10600]">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide text-white uppercase sm:text-xl">
                      {item.title}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-[#B5B5B5]">
                      {item.subtitle}
                    </div>
                  </div>
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-zinc-500" />
              </button>
            );
          })}
        </div>
      )}

      {/* SUBMENU 1: PLANILHAS & LIVROS DE BORDO */}
      {activeMenu === 'roadbooks' && (
        <div className="space-y-4">
          <section className="rounded-xl border border-zinc-800 bg-[#111214] p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold text-white uppercase">
                  Importar Planilha (.NBP / .NBP.ZIP / .TXT)
                </h2>
                <p className="mt-0.5 text-xs text-[#B5B5B5]">
                  Importe ou troque seus livros de bordo em um só lugar para navegar offline.
                </p>
              </div>
              <button
                type="button"
                onClick={handleLoadSample}
                disabled={loadingSample}
                className="pitstop-btn-metal inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3.5 text-xs font-bold whitespace-nowrap shrink-0"
              >
                <FileText className="h-4 w-4 text-[#E10600]" />
                <span>{loadingSample ? 'Carregando...' : 'Testar com Modelo'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {IMPORT_FORMAT_OPTIONS.map((opt) => {
                const selected = importFormat === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setImportFormat(opt.id);
                      setRbError(null);
                    }}
                    className={`flex items-center justify-between rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
                      selected
                        ? 'border-[#E10600] bg-[#E10600]/15 text-white'
                        : 'border-zinc-800 bg-[#080B0D] text-[#C0C4C9] hover:border-zinc-700'
                    }`}
                  >
                    <div>
                      <div className="text-xs font-bold">{opt.label}</div>
                      <div className="mt-0.5 text-[11px] text-[#B5B5B5]">{opt.hint}</div>
                    </div>
                    <span className="ml-3 font-mono text-[11px] font-bold text-[#E10600] shrink-0">
                      {opt.ext}
                    </span>
                  </button>
                );
              })}
            </div>

            <label className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-700 bg-[#080B0D] px-5 py-6 text-center transition-colors hover:border-[#E10600] hover:bg-[#E10600]/5">
              <Upload className="h-7 w-7 text-[#E10600]" />
              <span className="mt-2 text-sm font-bold text-white">
                {importFormat === 'nbp'
                  ? 'Selecionar Planilha Digital .NBP / .NBP.ZIP (T15)'
                  : 'Selecionar Planilha (.NBP, .ZIP, .TXT, .CSV, .XML)'}
              </span>
              <span className="mt-1 text-xs text-[#B5B5B5]">
                Converte tulipas (desde 0,00), distâncias, médias, tempos ideais e observações.
              </span>
              <input
                type="file"
                accept=".nbp,.zip,.txt,.csv,.xml,.gpx,.json,.db,.sqlite,.sqlite3,application/zip"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleRoadbookFile(f);
                  e.currentTarget.value = '';
                }}
              />
            </label>

            {rbError && (
              <div className="flex items-start gap-2 rounded-lg border border-red-800/70 bg-red-950/50 p-3 text-xs text-red-200">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#FF2A2A]" />
                <span>{rbError}</span>
              </div>
            )}

            {rbSuccess && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-3 text-xs text-emerald-200">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                  <span>{rbSuccess}</span>
                </div>
                {onOpenNavigation && (
                  <button
                    type="button"
                    onClick={onOpenNavigation}
                    className="pitstop-btn-red inline-flex min-h-[34px] items-center gap-1.5 rounded-lg px-3 text-xs font-extrabold text-white uppercase"
                  >
                    <Navigation className="h-3.5 w-3.5" />
                    <span>Ir para Navegação</span>
                  </button>
                )}
              </div>
            )}

            {/* Diagnostic .NBP structure inspector */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-[#080B0D] px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-xs text-[#B5B5B5]">
                <FileSearch className="h-4 w-4 text-[#C0C4C9] shrink-0" />
                <span>Inspeção técnica do arquivo .NBP / .NBP.ZIP</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="pitstop-btn-metal inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold">
                  <FileSearch className="h-3.5 w-3.5 text-[#E10600]" />
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
                    className="rounded-lg border border-zinc-700 bg-[#1E1E22] px-3 py-1.5 text-[11px] font-semibold text-white"
                  >
                    {showStructureReport ? 'Ocultar' : 'Ver Estrutura'}
                  </button>
                )}
              </div>
            </div>

            {showStructureReport && fileStructureReport && (
              <div className="rounded-lg border border-zinc-800 bg-black p-3.5">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[11px] font-bold text-[#E10600] uppercase">
                    Estrutura Detectada
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handleDownloadDiagnosticTxt}
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-[#1E1E22] px-2.5 py-1 text-[11px] font-semibold text-[#C0C4C9]"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Baixar .TXT</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCopyStructureReport}
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-[#1E1E22] px-2.5 py-1 text-[11px] font-semibold text-[#C0C4C9]"
                    >
                      {copiedReport ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5 text-[#E10600]" />}
                      <span>{copiedReport ? 'Copiado' : 'Copiar'}</span>
                    </button>
                  </div>
                </div>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-[#C0C4C9]">
                  {fileStructureReport}
                </pre>
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-xl border border-zinc-800 bg-[#111214]">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-[#E10600]" />
                <h3 className="font-['Barlow_Condensed'] text-lg font-bold text-white uppercase">
                  Livros de Bordo Salvos ({savedRoadbooks.length})
                </h3>
              </div>
              <span className="text-[11px] text-[#B5B5B5]">Base offline</span>
            </div>

            {savedRoadbooks.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#B5B5B5]">
                Nenhuma planilha importada ainda. Envie um arquivo .NBP ou carregue o modelo acima.
              </div>
            ) : (
              <div className="divide-y divide-zinc-800/80">
                {savedRoadbooks.map((item) => {
                  const isActive = item.id === activeRoadbookId;
                  return (
                    <div
                      key={item.id ?? item.fileName}
                      className={`flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between ${
                        isActive ? 'bg-[#E10600]/10' : ''
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-['Barlow_Condensed'] text-lg font-bold text-white truncate">
                            {item.eventName}
                          </span>
                          <span className="font-mono text-[10px] font-bold uppercase text-[#E10600]">
                            {item.sourceFormat || 'TXT'}
                          </span>
                          {isActive && (
                            <span className="font-mono text-[10px] font-extrabold text-emerald-400 uppercase">
                              · Ativa
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-[#B5B5B5] tabular-nums">
                          <span>{item.tulipas.length} refs</span>
                          <span>{item.totalKm.toFixed(2)} km</span>
                          <span>
                            V:{item.countV} · D:{item.countD} · N:{item.countN}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleActivateRoadbook(item, true)}
                          className="pitstop-btn-red inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3.5 text-xs font-extrabold tracking-wide text-white uppercase"
                        >
                          <Navigation className="h-3.5 w-3.5" />
                          <span>{isActive ? 'Navegar' : 'Trocar e Navegar'}</span>
                        </button>
                        {item.id && (
                          <button
                            type="button"
                            onClick={() => handleDeleteSaved(item.id!)}
                            title="Remover da base interna"
                            className="inline-flex h-[36px] w-[36px] items-center justify-center rounded-lg border border-zinc-700 bg-[#080B0D] text-[#B5B5B5] hover:border-[#E10600] hover:text-[#FF2A2A]"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {/* SUBMENU 2: PAREAMENTO NAVEGADOR <-> PILOTO (MESTRE -> ESCRAVO) */}
      {activeMenu === 'pairing' && (
        <div className="space-y-4">
          <section className="rounded-xl border border-zinc-800 bg-[#111214] p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-white uppercase">
                  Espelhamento Mestre → Escravo
                </h2>
                <p className="mt-0.5 text-xs text-[#B5B5B5]">
                  O celular <strong className="text-white">Navegador (Mestre)</strong> transmite hodômetro, velocidade, TNAV, barra de cores, desenhos, notas e alertas em tempo real para o celular <strong className="text-white">Piloto (Escravo)</strong>.
                </p>
              </div>

              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-700 bg-[#080B0D] px-3 py-2 text-xs font-bold text-white">
                <input
                  type="checkbox"
                  checked={settings.pairing.enabled}
                  onChange={(e) =>
                    updateSettings({
                      pairing: { ...settings.pairing, enabled: e.target.checked },
                    })
                  }
                  className="h-4 w-4 accent-[#E10600]"
                />
                <span>{settings.pairing.enabled ? 'Pareamento Ativo' : 'Ativar Pareamento'}</span>
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <span className="block text-[11px] font-semibold text-[#C0C4C9] uppercase">
                  Papel deste Aparelho
                </span>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5 rounded-lg border border-zinc-800 bg-[#080B0D] p-1">
                  <button
                    type="button"
                    onClick={() =>
                      updateSettings({ pairing: { ...settings.pairing, role: 'navigator' } })
                    }
                    className={`min-h-[38px] rounded-md text-xs font-bold whitespace-nowrap ${
                      settings.pairing.role === 'navigator'
                        ? 'bg-[#E10600] text-white'
                        : 'text-[#B5B5B5]'
                    }`}
                  >
                    Navegador (Mestre)
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateSettings({ pairing: { ...settings.pairing, role: 'pilot' } })
                    }
                    className={`min-h-[38px] rounded-md text-xs font-bold whitespace-nowrap ${
                      settings.pairing.role === 'pilot'
                        ? 'bg-[#E10600] text-white'
                        : 'text-[#B5B5B5]'
                    }`}
                  >
                    Piloto (Escravo)
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="pairing-room-code"
                  className="block text-[11px] font-semibold text-[#C0C4C9] uppercase"
                >
                  Código da Sala / Dupla
                </label>
                <div className="mt-1.5 flex gap-1.5">
                  <input
                    id="pairing-room-code"
                    type="text"
                    value={settings.pairing.roomCode}
                    onChange={(e) =>
                      updateSettings({
                        pairing: {
                          ...settings.pairing,
                          roomCode: normalizeRoomCode(e.target.value),
                        },
                      })
                    }
                    placeholder="PS-4821"
                    className="flex-1 min-h-[42px] rounded-lg border border-zinc-700 bg-[#080B0D] px-3 font-mono text-sm font-black tracking-wider text-white uppercase focus:border-[#E10600] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      updateSettings({
                        pairing: { ...settings.pairing, roomCode: generatePairingRoomCode() },
                      })
                    }
                    className="pitstop-btn-metal min-h-[42px] rounded-lg px-3 text-xs font-bold whitespace-nowrap shrink-0"
                  >
                    Novo Código
                  </button>
                </div>
              </div>

              <div className="rounded-lg border border-zinc-800 bg-[#080B0D] p-3 flex flex-col justify-between">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-[#B5B5B5]">Sincronização</span>
                  <span
                    className={`font-mono font-bold ${
                      !settings.pairing.enabled
                        ? 'text-zinc-500'
                        : pairingPresence.status === 'connected'
                          ? 'text-emerald-400'
                          : pairingPresence.status === 'connecting'
                            ? 'text-amber-400'
                            : 'text-[#FF2A2A]'
                    }`}
                  >
                    {!settings.pairing.enabled
                      ? 'Desligado'
                      : pairingPresence.status === 'connected'
                        ? `Online (${pairingPresence.transport.toUpperCase()})`
                        : pairingPresence.status === 'connecting'
                          ? 'Conectando...'
                          : 'Sem rede'}
                  </span>
                </div>
                <div className="mt-1 font-mono text-[11px] text-[#C0C4C9] tabular-nums">
                  Mestre (Nav): {pairingPresence.navigators} · Escravo (Piloto): {pairingPresence.pilots}
                </div>
              </div>
            </div>

            {/* Bluetooth Pairing Picker & Screen Wake Lock */}
            <div className="grid grid-cols-1 gap-3 border-t border-zinc-800 pt-4 sm:grid-cols-2">
              <div className="rounded-lg border border-zinc-800 bg-[#080B0D] p-3.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Bluetooth className="h-4 w-4 text-[#E10600]" />
                    <span className="text-xs font-bold text-white uppercase">
                      Dispositivo Bluetooth
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleSelectBluetoothDevice}
                    className="pitstop-btn-metal rounded-lg px-3 py-1.5 text-xs font-bold whitespace-nowrap"
                  >
                    Buscar Bluetooth
                  </button>
                </div>
                <p className="font-mono text-xs text-[#C0C4C9]">
                  {settings.pairing.bluetoothDeviceName
                    ? `Pareado: ${settings.pairing.bluetoothDeviceName}`
                    : 'Nenhum dispositivo Bluetooth selecionado'}
                </p>
                {btStatusMsg && <p className="text-[11px] text-amber-300">{btStatusMsg}</p>}
              </div>

              <div className="rounded-lg border border-zinc-800 bg-[#080B0D] p-3.5 flex flex-col justify-between gap-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4 text-[#E10600]" />
                    <span className="text-xs font-bold text-white uppercase">
                      Tela Sempre Ativa
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleWakeLock}
                    className={`rounded-lg px-3 py-1.5 text-xs font-bold ${
                      wakeLockActive ? 'bg-emerald-600 text-white' : 'pitstop-btn-metal'
                    }`}
                  >
                    {wakeLockActive ? 'Ativa (WakeLock)' : 'Manter Acesa'}
                  </button>
                </div>
                <p className="text-[11px] text-[#B5B5B5]">
                  Evita que a tela do Piloto ou Navegador apague no painel durante a etapa.
                </p>
              </div>
            </div>

            {/* Setup checklist for Android / iOS */}
            <div className="rounded-lg border border-zinc-800 bg-[#080B0D] p-3.5 text-xs text-[#C0C4C9] space-y-1.5">
              <p className="font-bold text-white uppercase tracking-wide text-[11px]">
                Passo a passo rápido para dupla em campo:
              </p>
              <p>1. Pareie os dois celulares nas configurações de Bluetooth ou ligue o Hotspot/Vínculo Bluetooth no celular do Navegador.</p>
              <p>2. Em ambos os aparelhos, libere <strong className="text-white">Localização (&ldquo;Permitir o tempo todo&rdquo;)</strong> e <strong className="text-white">Dispositivos Próximos</strong>.</p>
              <p>3. Defina o mesmo <strong className="text-white">Código da Sala</strong> nos dois celulares: o Mestre controla a planilha e o Escravo exibe os dados e bipes em tempo real sem poder alterar a navegação.</p>
            </div>
          </section>
        </div>
      )}

      {/* SUBMENU 3: TELA DO PILOTO (PERSONALIZAÇÃO) */}
      {activeMenu === 'pilot' && (
        <section className="rounded-xl border border-zinc-800 bg-[#111214] p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-white uppercase">
                Campos Visíveis na Tela do Piloto
              </h2>
              <p className="text-xs text-[#B5B5B5]">
                Escolha exatamente o que aparece para o piloto na aba Navegação &gt; Piloto.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => updateSettings({ pilotDisplay: getDefaultPilotDisplay() })}
                className="rounded-lg border border-zinc-700 bg-[#080B0D] px-3 py-1.5 text-xs font-bold text-[#C0C4C9] hover:text-white"
              >
                Completo
              </button>
              <button
                type="button"
                onClick={() =>
                  updateSettings({
                    pilotDisplay: {
                      showDistance: true,
                      showOdometer: false,
                      showSpeed: true,
                      showTargetSpeed: true,
                      showTnav: true,
                      showColorBar: true,
                      showDeltaMeters: false,
                      showClock: false,
                      showDesenho: true,
                      showCap: false,
                      showObs: true,
                    },
                  })
                }
                className="rounded-lg border border-zinc-700 bg-[#080B0D] px-3 py-1.5 text-xs font-bold text-[#C0C4C9] hover:text-white"
              >
                Essencial Piloto
              </button>
              <button
                type="button"
                onClick={() =>
                  updateSettings({
                    pilotDisplay: {
                      showDistance: false,
                      showOdometer: false,
                      showSpeed: true,
                      showTargetSpeed: true,
                      showTnav: true,
                      showColorBar: true,
                      showDeltaMeters: false,
                      showClock: false,
                      showDesenho: false,
                      showCap: false,
                      showObs: false,
                    },
                  })
                }
                className="rounded-lg border border-zinc-700 bg-[#080B0D] px-3 py-1.5 text-xs font-bold text-[#C0C4C9] hover:text-white"
              >
                Minimalista (Vel/Média/TNAV)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3">
            {([
              { key: 'showSpeed', label: 'Velocidade Atual (km/h)' },
              { key: 'showTargetSpeed', label: 'Média Ideal (PMM)' },
              { key: 'showTnav', label: 'TNAV (Adiantado / Atrasado)' },
              { key: 'showColorBar', label: 'Barra de Cores (Verde/Cinza/Verm.)' },
              { key: 'showDistance', label: 'Distância Regressiva (m/km)' },
              { key: 'showOdometer', label: 'Hodômetro Total' },
              { key: 'showDeltaMeters', label: 'Diferença em Metros (+/- m)' },
              { key: 'showClock', label: 'Hora Oficial' },
              { key: 'showDesenho', label: 'Desenho da Tulipa (Quadrado)' },
              { key: 'showCap', label: 'CAP° / Número do Trecho' },
              { key: 'showObs', label: 'Observação (Retângulo + Texto)' },
            ] as const).map((item) => (
              <label
                key={item.key}
                className="flex min-h-[46px] cursor-pointer items-center gap-2.5 rounded-lg border border-zinc-800 bg-[#080B0D] px-3.5 py-2.5 text-xs font-semibold text-[#F4F4F4] hover:border-zinc-700"
              >
                <input
                  type="checkbox"
                  checked={settings.pilotDisplay[item.key]}
                  onChange={(e) =>
                    updateSettings({
                      pilotDisplay: {
                        ...settings.pilotDisplay,
                        [item.key]: e.target.checked,
                      },
                    })
                  }
                  className="h-4 w-4 accent-[#E10600]"
                />
                <span>{item.label}</span>
              </label>
            ))}
          </div>
        </section>
      )}

      {/* SUBMENU 4: AFERIÇÃO DO HODÔMETRO & W FINO */}
      {activeMenu === 'calibration' && (
        <section className="rounded-xl border border-zinc-800 bg-[#111214] p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-white uppercase">
                Aferição do Hodômetro, W Fino &amp; Pista de Calibração
              </h2>
              <p className="mt-1 text-xs text-[#B5B5B5]">
                <strong className="text-white">W maior</strong> → odômetro marca mais distância ·{' '}
                <strong className="text-white">W menor</strong> → odômetro marca menos distância.
              </p>
            </div>

            <div className="inline-flex rounded-lg border border-zinc-800 bg-[#080B0D] p-0.5 text-xs">
              <button
                type="button"
                onClick={() => updateSettings({ sensorMode: 'gps' })}
                className={`rounded-md px-3 py-1.5 font-semibold whitespace-nowrap shrink-0 ${
                  settings.sensorMode === 'gps'
                    ? 'bg-[#E10600] text-white'
                    : 'text-[#B5B5B5] hover:text-white'
                }`}
              >
                GPS (CAL%)
              </button>
              <button
                type="button"
                onClick={() => updateSettings({ sensorMode: 'blue' })}
                className={`rounded-md px-3 py-1.5 font-semibold whitespace-nowrap shrink-0 ${
                  settings.sensorMode === 'blue'
                    ? 'bg-[#E10600] text-white'
                    : 'text-[#B5B5B5] hover:text-white'
                }`}
              >
                Sensor Blue (W)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:items-center">
            <div className="lg:col-span-7 grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-1.5 rounded-xl border border-zinc-800 bg-[#080B0D] p-2">
              <button
                type="button"
                onClick={() => handleAdjustCalPct(-1)}
                className="min-h-[44px] rounded-lg border border-zinc-700 bg-[#1E1E22] px-3 font-mono text-xs font-extrabold text-[#C0C4C9] hover:text-white"
              >
                -1%
              </button>
              <button
                type="button"
                onClick={() => handleAdjustCalPct(-0.1)}
                className="min-h-[44px] rounded-lg border border-zinc-700 bg-[#1E1E22] px-3.5 font-mono text-base font-black text-white"
              >
                −
              </button>

              {editingW ? (
                <input
                  type="text"
                  inputMode="decimal"
                  autoFocus
                  value={wInputText}
                  onChange={(e) => setWInputText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCommitWEditor();
                    if (e.key === 'Escape') setEditingW(false);
                  }}
                  onBlur={handleCommitWEditor}
                  className="w-full min-h-[44px] rounded-lg border border-[#E10600] bg-black px-2 text-center font-mono text-base font-black text-white focus:outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={handleOpenWEditor}
                  className="flex min-h-[44px] flex-col items-center justify-center rounded-lg border border-zinc-700 bg-black px-2 hover:border-[#E10600]"
                >
                  <span className="font-mono text-lg font-black text-white tabular-nums">
                    {settings.sensorMode === 'blue'
                      ? `W ${activeW}`
                      : `${settings.calibrationPct.toFixed(2)}%`}
                  </span>
                  <span className="text-[9px] font-semibold tracking-wider text-[#B5B5B5] uppercase">
                    Toque para digitar
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={() => handleAdjustCalPct(0.1)}
                className="min-h-[44px] rounded-lg border border-zinc-700 bg-[#1E1E22] px-3.5 font-mono text-base font-black text-white"
              >
                +
              </button>
              <button
                type="button"
                onClick={() => handleAdjustCalPct(1)}
                className="min-h-[44px] rounded-lg border border-zinc-700 bg-[#1E1E22] px-3 font-mono text-xs font-extrabold text-[#C0C4C9] hover:text-white"
              >
                +1%
              </button>
            </div>

            <div className="lg:col-span-5 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-[#080B0D] p-3">
              <label htmlFor="w-base-cfg" className="text-xs font-semibold text-[#C0C4C9] whitespace-nowrap">
                W Base (100%):
              </label>
              <input
                id="w-base-cfg"
                type="number"
                min={500}
                max={99999}
                value={settings.wBaseValue}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 500) updateSettings({ wBaseValue: v });
                }}
                className="w-24 min-h-[38px] rounded-lg border border-zinc-700 bg-[#111214] px-2.5 font-mono text-xs font-bold text-white focus:border-[#E10600] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => updateSettings({ calibrationPct: 100 })}
                className="ml-auto inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-3 text-xs font-semibold text-[#C0C4C9] hover:text-white whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Zerar 100%</span>
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold tracking-wider text-[#C0C4C9] uppercase">
                Passagens em Pista de Aferição (Passagem 1 / 2 / 3)
              </span>
              {settings.wPasses.length > 0 && (
                <button
                  type="button"
                  onClick={() => updateSettings({ wPasses: [] })}
                  className="text-[11px] font-semibold text-[#FF2A2A] hover:underline"
                >
                  Limpar passagens
                </button>
              )}
            </div>

            <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <input
                type="number"
                inputMode="decimal"
                placeholder="Distância oficial (m) ex: 1000"
                value={passOfficialM}
                onChange={(e) => setPassOfficialM(e.target.value)}
                className="min-h-[42px] rounded-lg border border-zinc-700 bg-[#111214] px-3 font-mono text-xs text-white placeholder:text-zinc-500 focus:border-[#E10600] focus:outline-none"
              />
              <input
                type="number"
                inputMode="decimal"
                placeholder="Medida no hodômetro (m) ex: 992"
                value={passMeasuredM}
                onChange={(e) => setPassMeasuredM(e.target.value)}
                className="min-h-[42px] rounded-lg border border-zinc-700 bg-[#111214] px-3 font-mono text-xs text-white placeholder:text-zinc-500 focus:border-[#E10600] focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddCalibrationPass}
                className="pitstop-btn-metal min-h-[42px] rounded-lg px-3 text-xs font-bold whitespace-nowrap"
              >
                + Registrar Passagem ({Math.min(3, settings.wPasses.length + 1)}/3)
              </button>
            </div>

            {settings.wPasses.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-3">
                <div className="flex flex-wrap gap-2">
                  {settings.wPasses.map((p, idx) => (
                    <span
                      key={p.id}
                      className="rounded-md border border-zinc-700 bg-[#111214] px-2.5 py-1 font-mono text-[11px] text-[#C0C4C9]"
                    >
                      P{idx + 1}: {p.measuredM}m / {p.officialM}m →{' '}
                      <strong className="text-white">W {p.suggestedW}</strong>
                    </span>
                  ))}
                </div>
                {averageCalibrationSuggestion && (
                  <button
                    type="button"
                    onClick={handleApplyAverageW}
                    className="pitstop-btn-red inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3.5 text-xs font-extrabold text-white whitespace-nowrap shrink-0"
                  >
                    <span>
                      Aplicar Média W {averageCalibrationSuggestion.avgW} ({averageCalibrationSuggestion.avgPct.toFixed(2)}% · Erro{' '}
                      {averageCalibrationSuggestion.errorMPerKm >= 0 ? '+' : ''}
                      {averageCalibrationSuggestion.errorMPerKm.toFixed(1)} m/km)
                    </span>
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* SUBMENU 5: ALERTAS, ROAD BOOK & ATALHOS */}
      {activeMenu === 'alerts' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Volume2 className="h-4 w-4 text-[#E10600]" />
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-white uppercase">
                  Alertas Sonoros &amp; Cantada
                </h2>
              </div>
              <button
                type="button"
                onClick={() => testAlertSound(settings.alertStyle)}
                className="pitstop-btn-metal rounded-lg px-3 py-1.5 text-xs font-bold whitespace-nowrap"
              >
                Testar Alerta
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                { id: 'voice', label: 'Voz pt-BR' },
                { id: 'beep_short', label: 'Bipe Curto' },
                { id: 'beep_long', label: 'Bipe Longo' },
                { id: 'vibration', label: 'Vibração' },
              ] as const).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => updateSettings({ alertStyle: opt.id, voiceEnabled: true })}
                  className={`min-h-[38px] rounded-lg text-xs font-bold whitespace-nowrap ${
                    settings.alertStyle === opt.id
                      ? 'bg-[#E10600] text-white'
                      : 'border border-zinc-800 bg-[#080B0D] text-[#C0C4C9]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label
                  htmlFor="cfg-cantada-dist"
                  className="block text-[11px] font-semibold text-[#B5B5B5]"
                >
                  Distâncias / Gatilhos
                </label>
                <input
                  id="cfg-cantada-dist"
                  type="text"
                  value={thresholdsInput}
                  onChange={(e) => setThresholdsInput(e.target.value)}
                  onBlur={() => handleCommitThresholds(thresholdsInput)}
                  placeholder="100, 50, 20"
                  className="mt-1 w-full min-h-[40px] rounded-lg border border-zinc-700 bg-[#080B0D] px-3 font-mono text-xs text-white focus:border-[#E10600] focus:outline-none"
                />
              </div>

              <div>
                <span className="block text-[11px] font-semibold text-[#B5B5B5]">Unidade</span>
                <div className="mt-1 grid grid-cols-2 gap-1 rounded-lg border border-zinc-800 bg-[#080B0D] p-1">
                  <button
                    type="button"
                    onClick={() => updateSettings({ voiceUnit: 'meters' })}
                    className={`min-h-[32px] rounded-md text-xs font-bold ${
                      settings.voiceUnit === 'meters' ? 'bg-[#E10600] text-white' : 'text-[#B5B5B5]'
                    }`}
                  >
                    Metros
                  </button>
                  <button
                    type="button"
                    onClick={() => updateSettings({ voiceUnit: 'seconds' })}
                    className={`min-h-[32px] rounded-md text-xs font-bold ${
                      settings.voiceUnit === 'seconds' ? 'bg-[#E10600] text-white' : 'text-[#B5B5B5]'
                    }`}
                  >
                    Segundos
                  </button>
                </div>
              </div>
            </div>

            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-[#C0C4C9]">
              <input
                type="checkbox"
                checked={settings.voiceEnabled}
                onChange={(e) => updateSettings({ voiceEnabled: e.target.checked })}
                className="h-4 w-4 accent-[#E10600]"
              />
              <span>Ativar alertas automáticos antes das referências</span>
            </label>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Keyboard className="h-4 w-4 text-[#E10600]" />
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-white uppercase">
                  Teclas de Atalho / Controle Bluetooth
                </h2>
              </div>
              <button
                type="button"
                onClick={() => updateSettings({ shortcuts: getDefaultShortcuts() })}
                className="text-[11px] font-semibold text-[#C0C4C9] hover:text-white"
              >
                Padrão
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {([
                { key: 'syncHere', label: 'Zerar / OK Lap' },
                { key: 'toggleRun', label: 'Iniciar / Pausar' },
                { key: 'odoPlus', label: 'Hodômetro +Passo' },
                { key: 'odoMinus', label: 'Hodômetro -Passo' },
                { key: 'nextTulipa', label: 'Próxima Tulipa' },
                { key: 'prevTulipa', label: 'Tulipa Anterior' },
              ] as const).map((item) => {
                const isCap = capturingShortcut === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setCapturingShortcut(isCap ? null : item.key)}
                    className={`flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors ${
                      isCap
                        ? 'border-[#E10600] bg-[#E10600]/15'
                        : 'border-zinc-800 bg-[#080B0D] hover:border-zinc-600'
                    }`}
                  >
                    <span className="text-[10px] font-semibold text-[#B5B5B5] uppercase">
                      {item.label}
                    </span>
                    <span className="mt-0.5 font-mono text-xs font-bold text-white">
                      {isCap ? 'Pressione uma tecla...' : formatKeyLabel(settings.shortcuts[item.key])}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-4 space-y-3 lg:col-span-2">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-[#E10600]" />
              <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-white uppercase">
                Exibição do Road Book Digital
              </h2>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => updateSettings({ activeRowLine: 1 })}
                className={`min-h-[38px] rounded-lg text-xs font-bold ${
                  settings.activeRowLine === 1
                    ? 'bg-[#E10600] text-white'
                    : 'border border-zinc-800 bg-[#080B0D] text-[#C0C4C9]'
                }`}
              >
                Ref. da Vez: Linha 1 (Topo)
              </button>
              <button
                type="button"
                onClick={() => updateSettings({ activeRowLine: 2 })}
                className={`min-h-[38px] rounded-lg text-xs font-bold ${
                  settings.activeRowLine === 2
                    ? 'bg-[#E10600] text-white'
                    : 'border border-zinc-800 bg-[#080B0D] text-[#C0C4C9]'
                }`}
              >
                Ref. da Vez: Linha 2
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs text-[#C0C4C9]">
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={settings.reducePassedRow}
                  onChange={(e) => updateSettings({ reducePassedRow: e.target.checked })}
                  className="h-4 w-4 accent-[#E10600]"
                />
                <span>Reduzir passada</span>
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={settings.showPassedTick}
                  onChange={(e) => updateSettings({ showPassedTick: e.target.checked })}
                  className="h-4 w-4 accent-[#E10600]"
                />
                <span>✓ Verde na passada</span>
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <span className="text-xs font-semibold text-[#B5B5B5]">Tema da Referência:</span>
              <div className="flex gap-1.5">
                {([
                  { id: 'yellow', label: 'Amarelo' },
                  { id: 'blue', label: 'Azul' },
                  { id: 'green', label: 'Verde' },
                ] as { id: HighlightTheme; label: string }[]).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => updateSettings({ highlightTheme: t.id })}
                    className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                      settings.highlightTheme === t.id
                        ? 'bg-[#E10600] text-white'
                        : 'border border-zinc-800 bg-[#080B0D] text-[#C0C4C9]'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between text-xs font-semibold text-[#B5B5B5]">
                <span>Troca Antecipada</span>
                <span className="font-mono text-white">{settings.transitionAdvanceM} m</span>
              </div>
              <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                {[0, 5, 10, 20].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => updateSettings({ transitionAdvanceM: m })}
                    className={`min-h-[34px] rounded-lg font-mono text-xs font-bold ${
                      settings.transitionAdvanceM === m
                        ? 'bg-[#E10600] text-white'
                        : 'border border-zinc-800 bg-[#080B0D] text-[#C0C4C9]'
                    }`}
                  >
                    {m}m
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUBMENU 6: SISTEMA, GPS, BATERIA & BASE PITSTOP (SEM CAMPO MANUAL DE IP/URL) */}
      {activeMenu === 'system' && (
        <div className="space-y-4">
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-zinc-800 bg-[#111214] p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Satellite className="h-4 w-4 text-[#E10600]" />
                  <h2 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide text-white uppercase">
                    Sinal do GPS
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={readSingleGpsFix}
                  disabled={refreshingGps}
                  className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-semibold text-[#F4F4F4] hover:border-[#C0C4C9]/50 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className={`h-3.5 w-3.5 text-[#C0C4C9] ${refreshingGps ? 'animate-spin' : ''}`} />
                  <span>Atualizar</span>
                </button>
              </div>

              <div className="mt-3 flex items-baseline justify-between gap-2">
                <div>
                  <span className={`font-['Barlow_Condensed'] text-2xl font-extrabold italic ${gpsQuality.toneClass}`}>
                    {gps.status === 'active' ? gpsQuality.label : gps.status === 'denied' ? 'Bloqueado' : 'Buscando...'}
                  </span>
                  <span className="ml-2 font-mono text-xs text-[#C0C4C9] tabular-nums">
                    {gps.accuracyM !== null ? `±${gps.accuracyM} m` : '--'}
                  </span>
                </div>
                <div className="flex items-end gap-1" aria-hidden="true">
                  {[1, 2, 3, 4, 5].map((b) => (
                    <span
                      key={b}
                      className={`w-1.5 rounded-xs ${b <= gpsQuality.bars ? gpsQuality.barClass : 'bg-zinc-800'}`}
                      style={{ height: `${b * 4 + 4}px` }}
                    />
                  ))}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-zinc-800/90 pt-2.5 font-mono text-[11px] text-[#B5B5B5] tabular-nums">
                <span className="truncate">Lat: {gps.lat !== null ? gps.lat.toFixed(6) : '--'}</span>
                <span className="truncate text-right">Lon: {gps.lon !== null ? gps.lon.toFixed(6) : '--'}</span>
              </div>
              {gps.message && <p className="mt-2 text-xs text-amber-300">{gps.message}</p>}
            </div>

            <div className="rounded-xl border border-zinc-800 bg-[#111214] p-4 flex flex-col justify-between">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {renderBatteryIcon()}
                  <h2 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide text-white uppercase">
                    Bateria do Aparelho
                  </h2>
                </div>
                <span className="font-mono text-[11px] font-semibold text-[#B5B5B5]">
                  {battery.charging ? 'Carregando' : battery.supported ? 'Em bateria' : 'N/D'}
                </span>
              </div>

              <div className="mt-3 flex items-baseline justify-between">
                <span className="font-mono text-3xl font-extrabold text-white tabular-nums">
                  {battery.supported && battery.levelPct !== null ? `${battery.levelPct}%` : '--'}
                </span>
                <span className="text-xs text-[#B5B5B5]">
                  {battery.levelPct !== null && battery.levelPct <= 25
                    ? 'Recomendado ligar carregador veicular'
                    : 'Carga estável para etapa'}
                </span>
              </div>

              <div className="mt-3 h-2 w-full overflow-hidden rounded-sm border border-zinc-800 bg-[#080B0D]">
                <div
                  className={`h-full transition-all ${
                    (battery.levelPct ?? 0) <= 20
                      ? 'bg-[#E10600]'
                      : (battery.levelPct ?? 0) <= 50
                        ? 'bg-amber-400'
                        : 'bg-emerald-500'
                  }`}
                  style={{ width: `${battery.levelPct ?? 0}%` }}
                />
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-zinc-800 bg-[#111214] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-[#E10600]" />
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-white uppercase">
                  Hora GPS &amp; Conexão com a Base PitStop Sports
                </h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleSyncGpsClock}
                  className="pitstop-btn-metal rounded-lg px-3 py-1.5 text-xs font-bold whitespace-nowrap"
                >
                  Sinc. Hora GPS
                </button>
                <button
                  type="button"
                  onClick={handleTestBaseConnection}
                  disabled={healthState.checking}
                  className="pitstop-btn-red inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white whitespace-nowrap"
                >
                  <Server className="h-3.5 w-3.5" />
                  <span>{healthState.checking ? 'Verificando...' : 'Testar Base'}</span>
                </button>
              </div>
            </div>

            {clockSyncFeedback && (
              <p className="text-xs font-medium text-emerald-400">{clockSyncFeedback}</p>
            )}

            {healthState.message && (
              <p
                className={`flex items-center gap-1.5 text-xs ${
                  healthState.ok ? 'text-emerald-400' : 'text-amber-300'
                }`}
              >
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>{healthState.message}</span>
              </p>
            )}

            {pendingQueue.length > 0 && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                <span>{pendingQueue.length} coleta(s) na fila offline aguardando envio</span>
                <button
                  type="button"
                  disabled={retryingQueue}
                  onClick={handleRetryQueue}
                  className="inline-flex min-h-[32px] items-center gap-1 rounded-md bg-amber-400 px-2.5 text-xs font-extrabold text-black"
                >
                  <UploadCloud className="h-3.5 w-3.5" />
                  <span>{retryingQueue ? 'Enviando...' : 'Reenviar Agora'}</span>
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
