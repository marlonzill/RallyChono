import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';

interface StoredSubmission {
  id: string;
  fileName: string;
  eventName: string;
  carNumber: string;
  crewName: string;
  raceDate: string;
  startTimeStr: string;
  detectionRadiusM: number;
  recordedAt: string;
  passages: unknown[];
  rawTxt?: string;
}

interface StoredStanding {
  slug: string;
  eventName: string;
  createdAt: string;
  missedPenaltyPts: number;
  rows: unknown[];
  txtReport: string;
  csvReport: string;
}

interface BaseDatabase {
  submissions: StoredSubmission[];
  publishedStandings: StoredStanding[];
}

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const TXT_DIR = path.join(DATA_DIR, 'txts');
const DB_FILE = path.join(DATA_DIR, 'pitstop_base.json');

function ensureDataDirs(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(TXT_DIR)) {
    fs.mkdirSync(TXT_DIR, { recursive: true });
  }
}

function readDb(): BaseDatabase {
  ensureDataDirs();
  try {
    if (!fs.existsSync(DB_FILE)) {
      return { submissions: [], publishedStandings: [] };
    }
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BaseDatabase>;
    return {
      submissions: Array.isArray(parsed.submissions) ? parsed.submissions : [],
      publishedStandings: Array.isArray(parsed.publishedStandings)
        ? parsed.publishedStandings
        : [],
    };
  } catch {
    return { submissions: [], publishedStandings: [] };
  }
}

function writeDb(db: BaseDatabase): void {
  ensureDataDirs();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

function sanitizeSlugPart(val: string): string {
  return val
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

async function startServer(): Promise<void> {
  const app = express();

  // Open CORS for Capacitor APK (`https://localhost`) and local Wi-Fi devices sending GPS data
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '12mb' }));

  app.get('/api/health', (_req, res) => {
    const db = readDb();
    res.json({
      ok: true,
      brand: 'PitStop Sports',
      submissionsCount: db.submissions.length,
      publishedCount: db.publishedStandings.length,
    });
  });

  app.get('/api/results', (_req, res) => {
    const db = readDb();
    res.json({ ok: true, results: db.submissions });
  });

  app.post('/api/results', (req, res) => {
    const body = req.body as Partial<StoredSubmission> | undefined;
    if (!body || !body.carNumber || !Array.isArray(body.passages)) {
      res.status(400).json({
        ok: false,
        error: 'Dados incompletos: informe número do carro e lista de passagens.',
      });
      return;
    }

    const carNumClean = String(body.carNumber).trim();
    const eventClean = String(body.eventName || 'Prova PitStop Sports').trim();
    const id =
      body.id && String(body.id).trim()
        ? String(body.id).trim()
        : `car_${carNumClean.replace(/[^a-zA-Z0-9_-]/g, '')}_${Date.now()}`;
    const fileName =
      body.fileName && String(body.fileName).trim()
        ? String(body.fileName).trim()
        : `resultado_carro_${carNumClean.replace(/[^a-zA-Z0-9_-]/g, '')}.txt`;

    const submission: StoredSubmission = {
      id,
      fileName,
      eventName: eventClean,
      carNumber: carNumClean,
      crewName: String(body.crewName || '').trim(),
      raceDate: String(body.raceDate || '').trim(),
      startTimeStr: String(body.startTimeStr || '').trim(),
      detectionRadiusM: Number(body.detectionRadiusM) || 30,
      recordedAt: String(body.recordedAt || new Date().toISOString()),
      passages: body.passages,
      rawTxt: typeof body.rawTxt === 'string' ? body.rawTxt : undefined,
    };

    const db = readDb();
    const existingIdx = db.submissions.findIndex(
      (x) =>
        x.id === submission.id ||
        (x.carNumber === submission.carNumber &&
          x.eventName === submission.eventName &&
          x.startTimeStr === submission.startTimeStr)
    );
    if (existingIdx >= 0) {
      db.submissions[existingIdx] = submission;
    } else {
      db.submissions.unshift(submission);
    }
    writeDb(db);

    if (submission.rawTxt) {
      try {
        ensureDataDirs();
        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        fs.writeFileSync(path.join(TXT_DIR, safeName), submission.rawTxt, 'utf-8');
      } catch {
        // Non-fatal if txt mirror fails
      }
    }

    res.status(201).json({
      ok: true,
      id: submission.id,
      count: db.submissions.length,
    });
  });

  app.delete('/api/results/:id', (req, res) => {
    const db = readDb();
    const before = db.submissions.length;
    db.submissions = db.submissions.filter((s) => s.id !== req.params.id);
    if (db.submissions.length !== before) {
      writeDb(db);
    }
    res.json({ ok: true, count: db.submissions.length });
  });

  app.delete('/api/results', (_req, res) => {
    const db = readDb();
    db.submissions = [];
    writeDb(db);
    res.json({ ok: true, count: 0 });
  });

  app.post('/api/public-standings', (req, res) => {
    const body = req.body as Partial<StoredStanding> | undefined;
    if (!body || !Array.isArray(body.rows)) {
      res.status(400).json({ ok: false, error: 'Tabela de classificação inválida.' });
      return;
    }

    const eventName = String(body.eventName || 'Classificação Oficial PitStop Sports').trim();
    const slug = `${sanitizeSlugPart(eventName) || 'prova'}-${Date.now().toString(36).slice(-5)}`;

    const snapshot: StoredStanding = {
      slug,
      eventName,
      createdAt: new Date().toISOString(),
      missedPenaltyPts: Number(body.missedPenaltyPts) || 600,
      rows: body.rows,
      txtReport: String(body.txtReport || ''),
      csvReport: String(body.csvReport || ''),
    };

    const db = readDb();
    db.publishedStandings.unshift(snapshot);
    if (db.publishedStandings.length > 50) {
      db.publishedStandings = db.publishedStandings.slice(0, 50);
    }
    writeDb(db);

    res.status(201).json({
      ok: true,
      slug,
      path: `/?resultado=${encodeURIComponent(slug)}`,
    });
  });

  app.get('/api/public-standings/:slug', (req, res) => {
    const db = readDb();
    const match = db.publishedStandings.find((p) => p.slug === req.params.slug);
    if (!match) {
      res.status(404).json({ ok: false, error: 'Classificação não encontrada.' });
      return;
    }
    res.json({ ok: true, snapshot: match });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(ROOT_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);

  // Real-time Navigator -> Pilot pairing WebSocket on /ws/pair
  interface PairRoom {
    clients: Map<WebSocket, 'navigator' | 'pilot'>;
    lastTelemetryJson: string | null;
  }
  const pairRooms = new Map<string, PairRoom>();
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/pair' });

  const broadcastPresence = (roomId: string, room: PairRoom) => {
    let navigators = 0;
    let pilots = 0;
    for (const r of room.clients.values()) {
      if (r === 'navigator') navigators += 1;
      else pilots += 1;
    }
    const msg = JSON.stringify({
      type: 'pair:presence',
      roomCode: roomId,
      navigators,
      pilots,
    });
    for (const ws of room.clients.keys()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  };

  wss.on('connection', (ws, req) => {
    const reqUrl = new URL(req.url || '/ws/pair', `http://127.0.0.1:${PORT}`);
    const roomId = (reqUrl.searchParams.get('room') || 'PS-0000')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, '')
      .slice(0, 12);
    const roleParam = reqUrl.searchParams.get('role') === 'pilot' ? 'pilot' : 'navigator';

    let room = pairRooms.get(roomId);
    if (!room) {
      room = { clients: new Map(), lastTelemetryJson: null };
      pairRooms.set(roomId, room);
    }

    room.clients.set(ws, roleParam);
    broadcastPresence(roomId, room);

    if (roleParam === 'pilot' && room.lastTelemetryJson && ws.readyState === WebSocket.OPEN) {
      ws.send(room.lastTelemetryJson);
    }

    ws.on('message', (rawData) => {
      if (roleParam !== 'navigator') return;
      const text = rawData.toString();
      if (text.length > 512 * 1024) return;
      try {
        const parsed = JSON.parse(text) as { type?: string };
        if (parsed.type === 'nav:telemetry') {
          room!.lastTelemetryJson = text;
          for (const [peer, peerRole] of room!.clients.entries()) {
            if (peerRole === 'pilot' && peer.readyState === WebSocket.OPEN) {
              peer.send(text);
            }
          }
        }
      } catch {
        // Ignore malformed telemetry payload
      }
    });

    ws.on('close', () => {
      const targetRoom = pairRooms.get(roomId);
      if (!targetRoom) return;
      targetRoom.clients.delete(ws);
      if (targetRoom.clients.size === 0) {
        pairRooms.delete(roomId);
      } else {
        broadcastPresence(roomId, targetRoom);
      }
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`PitStop Sports server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start PitStop Sports server:', err);
  process.exit(1);
});
