import { resolveApiBaseUrl } from './baseApi';

export type PairingRole = 'navigator' | 'pilot';

export interface PairingTelemetryPayload {
  roomCode: string;
  odometerKm: number;
  partialKm: number;
  speedKmh: number;
  targetSpeedKmh: number | null;
  deltaSec: number | null;
  deltaMeters?: number | null;
  clockTimeStr?: string;
  elapsedMs?: number;
  activeTulipaIdx: number;
  tulipaNum: number;
  distToNextKm: number;
  cap: number | null;
  type: 'D' | 'V' | 'N' | '';
  section: number | null;
  tdnMs: number | null;
  sectionRemainingMs: number | null;
  notes?: string;
  imageDataUrl?: string;
  notesImageDataUrl?: string;
  imageIsComposite?: boolean;
  isRunning: boolean;
  eventName?: string;
  updatedAtMs: number;
}

export interface PairingPresenceState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  navigators: number;
  pilots: number;
  transport: 'ws' | 'local' | 'none';
  errorMessage?: string;
}

export function normalizeRoomCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 12);
}

export function generatePairingRoomCode(): string {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `PS-${num}`;
}

function buildWebSocketUrl(roomCode: string, role: PairingRole): string | null {
  if (typeof window === 'undefined') return null;

  const customBase = resolveApiBaseUrl();
  let wsOrigin = '';

  if (customBase) {
    try {
      const parsed = new URL(customBase);
      const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      wsOrigin = `${wsProto}//${parsed.host}`;
    } catch {
      wsOrigin = '';
    }
  }

  if (!wsOrigin) {
    const loc = window.location;
    if (loc.protocol === 'http:' || loc.protocol === 'https:') {
      const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
      wsOrigin = `${wsProto}//${loc.host}`;
    }
  }

  if (!wsOrigin) return null;
  return `${wsOrigin}/ws/pair?room=${encodeURIComponent(roomCode)}&role=${encodeURIComponent(role)}`;
}

export interface PairingConnection {
  sendTelemetry: (payload: PairingTelemetryPayload) => void;
  close: () => void;
}

export function connectPairingRoom(opts: {
  roomCode: string;
  role: PairingRole;
  onTelemetry: (payload: PairingTelemetryPayload) => void;
  onPresence: (state: PairingPresenceState) => void;
}): PairingConnection {
  const cleanRoom = normalizeRoomCode(opts.roomCode);
  if (!cleanRoom) {
    opts.onPresence({
      status: 'error',
      navigators: 0,
      pilots: 0,
      transport: 'none',
      errorMessage: 'Informe um código de dupla válido.',
    });
    return {
      sendTelemetry: () => {},
      close: () => {},
    };
  }

  let closed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let channel: BroadcastChannel | null = null;
  let wsOpen = false;

  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(`pitstop_pair_${cleanRoom}`);
      channel.onmessage = (ev) => {
        if (closed || opts.role !== 'pilot') return;
        const msg = ev.data as { type?: string; payload?: PairingTelemetryPayload };
        if (msg?.type === 'nav:telemetry' && msg.payload) {
          opts.onTelemetry(msg.payload);
        }
      };
    } catch {
      channel = null;
    }
  }

  const connectWs = () => {
    if (closed) return;
    const url = buildWebSocketUrl(cleanRoom, opts.role);
    if (!url) {
      opts.onPresence({
        status: channel ? 'connected' : 'error',
        navigators: opts.role === 'navigator' ? 1 : 0,
        pilots: opts.role === 'pilot' ? 1 : 0,
        transport: channel ? 'local' : 'none',
        errorMessage: channel
          ? undefined
          : 'Configure o IP/Servidor Base PitStop em Configurações para conectar por Wi-Fi.',
      });
      return;
    }

    opts.onPresence({
      status: 'connecting',
      navigators: opts.role === 'navigator' ? 1 : 0,
      pilots: opts.role === 'pilot' ? 1 : 0,
      transport: 'ws',
    });

    try {
      ws = new WebSocket(url);
    } catch {
      opts.onPresence({
        status: 'error',
        navigators: 0,
        pilots: 0,
        transport: 'none',
        errorMessage: 'Não foi possível abrir WebSocket.',
      });
      return;
    }

    ws.onopen = () => {
      if (closed) return;
      wsOpen = true;
      opts.onPresence({
        status: 'connected',
        navigators: opts.role === 'navigator' ? 1 : 0,
        pilots: opts.role === 'pilot' ? 1 : 0,
        transport: 'ws',
      });
    };

    ws.onmessage = (ev) => {
      if (closed) return;
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          payload?: PairingTelemetryPayload;
          navigators?: number;
          pilots?: number;
        };
        if (msg.type === 'pair:presence') {
          opts.onPresence({
            status: 'connected',
            navigators: Number(msg.navigators) || 0,
            pilots: Number(msg.pilots) || 0,
            transport: 'ws',
          });
        } else if (msg.type === 'nav:telemetry' && msg.payload && opts.role === 'pilot') {
          opts.onTelemetry(msg.payload);
        }
      } catch {
        // Ignore malformed frames
      }
    };

    ws.onclose = () => {
      wsOpen = false;
      if (closed) return;
      opts.onPresence({
        status: 'disconnected',
        navigators: 0,
        pilots: 0,
        transport: channel ? 'local' : 'none',
      });
      reconnectTimer = window.setTimeout(connectWs, 2500);
    };

    ws.onerror = () => {
      wsOpen = false;
      if (closed) return;
      opts.onPresence({
        status: channel ? 'connected' : 'error',
        navigators: opts.role === 'navigator' ? 1 : 0,
        pilots: opts.role === 'pilot' ? 1 : 0,
        transport: channel ? 'local' : 'none',
        errorMessage: 'Sem acesso ao servidor WebSocket.',
      });
    };
  };

  connectWs();

  return {
    sendTelemetry: (payload: PairingTelemetryPayload) => {
      if (closed || opts.role !== 'navigator') return;
      const envelope = { type: 'nav:telemetry', payload };
      if (ws && wsOpen && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(envelope));
        } catch {
          // Ignore send errors while reconnecting
        }
      }
      if (channel) {
        try {
          channel.postMessage(envelope);
        } catch {
          // Ignore local broadcast errors
        }
      }
    },
    close: () => {
      closed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore close error
        }
        ws = null;
      }
      if (channel) {
        try {
          channel.close();
        } catch {
          // Ignore close error
        }
        channel = null;
      }
    },
  };
}
