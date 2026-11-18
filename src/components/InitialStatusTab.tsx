import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Battery, Compass, Flag, Gauge, Satellite, Settings } from 'lucide-react';
import type { ActiveTab } from '../types/rally';
import { useNavSettings } from '../utils/navSettings';
import { listSavedRoadbooks } from '../utils/roadbookStorage';
import { PitStopLogo } from './PitStopLogo';

interface InitialStatusTabProps {
  onNavigate: (tab: ActiveTab) => void;
}

interface BatteryManagerLike extends EventTarget {
  charging: boolean;
  level: number;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManagerLike>;
}

export const InitialStatusTab: React.FC<InitialStatusTabProps> = ({ onNavigate }) => {
  const [settings] = useNavSettings();
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsActive, setGpsActive] = useState(false);
  const [batteryPct, setBatteryPct] = useState<number | null>(null);
  const [savedCount, setSavedCount] = useState(0);

  useEffect(() => {
    listSavedRoadbooks()
      .then((list) => setSavedCount(list.length))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const nav = navigator as NavigatorWithBattery;
    if (typeof nav.getBattery !== 'function') return;
    let mounted = true;
    nav
      .getBattery()
      .then((bm) => {
        if (!mounted) return;
        setBatteryPct(Math.round(bm.level * 100));
        const onLvl = () => {
          if (mounted) setBatteryPct(Math.round(bm.level * 100));
        };
        bm.addEventListener('levelchange', onLvl);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const probeGps = async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          const pos = await Geolocation.getCurrentPosition({
            enableHighAccuracy: true,
            timeout: 8000,
          });
          if (!mounted) return;
          setGpsActive(true);
          setGpsAccuracy(pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null);
        } else if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (!mounted) return;
              setGpsActive(true);
              setGpsAccuracy(pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null);
            },
            () => {
              if (mounted) setGpsActive(false);
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
          );
        }
      } catch {
        if (mounted) setGpsActive(false);
      }
    };
    probeGps();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className="relative flex min-h-[calc(100vh-11rem)] flex-col items-center justify-center px-2 py-3 text-center sm:px-3 sm:py-5">
      {/* Integrated PitStop Sports Hero Centerpiece */}
      <div className="relative flex w-full max-w-2xl flex-col items-center">
        <PitStopLogo variant="full" animated className="w-full" />

        <h1 className="-mt-2 font-['Barlow_Condensed'] text-3xl font-extrabold italic tracking-wide text-white uppercase sm:text-5xl">
          Navegação de <span className="text-[#E10600]">Alta Precisão</span>
        </h1>
        <p className="mt-1.5 max-w-md text-sm text-[#B5B5B5] sm:text-base">
          Explore novas rotas com precisão de cronômetro. Cada waypoint conta.
        </p>

        {/* Primary Motorsport Launch Actions (Exact order matching Top Nav: Navegação -> Velocidade -> Coletor -> Configurações) */}
        <div className="mt-6 grid w-full max-w-2xl grid-cols-2 gap-2.5 sm:flex sm:flex-row sm:justify-center sm:gap-3">
          <button
            type="button"
            onClick={() => onNavigate('navegacao')}
            className="pitstop-btn-red inline-flex min-h-[50px] flex-1 items-center justify-center gap-2 rounded-lg px-4 text-xs font-extrabold tracking-wider text-white uppercase whitespace-nowrap shrink-0 transition-transform active:scale-[0.99] sm:text-sm"
          >
            <Gauge className="h-4 w-4 sm:h-5 sm:w-5" />
            <span>Navegação</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('velocidade')}
            className="pitstop-btn-metal inline-flex min-h-[50px] flex-1 items-center justify-center gap-2 rounded-lg px-4 text-xs font-bold tracking-wider uppercase whitespace-nowrap shrink-0 sm:text-sm"
          >
            <Flag className="h-4 w-4 text-[#E10600] sm:h-5 sm:w-5" />
            <span>Velocidade</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('competidor')}
            className="pitstop-btn-metal inline-flex min-h-[50px] flex-1 items-center justify-center gap-2 rounded-lg px-4 text-xs font-bold tracking-wider uppercase whitespace-nowrap shrink-0 sm:text-sm"
          >
            <Compass className="h-4 w-4 text-[#C0C4C9] sm:h-5 sm:w-5" />
            <span>Coletor</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('configuracoes')}
            className="inline-flex min-h-[50px] items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-[#111214] px-4 text-xs font-bold tracking-wider text-[#C0C4C9] uppercase transition-colors hover:border-zinc-600 hover:text-white whitespace-nowrap shrink-0 sm:text-sm"
          >
            <Settings className="h-4 w-4" />
            <span>Configurações</span>
          </button>
        </div>

        {/* Minimal Unboxed Readiness Line */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-xs text-[#B5B5B5] tabular-nums">
          <span className="inline-flex items-center gap-1.5">
            <Satellite className={`h-3.5 w-3.5 ${gpsActive ? 'text-emerald-400' : 'text-[#E10600]'}`} />
            <span>
              {gpsActive ? `GPS ±${gpsAccuracy ?? '--'}m` : 'GPS aguardando'}
            </span>
          </span>
          <span aria-hidden="true" className="text-zinc-700">·</span>
          <span className="inline-flex items-center gap-1.5">
            <Battery className="h-3.5 w-3.5 text-[#C0C4C9]" />
            <span>Bateria {batteryPct !== null ? `${batteryPct}%` : '--'}</span>
          </span>
          <span aria-hidden="true" className="text-zinc-700">·</span>
          <span>
            {savedCount} {savedCount === 1 ? 'planilha offline' : 'planilhas offline'}
          </span>
          {settings.pairing.enabled && (
            <>
              <span aria-hidden="true" className="text-zinc-700">·</span>
              <span className="text-[#E10600] font-bold">
                Sala {settings.pairing.roomCode}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
