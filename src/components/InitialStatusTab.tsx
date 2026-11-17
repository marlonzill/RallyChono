import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import {
  Battery,
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Compass,
  Database,
  Gauge,
  MapPin,
  RefreshCw,
  Satellite,
} from 'lucide-react';
import type { ActiveTab } from '../types/rally';
import { listSavedRoadbooks } from '../utils/roadbookStorage';

interface InitialStatusTabProps {
  onNavigate: (tab: ActiveTab) => void;
}

interface BatteryManagerLike extends EventTarget {
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
  level: number;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManagerLike>;
}

interface GpsTelemetryState {
  status: 'searching' | 'active' | 'denied' | 'error';
  accuracyM: number | null;
  lat: number | null;
  lon: number | null;
  altitudeM: number | null;
  speedKmh: number | null;
  updatedAtMs: number | null;
  message?: string;
}

interface BatteryTelemetryState {
  supported: boolean;
  levelPct: number | null;
  charging: boolean;
  chargingTimeSec: number | null;
  dischargingTimeSec: number | null;
}

function getGpsQuality(accuracyM: number | null): {
  bars: number;
  label: string;
  toneClass: string;
  barClass: string;
} {
  if (accuracyM === null) {
    return {
      bars: 0,
      label: 'Aguardando',
      toneClass: 'text-slate-400',
      barClass: 'bg-slate-600',
    };
  }
  if (accuracyM <= 5) {
    return {
      bars: 5,
      label: 'Excelente',
      toneClass: 'text-emerald-400',
      barClass: 'bg-emerald-400',
    };
  }
  if (accuracyM <= 10) {
    return {
      bars: 4,
      label: 'Ótimo',
      toneClass: 'text-emerald-400',
      barClass: 'bg-emerald-400',
    };
  }
  if (accuracyM <= 20) {
    return {
      bars: 3,
      label: 'Bom',
      toneClass: 'text-amber-400',
      barClass: 'bg-amber-400',
    };
  }
  if (accuracyM <= 40) {
    return {
      bars: 2,
      label: 'Fraco',
      toneClass: 'text-orange-400',
      barClass: 'bg-orange-400',
    };
  }
  return {
    bars: 1,
    label: 'Instável',
    toneClass: 'text-red-400',
    barClass: 'bg-red-500',
  };
}

function formatDurationMinutes(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec) || sec <= 0 || sec >= 86400 * 5) {
    return null;
  }
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}min`;
  return `${m} min`;
}

function formatClockOnly(tsMs: number): string {
  const d = new Date(tsMs);
  return [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join(':');
}

export const InitialStatusTab: React.FC<InitialStatusTabProps> = ({ onNavigate }) => {
  const [gps, setGps] = useState<GpsTelemetryState>({
    status: 'searching',
    accuracyM: null,
    lat: null,
    lon: null,
    altitudeM: null,
    speedKmh: null,
    updatedAtMs: null,
  });

  const [battery, setBattery] = useState<BatteryTelemetryState>({
    supported: true,
    levelPct: null,
    charging: false,
    chargingTimeSec: null,
    dischargingTimeSec: null,
  });

  const [refreshingGps, setRefreshingGps] = useState(false);
  const [savedCount, setSavedCount] = useState(0);

  useEffect(() => {
    listSavedRoadbooks()
      .then((list) => setSavedCount(list.length))
      .catch(() => {});
  }, []);

  // Battery Status Monitor
  useEffect(() => {
    const nav = navigator as NavigatorWithBattery;
    if (typeof nav.getBattery !== 'function') {
      setBattery({
        supported: false,
        levelPct: null,
        charging: false,
        chargingTimeSec: null,
        dischargingTimeSec: null,
      });
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
        chargingTimeSec: Number.isFinite(manager.chargingTime) ? manager.chargingTime : null,
        dischargingTimeSec: Number.isFinite(manager.dischargingTime) ? manager.dischargingTime : null,
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
        bm.addEventListener('chargingtimechange', syncBattery);
        bm.addEventListener('dischargingtimechange', syncBattery);
      })
      .catch(() => {
        if (mounted) {
          setBattery({
            supported: false,
            levelPct: null,
            charging: false,
            chargingTimeSec: null,
            dischargingTimeSec: null,
          });
        }
      });

    return () => {
      mounted = false;
      if (manager) {
        manager.removeEventListener('levelchange', syncBattery);
        manager.removeEventListener('chargingchange', syncBattery);
        manager.removeEventListener('chargingtimechange', syncBattery);
        manager.removeEventListener('dischargingtimechange', syncBattery);
      }
    };
  }, []);

  const applyPosition = useCallback(
    (
      lat: number,
      lon: number,
      accuracy: number | null,
      altitude: number | null,
      speedMs: number | null,
      ts: number
    ) => {
      setGps({
        status: 'active',
        accuracyM: accuracy !== null && Number.isFinite(accuracy) ? Math.round(accuracy) : null,
        lat,
        lon,
        altitudeM: altitude !== null && Number.isFinite(altitude) ? Math.round(altitude) : null,
        speedKmh:
          speedMs !== null && Number.isFinite(speedMs) && speedMs >= 0
            ? Number((speedMs * 3.6).toFixed(1))
            : 0,
        updatedAtMs: ts || Date.now(),
      });
    },
    []
  );

  // Continuous Live GPS Signal Watcher
  useEffect(() => {
    let cancelled = false;
    let webWatchId: number | null = null;
    let capWatchId: string | null = null;

    if (Capacitor.isNativePlatform()) {
      (async () => {
        try {
          const perm = await Geolocation.requestPermissions();
          if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
            if (!cancelled) {
              setGps((prev) => ({
                ...prev,
                status: 'denied',
                message: 'Permissão de localização negada nas configurações do Android.',
              }));
            }
            return;
          }
          const id = await Geolocation.watchPosition(
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 },
            (pos, err) => {
              if (cancelled) return;
              if (err) {
                setGps((prev) => ({
                  ...prev,
                  status: 'searching',
                  message: 'Buscando sinal dos satélites GPS...',
                }));
                return;
              }
              if (pos) {
                applyPosition(
                  pos.coords.latitude,
                  pos.coords.longitude,
                  pos.coords.accuracy ?? null,
                  pos.coords.altitude ?? null,
                  pos.coords.speed ?? null,
                  pos.timestamp || Date.now()
                );
              }
            }
          );
          if (cancelled) {
            Geolocation.clearWatch({ id }).catch(() => {});
          } else {
            capWatchId = id;
          }
        } catch {
          if (!cancelled) {
            setGps((prev) => ({
              ...prev,
              status: 'error',
              message: 'Não foi possível iniciar o receptor GPS nativo.',
            }));
          }
        }
      })();

      return () => {
        cancelled = true;
        if (capWatchId !== null) {
          Geolocation.clearWatch({ id: capWatchId }).catch(() => {});
        }
      };
    }

    if (!('geolocation' in navigator)) {
      setGps((prev) => ({
        ...prev,
        status: 'error',
        message: 'Geolocalização não suportada neste navegador.',
      }));
      return;
    }

    webWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (cancelled) return;
        applyPosition(
          pos.coords.latitude,
          pos.coords.longitude,
          pos.coords.accuracy ?? null,
          pos.coords.altitude ?? null,
          pos.coords.speed ?? null,
          pos.timestamp || Date.now()
        );
      },
      (err) => {
        if (cancelled) return;
        setGps((prev) => ({
          ...prev,
          status: err.code === 1 ? 'denied' : 'error',
          message:
            err.code === 1
              ? 'Permissão GPS bloqueada. Libere a localização para este site/app.'
              : 'Sinal GPS fraco ou indisponível em ambiente fechado.',
        }));
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 12000 }
    );

    return () => {
      cancelled = true;
      if (webWatchId !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(webWatchId);
      }
    };
  }, [applyPosition]);

  const handleRefreshGps = async () => {
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
        applyPosition(
          pos.coords.latitude,
          pos.coords.longitude,
          pos.coords.accuracy ?? null,
          pos.coords.altitude ?? null,
          pos.coords.speed ?? null,
          pos.timestamp || Date.now()
        );
        return;
      }

      if ('geolocation' in navigator) {
        await new Promise<void>((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              applyPosition(
                pos.coords.latitude,
                pos.coords.longitude,
                pos.coords.accuracy ?? null,
                pos.coords.altitude ?? null,
                pos.coords.speed ?? null,
                pos.timestamp || Date.now()
              );
              resolve();
            },
            () => resolve(),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
          );
        });
      }
    } finally {
      setRefreshingGps(false);
    }
  };

  const gpsQuality = getGpsQuality(gps.status === 'active' ? gps.accuracyM : null);
  const batteryPct = battery.levelPct ?? 0;
  const batteryBarTone =
    battery.charging
      ? 'bg-sky-400'
      : batteryPct >= 50
        ? 'bg-emerald-400'
        : batteryPct >= 20
          ? 'bg-amber-400'
          : 'bg-red-500';
  const batteryTextTone =
    battery.charging
      ? 'text-sky-400'
      : batteryPct >= 50
        ? 'text-emerald-400'
        : batteryPct >= 20
          ? 'text-amber-400'
          : 'text-red-400';

  const BatteryIcon = battery.charging
    ? BatteryCharging
    : !battery.supported || battery.levelPct === null
      ? Battery
      : batteryPct >= 75
        ? BatteryFull
        : batteryPct >= 35
          ? BatteryMedium
          : batteryPct >= 15
            ? BatteryLow
            : BatteryWarning;

  const batteryRemainingLabel = battery.charging
    ? formatDurationMinutes(battery.chargingTimeSec)
      ? `Carga completa em ${formatDurationMinutes(battery.chargingTimeSec)}`
      : 'Conectado à energia / carregando'
    : formatDurationMinutes(battery.dischargingTimeSec)
      ? `Autonomia estimada: ${formatDurationMinutes(battery.dischargingTimeSec)}`
      : 'Operando na bateria do aparelho';

  return (
    <div className="mx-auto max-w-5xl space-y-3.5 sm:space-y-5">
      {/* Top Hero Readiness Banner */}
      <section className="relative overflow-hidden rounded-2xl border border-slate-800 bg-[#12161f] text-slate-100 shadow-2xl">
        <div aria-hidden="true" className="h-1.5 w-full rally-track-stripe" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-0 top-1.5 h-28 w-44 bg-rally-checkered opacity-25 [mask-image:linear-gradient(to_bottom_left,black,transparent)]"
        />

        <div className="relative flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <p className="text-[10px] font-bold tracking-[0.18em] text-orange-400 uppercase sm:text-[11px]">
              Pré-Largada · Diagnóstico do Aparelho
            </p>
            <h2 className="mt-1 font-['Barlow_Condensed'] text-2xl font-extrabold italic tracking-wide text-white sm:text-3xl">
              Painel Inicial do Competidor
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400 sm:text-sm">
              Confira o nível de sinal dos satélites GPS e a carga da bateria antes de entrar no trecho cronometrado.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 shrink-0 sm:gap-2.5">
            <button
              type="button"
              onClick={() => onNavigate('competidor')}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-extrabold tracking-wide text-white uppercase rally-btn-orange sm:min-h-[44px] sm:gap-2 sm:px-4"
            >
              <Compass className="h-4 w-4" />
              <span>Abrir Coletor GPS</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('navegacao')}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-bold tracking-wide text-white uppercase hover:bg-slate-800 sm:min-h-[44px] sm:gap-2 sm:px-4"
            >
              <Gauge className="h-4 w-4 text-orange-400" />
              <span>Abrir Navegação</span>
            </button>
          </div>
        </div>
      </section>

      {/* Main Telemetry Grid: GPS Signal + Device Battery */}
      <div className="grid grid-cols-1 gap-3.5 sm:gap-5 md:grid-cols-2">
        {/* Card 1: GPS Signal */}
        <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#12161f] text-slate-100 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 sm:px-5 sm:py-3.5">
            <div className="flex items-center gap-2">
              <Satellite className="h-4 w-4 text-orange-500" />
              <h3 className="font-['Barlow_Condensed'] text-lg font-bold italic text-white sm:text-xl">
                Sinal do GPS
              </h3>
            </div>

            <button
              type="button"
              onClick={handleRefreshGps}
              disabled={refreshingGps}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50 sm:min-h-[34px] sm:px-3"
            >
              <RefreshCw className={`h-3.5 w-3.5 text-orange-400 ${refreshingGps ? 'animate-spin' : ''}`} />
              <span>{refreshingGps ? 'Lendo...' : 'Atualizar'}</span>
            </button>
          </div>

          <div className="space-y-3 p-4 sm:space-y-4 sm:p-5">
            <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#080b10] p-3.5 sm:p-4">
              <div className="min-w-0">
                <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase sm:text-[11px]">
                  Qualidade e Precisão
                </span>
                <div className="mt-1 flex flex-wrap items-baseline gap-2">
                  <span className={`font-mono text-2xl font-extrabold tabular-nums sm:text-4xl ${gpsQuality.toneClass}`}>
                    {gps.status === 'active' && gps.accuracyM !== null ? `±${gps.accuracyM}m` : '--'}
                  </span>
                  <span className={`text-xs font-bold uppercase sm:text-sm ${gpsQuality.toneClass}`}>
                    {gps.status === 'active'
                      ? gpsQuality.label
                      : gps.status === 'searching'
                        ? 'Buscando satélites...'
                        : gps.status === 'denied'
                          ? 'Permissão negada'
                          : 'Indisponível'}
                  </span>
                </div>
              </div>

              {/* 5-bar signal strength meter */}
              <div className="flex items-end gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5" aria-label={`Intensidade do sinal GPS: ${gpsQuality.bars} de 5 barras`}>
                {[1, 2, 3, 4, 5].map((bar) => (
                  <span
                    key={bar}
                    className={`w-2 rounded-xs transition-colors ${
                      bar <= gpsQuality.bars ? gpsQuality.barClass : 'bg-slate-800'
                    }`}
                    style={{ height: `${bar * 5 + 4}px` }}
                  />
                ))}
              </div>
            </div>

            {gps.message && gps.status !== 'active' && (
              <p className="rounded-xl border border-amber-800/60 bg-amber-950/30 px-3.5 py-2.5 text-xs text-amber-200">
                {gps.message}
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-xl border border-slate-800 bg-[#0a0d13] p-3">
                <span className="flex items-center gap-1 text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                  <MapPin className="h-3 w-3 text-orange-400" />
                  Latitude
                </span>
                <p className="mt-1 font-mono text-sm font-bold text-white tabular-nums">
                  {gps.lat !== null ? gps.lat.toFixed(6) : '---'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-[#0a0d13] p-3">
                <span className="flex items-center gap-1 text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                  <MapPin className="h-3 w-3 text-orange-400" />
                  Longitude
                </span>
                <p className="mt-1 font-mono text-sm font-bold text-white tabular-nums">
                  {gps.lon !== null ? gps.lon.toFixed(6) : '---'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-[#0a0d13] p-3">
                <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                  Velocidade Atual
                </span>
                <p className="mt-1 font-mono text-sm font-bold text-white tabular-nums">
                  {gps.speedKmh !== null ? `${gps.speedKmh.toFixed(1)} km/h` : '0.0 km/h'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-[#0a0d13] p-3">
                <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                  Altitude / Leitura
                </span>
                <p className="mt-1 font-mono text-sm font-bold text-white tabular-nums">
                  {gps.altitudeM !== null ? `${gps.altitudeM} m` : '--'} ·{' '}
                  {gps.updatedAtMs ? formatClockOnly(gps.updatedAtMs) : '--:--:--'}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Card 2: Device Battery */}
        <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#12161f] text-slate-100 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 sm:px-5 sm:py-3.5">
            <div className="flex items-center gap-2">
              <BatteryIcon className={`h-4 w-4 ${batteryTextTone}`} />
              <h3 className="font-['Barlow_Condensed'] text-lg font-bold italic text-white sm:text-xl">
                Bateria do Aparelho
              </h3>
            </div>
            <span
              className={`font-mono text-[10px] font-bold uppercase sm:text-[11px] ${
                battery.supported ? batteryTextTone : 'text-slate-400'
              }`}
            >
              {!battery.supported
                ? 'Sem sensor web'
                : battery.charging
                  ? 'Carregando'
                  : 'Em bateria'}
            </span>
          </div>

          <div className="space-y-3 p-4 sm:space-y-4 sm:p-5">
            {battery.supported && battery.levelPct !== null ? (
              <>
                <div className="rounded-xl border border-slate-800 bg-[#080b10] p-3.5 sm:p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase sm:text-[11px]">
                        Carga Disponível
                      </span>
                      <div className="mt-1 flex flex-wrap items-baseline gap-2">
                        <span className={`font-mono text-3xl font-extrabold tabular-nums sm:text-5xl ${batteryTextTone}`}>
                          {battery.levelPct}%
                        </span>
                        <span className="text-xs font-semibold text-slate-300">
                          {battery.levelPct >= 50
                            ? 'Pronto para prova'
                            : battery.levelPct >= 20
                              ? 'Recomendado conectar 12V'
                              : 'Bateria crítica! Conecte carregador'}
                        </span>
                      </div>
                    </div>

                    {/* Visual segmented battery graphic */}
                    <div className="flex items-center gap-1 shrink-0" aria-hidden="true">
                      <div className="flex h-8 w-14 items-center rounded-lg border-2 border-slate-600 bg-slate-950 p-1 sm:h-10 sm:w-20">
                        <div
                          className={`h-full rounded-sm transition-all duration-300 ${batteryBarTone}`}
                          style={{ width: `${Math.max(4, battery.levelPct)}%` }}
                        />
                      </div>
                      <div className="h-3.5 w-1.5 rounded-r-sm bg-slate-600 sm:h-4" />
                    </div>
                  </div>

                  {/* Full width level progress bar */}
                  <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-slate-900">
                    <div
                      className={`h-full transition-all duration-300 ${batteryBarTone}`}
                      style={{ width: `${Math.max(2, battery.levelPct)}%` }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
                  <div className="rounded-xl border border-slate-800 bg-[#0a0d13] p-3">
                    <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                      Estado de Alimentação
                    </span>
                    <p className="mt-1 font-mono text-sm font-bold text-white">
                      {battery.charging ? 'Carregando (USB / 12V)' : 'Usando Bateria'}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-[#0a0d13] p-3">
                    <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                      Previsão
                    </span>
                    <p className="mt-1 font-mono text-sm font-bold text-white">
                      {batteryRemainingLabel}
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-slate-800 bg-[#080b10] p-5 text-sm text-slate-300">
                <p className="font-semibold text-white">
                  Sensor de bateria restrito neste navegador
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  Este navegador não expõe o nível da bateria via Web API. No Android App (APK) ou no Chrome Android, a porcentagem exata e o status de carregamento aparecem automaticamente aqui.
                </p>
              </div>
            )}

            <div className="flex items-center justify-between rounded-xl border border-slate-800/80 bg-[#0a0d13] px-4 py-3 text-xs text-slate-300">
              <span className="flex items-center gap-2">
                <Database className="h-4 w-4 text-orange-400" />
                <span>Planilhas na Base Interna Offline</span>
              </span>
              <strong className="font-mono text-white">
                {savedCount} {savedCount === 1 ? 'planilha' : 'planilhas'}
              </strong>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
