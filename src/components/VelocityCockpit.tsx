import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import {
  Calculator,
  Compass,
  Copy,
  Download,
  Flag,
  FolderOpen,
  Gauge,
  Map as MapIcon,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Timer,
  Trash2,
  TrendingUp,
  Upload,
} from 'lucide-react';
import { TimeCalculatorModal } from './TimeCalculatorModal';
import { useNavSettings } from '../utils/navSettings';
import {
  bearingBetweenDeg,
  computeOptimalStage,
  computePredictiveDeltaSec,
  createDemoSpecialStage,
  detectTrapCrossing,
  exportTrackGeoJson,
  exportTrackGpx,
  formatDeltaSeconds,
  formatStageDuration,
  getOrderedTrackTraps,
  haversineMetersVel,
  loadVelocityRuns,
  loadVelocityTracks,
  parseGpxOrGeoJsonToTrack,
  saveVelocityRuns,
  saveVelocityTracks,
  type TrapKind,
  type VelocityRun,
  type VelocitySample,
  type VelocityTrack,
  type VelocityTrap,
} from '../utils/velocityEngine';

type VelocitySubTab = 'timer' | 'gauges' | 'map' | 'analysis';
type VelDriveSource = 'gps' | 'simulator';

interface GaugeVisibility {
  speed: boolean;
  trip: boolean;
  officialClock: boolean;
  stageTime: boolean;
  maxSpeed: boolean;
  altitude: boolean;
  gpsAccuracy: boolean;
  heading: boolean;
}

const GAUGE_PREFS_KEY = 'pitstop_velocity_gauges_v1';

const DEFAULT_GAUGES: GaugeVisibility = {
  speed: true,
  trip: true,
  officialClock: true,
  stageTime: true,
  maxSpeed: true,
  altitude: true,
  gpsAccuracy: true,
  heading: true,
};

function loadGaugePrefs(): GaugeVisibility {
  try {
    const raw = localStorage.getItem(GAUGE_PREFS_KEY);
    if (!raw) return DEFAULT_GAUGES;
    return { ...DEFAULT_GAUGES, ...(JSON.parse(raw) as Partial<GaugeVisibility>) };
  } catch {
    return DEFAULT_GAUGES;
  }
}

function formatClockTime(tsMs: number): string {
  const d = new Date(tsMs);
  return [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join(':');
}

export const VelocityCockpit: React.FC = () => {
  const [navSettings] = useNavSettings();
  const [subTab, setSubTab] = useState<VelocitySubTab>('timer');
  const [source, setSource] = useState<VelDriveSource>('gps');

  const [tracks, setTracks] = useState<VelocityTrack[]>(() => loadVelocityTracks());
  const [runs, setRuns] = useState<VelocityRun[]>(() => loadVelocityRuns());
  const [activeTrackId, setActiveTrackId] = useState<string>(() => {
    const existing = loadVelocityTracks();
    return existing[0]?.id ?? '';
  });

  // Active recording / stage session state
  const [isRecording, setIsRecording] = useState(false);
  const [stageState, setStageState] = useState<'idle' | 'armed' | 'running' | 'finished'>('idle');
  const [stageStartMs, setStageStartMs] = useState<number | null>(null);
  const [lastFinishedMs, setLastFinishedMs] = useState<number | null>(null);
  const [currentSplitTimesMs, setCurrentSplitTimesMs] = useState<Record<string, number>>({});
  const [liveSamples, setLiveSamples] = useState<VelocitySample[]>([]);

  // Live telemetry values
  const [speedKmh, setSpeedKmh] = useState(0);
  const [maxSpeedKmh, setMaxSpeedKmh] = useState(0);
  const [altitudeM, setAltitudeM] = useState<number | null>(null);
  const [headingDeg, setHeadingDeg] = useState<number | null>(null);
  const [gpsAccuracyM, setGpsAccuracyM] = useState<number | null>(null);
  const [gpsActive, setGpsActive] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [totalDistKm, setTotalDistKm] = useState(0);
  const [tripDistKm, setTripDistKm] = useState(0);
  const [tripTargetKm, setTripTargetKm] = useState<number | null>(null);
  const [tripRegressive, setTripRegressive] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [currentPos, setCurrentPos] = useState<{ lat: number; lon: number } | null>(null);

  // Simulator & Editor state
  const [simPlaying, setSimPlaying] = useState(false);
  const [simMultiplier, setSimMultiplier] = useState(1);
  const [newTrackName, setNewTrackName] = useState('');
  const [showNewTrackModal, setShowNewTrackModal] = useState(false);
  const [newTrapWidthM, setNewTrapWidthM] = useState(35);
  const [postEditIdx, setPostEditIdx] = useState(0);
  const [showGaugeConfig, setShowGaugeConfig] = useState(false);
  const [gaugeVisibility, setGaugeVisibility] = useState<GaugeVisibility>(() => loadGaugePrefs());
  const [statusFeedback, setStatusFeedback] = useState<string | null>(null);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [showTimeCalc, setShowTimeCalc] = useState(false);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editingTrackName, setEditingTrackName] = useState('');

  const prevSampleRef = useRef<VelocitySample | null>(null);
  const stageStateRef = useRef(stageState);
  stageStateRef.current = stageState;
  const stageStartMsRef = useRef(stageStartMs);
  stageStartMsRef.current = stageStartMs;
  const currentSplitTimesRef = useRef(currentSplitTimesMs);
  currentSplitTimesRef.current = currentSplitTimesMs;
  const liveSamplesRef = useRef(liveSamples);
  liveSamplesRef.current = liveSamples;
  const maxSpeedRef = useRef(maxSpeedKmh);
  maxSpeedRef.current = maxSpeedKmh;
  const totalDistRef = useRef(totalDistKm);
  totalDistRef.current = totalDistKm;
  const simProgressRef = useRef(0);
  const webWatchRef = useRef<number | null>(null);
  const capWatchRef = useRef<string | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    saveVelocityTracks(tracks);
  }, [tracks]);

  useEffect(() => {
    saveVelocityRuns(runs);
  }, [runs]);

  useEffect(() => {
    try {
      localStorage.setItem(GAUGE_PREFS_KEY, JSON.stringify(gaugeVisibility));
    } catch {
      // Ignore storage error
    }
  }, [gaugeVisibility]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);

  // Optional screen wake lock while session or timer is active
  useEffect(() => {
    if (!isRecording && stageState !== 'running' && stageState !== 'armed') {
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
      setWakeLockActive(false);
      return;
    }
    if ('wakeLock' in navigator) {
      navigator.wakeLock
        .request('screen')
        .then((s) => {
          wakeLockRef.current = s;
          setWakeLockActive(true);
        })
        .catch(() => setWakeLockActive(false));
    }
    return () => {
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, [isRecording, stageState]);

  const activeTrack = useMemo(
    () => tracks.find((t) => t.id === activeTrackId) ?? null,
    [tracks, activeTrackId]
  );

  const trackRuns = useMemo(() => {
    if (!activeTrack) return [];
    return runs
      .filter((r) => r.trackId === activeTrack.id)
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
  }, [runs, activeTrack]);

  const optimalSummary = useMemo(() => {
    if (!activeTrack) {
      return {
        optimalTotalMs: null,
        bestRunTotalMs: null,
        bestRunId: null,
        lastRunTotalMs: null,
        sectors: [],
      };
    }
    return computeOptimalStage(activeTrack, runs);
  }, [activeTrack, runs]);

  const bestRun = useMemo(() => {
    if (!optimalSummary.bestRunId) return null;
    return trackRuns.find((r) => r.id === optimalSummary.bestRunId) ?? null;
  }, [trackRuns, optimalSummary.bestRunId]);

  const lastRun = useMemo(() => {
    return trackRuns.length > 0 ? trackRuns[trackRuns.length - 1] : null;
  }, [trackRuns]);

  const showToast = useCallback((msg: string) => {
    setStatusFeedback(msg);
    window.setTimeout(() => {
      setStatusFeedback((curr) => (curr === msg ? null : curr));
    }, 3500);
  }, []);

  const finalizeRun = useCallback(
    (finishedAtMs: number, splitsOverride?: Record<string, number>) => {
      const startMs = stageStartMsRef.current;
      if (!startMs) return;
      const elapsedTotal = Math.max(100, finishedAtMs - startMs);
      const samples = liveSamplesRef.current;
      const distKm = totalDistRef.current;
      const avgSpeed =
        elapsedTotal > 0 ? (distKm / (elapsedTotal / 3600000)) : 0;

      if (activeTrack) {
        const nextNum =
          runs.filter((r) => r.trackId === activeTrack.id).length + 1;
        const newRun: VelocityRun = {
          id: `run_${Date.now()}`,
          trackId: activeTrack.id,
          runNumber: nextNum,
          startedAtMs: startMs,
          finishedAtMs,
          totalMs: elapsedTotal,
          splitTimesMs: splitsOverride ?? currentSplitTimesRef.current,
          maxSpeedKmh: Math.round(maxSpeedRef.current),
          avgSpeedKmh: Math.round(avgSpeed),
          distanceKm: Number(distKm.toFixed(3)),
          samples: samples.slice(-600),
        };
        setRuns((prev) => [newRun, ...prev]);

        // Also update track reference trace if track didn't have one
        setTracks((prev) =>
          prev.map((t) =>
            t.id === activeTrack.id && (!t.baseTrace || t.baseTrace.length === 0)
              ? {
                  ...t,
                  referenceDistanceKm: distKm,
                  baseTrace: samples.slice(-600),
                }
              : t
          )
        );
      }

      setLastFinishedMs(elapsedTotal);
      setStageState('finished');
      setIsRecording(false);
      setSimPlaying(false);
      showToast(`Chegada registrada: ${formatStageDuration(elapsedTotal)}`);
    },
    [activeTrack, runs, showToast]
  );

  // Core GPS sample processor with Trap vector intersection
  const processIncomingFix = useCallback(
    (fix: {
      lat: number;
      lon: number;
      speedKmh: number;
      accuracyM: number | null;
      headingDeg: number | null;
      altitudeM: number | null;
      timestampMs: number;
    }) => {
      setCurrentPos({ lat: fix.lat, lon: fix.lon });
      setSpeedKmh(fix.speedKmh);
      setGpsAccuracyM(fix.accuracyM);
      setAltitudeM(fix.altitudeM);
      setGpsActive(true);
      setGpsError(null);

      const prev = prevSampleRef.current;
      let deltaDistKm = 0;
      let resolvedHeading = fix.headingDeg;

      if (prev) {
        const stepM = haversineMetersVel(prev.lat, prev.lon, fix.lat, fix.lon);
        // Filter extreme GPS jitter when stationary
        if (stepM >= 0.4 && stepM < 500) {
          deltaDistKm = stepM / 1000;
          if (resolvedHeading === null && stepM >= 2) {
            resolvedHeading = bearingBetweenDeg(prev.lat, prev.lon, fix.lat, fix.lon);
          }
        }
      }
      if (resolvedHeading !== null) {
        setHeadingDeg(Math.round(resolvedHeading));
      }

      const nextTotalDist = totalDistRef.current + deltaDistKm;
      if (isRecording || stageStateRef.current === 'running') {
        setTotalDistKm(nextTotalDist);
        setTripDistKm((t) => t + deltaDistKm);
      } else if (stageStateRef.current === 'armed') {
        setTripDistKm((t) => t + deltaDistKm);
      }

      if (fix.speedKmh > maxSpeedRef.current && (isRecording || stageStateRef.current === 'running')) {
        setMaxSpeedKmh(Math.round(fix.speedKmh));
      }

      let activeStartMs = stageStartMsRef.current;
      let nextStageState = stageStateRef.current;
      const updatedSplits = { ...currentSplitTimesRef.current };

      // Check Virtual Trap crossings when track is selected and prev fix exists
      if (activeTrack && prev && (stageStateRef.current === 'armed' || stageStateRef.current === 'running')) {
        const ordered = getOrderedTrackTraps(activeTrack);
        for (const trap of ordered) {
          const hit = detectTrapCrossing(
            { lat: prev.lat, lon: prev.lon, timestampMs: prev.timestampMs },
            { lat: fix.lat, lon: fix.lon, timestampMs: fix.timestampMs },
            trap
          );
          if (!hit) continue;

          if (trap.kind === 'start' && nextStageState === 'armed') {
            activeStartMs = hit.crossTimestampMs;
            nextStageState = 'running';
            setStageStartMs(hit.crossTimestampMs);
            setStageState('running');
            setTotalDistKm(0);
            setTripDistKm(0);
            setMaxSpeedKmh(Math.round(fix.speedKmh));
            setCurrentSplitTimesMs({});
            showToast(`Largada automática (${trap.name})`);
          } else if (
            trap.kind === 'split' &&
            nextStageState === 'running' &&
            activeStartMs !== null &&
            updatedSplits[trap.id] === undefined
          ) {
            const splitMs = Math.max(0, hit.crossTimestampMs - activeStartMs);
            updatedSplits[trap.id] = splitMs;
            setCurrentSplitTimesMs({ ...updatedSplits });
            showToast(`${trap.name}: ${formatStageDuration(splitMs)}`);
          } else if (
            trap.kind === 'finish' &&
            nextStageState === 'running' &&
            activeStartMs !== null
          ) {
            const finMs = Math.max(100, hit.crossTimestampMs - activeStartMs);
            updatedSplits[trap.id] = finMs;
            setCurrentSplitTimesMs({ ...updatedSplits });
            finalizeRun(hit.crossTimestampMs, updatedSplits);
            nextStageState = 'finished';
          }
        }
      }

      const elapsedMs =
        activeStartMs !== null && nextStageState === 'running'
          ? Math.max(0, fix.timestampMs - activeStartMs)
          : liveSamplesRef.current.length > 0
            ? fix.timestampMs - liveSamplesRef.current[0].timestampMs
            : 0;

      const sample: VelocitySample = {
        lat: fix.lat,
        lon: fix.lon,
        speedKmh: fix.speedKmh,
        accuracyM: fix.accuracyM,
        headingDeg: resolvedHeading,
        altitudeM: fix.altitudeM,
        timestampMs: fix.timestampMs,
        distKm: nextStageState === 'running' ? nextTotalDist : liveSamplesRef.current.length === 0 ? 0 : nextTotalDist,
        stageElapsedMs: elapsedMs,
      };

      prevSampleRef.current = sample;
      if (isRecording || nextStageState === 'running') {
        setLiveSamples((arr) => [...arr.slice(-899), sample]);
      }
    },
    [activeTrack, isRecording, finalizeRun, showToast]
  );

  // Real GPS listener
  useEffect(() => {
    if (source !== 'gps') return;
    let cancelled = false;

    const cleanup = () => {
      if (webWatchRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(webWatchRef.current);
        webWatchRef.current = null;
      }
      if (capWatchRef.current !== null) {
        Geolocation.clearWatch({ id: capWatchRef.current }).catch(() => {});
        capWatchRef.current = null;
      }
    };

    const startGps = async () => {
      if (Capacitor.isNativePlatform()) {
        try {
          const perm = await Geolocation.requestPermissions();
          if (cancelled) return;
          if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
            setGpsError('Permissão de GPS negada no dispositivo.');
            return;
          }
          const wid = await Geolocation.watchPosition(
            { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
            (pos, err) => {
              if (cancelled || err || !pos) return;
              processIncomingFix({
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                speedKmh: pos.coords.speed ? Math.max(0, pos.coords.speed * 3.6) : 0,
                accuracyM: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null,
                headingDeg:
                  pos.coords.heading !== null && Number.isFinite(pos.coords.heading)
                    ? Math.round(pos.coords.heading)
                    : null,
                altitudeM:
                  pos.coords.altitude !== null && Number.isFinite(pos.coords.altitude)
                    ? Math.round(pos.coords.altitude)
                    : null,
                timestampMs: pos.timestamp || Date.now(),
              });
            }
          );
          capWatchRef.current = wid;
        } catch {
          if (!cancelled) setGpsError('Erro ao iniciar receptor GPS.');
        }
        return;
      }

      if (!('geolocation' in navigator)) {
        setGpsError('GPS indisponível neste navegador. Use o modo Simulador para testar.');
        return;
      }

      webWatchRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          if (cancelled) return;
          processIncomingFix({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            speedKmh: pos.coords.speed ? Math.max(0, pos.coords.speed * 3.6) : 0,
            accuracyM: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null,
            headingDeg:
              pos.coords.heading !== null && Number.isFinite(pos.coords.heading)
                ? Math.round(pos.coords.heading)
                : null,
            altitudeM:
              pos.coords.altitude !== null && Number.isFinite(pos.coords.altitude)
                ? Math.round(pos.coords.altitude)
                : null,
            timestampMs: pos.timestamp || Date.now(),
          });
        },
        (err) => {
          if (cancelled) return;
          setGpsActive(false);
          setGpsError(
            err.code === 1
              ? 'Localização bloqueada no navegador. Libere o GPS ou use o Simulador.'
              : 'Aguardando sinal GPS em área aberta (ou ative Simulador).'
          );
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
    };

    startGps();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [source, processIncomingFix]);

  // Simulator GPS engine for testing Point-to-Point traps indoors
  const demoStage = useMemo(() => createDemoSpecialStage(), []);
  useEffect(() => {
    if (source !== 'simulator' || !simPlaying) return;
    const path = demoStage.simWaypoints;
    const id = window.setInterval(() => {
      const idxFloat = simProgressRef.current;
      const idx0 = Math.floor(idxFloat);
      if (idx0 >= path.length - 1) {
        setSimPlaying(false);
        return;
      }
      const idx1 = idx0 + 1;
      const frac = idxFloat - idx0;
      const p0 = path[idx0];
      const p1 = path[idx1];
      const lat = p0.lat + (p1.lat - p0.lat) * frac;
      const lon = p0.lon + (p1.lon - p0.lon) * frac;
      // Add slight speed variation on consecutive runs so delta predictive is visibly tested!
      const runVariance = trackRuns.length % 2 === 1 ? 1.07 : 0.96;
      const spd = Math.round((p0.speedKmh + (p1.speedKmh - p0.speedKmh) * frac) * runVariance);
      const alt = Math.round(p0.altM + (p1.altM - p0.altM) * frac);
      const hdg = bearingBetweenDeg(p0.lat, p0.lon, p1.lat, p1.lon);

      processIncomingFix({
        lat,
        lon,
        speedKmh: spd,
        accuracyM: 3,
        headingDeg: hdg,
        altitudeM: alt,
        timestampMs: Date.now(),
      });

      const segM = Math.max(10, haversineMetersVel(p0.lat, p0.lon, p1.lat, p1.lon));
      const mPerTick = ((spd / 3.6) * 0.2) * simMultiplier;
      simProgressRef.current += mPerTick / segM;
    }, 200);

    return () => window.clearInterval(id);
  }, [source, simPlaying, simMultiplier, demoStage, processIncomingFix, trackRuns.length]);

  const handleLoadDemoStage = () => {
    const existing = tracks.find((t) => t.id === demoStage.track.id);
    if (!existing) {
      setTracks((prev) => [demoStage.track, ...prev]);
    }
    setActiveTrackId(demoStage.track.id);
    setSource('simulator');
    simProgressRef.current = 0;
    prevSampleRef.current = null;
    setLiveSamples([]);
    setTotalDistKm(0);
    setTripDistKm(0);
    setCurrentSplitTimesMs({});
    setStageStartMs(null);
    setLastFinishedMs(null);
    setStageState('armed');
    setIsRecording(true);
    setSimPlaying(true);
    showToast('Especial SS-01 armada no Simulador! Cruzando pórtico de largada...');
  };

  const handleStartOrArmStage = () => {
    if (stageState === 'running') {
      finalizeRun(Date.now());
      return;
    }

    prevSampleRef.current = null;
    setLiveSamples([]);
    setTotalDistKm(0);
    setTripDistKm(0);
    setMaxSpeedKmh(0);
    setCurrentSplitTimesMs({});
    setLastFinishedMs(null);
    setIsRecording(true);

    const hasStartTrap = activeTrack?.traps.some((t) => t.kind === 'start');
    if (hasStartTrap) {
      setStageStartMs(null);
      setStageState('armed');
      if (source === 'simulator') {
        simProgressRef.current = 0;
        setSimPlaying(true);
      }
      showToast('Armado: aguardando cruzar linha de Largada (Start Trap)');
    } else {
      setStageStartMs(Date.now());
      setStageState('running');
      showToast('Especial iniciada manualmente!');
    }
  };

  const handleStartRecceSession = () => {
    const name = newTrackName.trim() || `Especial ${tracks.length + 1}`;
    const newTrack: VelocityTrack = {
      id: `trk_${Date.now()}`,
      name,
      mode: 'point-to-point',
      traps: [],
      createdAtMs: Date.now(),
      referenceDistanceKm: 0,
    };
    setTracks((prev) => [newTrack, ...prev]);
    setActiveTrackId(newTrack.id);
    setNewTrackName('');
    setShowNewTrackModal(false);
    setLiveSamples([]);
    setTotalDistKm(0);
    setTripDistKm(0);
    setStageState('idle');
    setIsRecording(true);
    setSubTab('map');
    showToast(`Recce iniciado: ${name}. Marque Start, Splits e Finish durante o trajeto!`);
  };

  const handleDropTrapAtPosition = (kind: TrapKind, sampleOverride?: VelocitySample) => {
    if (!activeTrack) {
      setShowNewTrackModal(true);
      return;
    }

    const pos = sampleOverride ?? (currentPos
      ? {
          lat: currentPos.lat,
          lon: currentPos.lon,
          headingDeg: headingDeg ?? 0,
        }
      : null);

    if (!pos) {
      showToast('Aguarde uma coordenada GPS (ou ative o Simulador) para posicionar a Trap.');
      return;
    }

    const splitCount = activeTrack.traps.filter((t) => t.kind === 'split').length;
    const trapLabel =
      kind === 'start'
        ? 'Largada (Start)'
        : kind === 'finish'
          ? 'Chegada (Finish)'
          : `Parcial ${splitCount + 1}`;

    const newTrap: VelocityTrap = {
      id: `trap_${kind}_${Date.now()}`,
      name: trapLabel,
      kind,
      lat: pos.lat,
      lon: pos.lon,
      bearingDeg: pos.headingDeg ?? headingDeg ?? 0,
      widthM: newTrapWidthM,
    };

    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== activeTrack.id) return t;
        // Replace existing Start/Finish if Point-to-Point already has one, or append Split
        const filtered =
          kind === 'split'
            ? t.traps
            : t.traps.filter((existing) => existing.kind !== kind);
        return {
          ...t,
          traps: [...filtered, newTrap],
        };
      })
    );
    showToast(`${trapLabel} posicionada (${newTrap.bearingDeg}° · ${newTrapWidthM}m)!`);
  };

  const handleRemoveTrap = (trapId: string) => {
    if (!activeTrack) return;
    setTracks((prev) =>
      prev.map((t) =>
        t.id === activeTrack.id
          ? { ...t, traps: t.traps.filter((tr) => tr.id !== trapId) }
          : t
      )
    );
  };

  const handleDuplicateTrack = (track: VelocityTrack) => {
    const copyId = `trk_${Date.now()}`;
    const copyName = `${track.name} (Cópia)`;
    const cloned: VelocityTrack = {
      ...track,
      id: copyId,
      name: copyName,
      createdAtMs: Date.now(),
      traps: track.traps.map((tr) => ({ ...tr, id: `${tr.id}_c_${Date.now()}` })),
      baseTrace: track.baseTrace ? [...track.baseTrace] : undefined,
    };
    setTracks((prev) => [cloned, ...prev]);
    setActiveTrackId(copyId);
    showToast(`Cópia salva: "${copyName}"`);
  };

  const handleDeleteTrack = (trackId: string) => {
    const remaining = tracks.filter((t) => t.id !== trackId);
    setTracks(remaining);
    setRuns((prev) => prev.filter((r) => r.trackId !== trackId));
    if (activeTrackId === trackId) {
      setActiveTrackId(remaining[0]?.id ?? '');
      setStageState('idle');
      setStageStartMs(null);
      setLastFinishedMs(null);
      setCurrentSplitTimesMs({});
    }
    showToast('Mapa / Especial excluído.');
  };

  const handleCommitRenameTrack = (trackId: string) => {
    const clean = editingTrackName.trim();
    if (!clean) {
      setEditingTrackId(null);
      return;
    }
    setTracks((prev) =>
      prev.map((t) => (t.id === trackId ? { ...t, name: clean } : t))
    );
    setEditingTrackId(null);
    showToast(`Nome atualizado para "${clean}"`);
  };

  const handleImportGeoFile = async (file: File) => {
    try {
      const content = await file.text();
      const parsed = parseGpxOrGeoJsonToTrack(content, file.name);
      setTracks((prev) => [parsed, ...prev]);
      setActiveTrackId(parsed.id);
      setSubTab('map');
      showToast(`Traçado "${parsed.name}" importado com ${parsed.traps.length} armadilhas.`);
    } catch {
      showToast('Não foi possível ler o arquivo .GPX ou .GeoJSON.');
    }
  };

  const handleExportTrack = (fmt: 'geojson' | 'gpx') => {
    if (!activeTrack) return;
    const trace =
      liveSamples.length > 1
        ? liveSamples
        : lastRun?.samples && lastRun.samples.length > 1
          ? lastRun.samples
          : activeTrack.baseTrace ?? [];
    const content =
      fmt === 'geojson'
        ? exportTrackGeoJson(activeTrack, trace)
        : exportTrackGpx(activeTrack, trace);
    const slug = activeTrack.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const blob = new Blob([content], {
      type: fmt === 'geojson' ? 'application/geo+json' : 'application/gpx+xml',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}.${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Computed live stage elapsed & predictive time delta
  const clockAdjustedNow = nowMs + navSettings.clockOffsetMs;
  const currentStageElapsedMs =
    stageState === 'running' && stageStartMs !== null
      ? Math.max(0, nowMs - stageStartMs)
      : stageState === 'finished' && lastFinishedMs !== null
        ? lastFinishedMs
        : 0;

  const predictiveDeltaSec = useMemo(() => {
    if (stageState !== 'running' || !bestRun) return null;
    return computePredictiveDeltaSec(totalDistKm, currentStageElapsedMs, bestRun);
  }, [stageState, bestRun, totalDistKm, currentStageElapsedMs]);

  const orderedTraps = useMemo(
    () => (activeTrack ? getOrderedTrackTraps(activeTrack) : []),
    [activeTrack]
  );

  // Trace available for Post-Recording Trap Editor & SVG Map
  const editableTrace = useMemo(() => {
    if (liveSamples.length > 1) return liveSamples;
    if (lastRun && lastRun.samples.length > 1) return lastRun.samples;
    if (activeTrack?.baseTrace && activeTrack.baseTrace.length > 1) {
      return activeTrack.baseTrace;
    }
    return [];
  }, [liveSamples, lastRun, activeTrack]);

  useEffect(() => {
    if (postEditIdx >= editableTrace.length) {
      setPostEditIdx(Math.max(0, editableTrace.length - 1));
    }
  }, [editableTrace.length, postEditIdx]);

  const displayedTripKm =
    tripRegressive && tripTargetKm !== null
      ? Math.max(0, tripTargetKm - tripDistKm)
      : tripDistKm;

  // Delta visual bar percentage (-5s..+5s range)
  const deltaClampedPct =
    predictiveDeltaSec === null
      ? 0
      : Math.min(50, Math.max(6, (Math.abs(predictiveDeltaSec) / 5) * 50));
  const isFaster = predictiveDeltaSec !== null && predictiveDeltaSec < -0.05;
  const isSlower = predictiveDeltaSec !== null && predictiveDeltaSec > 0.05;

  // Build SVG bounds for Live Map
  const mapGeometry = useMemo(() => {
    const pts: { lat: number; lon: number }[] = [
      ...editableTrace.map((s) => ({ lat: s.lat, lon: s.lon })),
      ...orderedTraps.map((t) => ({ lat: t.lat, lon: t.lon })),
    ];
    if (currentPos) pts.push(currentPos);
    if (pts.length === 0) return null;

    let minLat = pts[0].lat;
    let maxLat = pts[0].lat;
    let minLon = pts[0].lon;
    let maxLon = pts[0].lon;
    for (const p of pts) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    const padLat = Math.max(0.0008, (maxLat - minLat) * 0.14);
    const padLon = Math.max(0.0008, (maxLon - minLon) * 0.14);
    minLat -= padLat;
    maxLat += padLat;
    minLon -= padLon;
    maxLon += padLon;

    const project = (lat: number, lon: number) => {
      const x = ((lon - minLon) / Math.max(1e-6, maxLon - minLon)) * 320 + 20;
      const y = (1 - (lat - minLat) / Math.max(1e-6, maxLat - minLat)) * 200 + 20;
      return { x, y };
    };

    return { project };
  }, [editableTrace, orderedTraps, currentPos]);

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Top Track Selector & GPS/Simulator Bar */}
      <section className="rounded-xl border border-zinc-800 bg-[#111214] px-3 py-2.5 text-white shadow-lg sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <select
              aria-label="Selecionar especial ou circuito"
              value={activeTrackId}
              onChange={(e) => {
                setActiveTrackId(e.target.value);
                setStageState('idle');
                setStageStartMs(null);
                setLastFinishedMs(null);
                setCurrentSplitTimesMs({});
              }}
              className="min-h-[38px] max-w-[230px] rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 text-xs font-bold text-white focus:border-[#E10600] focus:outline-none sm:max-w-[290px]"
            >
              <option value="">Selecionar Especial / Circuito...</option>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.traps.length} traps)
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => setShowNewTrackModal(true)}
              className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-bold text-white hover:bg-zinc-800 whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5 text-[#E10600]" />
              <span>Nova Especial</span>
            </button>

            <button
              type="button"
              onClick={handleLoadDemoStage}
              className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-semibold text-[#C0C4C9] hover:text-white whitespace-nowrap"
            >
              <Play className="h-3 w-3 text-emerald-400" />
              <span>Demo SS-01</span>
            </button>

            <button
              type="button"
              onClick={() => setShowTimeCalc(true)}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-950/35 px-3 text-xs font-bold text-emerald-300 hover:bg-emerald-950/60 whitespace-nowrap"
            >
              <Calculator className="h-3.5 w-3.5 text-emerald-400" />
              <span>Calc. Tempo</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <div className="inline-flex rounded-lg border border-zinc-800 bg-[#080B0D] p-0.5">
              <button
                type="button"
                onClick={() => {
                  setSource('gps');
                  setSimPlaying(false);
                }}
                className={`min-h-[32px] rounded-md px-2.5 text-[11px] font-bold transition-colors whitespace-nowrap ${
                  source === 'gps' ? 'bg-[#E10600] text-white' : 'text-[#B5B5B5] hover:text-white'
                }`}
              >
                GPS {gpsActive ? `±${gpsAccuracyM ?? '--'}m` : ''}
              </button>
              <button
                type="button"
                onClick={() => setSource('simulator')}
                className={`min-h-[32px] rounded-md px-2.5 text-[11px] font-bold transition-colors whitespace-nowrap ${
                  source === 'simulator' ? 'bg-[#E10600] text-white' : 'text-[#B5B5B5] hover:text-white'
                }`}
              >
                Simulador
              </button>
            </div>

            {source === 'simulator' && (
              <div className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-[#080B0D] px-1.5 py-0.5">
                <button
                  type="button"
                  onClick={() => setSimPlaying((v) => !v)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded text-white hover:bg-zinc-800"
                  aria-label={simPlaying ? 'Pausar simulador' : 'Rodar simulador'}
                >
                  {simPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 text-emerald-400" />}
                </button>
                {[1, 2, 4].map((x) => (
                  <button
                    key={x}
                    type="button"
                    onClick={() => setSimMultiplier(x)}
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                      simMultiplier === x ? 'bg-[#E10600] text-white' : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    {x}x
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 4 Swipeable/Tabbed RaceChrono Modules */}
        <div className="mt-2.5 grid grid-cols-4 gap-1 rounded-lg border border-zinc-800 bg-[#080B0D] p-1">
          {(
            [
              ['timer', 'Cronômetro', Timer],
              ['gauges', 'Mostradores', Gauge],
              ['map', 'Mapa & Traps', MapIcon],
              ['analysis', 'Telemetria', TrendingUp],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setSubTab(id)}
              className={`inline-flex min-h-[38px] items-center justify-center gap-1 rounded-md px-1.5 text-[11px] font-bold transition-colors whitespace-nowrap sm:text-xs ${
                subTab === id
                  ? 'pitstop-btn-red text-white'
                  : 'text-[#B5B5B5] hover:text-white'
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>

        {(statusFeedback || gpsError) && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-[#080B0D] px-3 py-1.5 text-xs">
            <span className={gpsError && !statusFeedback ? 'text-amber-300' : 'text-emerald-400 font-semibold'}>
              {statusFeedback || gpsError}
            </span>
            {wakeLockActive && (
              <span className="font-mono text-[10px] text-zinc-400 whitespace-nowrap">Tela Ativa</span>
            )}
          </div>
        )}
      </section>

      {/* SCREEN 1: CRONÔMETRO DE ESPECIAL (HIGH CONTRAST DAYLIGHT UI) */}
      {subTab === 'timer' && (
        <section className="space-y-3">
          {/* Top Visual Predictive Time Delta Bar */}
          <div className="rounded-xl border border-zinc-800 bg-[#000000] p-3 text-white shadow-xl sm:p-4">
            <div className="flex items-center justify-between font-mono text-xs tabular-nums">
              <span className="font-bold text-emerald-400">MAIS RÁPIDO (-s)</span>
              <span
                className={`text-base font-extrabold sm:text-xl ${
                  isFaster
                    ? 'text-emerald-400'
                    : isSlower
                      ? 'text-[#FF2A2A]'
                      : 'text-[#C0C4C9]'
                }`}
              >
                DELTA {formatDeltaSeconds(predictiveDeltaSec)}
              </span>
              <span className="font-bold text-[#FF2A2A]">MAIS LENTO (+s)</span>
            </div>

            <div className="relative mt-2 h-6 w-full overflow-hidden rounded-lg border border-zinc-800 bg-[#111214]">
              <div className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 bg-zinc-400/80 z-10" />
              {isFaster && (
                <div
                  className="absolute inset-y-0 right-1/2 bg-emerald-500 transition-all duration-150"
                  style={{ width: `${deltaClampedPct}%` }}
                />
              )}
              {isSlower && (
                <div
                  className="absolute inset-y-0 left-1/2 bg-[#E10600] transition-all duration-150"
                  style={{ width: `${deltaClampedPct}%` }}
                />
              )}
            </div>

            {/* Giant Daylight-Readable Stage Clock */}
            <div className="mt-4 flex flex-col items-center justify-center rounded-xl border border-zinc-800/90 bg-[#050608] py-5 px-3 text-center sm:py-7">
              <div className="flex items-center gap-2 font-mono text-[11px] font-bold tracking-widest uppercase text-[#B5B5B5]">
                <span>
                  {activeTrack ? activeTrack.name : 'Especial Livre (Sem Traps)'}
                </span>
                <span aria-hidden="true">·</span>
                <span
                  className={
                    stageState === 'running'
                      ? 'text-emerald-400'
                      : stageState === 'armed'
                        ? 'text-amber-400'
                        : 'text-[#C0C4C9]'
                  }
                >
                  {stageState === 'running'
                    ? 'CRONOMETRANDO'
                    : stageState === 'armed'
                      ? 'ARMADO P/ LARGADA'
                      : stageState === 'finished'
                        ? 'ESPECIAL FINALIZADA'
                        : 'PRONTO'}
                </span>
              </div>

              <div
                className={`mt-1 font-mono text-6xl font-extrabold tracking-tight tabular-nums sm:text-7xl md:text-8xl ${
                  stageState === 'running'
                    ? 'text-white'
                    : stageState === 'finished'
                      ? 'text-emerald-400'
                      : 'text-[#C0C4C9]'
                }`}
              >
                {formatStageDuration(currentStageElapsedMs)}
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-center gap-x-6 gap-y-1 font-mono text-xs text-[#C0C4C9] tabular-nums sm:text-sm">
                <span>
                  Velocidade: <strong className="text-white text-base">{Math.round(speedKmh)}</strong> km/h
                </span>
                <span>
                  Trip: <strong className="text-amber-300 text-base">{displayedTripKm.toFixed(2)}</strong> km
                </span>
                <span>
                  CH GPS: <strong className="text-white text-base">{formatClockTime(clockAdjustedNow)}</strong>
                </span>
              </div>
            </div>

            {/* Summary Metrics: Last / Best / Optimal Stage */}
            <div className="mt-3 grid grid-cols-3 gap-2 font-mono tabular-nums">
              <div className="rounded-lg border border-zinc-800 bg-[#080B0D] px-2.5 py-2 text-center">
                <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Última</p>
                <p className="mt-0.5 text-sm font-extrabold text-white sm:text-lg">
                  {formatStageDuration(optimalSummary.lastRunTotalMs)}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-[#080B0D] px-2.5 py-2 text-center">
                <p className="text-[10px] font-bold text-emerald-400 uppercase">Melhor Passada</p>
                <p className="mt-0.5 text-sm font-extrabold text-emerald-400 sm:text-lg">
                  {formatStageDuration(optimalSummary.bestRunTotalMs)}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-[#080B0D] px-2.5 py-2 text-center">
                <p className="text-[10px] font-bold text-amber-400 uppercase">Ideal (Optimal)</p>
                <p className="mt-0.5 text-sm font-extrabold text-amber-300 sm:text-lg">
                  {formatStageDuration(optimalSummary.optimalTotalMs)}
                </p>
              </div>
            </div>
          </div>

          {/* Splits Comparison Table */}
          {orderedTraps.filter((t) => t.kind !== 'start').length > 0 && (
            <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white sm:p-4">
              <h3 className="text-xs font-bold tracking-wider text-[#B5B5B5] uppercase">
                Parciais da Especial (Splits)
              </h3>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full border-collapse text-left font-mono text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-zinc-800 text-[#B5B5B5]">
                      <th className="py-2 pr-2">Trap / Parcial</th>
                      <th className="px-2 py-2 text-right">Atual</th>
                      <th className="px-2 py-2 text-right">Melhor</th>
                      <th className="py-2 pl-2 text-right">Diferença</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {orderedTraps
                      .filter((t) => t.kind !== 'start')
                      .map((trap) => {
                        const currMs = currentSplitTimesMs[trap.id] ?? null;
                        const bestMs = bestRun?.splitTimesMs[trap.id] ?? null;
                        const diffSec =
                          currMs !== null && bestMs !== null ? (currMs - bestMs) / 1000 : null;
                        return (
                          <tr key={trap.id}>
                            <td className="py-2 pr-2 font-sans font-semibold text-white">
                              {trap.name}
                            </td>
                            <td className="px-2 py-2 text-right text-white">
                              {formatStageDuration(currMs)}
                            </td>
                            <td className="px-2 py-2 text-right text-emerald-400">
                              {formatStageDuration(bestMs)}
                            </td>
                            <td
                              className={`py-2 pl-2 text-right font-bold ${
                                diffSec === null
                                  ? 'text-zinc-500'
                                  : diffSec <= 0
                                    ? 'text-emerald-400'
                                    : 'text-[#FF2A2A]'
                              }`}
                            >
                              {formatDeltaSeconds(diffSec)}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Extra-Large Vibration-Proof Bottom Controls (>= 25% width each) */}
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => {
                setTripDistKm(0);
                showToast('Hodômetro parcial (Trip) zerado.');
              }}
              className="pitstop-btn-metal flex min-h-[60px] flex-col items-center justify-center gap-1 rounded-xl px-2 text-xs font-extrabold uppercase sm:text-sm"
            >
              <RotateCcw className="h-5 w-5 text-[#C0C4C9]" />
              <span>Zerar Trip</span>
            </button>

            <button
              type="button"
              onClick={() =>
                handleDropTrapAtPosition(
                  !activeTrack || activeTrack.traps.every((t) => t.kind !== 'start')
                    ? 'start'
                    : 'split'
                )
              }
              className="pitstop-btn-metal flex min-h-[60px] flex-col items-center justify-center gap-1 rounded-xl px-2 text-xs font-extrabold uppercase sm:text-sm"
            >
              <Flag className="h-5 w-5 text-amber-400" />
              <span>+ Armadilha</span>
            </button>

            <button
              type="button"
              onClick={handleStartOrArmStage}
              className="pitstop-btn-red flex min-h-[60px] flex-col items-center justify-center gap-1 rounded-xl px-2 text-xs font-extrabold text-white uppercase sm:text-sm"
            >
              {stageState === 'running' ? (
                <>
                  <Flag className="h-5 w-5" />
                  <span>Encerrar SS</span>
                </>
              ) : (
                <>
                  <Play className="h-5 w-5 fill-current" />
                  <span>Iniciar Especial</span>
                </>
              )}
            </button>
          </div>
        </section>
      )}

      {/* SCREEN 2: MOSTRADORES (HIGH-CONTRAST CONFIGURABLE GAUGES FOR NAVEGADOR) */}
      {subTab === 'gauges' && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-[#111214] px-3.5 py-2.5 text-white">
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-[#E10600]" />
              <span className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
                Mostradores do Navegador
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (!tripRegressive) {
                    const input = tripTargetKm ?? (activeTrack?.referenceDistanceKm || 2.0);
                    setTripTargetKm(input);
                    setTripRegressive(true);
                  } else {
                    setTripRegressive(false);
                  }
                }}
                className={`min-h-[36px] rounded-lg border px-2.5 text-xs font-bold whitespace-nowrap ${
                  tripRegressive
                    ? 'border-[#E10600] bg-[#E10600]/20 text-white'
                    : 'border-zinc-700 bg-[#080B0D] text-[#C0C4C9]'
                }`}
              >
                Trip: {tripRegressive ? 'Regressivo' : 'Progressivo'}
              </button>

              <button
                type="button"
                onClick={() => setShowGaugeConfig((v) => !v)}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 text-xs font-bold text-[#C0C4C9] hover:text-white"
              >
                <Settings2 className="h-3.5 w-3.5" />
                <span>Campos</span>
              </button>
            </div>
          </div>

          {showGaugeConfig && (
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-zinc-800 bg-[#111214] p-3 text-xs sm:grid-cols-4">
              {(
                [
                  ['speed', 'Velocidade'],
                  ['trip', 'Hodômetro Trip'],
                  ['officialClock', 'Horário CH (GPS)'],
                  ['stageTime', 'Cronômetro SS'],
                  ['maxSpeed', 'Vel. Máxima'],
                  ['altitude', 'Altitude'],
                  ['gpsAccuracy', 'Sinal GPS'],
                  ['heading', 'Rumo (CAP)'],
                ] as const
              ).map(([key, label]) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-[#080B0D] px-3 py-2 text-white"
                >
                  <span>{label}</span>
                  <input
                    type="checkbox"
                    checked={gaugeVisibility[key]}
                    onChange={(e) =>
                      setGaugeVisibility((prev) => ({
                        ...prev,
                        [key]: e.target.checked,
                      }))
                    }
                    className="h-4 w-4 accent-[#E10600]"
                  />
                </label>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
            {gaugeVisibility.speed && (
              <div className="rounded-xl border border-zinc-800 bg-[#000000] p-4 text-center">
                <p className="text-[11px] font-bold tracking-wider text-[#B5B5B5] uppercase">
                  Velocidade
                </p>
                <p className="mt-1 font-mono text-5xl font-extrabold text-white tabular-nums sm:text-6xl">
                  {Math.round(speedKmh)}
                </p>
                <p className="font-mono text-xs text-[#E10600] font-bold">KM/H</p>
              </div>
            )}

            {gaugeVisibility.trip && (
              <div className="rounded-xl border border-zinc-800 bg-[#000000] p-4 text-center">
                <p className="text-[11px] font-bold tracking-wider text-[#B5B5B5] uppercase">
                  {tripRegressive ? 'Trip Regressivo' : 'Trip Parcial'}
                </p>
                <p className="mt-1 font-mono text-4xl font-extrabold text-amber-300 tabular-nums sm:text-5xl">
                  {displayedTripKm.toFixed(2)}
                </p>
                <p className="font-mono text-xs text-zinc-400">
                  Total {totalDistKm.toFixed(2)} km
                </p>
              </div>
            )}

            {gaugeVisibility.officialClock && (
              <div className="rounded-xl border border-zinc-800 bg-[#000000] p-4 text-center">
                <p className="text-[11px] font-bold tracking-wider text-[#B5B5B5] uppercase">
                  Horário Oficial (CH)
                </p>
                <p className="mt-2 font-mono text-3xl font-extrabold text-emerald-400 tabular-nums sm:text-4xl">
                  {formatClockTime(clockAdjustedNow)}
                </p>
                <p className="mt-1 font-mono text-[11px] text-zinc-400">GPS SYNC</p>
              </div>
            )}

            {gaugeVisibility.stageTime && (
              <div className="rounded-xl border border-zinc-800 bg-[#000000] p-4 text-center">
                <p className="text-[11px] font-bold tracking-wider text-[#B5B5B5] uppercase">
                  Tempo Especial
                </p>
                <p className="mt-2 font-mono text-3xl font-extrabold text-white tabular-nums sm:text-4xl">
                  {formatStageDuration(currentStageElapsedMs)}
                </p>
                <p className="mt-1 font-mono text-[11px] text-zinc-400">
                  Delta {formatDeltaSeconds(predictiveDeltaSec)}
                </p>
              </div>
            )}

            {gaugeVisibility.maxSpeed && (
              <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-3.5 text-center">
                <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Vel. Máxima</p>
                <p className="mt-1 font-mono text-3xl font-bold text-white tabular-nums">
                  {maxSpeedKmh}
                </p>
                <p className="font-mono text-[11px] text-zinc-500">km/h</p>
              </div>
            )}

            {gaugeVisibility.altitude && (
              <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-3.5 text-center">
                <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Altitude</p>
                <p className="mt-1 font-mono text-3xl font-bold text-white tabular-nums">
                  {altitudeM !== null ? `${altitudeM}m` : '--'}
                </p>
                <p className="font-mono text-[11px] text-zinc-500">Elevação GPS</p>
              </div>
            )}

            {gaugeVisibility.gpsAccuracy && (
              <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-3.5 text-center">
                <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Sinal GPS</p>
                <p className="mt-1 font-mono text-3xl font-bold text-emerald-400 tabular-nums">
                  {gpsAccuracyM !== null ? `±${gpsAccuracyM}m` : '--'}
                </p>
                <p className="font-mono text-[11px] text-zinc-500">
                  {source === 'simulator' ? 'Simulador' : 'Receptor Ativo'}
                </p>
              </div>
            )}

            {gaugeVisibility.heading && (
              <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-3.5 text-center">
                <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Rumo (CAP)</p>
                <p className="mt-1 font-mono text-3xl font-bold text-white tabular-nums">
                  {headingDeg !== null ? `${headingDeg}°` : '--'}
                </p>
                <p className="font-mono text-[11px] text-zinc-500">Direção</p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => {
                setTripDistKm(0);
                showToast('Trip zerado.');
              }}
              className="pitstop-btn-metal min-h-[56px] rounded-xl text-sm font-extrabold uppercase"
            >
              Zerar Trip (Botão Grande)
            </button>
            <button
              type="button"
              onClick={handleStartOrArmStage}
              className="pitstop-btn-red min-h-[56px] rounded-xl text-sm font-extrabold text-white uppercase"
            >
              {stageState === 'running' ? 'Encerrar Especial' : 'Iniciar Especial'}
            </button>
          </div>
        </section>
      )}

      {/* SCREEN 3: MAPA AO VIVO & EDITOR DE ARMADILHAS (MÉTODO A + MÉTODO B) */}
      {subTab === 'map' && (
        <section className="space-y-3">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
            {/* Live High-Contrast SVG Track Map */}
            <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-3 lg:col-span-7">
              <div className="flex items-center justify-between text-xs text-[#B5B5B5]">
                <span className="font-bold text-white uppercase">
                  Mapa do Traçado e Armadilhas (Traps)
                </span>
                <span className="font-mono">
                  {editableTrace.length} pontos · {orderedTraps.length} traps
                </span>
              </div>

              <div className="mt-2.5 flex items-center justify-center rounded-xl border border-zinc-800 bg-[#000000] p-2">
                {mapGeometry ? (
                  <svg viewBox="0 0 360 240" className="h-64 w-full sm:h-80">
                    {/* Recorded/Reference Route */}
                    {editableTrace.length > 1 && (
                      <polyline
                        fill="none"
                        stroke="#C0C4C9"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        points={editableTrace
                          .map((s) => {
                            const pt = mapGeometry.project(s.lat, s.lon);
                            return `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
                          })
                          .join(' ')}
                      />
                    )}

                    {/* Selected Post-Recording Scrubber Cursor */}
                    {editableTrace[postEditIdx] && (() => {
                      const sc = mapGeometry.project(
                        editableTrace[postEditIdx].lat,
                        editableTrace[postEditIdx].lon
                      );
                      return (
                        <g>
                          <circle cx={sc.x} cy={sc.y} r="7" fill="none" stroke="#38bdf8" strokeWidth="2" />
                          <circle cx={sc.x} cy={sc.y} r="2.5" fill="#38bdf8" />
                        </g>
                      );
                    })()}

                    {/* Perpendicular Trap Gates */}
                    {orderedTraps.map((trap) => {
                      const pt = mapGeometry.project(trap.lat, trap.lon);
                      const rad = (trap.bearingDeg * Math.PI) / 180;
                      const px = Math.cos(rad);
                      const py = -Math.sin(rad);
                      const gateHalfPx = 14;
                      const color =
                        trap.kind === 'start'
                          ? '#10b981'
                          : trap.kind === 'finish'
                            ? '#E10600'
                            : '#f59e0b';
                      return (
                        <g key={trap.id}>
                          <line
                            x1={pt.x - px * gateHalfPx}
                            y1={pt.y + py * gateHalfPx}
                            x2={pt.x + px * gateHalfPx}
                            y2={pt.y - py * gateHalfPx}
                            stroke={color}
                            strokeWidth="3.5"
                            strokeLinecap="round"
                          />
                          <text
                            x={pt.x + 8}
                            y={pt.y - 6}
                            fill={color}
                            fontSize="9"
                            fontWeight="bold"
                            fontFamily="monospace"
                          >
                            {trap.kind === 'start' ? 'START' : trap.kind === 'finish' ? 'FIN' : trap.name}
                          </text>
                        </g>
                      );
                    })}

                    {/* Live Vehicle Cursor */}
                    {currentPos && (() => {
                      const car = mapGeometry.project(currentPos.lat, currentPos.lon);
                      return (
                        <g>
                          <circle cx={car.x} cy={car.y} r="8" fill="#E10600" fillOpacity="0.3" />
                          <circle cx={car.x} cy={car.y} r="4.5" fill="#FFFFFF" stroke="#E10600" strokeWidth="2" />
                        </g>
                      );
                    })()}
                  </svg>
                ) : (
                  <div className="flex h-64 flex-col items-center justify-center text-center text-xs text-zinc-500">
                    <Compass className="h-8 w-8 text-[#E10600]" />
                    <p className="mt-2 max-w-xs">
                      Inicie uma gravação GPS ou clique em <strong>Demo SS-01</strong> acima para visualizar o traçado e posicionar armadilhas.
                    </p>
                  </div>
                )}
              </div>

              {/* Método A: Real-Time Recce Trap Buttons */}
              <div className="mt-3">
                <p className="text-[11px] font-bold tracking-wider text-[#B5B5B5] uppercase">
                  Método A · Captura em Tempo Real (Recce na Posição Atual)
                </p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => handleDropTrapAtPosition('start')}
                    className="min-h-[44px] rounded-lg border border-emerald-500/40 bg-emerald-950/35 px-2 text-xs font-bold text-emerald-300 hover:bg-emerald-950/60"
                  >
                    + Start (Largada)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDropTrapAtPosition('split')}
                    className="min-h-[44px] rounded-lg border border-amber-500/40 bg-amber-950/35 px-2 text-xs font-bold text-amber-300 hover:bg-amber-950/60"
                  >
                    + Split (Parcial)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDropTrapAtPosition('finish')}
                    className="min-h-[44px] rounded-lg border border-[#E10600]/50 bg-[#E10600]/20 px-2 text-xs font-bold text-red-300 hover:bg-[#E10600]/35"
                  >
                    + Finish (Chegada)
                  </button>
                </div>
              </div>
            </div>

            {/* Método B: Post-Recording Editor + GPX/GeoJSON Import/Export */}
            <div className="space-y-3 rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white lg:col-span-5">
              <div>
                <p className="text-[11px] font-bold tracking-wider text-[#E10600] uppercase">
                  Método B · Editor Pós-Gravação &amp; GPX
                </p>
                <p className="mt-0.5 text-xs text-[#B5B5B5]">
                  Mova a mira azul ao longo do traçado gravado para posicionar ou ajustar armadilhas (Largura 20m–50m).
                </p>
              </div>

              <div className="rounded-lg border border-zinc-800 bg-[#080B0D] p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#C0C4C9]">Largura da Linha (Trap Width):</span>
                  <div className="inline-flex gap-1">
                    {[20, 30, 35, 50].map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => setNewTrapWidthM(w)}
                        className={`rounded px-2 py-1 font-mono text-[11px] font-bold ${
                          newTrapWidthM === w ? 'bg-[#E10600] text-white' : 'bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {w}m
                      </button>
                    ))}
                  </div>
                </div>

                {editableTrace.length > 1 && (
                  <>
                    <div className="flex items-center justify-between font-mono text-[11px] text-zinc-400 pt-1">
                      <span>Ponto #{postEditIdx + 1}/{editableTrace.length}</span>
                      <span>
                        {editableTrace[postEditIdx]?.distKm.toFixed(2)} km ·{' '}
                        {Math.round(editableTrace[postEditIdx]?.speedKmh ?? 0)} km/h
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, editableTrace.length - 1)}
                      value={postEditIdx}
                      onChange={(e) => setPostEditIdx(Number(e.target.value))}
                      className="w-full accent-sky-400"
                    />
                    <div className="grid grid-cols-3 gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => handleDropTrapAtPosition('start', editableTrace[postEditIdx])}
                        className="min-h-[38px] rounded border border-emerald-600/40 bg-emerald-950/30 text-[11px] font-bold text-emerald-300"
                      >
                        Fixar Start
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDropTrapAtPosition('split', editableTrace[postEditIdx])}
                        className="min-h-[38px] rounded border border-amber-600/40 bg-amber-950/30 text-[11px] font-bold text-amber-300"
                      >
                        Fixar Split
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDropTrapAtPosition('finish', editableTrace[postEditIdx])}
                        className="min-h-[38px] rounded border border-red-600/40 bg-red-950/30 text-[11px] font-bold text-red-300"
                      >
                        Fixar Finish
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* Traps List */}
              <div className="space-y-1.5 max-h-44 overflow-y-auto">
                {orderedTraps.length === 0 ? (
                  <p className="py-3 text-center text-xs text-zinc-500">
                    Nenhuma armadilha configurada ainda.
                  </p>
                ) : (
                  orderedTraps.map((tr) => (
                    <div
                      key={tr.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-[#080B0D] px-2.5 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <p className="font-bold text-white truncate">{tr.name}</p>
                        <p className="font-mono text-[10px] text-zinc-400">
                          {tr.bearingDeg}° · Largura {tr.widthM}m · {tr.lat.toFixed(5)}, {tr.lon.toFixed(5)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveTrap(tr.id)}
                        className="flex h-8 w-8 items-center justify-center rounded text-zinc-500 hover:bg-red-950/50 hover:text-red-400"
                        aria-label={`Remover ${tr.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Export / Import GeoJSON & GPX */}
              <div className="flex flex-wrap gap-2 border-t border-zinc-800 pt-2.5">
                <label className="inline-flex min-h-[38px] cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 bg-[#1E1E22] px-3 text-xs font-semibold text-white hover:bg-zinc-800">
                  <Upload className="h-3.5 w-3.5 text-[#E10600]" />
                  <span>Importar GPX/GeoJSON</span>
                  <input
                    type="file"
                    accept=".gpx,.geojson,.json"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleImportGeoFile(f);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>

                {activeTrack && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleExportTrack('gpx')}
                      className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-semibold text-[#C0C4C9] hover:text-white"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>.GPX</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportTrack('geojson')}
                      className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-semibold text-[#C0C4C9] hover:text-white"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>.GeoJSON</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Saved Maps & Traps Library (multiple stages saved offline) */}
          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-[#E10600]" />
                <h3 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
                  Mapas &amp; Traps Salvos ({tracks.length})
                </h3>
              </div>
              <div className="flex flex-wrap gap-2">
                {activeTrack && (
                  <button
                    type="button"
                    onClick={() => handleDuplicateTrack(activeTrack)}
                    className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-bold text-[#C0C4C9] hover:text-white"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    <span>Salvar Cópia</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowNewTrackModal(true)}
                  className="pitstop-btn-red inline-flex min-h-[36px] items-center gap-1 rounded-lg px-3 text-xs font-extrabold text-white"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Novo Mapa/Especial</span>
                </button>
              </div>
            </div>

            {tracks.length === 0 ? (
              <p className="py-5 text-center text-xs text-zinc-500">
                Nenhum mapa salvo ainda. Clique em <strong>Novo Mapa/Especial</strong> ou importe um arquivo GPX/GeoJSON.
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {tracks.map((tr) => {
                  const isActive = tr.id === activeTrackId;
                  const passCount = runs.filter((r) => r.trackId === tr.id).length;
                  return (
                    <div
                      key={tr.id}
                      className={`flex flex-col justify-between gap-2 rounded-xl border p-3 transition-colors ${
                        isActive
                          ? 'border-[#E10600]/80 bg-[#1A0D0E]'
                          : 'border-zinc-800 bg-[#080B0D]'
                      }`}
                    >
                      {editingTrackId === tr.id ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={editingTrackName}
                            onChange={(e) => setEditingTrackName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleCommitRenameTrack(tr.id);
                              if (e.key === 'Escape') setEditingTrackId(null);
                            }}
                            autoFocus
                            className="w-full min-h-[34px] rounded border border-zinc-700 bg-[#111214] px-2 text-xs text-white focus:border-[#E10600] focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => handleCommitRenameTrack(tr.id)}
                            className="min-h-[34px] rounded bg-emerald-600 px-2.5 text-xs font-bold text-white"
                          >
                            OK
                          </button>
                        </div>
                      ) : (
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <p className="font-bold text-sm text-white leading-tight truncate">
                              {tr.name}
                            </p>
                            {isActive && (
                              <span className="font-mono text-[10px] font-extrabold text-[#E10600] uppercase shrink-0">
                                Ativo
                              </span>
                            )}
                          </div>
                          <p className="mt-1 font-mono text-[11px] text-zinc-400">
                            {tr.traps.length} traps · {tr.referenceDistanceKm.toFixed(2)} km · {passCount} pass.
                          </p>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-zinc-800/80">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveTrackId(tr.id);
                            setStageState('idle');
                            setStageStartMs(null);
                            setLastFinishedMs(null);
                            setCurrentSplitTimesMs({});
                            showToast(`Mapa carregado: ${tr.name}`);
                          }}
                          className={`min-h-[34px] flex-1 rounded-lg px-2.5 text-xs font-bold ${
                            isActive
                              ? 'bg-[#E10600] text-white'
                              : 'border border-zinc-700 bg-[#1E1E22] text-white hover:bg-zinc-800'
                          }`}
                        >
                          {isActive ? 'Selecionado' : 'Carregar'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingTrackId(tr.id);
                            setEditingTrackName(tr.name);
                          }}
                          className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-zinc-800 bg-[#111214] text-zinc-400 hover:text-white"
                          aria-label={`Renomear ${tr.name}`}
                          title="Renomear"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDuplicateTrack(tr)}
                          className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-zinc-800 bg-[#111214] text-zinc-400 hover:text-white"
                          aria-label={`Duplicar ${tr.name}`}
                          title="Duplicar"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteTrack(tr.id)}
                          className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-zinc-800 bg-[#111214] text-zinc-500 hover:bg-red-950/50 hover:text-red-400"
                          aria-label={`Excluir ${tr.name}`}
                          title="Excluir"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {/* SCREEN 4: TELEMETRIA, COMPARATIVO & TEMPO IDEAL (OPTIMAL STAGE) */}
      {subTab === 'analysis' && (
        <section className="space-y-3">
          {/* Speed vs Distance Telemetry Trace */}
          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-4 text-white">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide uppercase">
                  Gráfico de Velocidade e Parciais
                </h3>
                <p className="text-xs text-[#B5B5B5]">
                  Traçado comparativo de velocidade (km/h) ao longo da especial.
                </p>
              </div>
              {optimalSummary.optimalTotalMs !== null && (
                <div className="font-mono text-xs text-amber-300 font-bold">
                  Tempo Ideal (Optimal): {formatStageDuration(optimalSummary.optimalTotalMs)}
                </div>
              )}
            </div>

            <div className="mt-3 rounded-xl border border-zinc-800 bg-[#080B0D] p-3">
              {editableTrace.length > 2 ? (
                <svg viewBox="0 0 400 130" className="h-40 w-full">
                  <line x1="0" y1="30" x2="400" y2="30" stroke="#27272a" strokeDasharray="3 3" />
                  <line x1="0" y1="70" x2="400" y2="70" stroke="#27272a" strokeDasharray="3 3" />
                  <line x1="0" y1="110" x2="400" y2="110" stroke="#27272a" />
                  {bestRun && bestRun.samples.length > 1 && (
                    <polyline
                      fill="none"
                      stroke="#10b981"
                      strokeWidth="1.75"
                      strokeOpacity="0.65"
                      points={bestRun.samples
                        .map((s, i) => {
                          const x = (i / Math.max(1, bestRun.samples.length - 1)) * 390 + 5;
                          const y = 115 - Math.min(100, (s.speedKmh / 160) * 100);
                          return `${x.toFixed(1)},${y.toFixed(1)}`;
                        })
                        .join(' ')}
                    />
                  )}
                  <polyline
                    fill="none"
                    stroke="#E10600"
                    strokeWidth="2.5"
                    points={editableTrace
                      .map((s, i) => {
                        const x = (i / Math.max(1, editableTrace.length - 1)) * 390 + 5;
                        const y = 115 - Math.min(100, (s.speedKmh / 160) * 100);
                        return `${x.toFixed(1)},${y.toFixed(1)}`;
                      })
                      .join(' ')}
                  />
                  <text x="8" y="25" fill="#71717a" fontSize="9" fontFamily="monospace">
                    140 km/h
                  </text>
                  <text x="8" y="66" fill="#71717a" fontSize="9" fontFamily="monospace">
                    70 km/h
                  </text>
                </svg>
              ) : (
                <div className="flex h-32 items-center justify-center text-xs text-zinc-500">
                  Complete uma passagem ou ative o Simulador para gerar o gráfico de telemetria.
                </div>
              )}
            </div>
          </div>

          {/* Optimal Stage Sector Breakdown */}
          {optimalSummary.sectors.length > 0 && (
            <div className="rounded-xl border border-zinc-800 bg-[#111214] p-4 text-white">
              <h3 className="text-xs font-bold tracking-wider text-amber-400 uppercase">
                Cálculo de Tempo Ideal por Setor (Optimal Stage)
              </h3>
              <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {optimalSummary.sectors.map((sec) => (
                  <div
                    key={sec.sectorIndex}
                    className="rounded-lg border border-zinc-800 bg-[#080B0D] px-3 py-2.5 font-mono"
                  >
                    <p className="font-sans text-xs font-bold text-[#C0C4C9]">{sec.label}</p>
                    <p className="mt-1 text-lg font-extrabold text-amber-300 tabular-nums">
                      {formatStageDuration(sec.bestMs)}
                    </p>
                    <p className="text-[10px] text-zinc-500">
                      {sec.bestRunNumber ? `Obtido na Passada #${sec.bestRunNumber}` : 'Sem registro'}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recorded Passes History */}
          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-4 text-white">
            <div className="flex items-center justify-between">
              <h3 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide uppercase">
                Histórico de Passagens ({trackRuns.length})
              </h3>
              {trackRuns.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (!activeTrack) return;
                    setRuns((prev) => prev.filter((r) => r.trackId !== activeTrack.id));
                  }}
                  className="text-xs font-semibold text-red-400 hover:text-red-300"
                >
                  Limpar Passagens
                </button>
              )}
            </div>

            {trackRuns.length === 0 ? (
              <p className="py-6 text-center text-xs text-zinc-500">
                Nenhuma passagem gravada ainda nesta especial.
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full border-collapse text-left font-mono text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-zinc-800 text-[#B5B5B5]">
                      <th className="py-2 pr-2">Passada</th>
                      <th className="px-2 py-2">Tempo Total</th>
                      <th className="px-2 py-2 text-right">Distância</th>
                      <th className="px-2 py-2 text-right">Vel. Méd</th>
                      <th className="py-2 pl-2 text-right">Vel. Máx</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {trackRuns.map((run) => {
                      const isBest = run.id === optimalSummary.bestRunId;
                      return (
                        <tr key={run.id} className={isBest ? 'bg-emerald-950/25' : ''}>
                          <td className="py-2 pr-2 font-sans font-bold text-white">
                            #{run.runNumber} {isBest && <span className="text-emerald-400">(Melhor)</span>}
                          </td>
                          <td className="px-2 py-2 font-extrabold text-white">
                            {formatStageDuration(run.totalMs)}
                          </td>
                          <td className="px-2 py-2 text-right text-[#C0C4C9]">
                            {run.distanceKm.toFixed(2)} km
                          </td>
                          <td className="px-2 py-2 text-right text-[#C0C4C9]">
                            {run.avgSpeedKmh} km/h
                          </td>
                          <td className="py-2 pl-2 text-right text-amber-300">
                            {run.maxSpeedKmh} km/h
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Modal: Create New Point-to-Point Special Stage */}
      {showNewTrackModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-[#111214] p-5 text-white shadow-2xl">
            <h3 className="font-['Barlow_Condensed'] text-2xl font-bold italic uppercase">
              Nova Especial (Ponto-a-Ponto)
            </h3>
            <p className="mt-1 text-xs text-[#B5B5B5]">
              Crie um trecho cronometrado e adicione as armadilhas (Start, Splits e Finish) durante o reconhecimento ou após gravar o trajeto.
            </p>
            <input
              type="text"
              value={newTrackName}
              onChange={(e) => setNewTrackName(e.target.value)}
              placeholder="Ex: SS-02 Morro do Boi"
              className="mt-4 w-full min-h-[44px] rounded-lg border border-zinc-700 bg-[#080B0D] px-3 text-sm text-white focus:border-[#E10600] focus:outline-none"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNewTrackModal(false)}
                className="min-h-[42px] rounded-lg border border-zinc-700 bg-[#080B0D] px-4 text-xs font-semibold text-[#C0C4C9]"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleStartRecceSession}
                className="pitstop-btn-red min-h-[42px] rounded-lg px-4 text-xs font-extrabold text-white"
              >
                Iniciar Recce
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Time Calculator Overlay (Hours Minutes ATM Input) */}
      <TimeCalculatorModal open={showTimeCalc} onClose={() => setShowTimeCalc(false)} />
    </div>
  );
};
