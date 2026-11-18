import { useCallback, useEffect, useState } from 'react';
import { generatePairingRoomCode, normalizeRoomCode, type PairingRole } from './pairingClient';

export type HighlightTheme = 'yellow' | 'blue' | 'green';
export type SensorMode = 'gps' | 'blue';
export type VoiceUnit = 'meters' | 'seconds';
export type AlertStyle = 'voice' | 'beep_short' | 'beep_long' | 'vibration';
export type ScreenOrientationLock = 'auto' | 'portrait' | 'landscape';

export interface PilotDisplayOptions {
  showDistance: boolean;
  showOdometer: boolean;
  showSpeed: boolean;
  showTargetSpeed: boolean;
  showTnav: boolean;
  showColorBar: boolean;
  showDeltaMeters: boolean;
  showClock: boolean;
  showDesenho: boolean;
  showCap: boolean;
  showObs: boolean;
}

export interface ShortcutBindings {
  syncHere: string;
  odoPlus: string;
  odoMinus: string;
  nextTulipa: string;
  prevTulipa: string;
  toggleRun: string;
}

export interface PairingSettings {
  enabled: boolean;
  role: PairingRole;
  roomCode: string;
  bluetoothDeviceName?: string;
}

export interface CalibrationPassRecord {
  id: string;
  officialM: number;
  measuredM: number;
  suggestedW: number;
}

export interface PitStopNavSettings {
  raceDate: string;
  startTimeStr: string;
  clockOffsetMs: number;
  calibrationPct: number;
  sensorMode: SensorMode;
  wBaseValue: number;
  transitionAdvanceM: number;
  activeRowLine: 1 | 2;
  reducePassedRow: boolean;
  showPassedTick: boolean;
  highlightTheme: HighlightTheme;
  voiceEnabled: boolean;
  voiceUnit: VoiceUnit;
  voiceThresholds: number[];
  alertStyle: AlertStyle;
  pilotDisplay: PilotDisplayOptions;
  shortcuts: ShortcutBindings;
  pairing: PairingSettings;
  wPasses: CalibrationPassRecord[];
  baseServerUrl: string;
  screenOrientation: ScreenOrientationLock;
  goproAutoRecOnStart: boolean;
}

const STORAGE_KEY = 'pitstop_nav_settings_v1';
const SETTINGS_EVENT = 'pitstop:nav-settings-updated';

function getTodayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDefaultTime(): string {
  const now = new Date();
  return [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join(':');
}

export function getDefaultPilotDisplay(): PilotDisplayOptions {
  return {
    showDistance: true,
    showOdometer: true,
    showSpeed: true,
    showTargetSpeed: true,
    showTnav: true,
    showColorBar: true,
    showDeltaMeters: false,
    showClock: false,
    showDesenho: true,
    showCap: true,
    showObs: true,
  };
}

export function getDefaultShortcuts(): ShortcutBindings {
  return {
    syncHere: 'Enter',
    odoPlus: 'ArrowUp',
    odoMinus: 'ArrowDown',
    nextTulipa: 'ArrowRight',
    prevTulipa: 'ArrowLeft',
    toggleRun: ' ',
  };
}

export function getDefaultNavSettings(): PitStopNavSettings {
  return {
    raceDate: getTodayDate(),
    startTimeStr: getDefaultTime(),
    clockOffsetMs: 0,
    calibrationPct: 100.0,
    sensorMode: 'gps',
    wBaseValue: 4000,
    transitionAdvanceM: 5,
    activeRowLine: 2,
    reducePassedRow: true,
    showPassedTick: true,
    highlightTheme: 'yellow',
    voiceEnabled: true,
    voiceUnit: 'meters',
    voiceThresholds: [100, 50, 20],
    alertStyle: 'voice',
    pilotDisplay: getDefaultPilotDisplay(),
    shortcuts: getDefaultShortcuts(),
    pairing: {
      enabled: false,
      role: 'navigator',
      roomCode: generatePairingRoomCode(),
    },
    wPasses: [],
    baseServerUrl: '',
    screenOrientation: 'auto',
    goproAutoRecOnStart: false,
  };
}

export function getNavSettings(): PitStopNavSettings {
  const defaults = getDefaultNavSettings();
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PitStopNavSettings>;
    const alertStyle: AlertStyle =
      parsed.alertStyle === 'beep_short' ||
      parsed.alertStyle === 'beep_long' ||
      parsed.alertStyle === 'vibration'
        ? parsed.alertStyle
        : 'voice';
    return {
      ...defaults,
      ...parsed,
      activeRowLine: parsed.activeRowLine === 1 ? 1 : 2,
      highlightTheme:
        parsed.highlightTheme === 'blue' || parsed.highlightTheme === 'green'
          ? parsed.highlightTheme
          : 'yellow',
      sensorMode: parsed.sensorMode === 'blue' ? 'blue' : 'gps',
      voiceUnit: parsed.voiceUnit === 'seconds' ? 'seconds' : 'meters',
      alertStyle,
      pilotDisplay: {
        ...defaults.pilotDisplay,
        ...(parsed.pilotDisplay || {}),
      },
      shortcuts: {
        ...defaults.shortcuts,
        ...(parsed.shortcuts || {}),
      },
      pairing: {
        enabled: Boolean(parsed.pairing?.enabled),
        role: parsed.pairing?.role === 'pilot' ? 'pilot' : 'navigator',
        roomCode:
          normalizeRoomCode(parsed.pairing?.roomCode || '') || defaults.pairing.roomCode,
        bluetoothDeviceName: parsed.pairing?.bluetoothDeviceName || '',
      },
      wPasses: Array.isArray(parsed.wPasses) ? parsed.wPasses.slice(0, 6) : [],
      screenOrientation:
        parsed.screenOrientation === 'portrait' || parsed.screenOrientation === 'landscape'
          ? parsed.screenOrientation
          : 'auto',
      goproAutoRecOnStart: Boolean(parsed.goproAutoRecOnStart),
      voiceThresholds:
        Array.isArray(parsed.voiceThresholds) && parsed.voiceThresholds.length > 0
          ? parsed.voiceThresholds
              .map((n) => Number(n))
              .filter((n) => Number.isFinite(n) && n > 0)
              .sort((a, b) => b - a)
          : defaults.voiceThresholds,
    };
  } catch {
    return defaults;
  }
}

export function updateNavSettings(
  patch: Partial<PitStopNavSettings> | ((prev: PitStopNavSettings) => PitStopNavSettings)
): PitStopNavSettings {
  const current = getNavSettings();
  const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: next }));
  } catch {
    // Ignore quota errors
  }
  return next;
}

export function useNavSettings(): [
  PitStopNavSettings,
  (patch: Partial<PitStopNavSettings> | ((prev: PitStopNavSettings) => PitStopNavSettings)) => void
] {
  const [settings, setSettings] = useState<PitStopNavSettings>(() => getNavSettings());

  useEffect(() => {
    const onUpdate = (e: Event) => {
      const detail = (e as CustomEvent<PitStopNavSettings>).detail;
      if (detail) {
        setSettings(detail);
      } else {
        setSettings(getNavSettings());
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setSettings(getNavSettings());
      }
    };
    window.addEventListener(SETTINGS_EVENT, onUpdate);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SETTINGS_EVENT, onUpdate);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const update = useCallback(
    (patch: Partial<PitStopNavSettings> | ((prev: PitStopNavSettings) => PitStopNavSettings)) => {
      const saved = updateNavSettings(patch);
      setSettings(saved);
    },
    []
  );

  return [settings, update];
}

export function wValueFromCalibrationPct(
  calibrationPct: number,
  wBaseValue = 4000
): number {
  const safeBase = wBaseValue > 0 ? wBaseValue : 4000;
  return Math.round(safeBase * (calibrationPct / 100));
}

export function calibrationPctFromWValue(
  wValue: number,
  wBaseValue = 4000
): number {
  const safeBase = wBaseValue > 0 ? wBaseValue : 4000;
  if (!Number.isFinite(wValue) || wValue <= 0) return 100;
  return Number(Math.min(130, Math.max(70, (wValue / safeBase) * 100)).toFixed(2));
}
