import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Geolocation } from '@capacitor/geolocation';
import { Share } from '@capacitor/share';
import {
  CheckCircle2,
  Clock,
  Download,
  EyeOff,
  FileText,
  Lock,
  Navigation,
  Play,
  RotateCcw,
  Share2,
  ShieldAlert,
  Sliders,
  Square,
  Upload,
} from 'lucide-react';
import type {
  ParsedRoadbook,
  PassageRecord,
  PendingCandidate,
  RallySessionConfig,
} from '../types/rally';
import {
  createInitialPassages,
  finalizePendingPassages,
  formatElapsedMs,
  parseRaceStartTimestampMs,
  processGpsFix,
} from '../utils/rallyEngine';
import { parseRoadbookTxt } from '../utils/rallyParser';
import { enrichRoadbookForNavigation, parseNavigationBuffer } from '../utils/roadbookFormats';
import { saveConvertedRoadbook } from '../utils/roadbookStorage';
import { formatResultTxt } from '../utils/resultFormatter';

type CollectorPhase = 'setup' | 'running' | 'finished';

interface PersistedSession {
  phase: CollectorPhase;
  config: RallySessionConfig;
  roadbook: ParsedRoadbook;
  passages: PassageRecord[];
  pending: Record<number, PendingCandidate>;
  nextExpectedIndex: number;
  startTimestampMs: number;
  resultTxt: string;
}

const STORAGE_KEY = 'rallychrono_active_session_v1';

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

export const CompetitorCollector: React.FC = () => {
  const [phase, setPhase] = useState<CollectorPhase>('setup');
  const [config, setConfig] = useState<RallySessionConfig>({
    carNumber: '',
    crewName: '',
    raceDate: getLocalTodayDate(),
    startTimeStr: getLocalNowTime(),
    detectionRadiusM: 30,
  });
  const [roadbook, setRoadbook] = useState<ParsedRoadbook | null>(null);
  const [passages, setPassages] = useState<PassageRecord[]>([]);
  const [pending, setPending] = useState<Record<number, PendingCandidate>>({});
  const [nextExpectedIndex, setNextExpectedIndex] = useState(0);
  const [startTimestampMs, setStartTimestampMs] = useState<number>(0);
  const [resultTxt, setResultTxt] = useState<string>('');

  const [parseError, setParseError] = useState<string | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);

  const [gpsTestState, setGpsTestState] = useState<{
    status: 'idle' | 'checking' | 'ok' | 'error';
    lat?: number;
    lon?: number;
    accuracyM?: number;
    message?: string;
  }>({ status: 'idle' });

  const [liveGpsState, setLiveGpsState] = useState<{
    status: 'waiting' | 'active' | 'error';
    accuracyM: number | null;
    fixCount: number;
    lastFixTime: number | null;
    errorMessage?: string;
  }>({
    status: 'waiting',
    accuracyM: null,
    fixCount: 0,
    lastFixTime: null,
  });

  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [blackoutMode, setBlackoutMode] = useState(false);
  const [confirmFinishOpen, setConfirmFinishOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);

  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const webWatchIdRef = useRef<number | null>(null);
  const capWatchIdRef = useRef<string | null>(null);
  const trackerRef = useRef({
    passages,
    pending,
    nextExpectedIndex,
  });
  trackerRef.current = { passages, pending, nextExpectedIndex };

  useEffect(() => {
    try {
      const savedRaw = localStorage.getItem(STORAGE_KEY);
      if (!savedRaw) return;
      const saved = JSON.parse(savedRaw) as PersistedSession;
      if (saved && saved.roadbook && saved.config) {
        setPhase(saved.phase);
        setConfig(saved.config);
        setRoadbook(saved.roadbook);
        setPassages(saved.passages || []);
        setPending(saved.pending || {});
        setNextExpectedIndex(saved.nextExpectedIndex || 0);
        setStartTimestampMs(saved.startTimestampMs || 0);
        setResultTxt(saved.resultTxt || '');
      }
    } catch {
      // Ignore corrupt storage
    }
  }, []);

  useEffect(() => {
    if (phase === 'setup' || !roadbook) return;
    try {
      const payload: PersistedSession = {
        phase,
        config,
        roadbook,
        passages,
        pending,
        nextExpectedIndex,
        startTimestampMs,
        resultTxt,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota errors
    }
  }, [
    phase,
    config,
    roadbook,
    passages,
    pending,
    nextExpectedIndex,
    startTimestampMs,
    resultTxt,
  ]);

  useEffect(() => {
    if (phase !== 'running') return;
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [phase]);

  const acquireWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      wakeLockRef.current = sentinel;
      setWakeLockActive(true);
      sentinel.addEventListener('release', () => {
        setWakeLockActive(false);
      });
    } catch {
      setWakeLockActive(false);
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
      } catch {
        // Ignore
      }
      wakeLockRef.current = null;
    }
    setWakeLockActive(false);
  }, []);

  useEffect(() => {
    if (phase !== 'running') return;
    acquireWakeLock();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      releaseWakeLock();
    };
  }, [phase, acquireWakeLock, releaseWakeLock]);

  const handleIncomingPosition = useCallback(
    (lat: number, lon: number, accuracy: number | null, fixTs: number) => {
      if (!roadbook) return;
      const current = trackerRef.current;
      const step = processGpsFix(
        roadbook.tulipas,
        current.passages,
        current.pending,
        current.nextExpectedIndex,
        config.detectionRadiusM,
        {
          lat,
          lon,
          accuracyM: accuracy !== null && Number.isFinite(accuracy) ? accuracy : null,
          timestampMs: fixTs,
        }
      );

      setPassages(step.passages);
      setPending(step.pending);
      setNextExpectedIndex(step.nextExpectedIndex);
      setLiveGpsState((prev) => ({
        status: 'active',
        accuracyM: accuracy !== null && Number.isFinite(accuracy) ? Math.round(accuracy) : null,
        fixCount: prev.fixCount + 1,
        lastFixTime: fixTs,
      }));
    },
    [roadbook, config.detectionRadiusM]
  );

  // Continuous Geolocation watcher (Capacitor Native on APK, Web API on browser/PWA)
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

    if (phase !== 'running' || !roadbook) {
      cleanup();
      return;
    }

    if (Capacitor.isNativePlatform()) {
      (async () => {
        try {
          const perm = await Geolocation.requestPermissions();
          if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
            if (!cancelled) {
              setLiveGpsState((prev) => ({
                ...prev,
                status: 'error',
                errorMessage: 'Permissão de localização negada nas configurações do Android.',
              }));
            }
            return;
          }
          const watchId = await Geolocation.watchPosition(
            { enableHighAccuracy: true, timeout: 12000, maximumAge: 1000 },
            (pos, err) => {
              if (cancelled) return;
              if (err) {
                setLiveGpsState((prev) => ({
                  ...prev,
                  status: 'error',
                  errorMessage: 'Sinal GPS indisponível no momento.',
                }));
                return;
              }
              if (pos) {
                handleIncomingPosition(
                  pos.coords.latitude,
                  pos.coords.longitude,
                  pos.coords.accuracy ?? null,
                  pos.timestamp || Date.now()
                );
              }
            }
          );
          if (cancelled) {
            Geolocation.clearWatch({ id: watchId }).catch(() => {});
          } else {
            capWatchIdRef.current = watchId;
          }
        } catch {
          if (!cancelled) {
            setLiveGpsState((prev) => ({
              ...prev,
              status: 'error',
              errorMessage: 'Falha ao iniciar GPS nativo no Android.',
            }));
          }
        }
      })();
      return () => {
        cancelled = true;
        cleanup();
      };
    }

    if (!('geolocation' in navigator)) {
      setLiveGpsState((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: 'Geolocalização não suportada neste navegador.',
      }));
      return;
    }

    const id = navigator.geolocation.watchPosition(
      (pos) => {
        handleIncomingPosition(
          pos.coords.latitude,
          pos.coords.longitude,
          pos.coords.accuracy ?? null,
          pos.timestamp || Date.now()
        );
      },
      (err) => {
        let msg = 'Erro ao ler GPS.';
        if (err.code === 1) msg = 'Permissão de localização negada no navegador.';
        else if (err.code === 2) msg = 'Sinal GPS indisponível no momento.';
        else if (err.code === 3) msg = 'Tempo esgotado buscando satélite GPS.';
        setLiveGpsState((prev) => ({
          ...prev,
          status: 'error',
          errorMessage: msg,
        }));
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 12000,
      }
    );

    webWatchIdRef.current = id;

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [phase, roadbook, handleIncomingPosition]);

  const handleRoadbookFile = async (file: File) => {
    setParseError(null);
    try {
      const buffer = await file.arrayBuffer();
      const parsed = await parseNavigationBuffer(buffer, file.name);
      const hasCoords = parsed.tulipas.some((t) => t.lat !== 0 || t.lon !== 0);
      if (!hasCoords) {
        throw new Error(
          `O arquivo "${file.name}" foi lido (${parsed.tulipas.length} tulipas), porém não possui coordenadas GPS (Lat/Lon) necessárias para o Coletor GPS. Use-o na aba Navegação ou importe o .TXT com coordenadas.`
        );
      }
      const enriched = enrichRoadbookForNavigation(parsed);
      setRoadbook(enriched);
      saveConvertedRoadbook(enriched).catch(() => {});
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : 'Falha ao ler arquivo da planilha.'
      );
    }
  };

  const handleLoadSampleRoadbook = async () => {
    setParseError(null);
    setLoadingSample(true);
    try {
      const res = await fetch('/assets/aistudio/rally_escoteiros_merged_66a34567.txt');
      if (!res.ok) throw new Error('Arquivo modelo não encontrado.');
      const text = await res.text();
      const parsed = enrichRoadbookForNavigation(
        parseRoadbookTxt(text, 'rally_escoteiros_merged.txt')
      );
      setRoadbook(parsed);
      saveConvertedRoadbook(parsed).catch(() => {});
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : 'Erro ao carregar planilha modelo.'
      );
    } finally {
      setLoadingSample(false);
    }
  };

  const handleTestGps = async () => {
    setGpsTestState({ status: 'checking' });

    if (Capacitor.isNativePlatform()) {
      try {
        const perm = await Geolocation.requestPermissions();
        if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
          setGpsTestState({
            status: 'error',
            message: 'Permissão negada. Libere a localização para o RallyChrono no Android.',
          });
          return;
        }
        const pos = await Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 10000,
        });
        setGpsTestState({
          status: 'ok',
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: Math.round(pos.coords.accuracy),
        });
      } catch {
        setGpsTestState({
          status: 'error',
          message: 'Não foi possível obter sinal GPS agora. Teste em área aberta.',
        });
      }
      return;
    }

    if (!('geolocation' in navigator)) {
      setGpsTestState({
        status: 'error',
        message: 'Navegador sem suporte à API de Geolocalização.',
      });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsTestState({
          status: 'ok',
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: Math.round(pos.coords.accuracy),
        });
      },
      (err) => {
        setGpsTestState({
          status: 'error',
          message:
            err.code === 1
              ? 'Permissão negada. Libere a localização nas configurações do Chrome Android.'
              : 'Não foi possível obter sinal GPS agora. Teste em área aberta.',
        });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const canStart = useMemo(() => {
    return (
      config.carNumber.trim().length > 0 &&
      config.startTimeStr.trim().length >= 5 &&
      roadbook !== null
    );
  }, [config.carNumber, config.startTimeStr, roadbook]);

  const handleStartRace = () => {
    if (!roadbook || !canStart) return;
    const normalizedStart =
      config.startTimeStr.length === 5
        ? `${config.startTimeStr}:00`
        : config.startTimeStr;
    const updatedConfig = { ...config, startTimeStr: normalizedStart };
    setConfig(updatedConfig);

    const startMs = parseRaceStartTimestampMs(
      updatedConfig.raceDate,
      normalizedStart
    );
    const initial = createInitialPassages(roadbook.tulipas, startMs);
    setStartTimestampMs(startMs);
    setPassages(initial);
    setPending({});
    setNextExpectedIndex(0);
    setResultTxt('');
    setLiveGpsState({
      status: 'waiting',
      accuracyM: null,
      fixCount: 0,
      lastFixTime: null,
    });
    setPhase('running');
  };

  const handleFinishRace = () => {
    if (!roadbook) return;
    const finalized = finalizePendingPassages(passages, pending);
    const txt = formatResultTxt(roadbook.eventName, config, finalized);
    setPassages(finalized);
    setPending({});
    setResultTxt(txt);
    setConfirmFinishOpen(false);
    setBlackoutMode(false);
    setPhase('finished');
  };

  const resultFileName = useMemo(() => {
    const cleanCar = (config.carNumber || '000').replace(/[^a-zA-Z0-9_-]/g, '');
    return `resultado_carro_${cleanCar}.txt`;
  }, [config.carNumber]);

  const handleDownloadTxt = async () => {
    setExportFeedback(null);

    if (Capacitor.isNativePlatform()) {
      try {
        await Filesystem.writeFile({
          path: resultFileName,
          data: resultTxt,
          directory: Directory.Documents,
          encoding: Encoding.UTF8,
        });
        setExportFeedback(
          `Arquivo salvo na pasta Documentos do celular como ${resultFileName}.`
        );
        return;
      } catch {
        // Fallback to cache + share or web download
      }
    }

    const blob = new Blob([resultTxt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = resultFileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleShareTxt = async () => {
    setExportFeedback(null);

    if (Capacitor.isNativePlatform()) {
      try {
        const written = await Filesystem.writeFile({
          path: resultFileName,
          data: resultTxt,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });
        await Share.share({
          title: `Resultado Carro ${config.carNumber}`,
          text: `Registro GPS do Carro ${config.carNumber} (${roadbook?.eventName ?? 'Rally'}).`,
          url: written.uri,
          dialogTitle: 'Enviar resultado para a organização',
        });
        return;
      } catch {
        await handleDownloadTxt();
        return;
      }
    }

    const file = new File([resultTxt], resultFileName, {
      type: 'text/plain;charset=utf-8',
    });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          title: `Resultado Carro ${config.carNumber}`,
          text: `Arquivo de registro GPS do Carro ${config.carNumber} (${roadbook?.eventName ?? 'Rally'}).`,
          files: [file],
        });
        return;
      } catch {
        // User cancelled or share failed; fall back to download
      }
    }
    await handleDownloadTxt();
    setExportFeedback(
      'Compartilhamento direto indisponível neste navegador — o arquivo .txt foi baixado para envio manual.'
    );
  };

  const handleReset = () => {
    localStorage.removeItem(STORAGE_KEY);
    setPhase('setup');
    setPassages([]);
    setPending({});
    setNextExpectedIndex(0);
    setResultTxt('');
    setExportFeedback(null);
  };

  // --- RUNNING PHASE (SILENT SECONDARY COCKPIT / VISOR DE PROVA) ---
  if (phase === 'running' && roadbook) {
    const elapsedMs = nowMs - startTimestampMs;
    const isPreStart = elapsedMs < 0;

    return (
      <div className="mx-auto max-w-2xl">
        {blackoutMode && (
          <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-black p-8 text-slate-600 select-none">
            <div className="text-xs tracking-wide">
              Carro {config.carNumber} · Coleta GPS em execução
            </div>
            <div className="text-center">
              <EyeOff className="mx-auto h-8 w-8 text-slate-700" />
              <p className="mt-3 text-sm text-slate-500">
                Tela escurecida para economia de bateria
              </p>
            </div>
            <button
              type="button"
              onClick={() => setBlackoutMode(false)}
              className="min-h-[48px] rounded-xl border border-slate-800 bg-slate-950 px-6 py-3 text-sm font-medium text-slate-300 hover:bg-slate-900"
            >
              Reativar Visor
            </button>
          </div>
        )}

        <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-[#0d1017] text-slate-100 shadow-2xl">
          <div aria-hidden="true" className="h-1.5 w-full rally-track-stripe" />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-1.5 right-0 h-32 w-48 bg-rally-checkered opacity-40 [mask-image:linear-gradient(to_bottom_left,black,transparent)]"
          />

          <div className="relative border-b border-slate-800/90 px-4 py-4 sm:px-6 sm:py-5">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div>
                <p className="text-[10px] font-bold tracking-[0.16em] text-red-500 uppercase sm:text-[11px]">
                  EM PROVA · Modo Secundário Silencioso
                </p>
                <h2 className="mt-1 font-['Barlow_Condensed'] text-2xl font-extrabold italic tracking-wide text-white sm:text-3xl">
                  Carro {config.carNumber}
                </h2>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase sm:text-[11px]">
                  Largada Oficial
                </p>
                <p className="font-mono text-lg font-bold text-amber-400 tabular-nums sm:text-xl">
                  {config.startTimeStr}
                </p>
              </div>
            </div>
          </div>

          <div className="relative space-y-4 px-4 py-4 sm:space-y-5 sm:px-6 sm:py-6">
            {/* Visor de Prova Digital */}
            <div className="rounded-xl border border-slate-800 bg-[#07090e] p-4 text-center shadow-inner sm:p-5">
              <p className="text-[10px] font-bold tracking-[0.16em] text-slate-400 uppercase sm:text-[11px]">
                {isPreStart
                  ? 'Contagem Regressiva para Largada'
                  : 'Visor de Prova — Tempo Decorrido'}
              </p>
              <p className="mt-1.5 font-['Barlow_Condensed'] text-4xl font-extrabold italic tracking-tight text-white tabular-nums sm:text-5xl">
                {formatElapsedMs(elapsedMs)}
              </p>
              <p className="mt-1.5 font-mono text-[11px] text-slate-400 tabular-nums sm:text-xs">
                {roadbook.eventName} · Raio {config.detectionRadiusM}m
              </p>
            </div>

            <div className="divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-[#12161f]">
              <div className="flex items-center justify-between px-4 py-3.5 text-sm">
                <span className="text-slate-300">Receptor GPS</span>
                {liveGpsState.status === 'active' ? (
                  <span className="font-mono text-xs font-semibold text-emerald-400 tabular-nums">
                    Ativo (±{liveGpsState.accuracyM ?? '--'}m · {liveGpsState.fixCount} leituras)
                  </span>
                ) : liveGpsState.status === 'error' ? (
                  <span className="text-xs font-medium text-red-400">
                    {liveGpsState.errorMessage}
                  </span>
                ) : (
                  <span className="text-xs font-medium text-amber-400">
                    Buscando satélites...
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between px-4 py-3.5 text-sm">
                <span className="text-slate-300">Tela Ativa (Wake Lock)</span>
                <span
                  className={`text-xs font-medium ${
                    wakeLockActive ? 'text-emerald-400' : 'text-slate-400'
                  }`}
                >
                  {wakeLockActive ? 'Bloqueio de sono ativo' : 'Gerenciado pelo sistema'}
                </span>
              </div>

              <div className="flex items-center justify-between px-4 py-3.5 text-sm">
                <span className="text-slate-300">Painel do Competidor</span>
                <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                  <Lock className="h-3.5 w-3.5 text-orange-400" />
                  Dados protegidos para a organização
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setBlackoutMode(true)}
                className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#161b26] px-4 py-3 text-sm font-semibold text-slate-200 transition-colors hover:bg-[#1e2533]"
              >
                <EyeOff className="h-4 w-4 text-slate-400" />
                <span>Escurecer Tela</span>
              </button>

              <button
                type="button"
                onClick={() => setConfirmFinishOpen(true)}
                className="rally-btn-red inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold tracking-wide text-white uppercase transition-all"
              >
                <Square className="h-4 w-4 fill-current" />
                <span>Encerrar e Gerar TXT</span>
              </button>
            </div>
          </div>
        </div>

        {confirmFinishOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-xs">
            <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-700 bg-[#12161f] text-slate-100 shadow-2xl">
              <div aria-hidden="true" className="h-1 w-full rally-track-stripe" />
              <div className="p-6">
                <h3 className="font-['Barlow_Condensed'] text-2xl font-bold text-white">
                  Encerrar coleta do Carro {config.carNumber}?
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-300">
                  Ao confirmar, o registro GPS será encerrado e o arquivo{' '}
                  <span className="font-mono text-xs font-semibold text-amber-300">
                    {resultFileName}
                  </span>{' '}
                  será gerado para envio à organização.
                </p>
                <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={() => setConfirmFinishOpen(false)}
                    className="min-h-[44px] rounded-xl border border-slate-700 bg-[#0a0d13] px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                  >
                    Continuar Gravando
                  </button>
                  <button
                    type="button"
                    onClick={handleFinishRace}
                    className="rally-btn-red min-h-[44px] rounded-xl px-5 py-2.5 text-sm font-bold text-white"
                  >
                    Confirmar Encerramento
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // --- FINISHED PHASE (ONLY EXPORT/SEND TXT — NO APURAÇÃO ACCESS FOR COMPETITOR) ---
  if (phase === 'finished' && roadbook) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-[#12161f] text-slate-100 shadow-2xl">
          <div aria-hidden="true" className="h-1.5 w-full rally-track-stripe" />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-1.5 right-0 h-28 w-44 bg-rally-checkered opacity-35 [mask-image:linear-gradient(to_bottom_left,black,transparent)]"
          />

          <div className="relative p-4 sm:p-7">
            <div className="flex items-start gap-3 sm:gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/15 text-emerald-400 sm:h-11 sm:w-11">
                <CheckCircle2 className="h-5 w-5 sm:h-6 sm:w-6" />
              </div>
              <div>
                <p className="text-[10px] font-bold tracking-[0.18em] text-emerald-400 uppercase sm:text-[11px]">
                  Registro Concluído
                </p>
                <h2 className="mt-0.5 font-['Barlow_Condensed'] text-xl font-bold italic text-white sm:text-2xl">
                  Coleta Encerrada — Carro {config.carNumber}
                </h2>
                <p className="mt-1 text-sm text-slate-300">
                  Arquivo de registro gerado para a planilha{' '}
                  <strong className="font-semibold text-white">
                    {roadbook.eventName}
                  </strong>
                  . Envie o arquivo abaixo diretamente para a organização fazer a apuração oficial.
                </p>
              </div>
            </div>

            <div className="mt-6 rounded-xl border border-slate-800 bg-[#0a0d13] px-4 py-3.5 text-sm text-slate-300">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-amber-300">
                  {resultFileName}
                </span>
                <span className="font-mono text-xs text-slate-400 tabular-nums">
                  Largada {config.startTimeStr} · Raio {config.detectionRadiusM}m
                </span>
              </div>
            </div>

            {exportFeedback && (
              <p className="mt-4 text-xs font-medium text-emerald-400">
                {exportFeedback}
              </p>
            )}

            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={handleShareTxt}
                className="rally-btn-orange inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white transition-all"
              >
                <Share2 className="h-4 w-4" />
                <span>Enviar para Organização</span>
              </button>

              <button
                type="button"
                onClick={handleDownloadTxt}
                className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#161b26] px-5 py-3 text-sm font-semibold text-slate-100 transition-colors hover:bg-[#1e2533]"
              >
                <Download className="h-4 w-4 text-orange-400" />
                <span>Salvar Arquivo (.txt)</span>
              </button>
            </div>

            <div className="mt-6 flex items-center justify-end border-t border-slate-800 pt-5">
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex min-h-[40px] items-center gap-1.5 text-sm font-medium text-slate-400 hover:text-white"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Preparar Nova Largada</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- SETUP PHASE (PRE-START CONFIGURATION) ---
  return (
    <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-12 lg:items-start">
      <div className="space-y-4 sm:space-y-6 lg:col-span-7">
        <section className="rounded-2xl border border-slate-800 bg-[#12161f] p-4 text-slate-100 shadow-lg sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-2.5">
            <div>
              <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-white sm:text-2xl">
                01. Identificação e Hora de Largada
              </h2>
              <p className="mt-0.5 text-xs text-slate-400 sm:text-sm">
                Preencha antes de alinhar no pórtico de largada.
              </p>
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-[#0a0d13] px-2.5 py-1.5">
              <label
                htmlFor="gps-radius-select"
                className="text-[11px] font-semibold text-slate-400 whitespace-nowrap"
              >
                Raio GPS
              </label>
              <select
                id="gps-radius-select"
                value={config.detectionRadiusM}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    detectionRadiusM: Number(e.target.value),
                  }))
                }
                aria-label="Raio de detecção GPS em metros"
                className="bg-transparent font-mono text-xs font-bold text-orange-400 focus:outline-none cursor-pointer"
              >
                {[2, 5, 10, 15, 20, 30, 40, 50, 75, 100, 150].map((r) => (
                  <option key={r} value={r} className="bg-[#0a0d13] text-slate-100">
                    {r} m
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="car-number"
                className="block text-sm font-semibold text-slate-200"
              >
                Número do Carro *
              </label>
              <input
                id="car-number"
                type="text"
                inputMode="numeric"
                placeholder="Ex: 042"
                value={config.carNumber}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, carNumber: e.target.value }))
                }
                className="mt-1.5 w-full min-h-[46px] rounded-xl border border-slate-700 bg-[#0a0d13] px-3.5 font-mono text-base font-bold text-white placeholder:font-sans placeholder:font-normal placeholder:text-slate-500 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20"
              />
            </div>

            <div>
              <label
                htmlFor="crew-name"
                className="block text-sm font-semibold text-slate-200"
              >
                Dupla / Equipe (opcional)
              </label>
              <input
                id="crew-name"
                type="text"
                placeholder="Ex: Silva / Costa"
                value={config.crewName}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, crewName: e.target.value }))
                }
                className="mt-1.5 w-full min-h-[46px] rounded-xl border border-slate-700 bg-[#0a0d13] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20"
              />
            </div>

            <div>
              <label
                htmlFor="race-date"
                className="block text-sm font-semibold text-slate-200"
              >
                Data da Prova
              </label>
              <input
                id="race-date"
                type="date"
                value={config.raceDate}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, raceDate: e.target.value }))
                }
                className="mt-1.5 w-full min-h-[46px] rounded-xl border border-slate-700 bg-[#0a0d13] px-3.5 font-mono text-sm text-white [color-scheme:dark] focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20"
              />
            </div>

            <div>
              <label
                htmlFor="start-time"
                className="block text-sm font-semibold text-slate-200"
              >
                Hora de Largada (HH:MM:SS) *
              </label>
              <div className="mt-1.5 flex gap-2">
                <input
                  id="start-time"
                  type="time"
                  step="1"
                  value={config.startTimeStr}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, startTimeStr: e.target.value }))
                  }
                  className="w-full min-h-[46px] rounded-xl border border-slate-700 bg-[#0a0d13] px-3.5 font-mono text-base font-bold text-white tabular-nums [color-scheme:dark] focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20"
                />
                <button
                  type="button"
                  onClick={() =>
                    setConfig((prev) => ({
                      ...prev,
                      raceDate: getLocalTodayDate(),
                      startTimeStr: getLocalNowTime(),
                    }))
                  }
                  className="inline-flex min-h-[46px] items-center gap-1.5 rounded-xl border border-slate-700 bg-[#161b26] px-3.5 text-xs font-semibold text-slate-200 hover:bg-[#1e2533] whitespace-nowrap shrink-0"
                >
                  <Clock className="h-3.5 w-3.5 text-orange-400" />
                  <span>Agora</span>
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-[#12161f] p-4 text-slate-100 shadow-lg sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-2.5">
            <div>
              <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-white sm:text-2xl">
                02. Importar Planilha (.txt / .nbp / .bin / .rbk)
              </h2>
              <p className="mt-0.5 text-xs text-slate-400 sm:text-sm">
                Carregue o arquivo enviado pela organização antes da largada.
              </p>
            </div>

            <button
              type="button"
              onClick={handleLoadSampleRoadbook}
              disabled={loadingSample}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-700 bg-[#161b26] px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-[#1e2533] whitespace-nowrap shrink-0"
            >
              <FileText className="h-3.5 w-3.5 text-orange-400" />
              <span>
                {loadingSample ? 'Carregando...' : 'Carregar Modelo (Rally Escoteiro)'}
              </span>
            </button>
          </div>

          <label className="mt-4 flex min-h-[112px] cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-[#0a0d13] px-4 py-5 text-center transition-colors hover:border-orange-500 hover:bg-orange-500/5">
            <Upload className="h-6 w-6 text-orange-400" />
            <span className="mt-2 text-sm font-semibold text-white">
              Selecionar arquivo .txt, .nbp, .bin ou .rbk no celular
            </span>
            <span className="mt-1 text-xs text-slate-400">
              Compatível com colunas Tul | TotalKm | Inter | Lat | Lon | CAP | IdealTime | Typ | Sec
            </span>
            <input
              type="file"
              accept=".txt,.csv,.nbp,.zip,.bin,.rbk,.xml,.gpx,.json,.db,.sqlite,.sqlite3,application/zip,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleRoadbookFile(f);
                e.currentTarget.value = '';
              }}
            />
          </label>

          {parseError && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-950/50 p-3 text-xs text-red-300">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              <span>{parseError}</span>
            </div>
          )}

          {roadbook && (
            <div className="mt-4 rounded-xl border border-emerald-500/30 bg-[#0a0d13] p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-white">
                  {roadbook.eventName}
                </p>
                <span className="font-mono text-xs text-slate-400">
                  {roadbook.fileName}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 tabular-nums">
                <span>
                  <strong className="text-orange-400">{roadbook.tulipas.length}</strong> referências
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  <strong className="text-white">{roadbook.totalKm.toFixed(2)} km</strong> totais
                </span>
                <span aria-hidden="true">·</span>
                <span className="text-emerald-400">Planilha validada para coleta GPS</span>
              </div>
            </div>
          )}
        </section>
      </div>

      <div className="space-y-6 lg:col-span-5">
        <section className="relative overflow-hidden rounded-2xl border border-slate-800 bg-[#12161f] text-slate-100 shadow-xl">
          <div aria-hidden="true" className="h-1.5 w-full rally-track-stripe" />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-1.5 right-0 h-24 w-36 bg-rally-checkered opacity-35 [mask-image:linear-gradient(to_bottom_left,black,transparent)]"
          />

          <div className="relative p-4 sm:p-6">
            <p className="text-[10px] font-bold tracking-[0.18em] text-orange-400 uppercase sm:text-[11px]">
              Pré-Largada
            </p>
            <h2 className="mt-0.5 font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-white sm:text-2xl">
              Verificação de GPS e Largada
            </h2>
            <p className="mt-0.5 text-xs text-slate-400 sm:text-sm">
              Confirme a permissão de localização antes de iniciar a coleta.
            </p>

            <div className="mt-4 rounded-xl border border-slate-800 bg-[#0a0d13] p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-slate-200">
                  Sinal GPS do Aparelho
                </span>
                <button
                  type="button"
                  onClick={handleTestGps}
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-700 bg-[#161b26] px-3 py-1.5 text-xs font-semibold text-slate-100 hover:bg-[#1e2533] whitespace-nowrap shrink-0"
                >
                  <Navigation className="h-3.5 w-3.5 text-orange-400" />
                  <span>
                    {gpsTestState.status === 'checking' ? 'Buscando...' : 'Testar GPS'}
                  </span>
                </button>
              </div>

              {gpsTestState.status === 'ok' && (
                <div className="mt-3 font-mono text-xs text-emerald-400 tabular-nums">
                  Sinal OK · Precisão ±{gpsTestState.accuracyM}m · Lat{' '}
                  {gpsTestState.lat?.toFixed(5)} / Lon {gpsTestState.lon?.toFixed(5)}
                </div>
              )}
              {gpsTestState.status === 'error' && (
                <p className="mt-3 text-xs text-red-400">{gpsTestState.message}</p>
              )}
            </div>

            <div className="mt-5 space-y-2.5 border-t border-slate-800 pt-5 text-xs leading-relaxed text-slate-400">
              <p className="flex items-start gap-2">
                <Sliders className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-400" />
                <span>
                  <strong className="text-slate-200">Registro Automático:</strong> O app grava
                  a passagem pelo ponto mais próximo dentro do raio configurado.
                </span>
              </p>
              <p className="flex items-start gap-2">
                <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-400" />
                <span>
                  <strong className="text-slate-200">Visor Silencioso:</strong> Durante a
                  prova, o aplicativo roda em modo secundário apenas para envio posterior à organização.
                </span>
              </p>
            </div>

            <button
              type="button"
              disabled={!canStart}
              onClick={handleStartRace}
              className="rally-btn-orange mt-6 inline-flex w-full min-h-[52px] items-center justify-center gap-2 rounded-xl px-5 py-3.5 text-base font-bold tracking-wide text-white transition-all disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-800 disabled:bg-none disabled:text-slate-500 disabled:shadow-none"
            >
              <Play className="h-4 w-4 fill-current" />
              <span>Iniciar Coleta da Prova</span>
            </button>

            {!canStart && (
              <p className="mt-2.5 text-center text-xs text-slate-500">
                Informe o número do carro e carregue a planilha para liberar a largada.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
