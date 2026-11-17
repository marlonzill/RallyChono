import type { ParsedRoadbook, RoadbookTulipa, TulipaType } from '../types/rally';

/**
 * Converts DMS strings like `27°39.984'S` or `52°17.531'W` to decimal degrees.
 */
export function parseCoordinateValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const direct = Number(trimmed.replace(',', '.'));
  if (Number.isFinite(direct)) {
    return direct;
  }

  const dmsMatch = trimmed.match(
    /^(-?\d+(?:\.\d+)?)\s*[°º]\s*(\d+(?:\.\d+)?)\s*['′]?\s*(?:(\d+(?:\.\d+)?)\s*["″]?)?\s*([NSEWO])?$/i
  );
  if (!dmsMatch) return null;

  const deg = parseFloat(dmsMatch[1]);
  const min = parseFloat(dmsMatch[2]);
  const sec = dmsMatch[3] ? parseFloat(dmsMatch[3]) : 0;
  const hemi = (dmsMatch[4] || '').toUpperCase();

  let decimal = Math.abs(deg) + min / 60 + sec / 3600;
  if (deg < 0 || hemi === 'S' || hemi === 'W' || hemi === 'O') {
    decimal = -decimal;
  }
  return decimal;
}

/**
 * Parses `HH:MM:SS.cc`, `HH:MM:SS`, `HH.MM.SS`, or `MM:SS(.cc)` into elapsed milliseconds from start.
 */
export function parseIdealTimeToMs(raw: string): number | null {
  const clean = raw.trim();
  if (!clean) return null;

  const hms = clean.match(/^(\d{1,3})[:.](\d{2})[:.](\d{2})(?:[.,](\d{1,3}))?$/);
  if (hms) {
    const hours = parseInt(hms[1], 10);
    const minutes = parseInt(hms[2], 10);
    const seconds = parseInt(hms[3], 10);
    if (minutes >= 60 || seconds >= 60) return null;
    const fracStr = hms[4] ?? '0';
    const fracMs =
      fracStr.length === 1
        ? parseInt(fracStr, 10) * 100
        : fracStr.length === 2
          ? parseInt(fracStr, 10) * 10
          : parseInt(fracStr.slice(0, 3), 10);

    return ((hours * 3600 + minutes * 60 + seconds) * 1000) + fracMs;
  }

  // Colon MM:SS(.cc) without hours (strict colon so decimal km like `6.23` never matches)
  const ms = clean.match(/^(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (ms) {
    const minutes = parseInt(ms[1], 10);
    const seconds = parseInt(ms[2], 10);
    if (minutes < 60 && seconds < 60) {
      const fracStr = ms[3] ?? '0';
      const fracMs =
        fracStr.length === 1
          ? parseInt(fracStr, 10) * 100
          : fracStr.length === 2
            ? parseInt(fracStr, 10) * 10
            : parseInt(fracStr.slice(0, 3), 10);
      return (minutes * 60 + seconds) * 1000 + fracMs;
    }
  }

  return null;
}

export interface ParsedVelTdn {
  typeHint?: TulipaType;
  avgSpeedKmh?: number | null;
  tdnMs?: number | null;
}

/**
 * Parses Vel/TDN tokens including compact notations seen in T15 / Totem / Rabbit roadbooks:
 * - Speeds: `35`, `35,5`, `v28`, `V 33`
 * - Timed Desloc/Neutro: `N12s`, `N 12s`, `D10'`, `D10m`, `D 0:08:00`, `00.08.00`, `00:10:00`
 */
export function parseVelTdnValue(raw: string): ParsedVelTdn {
  const clean = raw.trim();
  if (!clean) return {};

  // Prefixed type + H:MM:SS / MM:SS (e.g. "D 0:08:00", "N 00.01.00")
  const prefixedTime = clean.match(/^([DVN])\s+(\d{1,3}[:.]\d{2}(?:[:.]\d{2})?)$/i);
  if (prefixedTime) {
    const typeHint = prefixedTime[1].toUpperCase() as TulipaType;
    const ms = parseIdealTimeToMs(prefixedTime[2]);
    if (ms !== null) {
      return { typeHint, tdnMs: ms, avgSpeedKmh: typeHint === 'N' ? 0 : null };
    }
  }

  // Plain HH:MM:SS or MM:SS TDN duration
  const directTimeMs = parseIdealTimeToMs(clean);
  if (directTimeMs !== null) {
    return { tdnMs: directTimeMs, avgSpeedKmh: null };
  }

  // Compact seconds/minutes tokens: N12s, D10', D8m, N5'
  const durToken = clean.match(/^([DN])\s*(\d+(?:[.,]\d+)?)\s*(s|seg|m|min|')$/i);
  if (durToken) {
    const typeHint = durToken[1].toUpperCase() as TulipaType;
    const num = Number(durToken[2].replace(',', '.'));
    const unit = durToken[3].toLowerCase();
    if (Number.isFinite(num)) {
      const ms = unit.startsWith('s') ? Math.round(num * 1000) : Math.round(num * 60000);
      return { typeHint, tdnMs: ms, avgSpeedKmh: typeHint === 'N' ? 0 : null };
    }
  }

  // Compact speed tokens: v28, V12, V 35.5
  const velToken = clean.match(/^V\s*(\d+(?:[.,]\d+)?)(?:\s*km\/?h)?$/i);
  if (velToken) {
    const spd = Number(velToken[1].replace(',', '.'));
    if (Number.isFinite(spd)) {
      return { typeHint: 'V', avgSpeedKmh: spd, tdnMs: null };
    }
  }

  // Plain number: speed in km/h
  const num = Number(clean.replace(',', '.'));
  if (Number.isFinite(num)) {
    return { avgSpeedKmh: num, tdnMs: null };
  }

  return {};
}

export function normalizeTypeToken(raw: string): TulipaType {
  const upper = raw.trim().toUpperCase();
  if (!upper) return '';

  // Direct labels
  if (upper === 'D' || upper === 'DES' || upper === 'DESLOC' || upper === 'DESLOCAMENTO') {
    return 'D';
  }
  if (
    upper === 'V' ||
    upper === 'VEL' ||
    upper === 'VELOCIDADE' ||
    upper === 'MEDIA' ||
    upper === 'MÉDIA' ||
    upper === 'PC'
  ) {
    return 'V';
  }
  if (
    upper === 'N' ||
    upper === 'NEU' ||
    upper === 'NEUTRO' ||
    upper === 'NEUTRALIZACAO' ||
    upper === 'NEUTRALIZAÇÃO' ||
    upper === 'P' ||
    upper === 'PARADA'
  ) {
    return 'N';
  }

  // Combined / compact labels like `D1`, `T1 | Des`, `T2 Des`, `V28`, `N12s`, `D10'`
  if (/^D\d+(?:[.,]\d+)?(?:\s*(?:S|SEG|M|MIN|'))?$/i.test(upper) || /\bDES(?:LOC(?:AMENTO)?)?\b/.test(upper)) return 'D';
  if (/^V\d+(?:[.,]\d+)?$/i.test(upper) || /\bVEL(?:OCIDADE)?\b/.test(upper)) return 'V';
  if (/^N\d+(?:[.,]\d+)?(?:\s*(?:S|SEG|M|MIN|'))?$/i.test(upper) || /\bNEU(?:T(?:RO|RALIZACAO|RALIZAÇÃO))?\b/.test(upper)) return 'N';

  return '';
}

function extractEmbeddedSection(raw: string): number | null {
  const m = raw.trim().match(/^T\s*(\d+)\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function splitDelimitedLine(line: string, delimiter: string): string[] {
  if (delimiter.length !== 1 || delimiter === '\t') {
    return line.split(delimiter).map((c) => c.trim().replace(/^["']|["']$/g, ''));
  }

  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur.trim().replace(/^["']|["']$/g, ''));
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim().replace(/^["']|["']$/g, ''));
  return out;
}

function detectDelimiter(lines: string[]): string {
  for (const line of lines) {
    if (line.includes('|')) return '|';
    if (line.includes(';')) return ';';
    if (line.includes('\t')) return '\t';
  }
  // Check CSV commas only when multiple lines contain >= 3 commas outside decimal-only strings
  const commaCounts = lines
    .slice(0, 8)
    .map((l) => splitDelimitedLine(l, ',').length);
  if (commaCounts.some((c) => c >= 4)) {
    return ',';
  }
  return '|';
}

function parseFlexNum(raw: string): number {
  const clean = raw.trim().replace(/\s+/g, '');
  if (!clean) return NaN;
  const normalized = /^\-?\d{1,3}(\.\d{3})+,\d+$/.test(clean)
    ? clean.replace(/\./g, '').replace(',', '.')
    : clean.replace(',', '.');
  return Number(normalized);
}

function looksLikeGeoCoord(raw: string): boolean {
  const clean = raw.trim();
  if (!clean) return false;
  if (/[°º]/.test(clean)) return true;
  if (/^-?\d{1,3}[.,]\d{4,}$/.test(clean)) {
    const val = parseFlexNum(clean);
    return Number.isFinite(val) && Math.abs(val) <= 180 && Math.abs(val) > 0.5;
  }
  return false;
}

export function inferHeaderlessColumnMap(rows: string[][]): {
  map: Record<string, number>;
  notesIndices: number[];
} {
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const map: Record<string, number> = { tulipa: 0 };
  const notesIndices: number[] = [];

  if (maxCols < 3) return { map, notesIndices };

  const sample = rows.slice(0, Math.min(rows.length, 60));

  const colStats = Array.from({ length: maxCols }, (_, idx) => {
    const cells = sample.map((r) => (r[idx] ?? '').trim()).filter(Boolean);
    const nums = cells.map(parseFlexNum).filter((n) => Number.isFinite(n));
    const timeCount = cells.filter((c) => parseIdealTimeToMs(c) !== null).length;
    const typeCount = cells.filter((c) => normalizeTypeToken(c) !== '').length;
    const sectionTagCount = cells.filter((c) => /^T\s*\d+$/i.test(c)).length;
    const compactVelTdnCount = cells.filter((c) => {
      const p = parseVelTdnValue(c);
      return p.typeHint !== undefined;
    }).length;
    const coordCount = cells.filter(looksLikeGeoCoord).length;
    const intCount = nums.filter((n) => Number.isInteger(n)).length;
    const decimalCount = nums.filter((n) => Math.abs(n - Math.round(n)) > 0.0005).length;

    let seqPlusOneSteps = 0;
    for (let k = 1; k < nums.length; k++) {
      if (Math.abs(nums[k] - nums[k - 1] - 1) < 0.001 && Number.isInteger(nums[k])) {
        seqPlusOneSteps += 1;
      }
    }
    const seqRatio = nums.length > 3 ? seqPlusOneSteps / (nums.length - 1) : 0;

    const textOnlyCount = cells.filter(
      (c) =>
        Number.isNaN(parseFlexNum(c)) &&
        parseIdealTimeToMs(c) === null &&
        normalizeTypeToken(c) === '' &&
        !/^T\s*\d+$/i.test(c) &&
        parseVelTdnValue(c).typeHint === undefined &&
        !looksLikeGeoCoord(c)
    ).length;

    const descriptiveTextCount = cells.filter(
      (c) =>
        Number.isNaN(parseFlexNum(c)) &&
        parseIdealTimeToMs(c) === null &&
        normalizeTypeToken(c) === '' &&
        !/^T\s*\d+$/i.test(c) &&
        parseVelTdnValue(c).typeHint === undefined &&
        !looksLikeGeoCoord(c) &&
        /[a-zA-ZÀ-ÿ]{3,}/.test(c) &&
        !/^(?:true|false|null|n\/a)$/i.test(c) &&
        !/\.(?:png|jpe?g|gif|bmp|svg|webp)$/i.test(c) &&
        (c.includes(' ') || c.length >= 3)
    ).length;

    const maxNum = nums.length > 0 ? Math.max(...nums) : -Infinity;
    const minNum = nums.length > 0 ? Math.min(...nums) : Infinity;

    return {
      idx,
      total: cells.length,
      nums,
      timeCount,
      typeCount,
      sectionTagCount,
      compactVelTdnCount,
      coordCount,
      intCount,
      decimalCount,
      seqRatio,
      textOnlyCount,
      descriptiveTextCount,
      maxNum,
      minNum,
    };
  });

  // Identify Tulipa column cleanly: col 0 is default unless:
  // (a) col 0 is non-numeric/section/type and col 1 is sequential +1, OR
  // (b) col 0 is an outer row sequence (e.g. 2,3,4...) and col 1 is the real tulipa number starting at 1 (1,2,3...) followed by type/km
  let tulCol = 0;
  if (
    colStats[0] &&
    colStats[1] &&
    (colStats[0].nums.length < Math.max(1, colStats[0].total * 0.6) ||
      colStats[0].sectionTagCount >= Math.max(1, colStats[0].total * 0.5) ||
      colStats[0].typeCount >= Math.max(1, colStats[0].total * 0.5)) &&
    colStats[1].seqRatio >= 0.75
  ) {
    tulCol = 1;
  } else if (
    colStats[0] &&
    colStats[1] &&
    colStats[0].seqRatio < 0.5 &&
    colStats[1].seqRatio >= 0.85 &&
    colStats[2] &&
    colStats[2].decimalCount > 0
  ) {
    tulCol = 1;
  } else if (
    colStats[0] &&
    colStats[1] &&
    colStats[0].seqRatio >= 0.85 &&
    colStats[1].seqRatio >= 0.85 &&
    colStats[0].decimalCount === 0 &&
    colStats[1].decimalCount === 0 &&
    colStats[1].minNum >= 0 &&
    colStats[1].minNum <= 1 &&
    colStats[0].minNum > colStats[1].minNum
  ) {
    tulCol = 1;
  }
  map['tulipa'] = tulCol;

  const isValidKmCandidate = (st: (typeof colStats)[number] | undefined): boolean => {
    if (!st || st.total === 0) return false;
    if (st.nums.length < Math.max(1, st.total * 0.55)) return false;
    if (st.timeCount > 0 || st.typeCount >= st.total * 0.5 || st.coordCount >= st.total * 0.5) {
      return false;
    }
    // Never map a strict +1 row counter column as total_km if decimals exist later
    if (st.seqRatio >= 0.85 && st.decimalCount === 0) return false;
    return true;
  };

  let totalKmCol = -1;
  for (let c = tulCol + 1; c < Math.min(maxCols, tulCol + 4); c++) {
    if (isValidKmCandidate(colStats[c])) {
      totalKmCol = c;
      break;
    }
  }
  if (totalKmCol < 0 && colStats[tulCol + 1]?.nums.length >= Math.max(1, (colStats[tulCol + 1]?.total ?? 0) * 0.55)) {
    totalKmCol = tulCol + 1;
  }
  if (totalKmCol >= 0) {
    map['total_km'] = totalKmCol;
  }

  const nextAfterTotal = (totalKmCol >= 0 ? totalKmCol : tulCol) + 1;
  let dataStartCol = nextAfterTotal;
  if (
    colStats[nextAfterTotal] &&
    colStats[nextAfterTotal].timeCount === 0 &&
    colStats[nextAfterTotal].typeCount === 0 &&
    colStats[nextAfterTotal].coordCount < colStats[nextAfterTotal].total * 0.5 &&
    colStats[nextAfterTotal].nums.length >= Math.max(1, colStats[nextAfterTotal].total * 0.6) &&
    colStats[nextAfterTotal].seqRatio < 0.85
  ) {
    map['inter_km'] = nextAfterTotal;
    dataStartCol = nextAfterTotal + 1;
  }

  // Classify remaining columns by signature (check from col 0 skipping already-assigned columns)
  const timeCols: number[] = [];
  const coordCols: number[] = [];
  const intCols: number[] = [];
  const assignedCols = new Set<number>(Object.values(map));

  for (let c = 0; c < maxCols; c++) {
    if (assignedCols.has(c)) continue;
    const st = colStats[c];
    if (st.total === 0) continue;

    if (st.compactVelTdnCount >= Math.max(1, st.total * 0.4) && !('veltdn' in map)) {
      map['veltdn'] = c;
      assignedCols.add(c);
    } else if (st.sectionTagCount >= Math.max(1, st.total * 0.5) && !('section' in map)) {
      map['section'] = c;
      assignedCols.add(c);
    } else if (st.timeCount >= Math.max(1, st.total * 0.45)) {
      timeCols.push(c);
      assignedCols.add(c);
    } else if (st.typeCount >= Math.max(1, st.total * 0.5) && !('type' in map)) {
      map['type'] = c;
      assignedCols.add(c);
    } else if (st.coordCount >= Math.max(1, st.total * 0.5)) {
      coordCols.push(c);
      assignedCols.add(c);
    } else if (
      c >= dataStartCol - 1 &&
      (st.descriptiveTextCount >= 1 || st.textOnlyCount >= Math.max(1, st.total * 0.35))
    ) {
      notesIndices.push(c);
      assignedCols.add(c);
    } else if (c >= dataStartCol && st.nums.length >= Math.max(1, st.total * 0.5)) {
      intCols.push(c);
    } else if (st.textOnlyCount > 0 || st.descriptiveTextCount > 0) {
      notesIndices.push(c);
      assignedCols.add(c);
    }
  }

  if (coordCols.length >= 2) {
    map['lat'] = coordCols[0];
    map['lon'] = coordCols[1];
  } else if (coordCols.length === 1) {
    map['lat'] = coordCols[0];
  }

  if (timeCols.length === 1) {
    map['ideal_time'] = timeCols[0];
  } else if (timeCols.length >= 2) {
    map['veltdn'] = timeCols[0];
    map['ideal_time'] = timeCols[timeCols.length - 1];
  }

  const timeColIdx = map['ideal_time'] ?? Infinity;
  const typeColIdx = map['type'] ?? Infinity;

  for (const c of intCols) {
    const st = colStats[c];
    // Column after IdealTime or Type with small positive integers -> Section (Trecho)
    if (c > Math.min(timeColIdx, typeColIdx) && st.maxNum <= 99 && st.minNum >= 0 && !('section' in map)) {
      map['section'] = c;
      continue;
    }

    // Column with values > 150 up to 360 (headings) -> CAP
    if (st.maxNum > 150 && st.maxNum <= 360 && !('cap' in map)) {
      map['cap'] = c;
      continue;
    }

    // Check variance between consecutive rows to distinguish CAP (jumps wildly) vs Speed (repeats across section)
    let sameCount = 0;
    for (let k = 1; k < st.nums.length; k++) {
      if (Math.abs(st.nums[k] - st.nums[k - 1]) <= 0.5) sameCount += 1;
    }
    const repeatRatio = st.nums.length > 1 ? sameCount / (st.nums.length - 1) : 1;

    if (repeatRatio < 0.35 && st.maxNum <= 360 && 'lat' in map && !('cap' in map)) {
      map['cap'] = c;
    } else if (st.maxNum <= 150 && !('veltdn' in map) && !('speed' in map) && c < timeColIdx) {
      if (st.nums.length >= 4 && repeatRatio < 0.25 && !('cap' in map)) {
        map['cap'] = c;
      } else {
        map['speed'] = c;
      }
    } else if (!('cap' in map) && st.maxNum <= 360) {
      map['cap'] = c;
    } else if (!('section' in map) && st.maxNum <= 99) {
      map['section'] = c;
    }
  }

  return { map, notesIndices };
}

export function parseRoadbookTxt(content: string, fileName = 'planilha.txt'): ParsedRoadbook {
  const cleanContent = content.replace(/^\uFEFF/, '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
  const rawLines = cleanContent.split('\n');
  let eventName = fileName.replace(/\.(txt|csv|tsv|nbp|zip)$/i, '');

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#')) continue;
    const candidate = trimmed.replace(/^#+\s*/, '').trim();
    if (
      candidate &&
      !candidate.toLowerCase().startsWith('gerado') &&
      !candidate.toLowerCase().startsWith('type:') &&
      !candidate.toLowerCase().startsWith('ideal_time')
    ) {
      eventName = candidate.split(' - ')[0].trim();
      break;
    }
  }

  const nonEmptyDataLines = rawLines.filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (t.startsWith('#')) return false;
    if (/^[-=_+\s|]+$/.test(t)) return false;
    return true;
  });

  if (nonEmptyDataLines.length === 0) {
    throw new Error('O arquivo está vazio ou não possui linhas válidas de planilha.');
  }

  const delimiter = detectDelimiter(nonEmptyDataLines);
  let headerMap: Record<string, number> | null = null;
  let notesIndices: number[] = [];
  const candidateDataRows: string[][] = [];

  for (const line of nonEmptyDataLines) {
    const cols = splitDelimitedLine(line, delimiter);
    if (cols.length < 3) continue;

    // Detect header row (never treat a row containing a timestamp as a header)
    const joinedLower = cols.join(' ').toLowerCase();
    const firstColNum = parseFlexNum(cols[0]);
    const hasRowTimeValue = cols.some((c) => parseIdealTimeToMs(c) !== null);
    if (
      !headerMap &&
      candidateDataRows.length === 0 &&
      Number.isNaN(firstColNum) &&
      !hasRowTimeValue &&
      (joinedLower.includes('tul') ||
        joinedLower.includes('km') ||
        joinedLower.includes('lat') ||
        joinedLower.includes('tempo') ||
        joinedLower.includes('vel') ||
        joinedLower.includes('ref') ||
        joinedLower.includes('dist') ||
        joinedLower.includes('obs'))
    ) {
      const candidateMap: Record<string, number> = {};
      const candNotes: number[] = [];
      cols.forEach((col, idx) => {
        const key = col
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '');
        if (
          key.includes('tul') ||
          key === 'ref' ||
          key === 'nro' ||
          key === 'num' ||
          key === 'numero' ||
          key === 'no' ||
          key === 'item'
        ) {
          candidateMap['tulipa'] = idx;
        } else if (
          key === 'totalkm' ||
          key === 'total_km' ||
          key === 'total' ||
          key === 'km' ||
          key === 'kmtotal' ||
          key === 'kmacum' ||
          key === 'kmfinal' ||
          key === 'disttotal' ||
          key === 'distanciatotal' ||
          key === 'distancia' ||
          key === 'distacum' ||
          key === 'dist' ||
          key === 'dtotal' ||
          key === 'acumulado' ||
          key === 'odometro' ||
          key === 'hodometro' ||
          key === 'hod' ||
          key === 'odo'
        ) {
          candidateMap['total_km'] = idx;
        } else if (
          key === 'inter' ||
          key === 'interkm' ||
          key === 'inter_km' ||
          key === 'parcial' ||
          key === 'parcialkm' ||
          key === 'kmparcial' ||
          key === 'distparcial' ||
          key === 'distparc' ||
          key === 'dif' ||
          key === 'diferenca' ||
          key === 'diferencakm' ||
          key === 'trechokm'
        ) {
          candidateMap['inter_km'] = idx;
        } else if (key === 'rawlat' || key === 'raw_lat') {
          candidateMap['raw_lat'] = idx;
        } else if (key === 'rawlon' || key === 'raw_lon') {
          candidateMap['raw_lon'] = idx;
        } else if (key === 'lat' || key === 'latitude') {
          candidateMap['lat'] = idx;
        } else if (key === 'lon' || key === 'lng' || key === 'longitude') {
          candidateMap['lon'] = idx;
        } else if (key === 'cap' || key === 'rumo' || key === 'azimute' || key === 'heading') {
          candidateMap['cap'] = idx;
        } else if (key === 'veltdn' || key === 'tdn') {
          candidateMap['veltdn'] = idx;
        } else if (
          key.includes('ideal') ||
          key === 'tempo' ||
          key === 'tempoideal' ||
          key === 'tideal' ||
          key === 'hora' ||
          key === 'horaideal' ||
          key === 'hrideal' ||
          key === 'tempototal' ||
          key === 'passagem' ||
          key === 'time'
        ) {
          candidateMap['ideal_time'] = idx;
        } else if (key === 'typ' || key === 'type' || key === 'tipo' || key === 'modo') {
          candidateMap['type'] = idx;
        } else if (key === 'sec' || key === 'section' || key === 'secao' || key === 'trecho') {
          candidateMap['section'] = idx;
        } else if (
          key.includes('vel') ||
          key.includes('media') ||
          key === 'vm' ||
          key === 'vmedia' ||
          key === 'pmm' ||
          key === 'speed'
        ) {
          candidateMap['speed'] = idx;
        } else if (
          key.includes('obs') ||
          key.includes('refer') ||
          key.includes('desc') ||
          key.includes('texto') ||
          key.includes('nota') ||
          key.includes('instru') ||
          key.includes('hist') ||
          key.includes('info') ||
          key.includes('coment') ||
          key.includes('detalh') ||
          key.includes('avis') ||
          key.includes('mensag') ||
          key.includes('anot') ||
          key.includes('orient') ||
          key.includes('comand') ||
          key.includes('rotul') ||
          key.includes('legend') ||
          key === 'msg' ||
          key === 'txt' ||
          /^txt\d+$/.test(key) ||
          /^l\d+$/.test(key) ||
          /^linha\d*$/.test(key) ||
          key === 'local' ||
          key === 'complemento' ||
          key === 'titulo' ||
          key === 'subtitulo' ||
          key === 'resumo' ||
          key === 'ponto' ||
          key === 'rua' ||
          key === 'via' ||
          key === 'sentido' ||
          key.startsWith('campo')
        ) {
          candNotes.push(idx);
        }
      });
      if (Object.keys(candidateMap).length >= 3) {
        headerMap = candidateMap;
        notesIndices = candNotes;
        continue;
      }
    }

    const firstClean = cols[0].replace(/^[\uFEFF#Tt]+/, '').trim();
    const looksLikeStartRow = /^(largada|inicio|início|start|partida)$/i.test(cols[0].trim());
    if (!Number.isFinite(parseInt(firstClean, 10)) && !looksLikeStartRow) continue;
    candidateDataRows.push(cols);
  }

  if (!headerMap && candidateDataRows.length > 0) {
    const inferred = inferHeaderlessColumnMap(candidateDataRows);
    headerMap = inferred.map;
    notesIndices = inferred.notesIndices;
  } else if (headerMap && notesIndices.length === 0 && candidateDataRows.length > 0) {
    // Fallback: detect any unmapped column containing descriptive Latin text (multi-word or single-word like PORTÃO/PARE)
    const mapped = new Set<number>(Object.values(headerMap));
    const maxC = candidateDataRows.reduce((m, r) => Math.max(m, r.length), 0);
    const sample = candidateDataRows.slice(0, 80);
    for (let c = 0; c < maxC; c++) {
      if (mapped.has(c)) continue;
      const hasDescriptive = sample.some((r) => {
        const val = (r[c] ?? '').trim();
        return (
          val.length >= 3 &&
          /[a-zA-ZÀ-ÿ]{3,}/.test(val) &&
          normalizeTypeToken(val) === '' &&
          !/^T\s*\d+$/i.test(val) &&
          !/^(?:true|false|null|n\/a)$/i.test(val) &&
          !/\.(?:png|jpe?g|gif|bmp|svg|webp)$/i.test(val) &&
          Number.isNaN(parseFlexNum(val)) &&
          parseIdealTimeToMs(val) === null &&
          !looksLikeGeoCoord(val)
        );
      });
      if (hasDescriptive) notesIndices.push(c);
    }
  }

  const tulipas: RoadbookTulipa[] = [];
  for (const cols of candidateDataRows) {
    const getCol = (field: string): string => {
      if (headerMap && field in headerMap) {
        return cols[headerMap[field]] ?? '';
      }
      return '';
    };

    const tulCell = (getCol('tulipa') || cols[0] || '').trim();
    const isStartLabel = /^(largada|inicio|início|start|partida)$/i.test(tulCell);
    const tulRaw = tulCell.replace(/^[\uFEFF#Tt]+/, '').trim();
    const parsedTul = parseInt(tulRaw, 10);
    const tulipaNum = Number.isFinite(parsedTul) ? parsedTul : isStartLabel ? 1 : NaN;
    if (!Number.isFinite(tulipaNum)) continue;

    const totalKmVal = parseFlexNum(getCol('total_km'));
    const interKmVal = parseFlexNum(getCol('inter_km'));
    const totalKm = Number.isFinite(totalKmVal) ? totalKmVal : 0;
    const interKm = Number.isFinite(interKmVal) ? interKmVal : 0;

    const latRawStr = getCol('lat');
    const lonRawStr = getCol('lon');
    const latParsed = latRawStr ? parseCoordinateValue(latRawStr) : null;
    const lonParsed = lonRawStr ? parseCoordinateValue(lonRawStr) : null;
    const lat = latParsed ?? 0;
    const lon = lonParsed ?? 0;

    const idealTimeStr = getCol('ideal_time');
    const idealTimeMs = parseIdealTimeToMs(idealTimeStr);
    const typeCell = getCol('type');
    const velTdnRawPre = getCol('veltdn') || getCol('speed');
    const hasNotes = notesIndices.some((ni) => Boolean((cols[ni] ?? '').trim()));

    if (
      latParsed === null &&
      lonParsed === null &&
      !Number.isFinite(totalKmVal) &&
      !Number.isFinite(interKmVal) &&
      !idealTimeStr.trim() &&
      !velTdnRawPre.trim() &&
      !typeCell.trim() &&
      !hasNotes
    ) {
      continue;
    }

    const rawLat = headerMap && 'raw_lat' in headerMap ? cols[headerMap['raw_lat']] : undefined;
    const rawLon = headerMap && 'raw_lon' in headerMap ? cols[headerMap['raw_lon']] : undefined;

    const capRaw = getCol('cap');
    const capVal = capRaw ? parseInt(capRaw, 10) : null;

    const parsedType = normalizeTypeToken(typeCell);
    const secRaw = getCol('section');
    const embeddedSec = extractEmbeddedSection(secRaw || typeCell);
    const section = secRaw
      ? (/^\d+$/.test(secRaw.trim()) ? parseInt(secRaw, 10) : embeddedSec)
      : embeddedSec;

    const velTdnRaw = getCol('veltdn') || getCol('speed');
    const parsedVelTdn = velTdnRaw ? parseVelTdnValue(velTdnRaw) : {};
    const type: TulipaType = parsedType || parsedVelTdn.typeHint || '';
    const tdnMsFromCol = parsedVelTdn.tdnMs ?? null;
    const speedVal = parsedVelTdn.avgSpeedKmh ?? undefined;

    const notesRaw =
      notesIndices.length > 0
        ? notesIndices
            .map((ni) => cols[ni] ?? '')
            .map((s) => s.trim())
            .filter(Boolean)
            .join('\n')
        : '';

    tulipas.push({
      tulipa: tulipaNum,
      totalKm,
      interKm,
      lat,
      lon,
      rawLat,
      rawLon,
      cap: capVal !== null && Number.isFinite(capVal) ? capVal : null,
      idealTimeStr: idealTimeStr.trim(),
      idealTimeMs,
      type,
      section: section !== null && Number.isFinite(section) ? section : null,
      avgSpeedKmh: speedVal ?? undefined,
      tdnMs: tdnMsFromCol,
      notes: notesRaw.trim() || undefined,
    });
  }

  if (tulipas.length === 0) {
    throw new Error(
      'Nenhuma tulipa válida encontrada. Verifique se o arquivo segue o padrão com colunas Tul, Distância/KM, Tempo e Tipo.'
    );
  }

  const countV = tulipas.filter((t) => t.type === 'V').length;
  const countD = tulipas.filter((t) => t.type === 'D').length;
  const countN = tulipas.filter((t) => t.type === 'N').length;
  const totalKm = tulipas[tulipas.length - 1]?.totalKm ?? 0;

  return {
    eventName,
    fileName,
    tulipas,
    countV,
    countD,
    countN,
    totalKm,
  };
}
