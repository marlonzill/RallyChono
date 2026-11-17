import type {
  CompetitorResultFile,
  CompetitorSummary,
  ParsedRoadbook,
  PassageRecord,
  PassageStatus,
  RallySessionConfig,
  SectionSummary,
  TulipaType,
} from '../types/rally';
import { computePassageScore, formatClockMs, parseRaceStartTimestampMs } from './rallyEngine';

export function formatResultTxt(
  eventName: string,
  config: RallySessionConfig,
  passages: PassageRecord[]
): string {
  const totalV = passages.filter((p) => p.type === 'V').length;
  const recordedV = passages.filter((p) => p.type === 'V' && p.status === 'PASSOU').length;
  const totalPointsV = passages.reduce(
    (sum, p) => (p.type === 'V' ? sum + p.points : sum),
    0
  );
  const recordedAt = new Date().toISOString();

  const lines: string[] = [
    '# RALLY REGULARIDADE - REGISTRO DE PROVA (RESULTADO OFICIAL)',
    `# Evento: ${eventName}`,
    `# Carro: ${config.carNumber.trim() || 'SEM_NUMERO'}`,
    `# Dupla: ${config.crewName.trim() || '-'}`,
    `# Data: ${config.raceDate}`,
    `# HoraLargada: ${config.startTimeStr}`,
    `# RaioDeteccaoM: ${config.detectionRadiusM}`,
    `# TotalTulipas: ${passages.length}`,
    `# TrechosV_Registrados: ${recordedV}/${totalV}`,
    `# TotalPontos_V: ${totalPointsV}`,
    `# GeradoEm: ${recordedAt}`,
    '# Regra: Trechos V = 1 pt/seg (adiantado ou atrasado). Trechos D e N = 0 pts (isento).',
    '-'.repeat(120),
    'Tul | Typ | Sec | TotalKm | IdealTime   | IdealHora | RealHora     | DiffSec  | Pontos | DistM | Status',
    '-'.repeat(120),
  ];

  for (const p of passages) {
    const tul = String(p.tulipa).padStart(3, ' ');
    const typ = (p.type || '-').padEnd(3, ' ');
    const sec = (p.section !== null ? String(p.section) : '-').padStart(3, ' ');
    const km = p.totalKm.toFixed(2).padStart(7, ' ');
    const idealT = (p.idealTimeStr || '--:--:--.--').padEnd(11, ' ');
    const idealH =
      p.idealAbsoluteMs !== null
        ? formatClockMs(p.idealAbsoluteMs, false).padEnd(9, ' ')
        : '--:--:-- '.padEnd(9, ' ');
    const realH =
      p.actualTimestampMs !== null
        ? formatClockMs(p.actualTimestampMs, true).padEnd(12, ' ')
        : '--:--:--.-- '.padEnd(12, ' ');
    const diffStr =
      p.diffSec !== null
        ? `${p.diffSec >= 0 ? '+' : ''}${p.diffSec.toFixed(2)}`.padStart(8, ' ')
        : '--'.padStart(8, ' ');
    const ptsStr = String(p.points).padStart(6, ' ');
    const distStr =
      p.minDistanceM !== null ? p.minDistanceM.toFixed(1).padStart(5, ' ') : '--'.padStart(5, ' ');

    lines.push(
      `${tul} | ${typ} | ${sec} | ${km} | ${idealT} | ${idealH} | ${realH} | ${diffStr} | ${ptsStr} | ${distStr} | ${p.status}`
    );
  }

  lines.push('-'.repeat(120));
  return lines.join('\n') + '\n';
}

export function parseResultTxt(content: string, fileName: string): CompetitorResultFile {
  const lines = content.split(/\r?\n/);
  let eventName = 'Prova Rally';
  let carNumber = '';
  let crewName = '-';
  let raceDate = new Date().toISOString().slice(0, 10);
  let startTimeStr = '00:00:00';
  let detectionRadiusM = 30;
  let recordedAt = '';

  const passages: PassageRecord[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      const meta = trimmed.replace(/^#+\s*/, '');
      const colonIdx = meta.indexOf(':');
      if (colonIdx > 0) {
        const key = meta.slice(0, colonIdx).trim().toLowerCase();
        const val = meta.slice(colonIdx + 1).trim();
        if (key === 'evento') eventName = val;
        else if (key === 'carro') carNumber = val;
        else if (key === 'dupla') crewName = val;
        else if (key === 'data') raceDate = val;
        else if (key === 'horalargada') startTimeStr = val;
        else if (key === 'raiodeteccaom') detectionRadiusM = parseInt(val, 10) || 30;
        else if (key === 'geradoem') recordedAt = val;
      }
      continue;
    }

    if (/^[-=_+\s|]+$/.test(trimmed)) continue;
    if (trimmed.toLowerCase().startsWith('tul |')) continue;

    const cols = trimmed.split('|').map((c) => c.trim());
    if (cols.length < 11) continue;

    const tulipa = parseInt(cols[0], 10);
    if (!Number.isFinite(tulipa)) continue;

    const rawTyp = cols[1].toUpperCase();
    const type: TulipaType =
      rawTyp === 'D' || rawTyp === 'V' || rawTyp === 'N' ? rawTyp : '';
    const section = cols[2] !== '-' ? parseInt(cols[2], 10) : null;
    const totalKm = parseFloat(cols[3]) || 0;
    const idealTimeStr = cols[4] === '--:--:--.--' ? '' : cols[4];
    const idealHoraStr = cols[5] && !cols[5].includes('--') ? cols[5] : '--';
    const realHoraStr = cols[6] && !cols[6].includes('--') ? cols[6] : '--';
    const diffSec = cols[7] === '--' ? null : parseFloat(cols[7]);
    const parsedPoints = parseInt(cols[8], 10) || 0;
    // Enforce D and N zero-points invariant even when reading external files
    const points = type === 'V' ? parsedPoints : 0;
    const minDistanceM = cols[9] === '--' ? null : parseFloat(cols[9]);
    const status = cols[10] as PassageStatus;

    passages.push({
      tulipa,
      type,
      section: section !== null && Number.isFinite(section) ? section : null,
      totalKm,
      idealTimeStr,
      idealTimeMs: null,
      idealAbsoluteMs: null,
      idealHoraStr,
      realHoraStr,
      actualTimestampMs: realHoraStr === '--' ? null : 1,
      actualLat: null,
      actualLon: null,
      actualAccuracyM: null,
      minDistanceM: minDistanceM !== null && Number.isFinite(minDistanceM) ? minDistanceM : null,
      diffSec: diffSec !== null && Number.isFinite(diffSec) ? diffSec : null,
      points,
      status,
    });
  }

  if (!carNumber || passages.length === 0) {
    throw new Error(`Arquivo "${fileName}" não segue o formato de resultado do RallyChrono.`);
  }

  return {
    id: `${carNumber}-${fileName}-${Math.random().toString(36).slice(2, 7)}`,
    fileName,
    eventName,
    carNumber,
    crewName,
    raceDate,
    startTimeStr,
    detectionRadiusM,
    recordedAt,
    passages,
  };
}

export function summarizeCompetitorResult(
  result: CompetitorResultFile,
  missedVPenaltyPts: number
): CompetitorSummary {
  let totalV = 0;
  let recordedV = 0;
  let missedV = 0;
  let earlySecondsTotal = 0;
  let lateSecondsTotal = 0;
  let pointsFromV = 0;

  for (const p of result.passages) {
    if (p.type !== 'V') continue;
    totalV += 1;
    if (p.status === 'PASSOU') {
      recordedV += 1;
      pointsFromV += p.points;
      if (p.diffSec !== null) {
        if (p.diffSec < 0) earlySecondsTotal += Math.abs(p.diffSec);
        else lateSecondsTotal += p.diffSec;
      }
    } else {
      missedV += 1;
    }
  }

  const missedPenaltyPoints = missedV * missedVPenaltyPts;
  return {
    result,
    totalV,
    recordedV,
    missedV,
    earlySecondsTotal: Number(earlySecondsTotal.toFixed(1)),
    lateSecondsTotal: Number(lateSecondsTotal.toFixed(1)),
    pointsFromV,
    missedPenaltyPoints,
    finalTotalPoints: pointsFromV + missedPenaltyPoints,
  };
}

export function summarizeBySection(passages: PassageRecord[]): SectionSummary[] {
  const map = new Map<string, SectionSummary>();

  for (const p of passages) {
    const key = `${p.section ?? 'sem'}-${p.type || '-'}`;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        section: p.section,
        type: p.type,
        totalTulipas: 0,
        recordedCount: 0,
        points: 0,
        earlySeconds: 0,
        lateSeconds: 0,
      };
      map.set(key, entry);
    }

    entry.totalTulipas += 1;
    if (p.status === 'PASSOU' || p.status === 'PASSOU_ISENTO') {
      entry.recordedCount += 1;
    }
    if (p.type === 'V') {
      entry.points += p.points;
      if (p.diffSec !== null) {
        if (p.diffSec < 0) entry.earlySeconds += Math.abs(p.diffSec);
        else entry.lateSeconds += p.diffSec;
      }
    }
  }

  return Array.from(map.values()).map((s) => ({
    ...s,
    earlySeconds: Number(s.earlySeconds.toFixed(1)),
    lateSeconds: Number(s.lateSeconds.toFixed(1)),
  }));
}

export function formatIndividualReportTxt(
  summary: CompetitorSummary,
  rank: number,
  missedVPenaltyPts: number
): string {
  const sections = summarizeBySection(summary.result.passages);
  const lines: string[] = [
    '# BOLETIM INDIVIDUAL DETALHADO - RALLY REGULARIDADE',
    `# Evento: ${summary.result.eventName}`,
    `# PosicaoGeral: ${rank}º Lugar`,
    `# Carro: ${summary.result.carNumber}`,
    `# Dupla: ${summary.result.crewName}`,
    `# Data: ${summary.result.raceDate} | HoraLargada: ${summary.result.startTimeStr}`,
    `# PCs_V_Registrados: ${summary.recordedV}/${summary.totalV} | PCs_V_Perdidos: ${summary.missedV}`,
    `# TotalAdiantado: ${summary.earlySecondsTotal.toFixed(1)}s | TotalAtrasado: ${summary.lateSecondsTotal.toFixed(1)}s`,
    `# Pontos_Trechos_V: ${summary.pointsFromV} pts`,
    `# Penalidade_PCs_Perdidos (${missedVPenaltyPts} pts/PC): ${summary.missedPenaltyPoints} pts`,
    `# PONTUACAO_FINAL: ${summary.finalTotalPoints} pts (menor pontuacao vence)`,
    '',
    '=== RESUMO POR SECAO ===',
    'Sec | Tip | Tulipas | Registradas | Adiant(s) | Atraso(s) | Pontos',
    '-'.repeat(72),
  ];

  for (const s of sections) {
    lines.push(
      `${String(s.section ?? '-').padStart(3, ' ')} | ${(s.type || '-').padEnd(3, ' ')} | ${String(s.totalTulipas).padStart(7, ' ')} | ${String(s.recordedCount).padStart(11, ' ')} | ${s.earlySeconds.toFixed(1).padStart(9, ' ')} | ${s.lateSeconds.toFixed(1).padStart(9, ' ')} | ${String(s.points).padStart(6, ' ')}`
    );
  }

  lines.push('');
  lines.push('=== DETALHAMENTO TULIPA A TULIPA ===');
  lines.push('Tul | Sec | Tip | IdealHora | RealHora     | Diff(s)  | DistM | Pontos | Situacao');
  lines.push('-'.repeat(92));

  for (const p of summary.result.passages) {
    const tul = String(p.tulipa).padStart(3, ' ');
    const sec = String(p.section ?? '-').padStart(3, ' ');
    const typ = (p.type || '-').padEnd(3, ' ');
    const idealH = (p.idealHoraStr || '--').padEnd(9, ' ');
    const realH = (p.realHoraStr || '--').padEnd(12, ' ');
    const diff =
      p.diffSec !== null
        ? `${p.diffSec >= 0 ? '+' : ''}${p.diffSec.toFixed(2)}`.padStart(8, ' ')
        : '--'.padStart(8, ' ');
    const dist =
      p.minDistanceM !== null ? p.minDistanceM.toFixed(1).padStart(5, ' ') : '--'.padStart(5, ' ');
    const pts = String(p.points).padStart(6, ' ');
    const sit =
      p.type !== 'V'
        ? 'Isento (D/N)'
        : p.status === 'NAO_PASSOU'
          ? 'NAO PASSOU'
          : p.diffSec !== null && p.diffSec < 0
            ? 'Adiantado'
            : p.diffSec !== null && p.diffSec > 0
              ? 'Atrasado'
              : 'No tempo';
    lines.push(`${tul} | ${sec} | ${typ} | ${idealH} | ${realH} | ${diff} | ${dist} | ${pts} | ${sit}`);
  }

  return lines.join('\n') + '\n';
}

export function formatFinalStandingsTxt(
  summaries: CompetitorSummary[],
  missedVPenaltyPts: number
): string {
  const eventName = summaries[0]?.result.eventName ?? 'Rally Regularidade';
  const lines: string[] = [
    '# CLASSIFICACAO FINAL OFICIAL - RALLY REGULARIDADE',
    `# Evento: ${eventName}`,
    `# TotalCarros: ${summaries.length}`,
    `# PenalidadePorPCNaoRegistrado_V: ${missedVPenaltyPts} pts`,
    `# ApuradoEm: ${new Date().toLocaleString('pt-BR')}`,
    '-'.repeat(110),
    'Pos | Carro | Dupla                    | PCs_V   | Adiant(s) | Atraso(s) | Pts_V  | Penal_NC | TotalPts',
    '-'.repeat(110),
  ];

  summaries.forEach((s, i) => {
    const pos = String(i + 1).padStart(3, ' ');
    const car = s.result.carNumber.padStart(5, ' ');
    const crew = s.result.crewName.slice(0, 24).padEnd(24, ' ');
    const pcs = `${s.recordedV}/${s.totalV}`.padStart(7, ' ');
    const early = s.earlySecondsTotal.toFixed(1).padStart(9, ' ');
    const late = s.lateSecondsTotal.toFixed(1).padStart(9, ' ');
    const ptsV = String(s.pointsFromV).padStart(6, ' ');
    const penNC = String(s.missedPenaltyPoints).padStart(8, ' ');
    const total = String(s.finalTotalPoints).padStart(8, ' ');
    lines.push(
      `${pos} | ${car} | ${crew} | ${pcs} | ${early} | ${late} | ${ptsV} | ${penNC} | ${total}`
    );
  });

  lines.push('-'.repeat(110));
  return lines.join('\n') + '\n';
}

export function formatFinalStandingsCsv(summaries: CompetitorSummary[]): string {
  const header =
    'Posicao;Carro;Dupla;PCs_V_Registrados;Total_PCs_V;Adiantado_s;Atrasado_s;Pontos_V;Penalidade_NC;Total_Pontos';
  const rows = summaries.map((s, i) =>
    [
      i + 1,
      s.result.carNumber,
      `"${s.result.crewName.replace(/"/g, '""')}"`,
      s.recordedV,
      s.totalV,
      s.earlySecondsTotal.toFixed(1).replace('.', ','),
      s.lateSecondsTotal.toFixed(1).replace('.', ','),
      s.pointsFromV,
      s.missedPenaltyPoints,
      s.finalTotalPoints,
    ].join(';')
  );
  return [header, ...rows].join('\n');
}

/**
 * Creates 3 realistic simulated competitor result TXT files from a roadbook
 * so the organizer can immediately test the Apuração workflow.
 */
export function generateDemoResultFiles(roadbook: ParsedRoadbook): {
  fileName: string;
  content: string;
}[] {
  const demoCars = [
    { car: '014', crew: 'Silva / Costa', start: '08:14:00', jitterMaxSec: 2.8, missProb: 0 },
    { car: '007', crew: 'Mendes / Oliveira', start: '08:07:00', jitterMaxSec: 5.2, missProb: 0.02 },
    { car: '029', crew: 'Ribeiro / Santos', start: '08:29:00', jitterMaxSec: 9.5, missProb: 0.05 },
  ];

  const today = new Date().toISOString().slice(0, 10);

  return demoCars.map((demo, carIdx) => {
    const startMs = parseRaceStartTimestampMs(today, demo.start);
    const passages: PassageRecord[] = roadbook.tulipas.map((t, idx) => {
      const idealAbsoluteMs = t.idealTimeMs !== null ? startMs + t.idealTimeMs : null;
      const isExempt = t.type !== 'V';

      // Deterministic pseudo-random offset per car & tulipa
      const seed = Math.sin((carIdx + 1) * 131 + (idx + 1) * 37);
      const missed = Math.abs(seed) < demo.missProb;

      if (missed || idealAbsoluteMs === null) {
        return {
          tulipa: t.tulipa,
          type: t.type,
          section: t.section,
          totalKm: t.totalKm,
          idealTimeStr: t.idealTimeStr,
          idealTimeMs: t.idealTimeMs,
          idealAbsoluteMs,
          actualTimestampMs: null,
          actualLat: null,
          actualLon: null,
          actualAccuracyM: null,
          minDistanceM: null,
          diffSec: null,
          points: 0,
          status: isExempt ? 'NAO_PASSOU_ISENTO' : 'NAO_PASSOU',
        };
      }

      const offsetSec = seed * demo.jitterMaxSec;
      const actualMs = Math.round(idealAbsoluteMs + offsetSec * 1000);
      const { diffSec, points } = computePassageScore(t.type, idealAbsoluteMs, actualMs);
      const distM = Number((3 + Math.abs(Math.cos(idx + carIdx)) * 18).toFixed(1));

      return {
        tulipa: t.tulipa,
        type: t.type,
        section: t.section,
        totalKm: t.totalKm,
        idealTimeStr: t.idealTimeStr,
        idealTimeMs: t.idealTimeMs,
        idealAbsoluteMs,
        actualTimestampMs: actualMs,
        actualLat: t.lat,
        actualLon: t.lon,
        actualAccuracyM: 6,
        minDistanceM: distM,
        diffSec,
        points,
        status: isExempt ? 'PASSOU_ISENTO' : 'PASSOU',
      };
    });

    const content = formatResultTxt(
      roadbook.eventName,
      {
        carNumber: demo.car,
        crewName: demo.crew,
        raceDate: today,
        startTimeStr: demo.start,
        detectionRadiusM: 30,
      },
      passages
    );

    return {
      fileName: `resultado_carro_${demo.car}.txt`,
      content,
    };
  });
}
