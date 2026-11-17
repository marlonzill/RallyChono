import JSZip from 'jszip';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import type {
  ParsedRoadbook,
  RoadbookRaceParameters,
  RoadbookTulipa,
  TulipaType,
} from '../types/rally';
import {
  inferHeaderlessColumnMap,
  normalizeTypeToken,
  parseCoordinateValue,
  parseIdealTimeToMs,
  parseRoadbookTxt,
  parseVelTdnValue,
  splitDelimitedLine,
} from './rallyParser';

export type ImportFormatHint = 'auto' | 'nbp' | 'bin' | 'rbk' | 'txt';

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: (file: string) =>
        typeof window === 'undefined' ? `./public/${file}` : `/${file}`,
    }).catch((err) => {
      sqlJsPromise = null;
      throw err;
    });
  }
  return sqlJsPromise;
}

interface ZipImageEntry {
  dataUrl: string;
  normPath: string;
  baseName: string;
  stem: string;
  width: number;
  height: number;
}

interface ZipImageIndex {
  byFullPath: Map<string, string>;
  byBaseName: Map<string, string>;
  byStem: Map<string, string>;
  byNumber: Map<number, string>;
  byNumberList: Map<number, ZipImageEntry[]>;
  entries: ZipImageEntry[];
}

const IMAGE_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

function normalizeType(raw: string): TulipaType {
  const u = raw.trim().toUpperCase();
  if (u === 'D' || u === 'DES' || u === 'DESLOCAMENTO' || u === 'DESLOC') return 'D';
  if (
    u === 'V' ||
    u === 'VEL' ||
    u === 'VELOCIDADE' ||
    u === 'MEDIA' ||
    u === 'MÉDIA' ||
    u === 'PC'
  ) {
    return 'V';
  }
  if (
    u === 'N' ||
    u === 'NEU' ||
    u === 'NEUTRALIZACAO' ||
    u === 'NEUTRALIZAÇÃO' ||
    u === 'NEUTRO' ||
    u === 'P' ||
    u === 'PARADA'
  ) {
    return 'N';
  }
  return '';
}

function formatMsToIdealStr(ms: number): string {
  const totalSec = Math.max(0, ms) / 1000;
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = Math.floor(totalSec % 60);
  const cc = Math.floor((Math.max(0, ms) % 1000) / 10);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
}

function parseFlexibleTimeToMs(raw: string, unitHint?: 'ms' | 'sec'): number | null {
  const clean = raw.trim();
  if (!clean) return null;

  const hms = parseIdealTimeToMs(clean);
  if (hms !== null) return hms;

  // Support MM:SS or MM.SS with optional centiseconds
  const mmss = clean.match(/^(\d{1,3})[:.](\d{2})(?:[.,](\d{1,3}))?$/);
  if (mmss) {
    const minutes = parseInt(mmss[1], 10);
    const seconds = parseInt(mmss[2], 10);
    if (minutes < 60 && seconds < 60) {
      const fracStr = mmss[3] ?? '0';
      const fracMs =
        fracStr.length === 1
          ? parseInt(fracStr, 10) * 100
          : fracStr.length === 2
            ? parseInt(fracStr, 10) * 10
            : parseInt(fracStr.slice(0, 3), 10);
      return (minutes * 60 + seconds) * 1000 + fracMs;
    }
  }

  // Numeric seconds or ms if unit hint provided
  const num = Number(clean.replace(',', '.'));
  if (Number.isFinite(num) && num >= 0 && unitHint) {
    return unitHint === 'ms' ? Math.round(num) : Math.round(num * 1000);
  }

  return null;
}

function parseFlexNumber(raw: string): number | null {
  const clean = raw.trim();
  if (!clean) return null;
  // Handle Brazilian decimal comma when there's no dot, or 1.234,56
  let normalized = clean.replace(/\s+/g, '');
  if (/^\-?\d{1,3}(\.\d{3})+,\d+$/.test(normalized)) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = normalized.replace(',', '.');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseImageDimensionsFromBytes(
  bytes: Uint8Array,
  ext: string
): { width: number; height: number } {
  try {
    // GIF87a / GIF89a: little-endian uint16 at bytes 6..9
    if (
      bytes.length >= 10 &&
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46
    ) {
      return {
        width: bytes[6] | (bytes[7] << 8),
        height: bytes[8] | (bytes[9] << 8),
      };
    }

    // PNG: big-endian uint32 in IHDR at bytes 16..23
    if (
      bytes.length >= 24 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        width: view.getUint32(16, false),
        height: view.getUint32(20, false),
      };
    }

    // BMP: little-endian int32 at bytes 18..25
    if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        width: Math.abs(view.getInt32(18, true)),
        height: Math.abs(view.getInt32(22, true)),
      };
    }

    // JPEG: scan SOF0/1/2/3 markers
    if (
      (ext === 'jpg' || ext === 'jpeg' || (bytes[0] === 0xff && bytes[1] === 0xd8)) &&
      bytes.length >= 12
    ) {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = bytes[i + 1];
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x00) {
          i += 2;
          continue;
        }
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          return {
            height: (bytes[i + 5] << 8) | bytes[i + 6],
            width: (bytes[i + 7] << 8) | bytes[i + 8],
          };
        }
        const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
        if (segLen < 2) break;
        i += 2 + segLen;
      }
    }
  } catch {
    // Ignore malformed image header
  }
  return { width: 0, height: 0 };
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function extractTulipaNumberFromImagePath(normPath: string, stem: string): number | null {
  // Ignore T15 banner/cover files like REF0_0.GIF
  if (/^(?:ref0+[_-]0+|0+[_-]0+|capa|cover|logo|banner|header|fundo)$/i.test(stem)) {
    return null;
  }

  const refUnderMatch = stem.match(/^ref0+[_-]0*(\d{1,4})$/i);
  if (refUnderMatch) {
    const n = parseInt(refUnderMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  const prefixed = stem.match(
    /^(?:ref|obs|observ|des|desenho|tul(?:ipa)?|img|fig|txt|text|nota|info|cmd|seta|pic|foto)[_-]?0*(\d{1,4})(?:[_-]?(?:obs|observ|des|desenho|tul|txt|nota|info|a|b|d|o|1|2))?$/i
  );
  if (prefixed) {
    const n = parseInt(prefixed[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  const pureOrSuffix = stem.match(
    /^0*(\d{1,4})(?:[_-]?(?:obs|observ|des|desenho|tul|txt|nota|info|a|b|d|o|1|2))?$/i
  );
  if (pureOrSuffix) {
    const n = parseInt(pureOrSuffix[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  const tailMatch = stem.match(/(?:^|[_-])0*(\d{1,4})$/i);
  if (tailMatch) {
    const n = parseInt(tailMatch[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  // Fallback to parent directory name if stem is generic (e.g. 0026/obs.gif)
  const parts = normPath.split('/');
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2];
    const dirMatch = parent.match(/^(?:ref|tul(?:ipa)?)?[_-]?0*(\d{1,4})$/i);
    if (dirMatch) {
      const n = parseInt(dirMatch[1], 10);
      return Number.isFinite(n) ? n : null;
    }
  }

  return null;
}

function isObservationImagePath(normPath: string): boolean {
  return /(?:^|[/._-])(obs|observ|observacao|txt|text|nota|notas|info|msg|hist|com|desc)(?:[/._-\d]|$)/i.test(
    normPath
  );
}

function isDrawingImagePath(normPath: string): boolean {
  return /(?:^|[/._-])(des|desenho|tul|tulipa|fig|seta|dir|icon)(?:[/._-\d]|$)/i.test(
    normPath
  );
}

function resolveZipImagePairForTulipa(
  zipImages: ZipImageIndex | undefined,
  tulipaNum: number,
  explicitRef?: string
): {
  imageDataUrl?: string;
  notesImageDataUrl?: string;
  imageIsComposite?: boolean;
} {
  if (!zipImages) return {};

  const candidates = [...(zipImages.byNumberList?.get(tulipaNum) ?? [])];
  if (explicitRef) {
    const norm = explicitRef.trim().replace(/\\/g, '/').toLowerCase();
    const matchedUrl =
      zipImages.byFullPath.get(norm) ??
      zipImages.byBaseName.get(norm.split('/').pop() || norm) ??
      zipImages.byStem.get((norm.split('/').pop() || norm).replace(/\.[^.]+$/, ''));
    if (matchedUrl && !candidates.some((c) => c.dataUrl === matchedUrl)) {
      const foundEntry = zipImages.entries.find((e) => e.dataUrl === matchedUrl);
      if (foundEntry) candidates.unshift(foundEntry);
      else {
        return { imageDataUrl: matchedUrl };
      }
    }
  }

  if (candidates.length === 0) {
    const fallback = lookupZipImage(zipImages, tulipaNum, explicitRef);
    return fallback ? { imageDataUrl: fallback } : {};
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    const isComposite =
      only.width > 0 && only.height > 0 && only.width >= only.height * 1.55;
    if (isObservationImagePath(only.normPath) && !isDrawingImagePath(only.normPath)) {
      return { notesImageDataUrl: only.dataUrl };
    }
    return {
      imageDataUrl: only.dataUrl,
      imageIsComposite: isComposite || undefined,
    };
  }

  // 2+ images for this tulipa: separate Desenho vs Observação by path hints or aspect ratio
  const obsNamed = candidates.find((c) => isObservationImagePath(c.normPath));
  const desNamed = candidates.find(
    (c) => c !== obsNamed && isDrawingImagePath(c.normPath)
  );

  if (obsNamed && desNamed) {
    return {
      imageDataUrl: desNamed.dataUrl,
      notesImageDataUrl: obsNamed.dataUrl,
    };
  }
  if (obsNamed) {
    const other = candidates.find((c) => c !== obsNamed) ?? candidates[0];
    return {
      imageDataUrl: other.dataUrl,
      notesImageDataUrl: obsNamed.dataUrl,
    };
  }

  // Sort by aspect ratio ascending: square/portrait = Desenho, wider horizontal strip = Observação
  const sortedByAspect = [...candidates].sort((a, b) => {
    const arA = a.width > 0 && a.height > 0 ? a.width / a.height : 1;
    const arB = b.width > 0 && b.height > 0 ? b.width / b.height : 1;
    return arA - arB;
  });
  const first = sortedByAspect[0];
  const last = sortedByAspect[sortedByAspect.length - 1];
  return {
    imageDataUrl: first.dataUrl,
    notesImageDataUrl: last !== first ? last.dataUrl : undefined,
  };
}

function resolveInlineOrZipImage(
  zipImages: ZipImageIndex | undefined,
  tulipaNum: number,
  explicitRef?: string
): string | undefined {
  if (explicitRef) {
    const trimmed = explicitRef.trim();
    if (trimmed.startsWith('data:image/')) return trimmed;
    if (trimmed.startsWith('<svg')) {
      return `data:image/svg+xml;utf8,${encodeURIComponent(trimmed)}`;
    }
    if (trimmed.length > 64 && /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|Qk[0-9A-Za-z+/])/.test(trimmed)) {
      const mime = trimmed.startsWith('iVBOR')
        ? 'image/png'
        : trimmed.startsWith('/9j/')
          ? 'image/jpeg'
          : trimmed.startsWith('R0lGOD')
            ? 'image/gif'
            : 'image/bmp';
      return `data:${mime};base64,${trimmed}`;
    }
  }
  return lookupZipImage(zipImages, tulipaNum, explicitRef);
}

function lookupZipImage(
  zipImages: ZipImageIndex | undefined,
  tulipaNum: number,
  explicitRef?: string
): string | undefined {
  if (!zipImages) return undefined;
  if (explicitRef) {
    const norm = explicitRef.trim().replace(/\\/g, '/').toLowerCase();
    if (zipImages.byFullPath.has(norm)) return zipImages.byFullPath.get(norm);
    const base = norm.split('/').pop() || norm;
    if (zipImages.byBaseName.has(base)) return zipImages.byBaseName.get(base);
    const stem = base.replace(/\.[^.]+$/, '');
    if (zipImages.byStem.has(stem)) return zipImages.byStem.get(stem);
  }
  if (zipImages.byNumber.has(tulipaNum)) {
    return zipImages.byNumber.get(tulipaNum);
  }
  return undefined;
}

function applyZipImagesToRoadbook(
  roadbook: ParsedRoadbook,
  zipImages?: ZipImageIndex
): ParsedRoadbook {
  if (!zipImages || zipImages.byFullPath.size === 0) return roadbook;
  return {
    ...roadbook,
    tulipas: roadbook.tulipas.map((t) => {
      const pair = resolveZipImagePairForTulipa(zipImages, t.tulipa);
      const nextImage = t.imageDataUrl ?? pair.imageDataUrl;
      const nextNotesImg = t.notesImageDataUrl ?? pair.notesImageDataUrl;
      const nextComposite =
        t.imageIsComposite !== undefined
          ? t.imageIsComposite
          : nextNotesImg
            ? false
            : pair.imageIsComposite;
      if (
        nextImage === t.imageDataUrl &&
        nextNotesImg === t.notesImageDataUrl &&
        nextComposite === t.imageIsComposite
      ) {
        return t;
      }
      return {
        ...t,
        imageDataUrl: nextImage,
        notesImageDataUrl: nextNotesImg,
        imageIsComposite: nextComposite,
      };
    }),
  };
}

/**
 * Computes segment speeds (km/h) and fills missing ideal times if speed + distance are present.
 */
export function enrichRoadbookForNavigation(roadbook: ParsedRoadbook): ParsedRoadbook {
  const tulipas = roadbook.tulipas.map((t) => ({ ...t }));

  // 1. Auto-detect meter-scaled distances exported by integer roadbook tools (e.g. 150, 270, 1290 -> 0.15, 0.27, 1.29 km)
  const nonZeroTotals = tulipas.map((t) => t.totalKm).filter((v) => v > 0);
  const maxTotal = nonZeroTotals.length > 0 ? Math.max(...nonZeroTotals) : 0;
  const hasTotalDecimals = nonZeroTotals.some((v) => Math.abs(v - Math.round(v)) > 0.001);

  // Guard: never treat ascending +1 sequential row counters (1, 2, 3...) as meters
  let seqPlusOneSteps = 0;
  for (let i = 1; i < nonZeroTotals.length; i++) {
    if (Math.abs(nonZeroTotals[i] - nonZeroTotals[i - 1] - 1) < 0.001 && Number.isInteger(nonZeroTotals[i])) {
      seqPlusOneSteps += 1;
    }
  }
  const looksLikeRowCounter = nonZeroTotals.length >= 5 && seqPlusOneSteps / (nonZeroTotals.length - 1) >= 0.8;

  // Check speed*time sanity with strict majority voting across pairs so a single accidental pair cannot rescale whole roadbook
  let impliedMetersEvidence = false;
  if (!hasTotalDecimals && !looksLikeRowCounter && maxTotal >= 50) {
    let meterVotes = 0;
    let kmVotes = 0;
    for (let i = 1; i < tulipas.length; i++) {
      const a = tulipas[i - 1];
      const b = tulipas[i];
      if (a.idealTimeMs !== null && b.idealTimeMs !== null && a.avgSpeedKmh && a.avgSpeedKmh > 0) {
        const dtH = (b.idealTimeMs - a.idealTimeMs) / 3600000;
        const rawDiff = b.totalKm - a.totalKm;
        if (dtH > 0 && rawDiff > 0) {
          const expectedKm = a.avgSpeedKmh * dtH;
          if (expectedKm > 0) {
            const errMeters = Math.abs(rawDiff / 1000 - expectedKm);
            const errKm = Math.abs(rawDiff - expectedKm);
            if (errMeters < errKm * 0.1) meterVotes += 1;
            else if (errKm < errMeters * 0.1) kmVotes += 1;
          }
        }
      }
    }
    if (meterVotes >= 3 && meterVotes > kmVotes * 2) {
      impliedMetersEvidence = true;
    }
  }
  if (!hasTotalDecimals && !looksLikeRowCounter && (maxTotal >= 500 || impliedMetersEvidence)) {
    for (const t of tulipas) {
      t.totalKm = Number((t.totalKm / 1000).toFixed(3));
    }
  }

  const nonZeroInters = tulipas.map((t) => t.interKm).filter((v) => v > 0);
  const maxInter = nonZeroInters.length > 0 ? Math.max(...nonZeroInters) : 0;
  const hasInterDecimals = nonZeroInters.some((v) => Math.abs(v - Math.round(v)) > 0.001);
  if (!hasInterDecimals && (maxInter >= 200 || impliedMetersEvidence)) {
    for (const t of tulipas) {
      t.interKm = Number((t.interKm / 1000).toFixed(3));
    }
  }

  // 2. Preserve printed section distance (displayKm), mark odometer resets, and build continuous totalKm
  const hasPrecomputedDisplayKm =
    tulipas.length > 0 && tulipas.every((t) => t.displayKm !== undefined);
  let accKm = 0;
  const hasAnyTotal = tulipas.some((t) => t.totalKm > 0);
  if (hasPrecomputedDisplayKm) {
    // Already resolved by T15 .tpl parser (including exact end-of-section reset offsets)
  } else if (!hasAnyTotal && tulipas.some((t) => t.interKm > 0)) {
    for (let i = 0; i < tulipas.length; i++) {
      accKm += tulipas[i].interKm;
      const km3 = Number(accKm.toFixed(3));
      tulipas[i].totalKm = km3;
      tulipas[i].displayKm = km3;
    }
    if (tulipas.length > 0) tulipas[0].resetsOdometer = true;
  } else {
    let resetOffset = 0;
    let prevRawKm = tulipas[0]?.totalKm ?? 0;
    if (tulipas.length > 0) {
      tulipas[0].resetsOdometer = true;
    }
    for (let i = 0; i < tulipas.length; i++) {
      const rawKm = tulipas[i].totalKm;
      tulipas[i].displayKm = Number(rawKm.toFixed(3));
      if (i > 0 && rawKm + 0.05 < prevRawKm && (rawKm <= 1.0 || prevRawKm - rawKm > 0.5)) {
        tulipas[i - 1].resetsOdometer = true;
        resetOffset += prevRawKm;
      }
      prevRawKm = rawKm;
      tulipas[i].totalKm = Number((resetOffset + rawKm).toFixed(3));

      if (i > 0) {
        const diffKm = Number(Math.max(0, tulipas[i].totalKm - tulipas[i - 1].totalKm).toFixed(3));
        if (tulipas[i].interKm <= 0 && diffKm > 0) {
          tulipas[i].interKm = diffKm;
        }
      }
    }

    // Reconcile files where `interKm` represents OUTGOING segment distance (`totalKm[i+1] - totalKm[i]`)
    // instead of incoming distance from `tulipa[i-1]` to `tulipa[i]`
    if (tulipas.length >= 4) {
      let incomingMatches = 0;
      let outgoingMatches = 0;
      let comparable = 0;
      for (let i = 1; i < tulipas.length - 1; i++) {
        const interVal = tulipas[i].interKm;
        if (interVal <= 0) continue;
        const inDiff = Math.max(0, tulipas[i].totalKm - tulipas[i - 1].totalKm);
        const outDiff = Math.max(0, tulipas[i + 1].totalKm - tulipas[i].totalKm);
        comparable += 1;
        if (Math.abs(interVal - inDiff) <= 0.015) incomingMatches += 1;
        if (Math.abs(interVal - outDiff) <= 0.015) outgoingMatches += 1;
      }
      if (comparable >= 3 && outgoingMatches > incomingMatches * 1.5 && outgoingMatches >= comparable * 0.5) {
        if (tulipas[0].totalKm === 0) {
          tulipas[0].interKm = 0;
        }
        for (let i = 1; i < tulipas.length; i++) {
          tulipas[i].interKm = Number(
            Math.max(0, tulipas[i].totalKm - tulipas[i - 1].totalKm).toFixed(3)
          );
        }
      }
    }
  }

  // 2b. Propagate empty intermediate row types (e.g. blank Vel/TDN rows continuing a V or D block)
  for (let i = 0; i < tulipas.length; i++) {
    const curr = tulipas[i];
    if (!curr.type) {
      if (curr.avgSpeedKmh && curr.avgSpeedKmh > 0) {
        curr.type = 'V';
      } else if (curr.tdnMs && curr.tdnMs > 0) {
        curr.type = 'D';
      } else if (i > 0 && tulipas[i - 1].type) {
        curr.type = tulipas[i - 1].type;
      }
    }
  }

  // 3. Forward-fill idealTimeMs (including from speed*distance or TDN duration) and fill missing speeds
  let runningTimeMs = tulipas[0]?.idealTimeMs ?? 0;
  if (tulipas.length > 0 && tulipas[0].idealTimeMs === null) {
    tulipas[0].idealTimeMs = 0;
    tulipas[0].idealTimeStr = '00:00:00.00';
  }

  for (let i = 0; i < tulipas.length; i++) {
    const curr = tulipas[i];
    const prev = i > 0 ? tulipas[i - 1] : null;

    // Guard against trailing `00.00.00` placeholder timestamps after a timed/TDN row
    if (
      i > 0 &&
      prev &&
      curr.idealTimeMs === 0 &&
      (runningTimeMs > 0 ||
        (prev.tdnMs && prev.tdnMs > 0) ||
        (prev.type === 'V' && curr.totalKm > prev.totalKm))
    ) {
      curr.idealTimeMs = null;
    }

    if (curr.idealTimeMs === null && i > 0 && prev) {
      const segKm = Math.max(0, curr.totalKm - prev.totalKm) || curr.interKm;
      if (prev.type === 'V' && prev.avgSpeedKmh && prev.avgSpeedKmh > 0 && segKm > 0) {
        runningTimeMs += Math.round((segKm / prev.avgSpeedKmh) * 3600000);
      } else if ((prev.type === 'D' || prev.type === 'N') && prev.tdnMs && prev.tdnMs > 0) {
        runningTimeMs += prev.tdnMs;
      }
      curr.idealTimeMs = runningTimeMs;
      curr.idealTimeStr = formatMsToIdealStr(runningTimeMs);
    } else if (curr.idealTimeMs !== null) {
      runningTimeMs = curr.idealTimeMs;
      if (!curr.idealTimeStr) {
        curr.idealTimeStr = formatMsToIdealStr(runningTimeMs);
      }
    }
  }

  for (let i = 0; i < tulipas.length; i++) {
    const curr = tulipas[i];
    const prev = i > 0 ? tulipas[i - 1] : null;
    const next = tulipas[i + 1];

    if (curr.type === 'N') {
      curr.avgSpeedKmh = 0;
      continue;
    }

    if (curr.type === 'D') {
      if (curr.avgSpeedKmh === undefined) {
        curr.avgSpeedKmh = null;
      }
      continue;
    }

    // Inside V segments, ensure tdnMs is not misread as D/N wait duration
    if (curr.type === 'V') {
      curr.tdnMs = null;
    }

    if (curr.avgSpeedKmh === undefined || curr.avgSpeedKmh === null) {
      const sameSectionNext =
        next &&
        next.type === 'V' &&
        (curr.section === null || next.section === null || curr.section === next.section);

      if (sameSectionNext && curr.idealTimeMs !== null && next.idealTimeMs !== null) {
        const deltaKm = Math.max(0, next.totalKm - curr.totalKm);
        const deltaMs = next.idealTimeMs - curr.idealTimeMs;
        if (deltaKm >= 0.015 && deltaMs > 0) {
          const kmh = deltaKm / (deltaMs / 3600000);
          if (kmh >= 5 && kmh <= 160) {
            curr.avgSpeedKmh = Number(kmh.toFixed(1));
          }
        }
      }

      if (
        (curr.avgSpeedKmh === undefined || curr.avgSpeedKmh === null) &&
        prev &&
        prev.type === 'V' &&
        prev.avgSpeedKmh &&
        (curr.section === null || prev.section === null || curr.section === prev.section)
      ) {
        curr.avgSpeedKmh = prev.avgSpeedKmh;
      } else if (
        (curr.avgSpeedKmh === undefined || curr.avgSpeedKmh === null) &&
        next &&
        curr.idealTimeMs !== null &&
        next.idealTimeMs !== null
      ) {
        const deltaKm = Math.max(0, next.totalKm - curr.totalKm);
        const deltaMs = next.idealTimeMs - curr.idealTimeMs;
        if (deltaKm > 0 && deltaMs > 0) {
          const kmh = deltaKm / (deltaMs / 3600000);
          if (kmh >= 5 && kmh <= 160) {
            curr.avgSpeedKmh = Number(kmh.toFixed(1));
          }
        }
      }
    }
  }

  // 4. Compute contiguous block start/end/duration & TDN for Deslocamento (D) and Neutralização (N)
  let idx = 0;
  while (idx < tulipas.length) {
    const t = tulipas[idx];
    if (t.type !== 'D' && t.type !== 'N') {
      idx += 1;
      continue;
    }

    const blockType = t.type;
    const blockSec = t.section;
    let endIdx = idx;
    while (
      endIdx + 1 < tulipas.length &&
      tulipas[endIdx + 1].type === blockType &&
      (blockSec === null ||
        tulipas[endIdx + 1].section === null ||
        tulipas[endIdx + 1].section === blockSec)
    ) {
      endIdx += 1;
    }

    const startMs = tulipas[idx].idealTimeMs ?? 0;
    let maxBlockMs = startMs;
    for (let k = idx; k <= endIdx; k++) {
      const kt = tulipas[k].idealTimeMs;
      if (kt !== null && kt > maxBlockMs) {
        maxBlockMs = kt;
      }
    }
    const nextAfterMs = tulipas[endIdx + 1]?.idealTimeMs ?? null;
    const endMs =
      nextAfterMs !== null && nextAfterMs > maxBlockMs ? nextAfterMs : maxBlockMs;
    const explicitStartTdn = tulipas[idx].tdnMs ?? null;
    const durationMs =
      endMs - startMs > 0
        ? endMs - startMs
        : explicitStartTdn !== null && explicitStartTdn > 0
          ? explicitStartTdn
          : 0;

    for (let k = idx; k <= endIdx; k++) {
      tulipas[k].sectionStartTimeMs = startMs;
      tulipas[k].sectionEndTimeMs = endMs > startMs ? endMs : startMs + durationMs;
      tulipas[k].sectionDurationMs = durationMs;
      if (
        tulipas[k].tdnMs === undefined ||
        tulipas[k].tdnMs === null ||
        (k === idx && tulipas[k].tdnMs === 0 && durationMs > 0)
      ) {
        tulipas[k].tdnMs = k === idx ? durationMs : 0;
      }
    }

    idx = endIdx + 1;
  }

  const distinctSpeeds = Array.from(
    new Set(
      tulipas
        .filter((t) => t.type === 'V' && t.avgSpeedKmh !== null && t.avgSpeedKmh !== undefined && t.avgSpeedKmh > 0)
        .map((t) => Math.round((t.avgSpeedKmh as number) * 10) / 10)
    )
  ).sort((a, b) => a - b);

  const distinctSections = new Set<number>();
  let blockCount = 0;
  let prevType: TulipaType | null = null;
  let prevSec: number | null = null;
  for (const t of tulipas) {
    if (t.section !== null && Number.isFinite(t.section)) {
      distinctSections.add(t.section);
    }
    if (t.type !== prevType || t.section !== prevSec) {
      blockCount += 1;
      prevType = t.type;
      prevSec = t.section;
    }
  }

  const validTimes = tulipas
    .map((t) => t.idealTimeMs)
    .filter((ms): ms is number => ms !== null && Number.isFinite(ms));
  const estimatedDurationMs =
    validTimes.length >= 2
      ? Math.max(0, validTimes[validTimes.length - 1] - validTimes[0])
      : null;

  const raceParameters: RoadbookRaceParameters = {
    category: roadbook.raceParameters?.category,
    estimatedDurationMs,
    speedsKmh: distinctSpeeds,
    notesCount: tulipas.filter((t) =>
      Boolean((t.notes && t.notes.trim()) || t.notesImageDataUrl || t.imageIsComposite)
    ).length,
    sectionsCount: distinctSections.size > 0 ? distinctSections.size : blockCount,
    imagesCount: tulipas.filter((t) => Boolean(t.imageDataUrl || t.notesImageDataUrl)).length,
    rawHeaderLines: roadbook.raceParameters?.rawHeaderLines,
  };

  return {
    ...roadbook,
    sourceFormat: roadbook.sourceFormat ?? 'TXT',
    convertedAtMs: roadbook.convertedAtMs ?? Date.now(),
    tulipas,
    countV: tulipas.filter((t) => t.type === 'V').length,
    countD: tulipas.filter((t) => t.type === 'D').length,
    countN: tulipas.filter((t) => t.type === 'N').length,
    totalKm: tulipas[tulipas.length - 1]?.totalKm ?? 0,
    raceParameters,
  };
}

const NOTE_FIELD_KEYS = [
  'obs1',
  'obs2',
  'obs3',
  'obs4',
  'obs_1',
  'obs_2',
  'obs_3',
  'obs_4',
  'obslinha1',
  'obslinha2',
  'obslinha3',
  'obslinha4',
  'obs_linha1',
  'obs_linha2',
  'obs_linha3',
  'obs_linha4',
  'obslinha_1',
  'obslinha_2',
  'obslinha_3',
  'obslinha_4',
  'obs_texto',
  'observacao_texto',
  'observacoes_texto',
  'observacoes_obs',
  'observacao1',
  'observacao2',
  'observacao3',
  'observacao4',
  'obs',
  'observacao',
  'observacoes',
  'obstexto',
  'textoobs',
  'texto_obs',
  'obstext',
  'txtobs',
  'referencia',
  'reftexto',
  'ref_obs',
  'ref1',
  'ref2',
  'ref3',
  'ref4',
  'linha1',
  'linha2',
  'linha3',
  'linha4',
  'linha',
  'l1',
  'l2',
  'l3',
  'l4',
  'texto1',
  'texto2',
  'texto3',
  'texto4',
  'texto',
  'txt1',
  'txt2',
  'txt3',
  'txt4',
  'txt',
  'text',
  'descricao',
  'description',
  'desc1',
  'desc2',
  'desc3',
  'desc4',
  'desc',
  'instrucao',
  'comando',
  'orientacao',
  'rotulo',
  'historico',
  'hist',
  'info',
  'info1',
  'info2',
  'informacao',
  'informacoes',
  'comentario',
  'comentarios',
  'comment',
  'comments',
  'remark',
  'memo',
  'complemento',
  'complemento1',
  'complemento2',
  'rua',
  'via',
  'endereco',
  'logradouro',
  'sentido',
  'nota',
  'notas',
  'note',
  'notes',
  'anotacao',
  'anotacoes',
  'legenda',
  'caption',
  'dica',
  'aviso',
  'alerta',
  'perigo',
  'mensagem',
  'msg',
  'msg1',
  'msg2',
  'local',
  'localizacao',
  'pontoref',
  'ponto',
  'detalhe',
  'detalhes',
  'titulo',
  'subtitulo',
  'resumo',
  'conteudo',
  'item_texto',
  'campo1',
  'campo2',
  'campo3',
  'campo4',
  'string',
  'name',
];

function collectNoteLines(lookup: (key: string) => string): string | undefined {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const key of NOTE_FIELD_KEYS) {
    const val = lookup(key).trim();
    if (val && !seen.has(val.toLowerCase())) {
      seen.add(val.toLowerCase());
      parts.push(val);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

const RESERVED_NON_NOTE_KEY_RE = /^(id|seq|ordem|tulipa|tul|num|numero|nro|km|totalkm|kmtotal|interkm|parcial|dist|distancia|hod|odo|lat|lon|lng|cap|rumo|tempo|hora|ideal|vel|velocidade|media|vm|pmm|tdn|veltdn|tipo|type|typ|sec|secao|section|trecho|img|imagem|figura|arquivo|icon|desenho|blob|cor|color|created|updated|ativo|active|ok|status)$/i;

function isLikelyNoteText(str: string): boolean {
  const trimmed = str.trim();
  if (trimmed.length < 3) return false;
  if (!/[a-zA-ZÀ-ÿ]{3,}/.test(trimmed)) return false;
  if (normalizeTypeToken(trimmed) !== '') return false;
  if (/^T\s*\d+$/i.test(trimmed)) return false;
  if (/^(?:true|false|null|undefined|n\/a|sim|nao|não)$/i.test(trimmed)) return false;
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) return false;
  if (/\.(?:png|jpe?g|gif|bmp|svg|webp|xml|txt|nbp|zip)$/i.test(trimmed)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(trimmed)) return false;
  if (parseIdealTimeToMs(trimmed) !== null) return false;
  if (parseCoordinateValue(trimmed) !== null) return false;
  if (parseFlexNumber(trimmed) !== null) return false;
  return true;
}

function collectNotesWithFallback(
  lookup: (key: string) => string,
  entries: Array<[string, unknown]>
): string | undefined {
  const direct = collectNoteLines(lookup);
  if (direct) return direct;

  const extra: string[] = [];
  const seen = new Set<string>();
  for (const [rawKey, rawVal] of entries) {
    if (rawVal === null || rawVal === undefined || typeof rawVal === 'object') continue;
    const str = String(rawVal).trim();
    if (!str || str.length < 2) continue;
    const nk = normKey(rawKey);
    if (!nk || RESERVED_NON_NOTE_KEY_RE.test(nk)) continue;
    const keyLooksLikeNote = /(obs|desc|text|txt|nota|linha|hist|info|coment|compl|local|rua|via|avis|alert|perig|msg|anot|titul|resum|sentid|ender|refer|orient|comand|rotul|legend|memo|remark)/i.test(nk);
    const valLooksLikeText = isLikelyNoteText(str);
    if (keyLooksLikeNote || valLooksLikeText) {
      const low = str.toLowerCase();
      if (!seen.has(low)) {
        seen.add(low);
        extra.push(str);
      }
    }
  }
  return extra.length > 0 ? extra.join('\n') : undefined;
}

function normKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function getCaseInsensitiveProp(obj: Record<string, unknown>, keys: string[]): unknown {
  const lowerMap = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) {
    lowerMap.set(normKey(k), v);
  }
  for (const candidate of keys) {
    const norm = normKey(candidate);
    if (lowerMap.has(norm)) {
      const val = lowerMap.get(norm);
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        return val;
      }
    }
  }
  return undefined;
}

function findBestObjectArrayInJson(node: unknown, depth = 0): unknown[] {
  if (depth > 5 || !node || typeof node !== 'object') return [];
  if (Array.isArray(node)) {
    const objItems = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objItems.length >= 2) {
      const sample = objItems[0] as Record<string, unknown>;
      const hasRoadbookKey =
        getCaseInsensitiveProp(sample, [
          'tulipa',
          'tul',
          'totalkm',
          'km',
          'disttotal',
          'tempo',
          'idealtime',
          'tempoideal',
          'velocidade',
          'media',
          'lat',
          'latitude',
          'interkm',
          'parcial',
        ]) !== undefined;
      if (hasRoadbookKey) return objItems;
    }
    return [];
  }

  let best: unknown[] = [];
  for (const val of Object.values(node as Record<string, unknown>)) {
    const candidate = findBestObjectArrayInJson(val, depth + 1);
    if (candidate.length > best.length) {
      best = candidate;
    }
  }
  return best;
}

function tryParseJsonRoadbook(
  text: string,
  fileName: string,
  zipImages?: ZipImageIndex
): ParsedRoadbook | null {
  let trimmed = text.replace(/\u0000/g, '').trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const firstObj = trimmed.indexOf('{');
    const firstArr = trimmed.indexOf('[');
    const startIdx =
      firstObj >= 0 && firstArr >= 0
        ? Math.min(firstObj, firstArr)
        : Math.max(firstObj, firstArr);
    if (startIdx >= 0 && startIdx < 512) {
      trimmed = trimmed.slice(startIdx);
    } else {
      return null;
    }
  }

  try {
    const data = JSON.parse(trimmed);
    const items = findBestObjectArrayInJson(data);
    if (items.length === 0) return null;

    const tulipas: RoadbookTulipa[] = [];
    items.forEach((rawItem, idx) => {
      if (!rawItem || typeof rawItem !== 'object') return;
      const obj = rawItem as Record<string, unknown>;

      const numRaw = getCaseInsensitiveProp(obj, ['tulipa', 'tul', 'numero', 'num', 'id', 'ordem', 'seq']);
      const num = numRaw !== undefined ? Number(numRaw) : idx + 1;

      const kmRaw = getCaseInsensitiveProp(obj, [
        'totalkm',
        'kmtotal',
        'km',
        'disttotal',
        'distanciatotal',
        'odometro',
      ]);
      const metersRaw = getCaseInsensitiveProp(obj, ['totalm', 'distm', 'metros', 'distanciametros']);
      let totalKm = kmRaw !== undefined ? parseFlexNumber(String(kmRaw)) ?? 0 : 0;
      if (totalKm === 0 && metersRaw !== undefined) {
        totalKm = (parseFlexNumber(String(metersRaw)) ?? 0) / 1000;
      }

      const interRaw = getCaseInsensitiveProp(obj, [
        'interkm',
        'kmparcial',
        'parcial',
        'inter',
        'trechokm',
        'dif',
        'diferenca',
        'diferencakm',
        'distparcial',
      ]);
      const interKm = interRaw !== undefined ? parseFlexNumber(String(interRaw)) ?? 0 : 0;

      const latRaw = getCaseInsensitiveProp(obj, ['lat', 'latitude']);
      const lonRaw = getCaseInsensitiveProp(obj, ['lon', 'lng', 'longitude']);
      const lat = latRaw !== undefined ? parseCoordinateValue(String(latRaw)) ?? 0 : 0;
      const lon = lonRaw !== undefined ? parseCoordinateValue(String(lonRaw)) ?? 0 : 0;

      const capRaw = getCaseInsensitiveProp(obj, ['cap', 'rumo', 'heading', 'azimute', 'direcao']);
      const capNum = capRaw !== undefined ? parseFlexNumber(String(capRaw)) : null;
      const cap = capNum !== null ? Math.round(capNum) : null;

      const speedRaw = getCaseInsensitiveProp(obj, [
        'avgspeedkmh',
        'veltdn',
        'tdn',
        'velocidade',
        'velocidademedia',
        'veloc',
        'vel',
        'speed',
        'media',
        'vmedia',
        'vm',
        'pmm',
        'mediahoraria',
      ]);
      const parsedVelTdn = speedRaw !== undefined ? parseVelTdnValue(String(speedRaw)) : {};
      const avgSpeedKmh = parsedVelTdn.avgSpeedKmh ?? null;
      const tdnMs = parsedVelTdn.tdnMs ?? null;

      const idealRaw = getCaseInsensitiveProp(obj, [
        'idealtime',
        'tempoideal',
        'tempo',
        'horaideal',
        'hora',
        'tempototal',
      ]);
      const idealMsProp = getCaseInsensitiveProp(obj, ['idealtimems', 'tempoms']);
      const idealSecProp = getCaseInsensitiveProp(obj, ['temposec', 'temposeg', 'segundos']);
      let idealStr = idealRaw !== undefined ? String(idealRaw) : '';
      let idealTimeMs = parseFlexibleTimeToMs(idealStr);
      if (idealTimeMs === null && idealMsProp !== undefined) {
        idealTimeMs = parseFlexibleTimeToMs(String(idealMsProp), 'ms');
      } else if (idealTimeMs === null && idealSecProp !== undefined) {
        idealTimeMs = parseFlexibleTimeToMs(String(idealSecProp), 'sec');
      }
      if (idealTimeMs !== null && (!idealStr || /^\d+(\.\d+)?$/.test(idealStr.trim()))) {
        idealStr = formatMsToIdealStr(idealTimeMs);
      }

      const typeRaw = getCaseInsensitiveProp(obj, ['type', 'typ', 'tipo', 'modo']);
      const explicitType = normalizeType(String(typeRaw ?? ''));
      const type = explicitType || parsedVelTdn.typeHint || 'V';

      const secRaw = getCaseInsensitiveProp(obj, ['section', 'sec', 'secao', 'trecho']);
      const secNum = secRaw !== undefined ? parseFlexNumber(String(secRaw)) : null;
      const section = secNum !== null ? Math.round(secNum) : null;

      const notes = collectNotesWithFallback(
        (k) => {
          const v = getCaseInsensitiveProp(obj, [k]);
          return v !== undefined && typeof v !== 'object' ? String(v) : '';
        },
        Object.entries(obj)
      );

      const imgRaw = getCaseInsensitiveProp(obj, ['imagem', 'img', 'figura', 'tulipaimg', 'arquivo', 'icon']);
      const tulNumFinal = Number.isFinite(num) ? num : idx + 1;
      const imageDataUrl = lookupZipImage(
        zipImages,
        tulNumFinal,
        imgRaw ? String(imgRaw) : undefined
      );

      tulipas.push({
        tulipa: tulNumFinal,
        totalKm,
        interKm,
        lat,
        lon,
        cap,
        idealTimeStr: idealStr,
        idealTimeMs,
        type,
        section,
        avgSpeedKmh,
        tdnMs,
        notes,
        imageDataUrl,
      });
    });

    if (tulipas.length === 0) return null;

    const rootObj = !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    const eventProp = getCaseInsensitiveProp(rootObj, ['eventname', 'evento', 'prova', 'nome', 'titulo', 'title']);
    const eventName = eventProp
      ? String(eventProp).trim()
      : fileName.replace(/\.(nbp|bin|json|txt|zip)$/i, '');

    return enrichRoadbookForNavigation({
      eventName,
      fileName,
      tulipas,
      countV: tulipas.filter((t) => t.type === 'V').length,
      countD: tulipas.filter((t) => t.type === 'D').length,
      countN: tulipas.filter((t) => t.type === 'N').length,
      totalKm: tulipas[tulipas.length - 1]?.totalKm ?? 0,
    });
  } catch {
    return null;
  }
}

const KNOWN_XML_ROW_TAGS = new Set([
  'tulipa',
  'tul',
  'referencia',
  'ref',
  'waypoint',
  'ponto',
  'point',
  'trecho',
  'item',
  'planilha_item',
  'etapa',
  'row',
  'linha',
  'registro',
  'reg',
  'wpt',
  'trkpt',
  'rtept',
  'passagem',
  'navegacao',
  'nota',
  'marcacao',
  'checkpoint',
  't',
]);

const XML_LEADING_START_TAGS = new Set(['largada', 'inicio', 'partida', 'start']);

interface SimpleXmlNode {
  tag: string;
  attrs: Record<string, string>;
  fields: Record<string, string>;
}

function appendXmlField(fields: Record<string, string>, key: string, rawVal: string) {
  const val = rawVal.trim();
  if (!val || !key) return;
  const existing = fields[key];
  if (!existing) {
    fields[key] = val;
    return;
  }
  const existingLines = existing.split('\n').map((s) => s.toLowerCase());
  if (!existingLines.includes(val.toLowerCase())) {
    fields[key] = `${existing}\n${val}`;
  }
}

function unwrapCdataAndEntities(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseAttributesFromTag(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(attrStr)) !== null) {
    attrs[m[1].toLowerCase()] = unwrapCdataAndEntities(m[2] ?? m[3] ?? '').trim();
  }
  return attrs;
}

function parseXmlNodesUniversal(xmlText: string): { nodes: SimpleXmlNode[]; rootTitle?: string } {
  // Sanitize BOM, NUL, DOCTYPE and unescaped ampersands common in Brazilian rally exports
  const sanitized = xmlText
    .replace(/^\uFEFF/, '')
    .replace(/\u0000/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');

  const xmlStart = sanitized.indexOf('<');
  if (xmlStart < 0) return { nodes: [] };
  const cleanXml = sanitized.slice(xmlStart);

  // 1. Try native DOMParser when available (browser / Android WebView)
  if (typeof DOMParser !== 'undefined') {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(cleanXml, 'application/xml');
      if (!doc.querySelector('parsererror')) {
        const all = Array.from(doc.getElementsByTagName('*'));
        const byTag = new Map<string, Element[]>();
        for (const el of all) {
          const t = el.tagName.toLowerCase();
          if (!byTag.has(t)) byTag.set(t, []);
          byTag.get(t)!.push(el);
        }

        let targetElements: Element[] = [];
        for (const [tag, els] of byTag.entries()) {
          if (KNOWN_XML_ROW_TAGS.has(tag) && els.length > targetElements.length) {
            targetElements = els;
          }
        }

        // Fallback: pick largest repeating group (>= 2) with child elements or >=2 attrs
        if (targetElements.length === 0) {
          for (const [, els] of byTag.entries()) {
            if (els.length >= 2 && els.length > targetElements.length) {
              const sample = els[0];
              if (sample.children.length >= 2 || sample.attributes.length >= 2) {
                targetElements = els;
              }
            }
          }
        }

        // Include leading <Largada>/<Inicio>/<Start> sibling if omitted from the repeating row tag
        if (targetElements.length > 0) {
          const firstRow = targetElements[0];
          const prevEl = firstRow.previousElementSibling;
          if (
            prevEl &&
            XML_LEADING_START_TAGS.has(prevEl.tagName.toLowerCase()) &&
            (prevEl.children.length >= 1 || prevEl.attributes.length >= 1)
          ) {
            targetElements = [prevEl, ...targetElements];
          } else {
            for (const startTag of XML_LEADING_START_TAGS) {
              const startEls = byTag.get(startTag);
              if (startEls && startEls.length === 1) {
                const candidate = startEls[0];
                if (
                  candidate !== firstRow &&
                  (candidate.attributes.length >= 2 || candidate.children.length >= 2)
                ) {
                  targetElements = [candidate, ...targetElements];
                  break;
                }
              }
            }
          }
        }

        const nodes: SimpleXmlNode[] = targetElements.map((el) => {
          const attrs: Record<string, string> = {};
          for (const attr of Array.from(el.attributes)) {
            attrs[attr.name.toLowerCase()] = attr.value.trim();
          }
          const fields: Record<string, string> = { ...attrs };

          // Inherit section/type/speed attributes from parent <Trecho>/<Secao>/<Etapa> if missing on item
          let parent = el.parentElement;
          let pDepth = 0;
          while (parent && pDepth < 3) {
            for (const attr of Array.from(parent.attributes)) {
              const ak = attr.name.toLowerCase();
              const av = attr.value.trim();
              if (
                av &&
                !(ak in fields) &&
                /^(tipo|type|typ|secao|sec|section|trecho|media|velocidade|vel|veltdn|tdn|pmm)$/.test(
                  normKey(ak)
                )
              ) {
                fields[ak] = av;
              }
            }
            parent = parent.parentElement;
            pDepth += 1;
          }

          const collectChildElement = (child: Element) => {
            const key = child.tagName.toLowerCase();
            // Collect attributes on child elements (e.g. <Observacao Texto="..." /> or <Distancia Total="0.15" />)
            for (const cattr of Array.from(child.attributes)) {
              const ck = cattr.name.toLowerCase();
              const cv = cattr.value.trim();
              if (cv) {
                appendXmlField(fields, `${key}_${ck}`, cv);
                if (!fields[ck]) appendXmlField(fields, ck, cv);
                if (
                  (ck === 'texto' || ck === 'text' || ck === 'valor' || ck === 'value' || ck === 'conteudo') &&
                  key
                ) {
                  appendXmlField(fields, key, cv);
                }
              }
            }
            if (child.children.length > 0) {
              for (const grand of Array.from(child.children)) {
                collectChildElement(grand);
              }
            } else {
              const val = child.textContent?.trim() ?? '';
              if (val) {
                appendXmlField(fields, key, val);
              }
            }
          };

          for (const child of Array.from(el.children)) {
            collectChildElement(child);
          }
          return { tag: el.tagName.toLowerCase(), attrs, fields };
        });

        const titleEl = doc.querySelector('Nome, nome, Prova, prova, Evento, evento, name, title');
        return { nodes, rootTitle: titleEl?.textContent?.trim() || undefined };
      }
    } catch {
      // Fallback to lightweight parser below
    }
  }

  // 2. Pure-TS fallback XML parser (works identically in Node.js tests & broken XML)
  const nodes: SimpleXmlNode[] = [];
  const blockRegex = /<([^\s<>\/?!]+)(\s[^<>]*?)?(?:\/>|>([\s\S]*?)<\/\1>)/g;
  const groups = new Map<string, SimpleXmlNode[]>();

  const scanText = (src: string, depth = 0, inherited: Record<string, string> = {}) => {
    if (depth > 6) return;
    let match: RegExpExecArray | null;
    const localRegex = new RegExp(blockRegex.source, 'g');
    while ((match = localRegex.exec(src)) !== null) {
      const tag = match[1].toLowerCase();
      if (tag === '?xml' || tag.startsWith('!')) continue;
      const attrs = parseAttributesFromTag(match[2] ?? '');
      const inner = match[3] ?? '';
      const fields: Record<string, string> = { ...inherited, ...attrs };

      const nextInherited: Record<string, string> = { ...inherited };
      for (const [ak, av] of Object.entries(attrs)) {
        if (
          av &&
          /^(tipo|type|typ|secao|sec|section|trecho|media|velocidade|vel|veltdn|tdn|pmm)$/.test(
            normKey(ak)
          )
        ) {
          nextInherited[ak] = av;
        }
      }

      if (inner.includes('<')) {
        // Match both <Tag attr="...">content / CDATA</Tag> and self-closing <Tag attr="..." />
        const childRegex = /<([^\s<>\/?!]+)(\s[^<>]*?)?(?:\/>|>((?:<!\[CDATA\[[\s\S]*?\]\]>|[^<])*)<\/\1>)/g;
        let cm: RegExpExecArray | null;
        while ((cm = childRegex.exec(inner)) !== null) {
          const cTag = cm[1].toLowerCase();
          const cAttrs = parseAttributesFromTag(cm[2] ?? '');
          for (const [cak, cav] of Object.entries(cAttrs)) {
            appendXmlField(fields, `${cTag}_${cak}`, cav);
            if (!fields[cak]) appendXmlField(fields, cak, cav);
            if (
              (cak === 'texto' || cak === 'text' || cak === 'valor' || cak === 'value' || cak === 'conteudo') &&
              cTag
            ) {
              appendXmlField(fields, cTag, cav);
            }
          }
          const rawVal = unwrapCdataAndEntities(cm[3] ?? '').trim();
          if (rawVal) appendXmlField(fields, cTag, rawVal);
        }
        // Also collect leaf sub-tags inside nested containers (e.g., <Obs><Linha>TEXTO</Linha></Obs>)
        const leafRegex = /<([^\s<>\/?!]+)(?:\s[^<>]*?)?>([^<]+)<\/\1>/g;
        let lm: RegExpExecArray | null;
        while ((lm = leafRegex.exec(inner)) !== null) {
          const lTag = lm[1].toLowerCase();
          const lVal = unwrapCdataAndEntities(lm[2] ?? '').trim();
          if (lVal && !fields[lTag]?.includes(lVal)) {
            appendXmlField(fields, lTag, lVal);
          }
        }
        scanText(inner, depth + 1, nextInherited);
      }

      if (Object.keys(fields).length >= 2) {
        if (!groups.has(tag)) groups.set(tag, []);
        groups.get(tag)!.push({ tag, attrs, fields });
      }
    }
  };

  scanText(cleanXml, 0);

  let best: SimpleXmlNode[] = [];
  for (const [tag, list] of groups.entries()) {
    if (KNOWN_XML_ROW_TAGS.has(tag) && list.length > best.length) {
      best = list;
    }
  }
  if (best.length === 0) {
    for (const list of groups.values()) {
      if (list.length >= 2 && list.length > best.length) {
        best = list;
      }
    }
  }

  // Include leading <Largada>/<Inicio>/<Start> if omitted from main array
  if (best.length > 0) {
    for (const startTag of XML_LEADING_START_TAGS) {
      const startList = groups.get(startTag);
      if (startList && startList.length === 1 && !best.includes(startList[0])) {
        best = [startList[0], ...best];
        break;
      }
    }
  }

  nodes.push(...best);

  const titleMatch = cleanXml.match(/<(?:Nome|Prova|Evento|Titulo|name|title)>([^<]{2,80})<\/(?:Nome|Prova|Evento|Titulo|name|title)>/i);
  return { nodes, rootTitle: titleMatch?.[1]?.trim() };
}

function tryParseXmlRoadbook(
  text: string,
  fileName: string,
  zipImages?: ZipImageIndex
): ParsedRoadbook | null {
  if (!text.includes('<')) return null;

  try {
    const { nodes, rootTitle } = parseXmlNodesUniversal(text);
    if (nodes.length === 0) return null;

    const tulipas: RoadbookTulipa[] = [];
    let accKm = 0;

    nodes.forEach((node, idx) => {
      const readField = (names: string[]): string => {
        for (const n of names) {
          const lower = n.toLowerCase();
          if (node.fields[lower]) return node.fields[lower];
          const norm = normKey(n);
          for (const [fk, fv] of Object.entries(node.fields)) {
            if (normKey(fk) === norm && fv) return fv;
          }
        }
        return '';
      };

      const tulNumRaw = readField(['tulipa', 'tul', 'numero', 'num', 'nro', 'ref', 'id', 'ordem', 'seq']);
      const tulNum = parseInt(tulNumRaw, 10);

      const kmStr = readField([
        'total_km',
        'totalkm',
        'kmtotal',
        'kmacum',
        'kmfinal',
        'total',
        'km',
        'disttotal',
        'distanciatotal',
        'distacum',
        'dtotal',
        'acumulado',
        'dist',
        'odometro',
        'hodometro',
        'hod',
      ]);
      const metersStr = readField(['total_m', 'totalm', 'dist_m', 'distm', 'metros', 'distanciametros']);
      const interStr = readField(['inter_km', 'interkm', 'kmparcial', 'parcial', 'inter', 'trechokm', 'dif', 'diferenca', 'diferencakm', 'distparcial']);
      const latStr = readField(['lat', 'latitude']);
      const lonStr = readField(['lon', 'lng', 'longitude']);
      const capStr = readField(['cap', 'rumo', 'heading', 'azimute', 'direcao']);
      const speedStr = readField(['veltdn', 'tdn', 'velocidade', 'velocidademedia', 'veloc', 'vel', 'media', 'vmedia', 'vm', 'pmm', 'speed', 'avgspeedkmh', 'mediahoraria']);
      const idealStrRaw = readField(['ideal_time', 'idealtime', 'tempoideal', 'tempo', 'horaideal', 'hora', 'tempototal']);
      const idealSecStr = readField(['temposec', 'temposeg', 'segundos']);
      const idealMsStr = readField(['idealtimems', 'tempoms']);
      const typeStr = readField(['type', 'typ', 'tipo', 'modo']);
      const secStr = readField(['section', 'sec', 'secao', 'trecho']);
      const notes = collectNotesWithFallback((k) => readField([k]), Object.entries(node.fields));
      const imgStr = readField(['imagem', 'img', 'figura', 'tulipaimg', 'arquivo', 'icon', 'desenho', 'bitmap', 'bmp', 'png', 'svg']);

      const lat = (latStr ? parseCoordinateValue(latStr) : 0) ?? 0;
      const lon = (lonStr ? parseCoordinateValue(lonStr) : 0) ?? 0;
      const interKm = interStr ? parseFlexNumber(interStr) ?? 0 : 0;

      let totalKm = kmStr ? parseFlexNumber(kmStr) : null;
      if (totalKm === null && metersStr) {
        const m = parseFlexNumber(metersStr);
        if (m !== null) totalKm = m / 1000;
      }
      if (totalKm === null) {
        accKm += interKm;
        totalKm = Number(accKm.toFixed(3));
      } else {
        accKm = totalKm;
      }

      const capNum = capStr ? parseFlexNumber(capStr) : null;
      const cap = capNum !== null ? Math.round(capNum) : null;
      const parsedVelTdn = speedStr ? parseVelTdnValue(speedStr) : {};

      let idealStr = idealStrRaw;
      let idealTimeMs = parseFlexibleTimeToMs(idealStr);
      if (idealTimeMs === null && idealMsStr) {
        idealTimeMs = parseFlexibleTimeToMs(idealMsStr, 'ms');
      } else if (idealTimeMs === null && idealSecStr) {
        idealTimeMs = parseFlexibleTimeToMs(idealSecStr, 'sec');
      }
      if (idealTimeMs !== null && (!idealStr || /^\d+(\.\d+)?$/.test(idealStr.trim()))) {
        idealStr = formatMsToIdealStr(idealTimeMs);
      }

      const explicitType = typeStr ? normalizeTypeToken(typeStr) || normalizeType(typeStr) : '';
      const finalType = explicitType || parsedVelTdn.typeHint || 'V';

      const tulNumFinal = Number.isFinite(tulNum) ? tulNum : idx + 1;
      const imageDataUrl = resolveInlineOrZipImage(zipImages, tulNumFinal, imgStr || undefined);

      tulipas.push({
        tulipa: tulNumFinal,
        totalKm,
        interKm,
        lat,
        lon,
        cap,
        idealTimeStr: idealStr,
        idealTimeMs,
        type: finalType,
        section: secStr ? parseInt(secStr, 10) || null : null,
        avgSpeedKmh: parsedVelTdn.avgSpeedKmh ?? null,
        tdnMs: parsedVelTdn.tdnMs ?? null,
        notes,
        imageDataUrl,
      });
    });

    if (tulipas.length === 0) return null;

    return enrichRoadbookForNavigation({
      eventName: rootTitle || fileName.replace(/\.(nbp|bin|rbk|xml|gpx|zip)$/i, ''),
      fileName,
      tulipas,
      countV: tulipas.filter((t) => t.type === 'V').length,
      countD: tulipas.filter((t) => t.type === 'D').length,
      countN: tulipas.filter((t) => t.type === 'N').length,
      totalKm: tulipas[tulipas.length - 1]?.totalKm ?? 0,
    });
  } catch {
    return null;
  }
}

/**
 * Parses INI block format (e.g. [TULIPA1] / [REFERENCIA 1] sections with Key=Value).
 */
function tryParseIniRoadbook(
  text: string,
  fileName: string,
  zipImages?: ZipImageIndex
): ParsedRoadbook | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());
  const sections: { name: string; kv: Record<string, string> }[] = [];
  let current: { name: string; kv: Record<string, string> } | null = null;

  for (const line of lines) {
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const secMatch = line.match(/^\[([^\]]+)\]$/);
    if (secMatch) {
      current = { name: secMatch[1].trim(), kv: {} };
      sections.push(current);
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0 && current) {
      const key = normKey(line.slice(0, eqIdx));
      const val = line.slice(eqIdx + 1).trim();
      if (key) current.kv[key] = val;
    }
  }

  const rowSections = sections.filter((s) => {
    const k = s.kv;
    return (
      'totalkm' in k ||
      'kmtotal' in k ||
      'km' in k ||
      'dist' in k ||
      'disttotal' in k ||
      'distanciatotal' in k ||
      'interkm' in k ||
      'parcial' in k ||
      'velocidade' in k ||
      'veltdn' in k ||
      'tdn' in k ||
      'tempo' in k ||
      'tempoideal' in k
    );
  });

  if (rowSections.length < 2) return null;

  const metaSec = sections.find(
    (s) =>
      s.name.toLowerCase().includes('prova') ||
      s.name.toLowerCase().includes('info') ||
      s.name.toLowerCase().includes('cabecalho')
  );
  const eventName =
    metaSec?.kv['evento'] ||
    metaSec?.kv['prova'] ||
    metaSec?.kv['nome'] ||
    fileName.replace(/\.(nbp|ini|txt|zip)$/i, '');

  const tulipas: RoadbookTulipa[] = rowSections.map((sec, idx) => {
    const kv = sec.kv;
    const secNumMatch = sec.name.match(/(\d+)/);
    const tulNum = parseInt(kv['tulipa'] || kv['numero'] || secNumMatch?.[1] || '', 10);
    const totalKm =
      parseFlexNumber(kv['totalkm'] || kv['kmtotal'] || kv['disttotal'] || kv['distanciatotal'] || kv['km'] || kv['dist'] || '') ?? 0;
    const interKm =
      parseFlexNumber(kv['interkm'] || kv['kmparcial'] || kv['parcial'] || kv['dif'] || kv['diferenca'] || '') ?? 0;
    const lat = kv['lat'] || kv['latitude'] ? parseCoordinateValue(kv['lat'] || kv['latitude']) ?? 0 : 0;
    const lon = kv['lon'] || kv['lng'] || kv['longitude'] ? parseCoordinateValue(kv['lon'] || kv['lng'] || kv['longitude']) ?? 0 : 0;
    const capNum = kv['cap'] || kv['rumo'] ? parseFlexNumber(kv['cap'] || kv['rumo']) : null;
    const rawSpeed = kv['veltdn'] || kv['tdn'] || kv['velocidade'] || kv['media'] || kv['vel'] || kv['vm'] || kv['pmm'] || '';
    const parsedVelTdn = rawSpeed ? parseVelTdnValue(rawSpeed) : {};
    const idealStr = kv['tempoideal'] || kv['idealtime'] || kv['tempo'] || '';
    const idealTimeMs = parseFlexibleTimeToMs(idealStr);
    const explicitType = normalizeTypeToken(kv['tipo'] || kv['type'] || kv['typ'] || '');
    const type = explicitType || parsedVelTdn.typeHint || 'V';
    const secId = kv['secao'] || kv['sec'] ? parseInt(kv['secao'] || kv['sec'], 10) || null : null;
    const notes = collectNotesWithFallback((k) => kv[k] ?? '', Object.entries(kv));
    const imgRef = kv['imagem'] || kv['img'] || kv['arquivo'];

    const finalNum = Number.isFinite(tulNum) ? tulNum : idx + 1;
    return {
      tulipa: finalNum,
      totalKm,
      interKm,
      lat,
      lon,
      cap: capNum !== null ? Math.round(capNum) : null,
      idealTimeStr: idealStr,
      idealTimeMs,
      type,
      section: secId,
      avgSpeedKmh: parsedVelTdn.avgSpeedKmh ?? null,
      tdnMs: parsedVelTdn.tdnMs ?? null,
      notes,
      imageDataUrl: lookupZipImage(zipImages, finalNum, imgRef),
    };
  });

  return enrichRoadbookForNavigation({
    eventName,
    fileName,
    tulipas,
    countV: tulipas.filter((t) => t.type === 'V').length,
    countD: tulipas.filter((t) => t.type === 'D').length,
    countN: tulipas.filter((t) => t.type === 'N').length,
    totalKm: tulipas[tulipas.length - 1]?.totalKm ?? 0,
  });
}

/**
 * Parses flexible NBP/CSV/TSV/semicolon text files with or without headers and with optional lat/lon.
 */
function tryParseFlexibleNbpText(
  text: string,
  fileName: string,
  zipImages?: ZipImageIndex
): ParsedRoadbook | null {
  const cleanText = text.replace(/^\uFEFF/, '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
  const ini = tryParseIniRoadbook(cleanText, fileName, zipImages);
  if (ini) return ini;

  const lines = cleanText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[-=_+\s|]+$/.test(l));
  if (lines.length === 0) return null;

  let eventName = fileName.replace(/\.(nbp|bin|txt|csv|tsv|zip)$/i, '');
  let headerMap: Record<string, number> | null = null;
  let notesIndices: number[] = [];
  const headeredRawRows: string[][] = [];
  const headerlessRows: string[][] = [];
  const tulipas: RoadbookTulipa[] = [];

  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith('//')) {
      const clean = line.replace(/^[#/]+\s*/, '').trim();
      if (clean && eventName === fileName.replace(/\.(nbp|bin|txt|csv|tsv|zip)$/i, '')) {
        eventName = clean.slice(0, 60);
      }
      continue;
    }

    const delim = line.includes('|')
      ? '|'
      : line.includes(';')
        ? ';'
        : line.includes('\t')
          ? '\t'
          : ',';

    const cols = splitDelimitedLine(line, delim);
    if (cols.length < 3) continue;

    // Detect header line dynamically (never treat a row containing a timestamp as header)
    const lowerJoined = cols.join(' ').toLowerCase();
    const hasTimeCell = cols.some((c) => parseIdealTimeToMs(c) !== null);
    if (
      !headerMap &&
      tulipas.length === 0 &&
      headerlessRows.length === 0 &&
      !hasTimeCell &&
      (lowerJoined.includes('km') ||
        lowerJoined.includes('tul') ||
        lowerJoined.includes('tempo') ||
        lowerJoined.includes('vel') ||
        lowerJoined.includes('parcial') ||
        lowerJoined.includes('dist') ||
        lowerJoined.includes('obs')) &&
      parseFlexNumber(cols[0]) === null
    ) {
      headerMap = {};
      notesIndices = [];
      cols.forEach((col, idx) => {
        const key = normKey(col);
        if (key.includes('tul') || key === 'num' || key === 'numero' || key === 'ref' || key === 'nro') headerMap!['tulipa'] = idx;
        else if (key === 'totalkm' || key === 'kmtotal' || key === 'total' || key === 'km' || key === 'kmacum' || key === 'kmfinal' || key === 'disttotal' || key === 'distancia' || key === 'dist' || key === 'dtotal' || key === 'acumulado' || key === 'odometro' || key === 'hodometro' || key === 'hod' || key === 'odo') headerMap!['totalKm'] = idx;
        else if (key === 'inter' || key === 'interkm' || key === 'kmparcial' || key === 'parcial' || key === 'distparcial' || key === 'distparc' || key === 'dif' || key === 'diferenca') headerMap!['interKm'] = idx;
        else if (key === 'lat' || key === 'latitude') headerMap!['lat'] = idx;
        else if (key === 'lon' || key === 'lng' || key === 'longitude') headerMap!['lon'] = idx;
        else if (key === 'cap' || key === 'rumo') headerMap!['cap'] = idx;
        else if (key === 'veltdn' || key === 'tdn') headerMap!['veltdn'] = idx;
        else if (key.includes('ideal') || key === 'tempo' || key === 'hora' || key === 'passagem' || key === 'time') headerMap!['time'] = idx;
        else if (key.includes('vel') || key.includes('media') || key.includes('speed') || key === 'vm' || key === 'pmm') headerMap!['speed'] = idx;
        else if (key === 'typ' || key === 'type' || key === 'tipo' || key === 'modo') headerMap!['type'] = idx;
        else if (key === 'sec' || key === 'secao' || key === 'section' || key === 'trecho') headerMap!['section'] = idx;
        else if (
          key.includes('obs') ||
          key.includes('desc') ||
          key.includes('refer') ||
          key.includes('texto') ||
          key.includes('nota') ||
          key.includes('coment') ||
          key.includes('hist') ||
          key.includes('info') ||
          key.includes('detalh') ||
          key.includes('avis') ||
          key.includes('mensag') ||
          key.includes('anot') ||
          key.includes('orient') ||
          key.includes('comand') ||
          key.includes('rotul') ||
          key.includes('legend') ||
          key === 'msg' ||
          key === 'local' ||
          key === 'complemento' ||
          key === 'titulo' ||
          key === 'subtitulo' ||
          key === 'resumo' ||
          key === 'ponto' ||
          key === 'remark' ||
          key === 'memo' ||
          key === 'string' ||
          key === 'rua' ||
          key === 'via' ||
          key === 'sentido' ||
          /^txt\d*$/.test(key) ||
          /^l\d+$/.test(key) ||
          /^linha\d*$/.test(key) ||
          key.startsWith('campo')
        ) notesIndices.push(idx);
      });
      continue;
    }

    if (headerMap) {
      headeredRawRows.push(cols);
      continue;
    }

    // Queue headerless candidate rows (allow Row 1 at 0,00 even when cols[1] is blank/type/start label)
    const firstCell = cols[0].trim();
    const isStartLabel = /^(largada|inicio|início|start|partida)$/i.test(firstCell);
    const firstNum = parseFlexNumber(firstCell.replace(/^[#Tt]+/, ''));
    const hasNumericOrTimeOrType = cols.slice(1).some((c) => {
      const t = c.trim();
      return (
        parseFlexNumber(t) !== null ||
        parseIdealTimeToMs(t) !== null ||
        parseVelTdnValue(t).typeHint !== undefined ||
        normalizeTypeToken(t) !== ''
      );
    });
    if ((firstNum === null && !isStartLabel) || !hasNumericOrTimeOrType) continue;
    headerlessRows.push(cols);
  }

  if (headerMap && headeredRawRows.length > 0) {
    // Fallback if header had unrecognized observation column name
    if (notesIndices.length === 0) {
      const mapped = new Set<number>(Object.values(headerMap));
      const maxC = headeredRawRows.reduce((m, r) => Math.max(m, r.length), 0);
      const sample = headeredRawRows.slice(0, 60);
      for (let c = 0; c < maxC; c++) {
        if (mapped.has(c)) continue;
        const hasDescriptive = sample.some((r) => isLikelyNoteText((r[c] ?? '').trim()));
        if (hasDescriptive) notesIndices.push(c);
      }
    }

    for (const cols of headeredRawRows) {
      const getField = (k: string) => (k in headerMap! ? cols[headerMap![k]] ?? '' : '');
      const tulCell = (getField('tulipa') || cols[0]).trim();
      const isStart = /^(largada|inicio|início|start|partida)$/i.test(tulCell);
      const firstNum = parseFlexNumber(tulCell.replace(/^[#Tt]+/, ''));
      const tulNum = firstNum !== null && Number.isInteger(firstNum) ? firstNum : isStart ? 1 : tulipas.length + 1;
      const totalKm = parseFlexNumber(getField('totalKm')) ?? 0;
      const interKm = parseFlexNumber(getField('interKm')) ?? 0;
      const lat = parseCoordinateValue(getField('lat')) ?? 0;
      const lon = parseCoordinateValue(getField('lon')) ?? 0;
      const capNum = parseFlexNumber(getField('cap'));
      const velTdnRaw = getField('veltdn') || getField('speed');
      const parsedVelTdn = velTdnRaw ? parseVelTdnValue(velTdnRaw) : {};
      const idealTimeStr = getField('time');
      const idealTimeMs = parseFlexibleTimeToMs(idealTimeStr);
      const explicitType = normalizeTypeToken(getField('type'));
      const type = explicitType || parsedVelTdn.typeHint || 'V';
      const secNum = parseFlexNumber(getField('section'));
      const notesList = notesIndices.map((ni) => (cols[ni] ?? '').trim()).filter(Boolean);
      const notes = notesList.length > 0 ? notesList.join('\n') : undefined;

      tulipas.push({
        tulipa: tulNum,
        totalKm,
        interKm,
        lat,
        lon,
        cap: capNum !== null ? Math.round(capNum) : null,
        idealTimeStr,
        idealTimeMs,
        type,
        section: secNum !== null ? Math.round(secNum) : null,
        avgSpeedKmh: parsedVelTdn.avgSpeedKmh ?? null,
        tdnMs: parsedVelTdn.tdnMs ?? null,
        notes,
        imageDataUrl: lookupZipImage(zipImages, tulNum),
      });
    }
  }

  if (headerlessRows.length > 0) {
    const inferred = inferHeaderlessColumnMap(headerlessRows);
    const colMap = inferred.map;
    const noteCols = inferred.notesIndices;
    for (const cols of headerlessRows) {
      const getField = (k: string) => (k in colMap ? cols[colMap[k]] ?? '' : '');
      const tulCell = (getField('tulipa') || cols[0]).trim();
      const isStart = /^(largada|inicio|início|start|partida)$/i.test(tulCell);
      const firstNum = parseFlexNumber(tulCell.replace(/^[#Tt]+/, ''));
      const tulNum = firstNum !== null && Number.isInteger(firstNum) ? firstNum : isStart ? 1 : tulipas.length + 1;
      const totalKm = parseFlexNumber(getField('total_km')) ?? 0;
      const interKm = parseFlexNumber(getField('inter_km')) ?? 0;
      const lat = parseCoordinateValue(getField('lat')) ?? 0;
      const lon = parseCoordinateValue(getField('lon')) ?? 0;
      const capNum = parseFlexNumber(getField('cap'));
      const velTdnRaw = getField('veltdn') || getField('speed');
      const parsedVelTdn = velTdnRaw ? parseVelTdnValue(velTdnRaw) : {};
      const idealTimeStr = getField('ideal_time');
      const idealTimeMs = parseFlexibleTimeToMs(idealTimeStr);
      const explicitType = normalizeTypeToken(getField('type'));
      const type = explicitType || parsedVelTdn.typeHint || 'V';
      const secNum = parseFlexNumber(getField('section'));
      const notesList = noteCols.map((ni) => (cols[ni] ?? '').trim()).filter(Boolean);
      const notes = notesList.length > 0 ? notesList.join('\n') : undefined;

      tulipas.push({
        tulipa: tulNum,
        totalKm,
        interKm,
        lat,
        lon,
        cap: capNum !== null ? Math.round(capNum) : null,
        idealTimeStr,
        idealTimeMs,
        type,
        section: secNum !== null ? Math.round(secNum) : null,
        avgSpeedKmh: parsedVelTdn.avgSpeedKmh ?? null,
        tdnMs: parsedVelTdn.tdnMs ?? null,
        notes,
        imageDataUrl: lookupZipImage(zipImages, tulNum),
      });
    }
  }

  if (tulipas.length < 2) return null;

  return enrichRoadbookForNavigation({
    eventName,
    fileName,
    tulipas,
    countV: tulipas.filter((t) => t.type === 'V').length,
    countD: tulipas.filter((t) => t.type === 'D').length,
    countN: tulipas.filter((t) => t.type === 'N').length,
    totalKm: tulipas[tulipas.length - 1]?.totalKm ?? 0,
  });
}

function decodeBufferToText(buffer: ArrayBuffer): {
  text: string;
  isBinary: boolean;
  signatureHex: string;
} {
  const bytes = new Uint8Array(buffer);
  const sigBytes = Array.from(bytes.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      text: new TextDecoder('utf-16le').decode(bytes),
      isBinary: false,
      signatureHex: sigBytes,
    };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      text: new TextDecoder('utf-16be').decode(bytes),
      isBinary: false,
      signatureHex: sigBytes,
    };
  }

  const sampleLen = Math.min(bytes.length, 4096);
  let printable = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = bytes[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 160) {
      printable += 1;
    }
  }
  const ratio = sampleLen > 0 ? printable / sampleLen : 0;

  // Prefer UTF-8, fallback to windows-1252/latin1 when accented Brazilian chars produce replacement marks
  let utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (utf8.includes('\uFFFD')) {
    try {
      utf8 = new TextDecoder('windows-1252').decode(bytes);
    } catch {
      utf8 = new TextDecoder('latin1').decode(bytes);
    }
  }

  if (ratio >= 0.72) {
    return { text: utf8, isBinary: false, signatureHex: sigBytes };
  }

  const latin1 = new TextDecoder('latin1').decode(bytes);
  return { text: latin1, isBinary: true, signatureHex: sigBytes };
}

/**
 * Dedicated parser for T15 Competições / T15Nav `.tpl` text plan inside `.nbp.zip`
 * Format:
 *   Prova = RallyDaGraciosa2026
 *   Categoria = Graduados
 *   Data = 18 de JULHO de 2026 (Gerado Por T15 Competições)
 *   PLANILHA CARRO
 *   1;REF0_0;;;;;;
 *   2;1;D;0,00;00:10:00;00:00:00.00;1;0,01;0
 *   10;9;V;0,00;38;00:10:00.00;2;0,01;0
 */
function tryParseT15TplRoadbook(
  text: string,
  fileName: string,
  zipImages?: ZipImageIndex
): ParsedRoadbook | null {
  const cleanLines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (cleanLines.length < 3) return null;

  let eventName = fileName.replace(/\.(nbp|zip|tpl|txt)$/i, '');
  let category: string | undefined;
  const rawHeaderLines: string[] = [];
  let hasTplSignature = /Gerado\s+Por\s+T15|PLANILHA\s+CARRO|^\d+;REF0+[_-]0*;/im.test(
    cleanLines.slice(0, 12).join('\n')
  );

  interface RawTplRow {
    seqNum: number;
    tulNum: number;
    type: TulipaType;
    rawKm: number;
    avgSpeedKmh: number | null;
    tdnMs: number | null;
    idealTimeStr: string;
    idealTimeMs: number | null;
    section: number | null;
    nextKm: number | null;
    notes?: string;
  }

  const rawRows: RawTplRow[] = [];

  for (const line of cleanLines) {
    const provaMatch = line.match(/^Prova\s*=\s*(.+)$/i);
    if (provaMatch) {
      eventName = provaMatch[1].trim() || eventName;
      rawHeaderLines.push(line);
      hasTplSignature = true;
      continue;
    }
    const catMatch = line.match(/^Categoria\s*=\s*(.+)$/i);
    if (catMatch) {
      category = catMatch[1].trim() || category;
      rawHeaderLines.push(line);
      hasTplSignature = true;
      continue;
    }
    if (/^(Data\s*=|PLANILHA\s+|-+$)/i.test(line)) {
      rawHeaderLines.push(line);
      continue;
    }

    if (!line.includes(';')) continue;
    const cols = line.split(';').map((c) => c.trim());
    if (cols.length < 6) continue;

    // Skip T15 cover/banner row (e.g. "1;REF0_0;;;;;;")
    if (/^REF0*[_-]0*$/i.test(cols[1])) {
      hasTplSignature = true;
      continue;
    }

    const seqNum = parseInt(cols[0], 10);
    const tulNum = parseInt(cols[1], 10);
    const type = normalizeType(cols[2]);
    if (!Number.isFinite(seqNum) || !Number.isFinite(tulNum) || !type) {
      continue;
    }

    const rawKm = parseFlexNumber(cols[3]) ?? 0;
    const velTdnRaw = cols[4] ?? '';
    let avgSpeedKmh: number | null = null;
    let tdnMs: number | null = null;
    if (type === 'V') {
      avgSpeedKmh = parseFlexNumber(velTdnRaw);
    } else if (type === 'D' || type === 'N') {
      avgSpeedKmh = type === 'N' ? 0 : null;
      tdnMs = parseFlexibleTimeToMs(velTdnRaw, 'sec');
    }

    const idealTimeStr = cols[5] ?? '';
    const idealTimeMs = parseFlexibleTimeToMs(idealTimeStr, 'sec');
    const section = cols[6] ? parseInt(cols[6], 10) : null;
    const nextKm = cols[7] !== undefined ? parseFlexNumber(cols[7]) : null;
    const extraNotes = cols
      .slice(9)
      .filter((c) => Boolean(c) && isLikelyNoteText(c))
      .join(' · ')
      .trim();

    rawRows.push({
      seqNum,
      tulNum,
      type,
      rawKm,
      avgSpeedKmh,
      tdnMs,
      idealTimeStr,
      idealTimeMs,
      section: section !== null && Number.isFinite(section) ? section : null,
      nextKm,
      notes: extraNotes || undefined,
    });
  }

  if (!hasTplSignature || rawRows.length < 2) return null;

  let resetOffset = 0;
  let prevRawKm = rawRows[0].rawKm;
  let prevNextKm = rawRows[0].nextKm;

  const tulipas: RoadbookTulipa[] = rawRows.map((row, idx) => {
    let isResetStart = idx === 0;
    if (
      idx > 0 &&
      row.rawKm + 0.05 < prevRawKm &&
      (row.rawKm <= 1.0 || prevRawKm - row.rawKm > 0.5)
    ) {
      isResetStart = true;
      const endOfPrevSectionKm =
        prevNextKm !== null && prevNextKm >= prevRawKm ? prevNextKm : prevRawKm;
      resetOffset += endOfPrevSectionKm;
    }

    const continuousTotalKm = Number((resetOffset + row.rawKm).toFixed(3));
    const displayKm = Number(row.rawKm.toFixed(3));
    const interKm = isResetStart
      ? displayKm
      : Number(Math.max(0, row.rawKm - prevRawKm).toFixed(3));

    prevRawKm = row.rawKm;
    prevNextKm = row.nextKm;

    const imgPair = resolveZipImagePairForTulipa(zipImages, row.tulNum);

    return {
      tulipa: row.tulNum,
      type: row.type,
      totalKm: continuousTotalKm,
      displayKm,
      interKm,
      resetsOdometer: idx === 0,
      cap: null,
      notes: row.notes ?? '',
      idealTimeStr: row.idealTimeStr,
      idealTimeMs: row.idealTimeMs,
      avgSpeedKmh: row.avgSpeedKmh,
      tdnMs: row.tdnMs,
      section: row.section,
      lat: 0,
      lon: 0,
      imageDataUrl: imgPair.imageDataUrl,
      notesImageDataUrl: imgPair.notesImageDataUrl,
      imageIsComposite: imgPair.imageIsComposite,
    };
  });

  // Mark odometer reset right before any section that dropped back to ~0,00
  for (let i = 1; i < tulipas.length; i++) {
    const prevDisplay = tulipas[i - 1].displayKm ?? tulipas[i - 1].totalKm;
    const currDisplay = tulipas[i].displayKm ?? tulipas[i].totalKm;
    if (currDisplay + 0.05 < prevDisplay && (currDisplay <= 1.0 || prevDisplay - currDisplay > 0.5)) {
      tulipas[i - 1].resetsOdometer = true;
    }
  }

  return enrichRoadbookForNavigation({
    fileName,
    eventName,
    sourceFormat: zipImages && zipImages.byFullPath.size > 0 ? 'T15-TPL-GIF' : 'T15-TPL',
    convertedAtMs: Date.now(),
    tulipas,
    countV: tulipas.filter((t) => t.type === 'V').length,
    countD: tulipas.filter((t) => t.type === 'D').length,
    countN: tulipas.filter((t) => t.type === 'N').length,
    totalKm: tulipas[tulipas.length - 1]?.totalKm ?? 0,
    raceParameters: {
      category,
      speedsKmh: [],
      notesCount: 0,
      sectionsCount: 0,
      imagesCount: 0,
      rawHeaderLines: rawHeaderLines.slice(0, 8),
    },
  });
}

function tryParsePlainTextPayload(
  text: string,
  fileName: string,
  zipImages?: ZipImageIndex
): ParsedRoadbook | null {
  const asJson = tryParseJsonRoadbook(text, fileName, zipImages);
  if (asJson) return asJson;

  const asXml = tryParseXmlRoadbook(text, fileName, zipImages);
  if (asXml) return asXml;

  const asT15Tpl = tryParseT15TplRoadbook(text, fileName, zipImages);
  if (asT15Tpl) return asT15Tpl;

  try {
    const standard = parseRoadbookTxt(text, fileName);
    return applyZipImagesToRoadbook(enrichRoadbookForNavigation(standard), zipImages);
  } catch {
    // Continue to flexible parser
  }

  const asFlexible = tryParseFlexibleNbpText(text, fileName, zipImages);
  if (asFlexible) return asFlexible;

  return null;
}

function isZipBuffer(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
}

function getZipEntryPriority(name: string): number {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xml') || lower.endsWith('.gpx')) return 1;
  if (lower.endsWith('.json')) return 2;
  if (lower.endsWith('.txt') || lower.endsWith('.csv') || lower.endsWith('.tsv')) return 3;
  if (lower.endsWith('.nbp') || lower.endsWith('.tpl') || lower.endsWith('.ini')) return 4;
  if (!lower.includes('.')) return 5;
  return 6;
}

async function parseZipContainer(
  buffer: ArrayBuffer,
  outerFileName: string,
  depth = 0
): Promise<ParsedRoadbook> {
  if (depth > 2) {
    throw new Error(`Profundidade máxima de compactação ZIP excedida ao ler "${outerFileName}".`);
  }

  const zip = await JSZip.loadAsync(buffer);
  const allEntries = Object.values(zip.files).filter(
    (entry) => !entry.dir && !entry.name.startsWith('__MACOSX/')
  );

  if (allEntries.length === 0) {
    throw new Error(`O arquivo ZIP/NBP "${outerFileName}" está vazio.`);
  }

  // Pass 1: Extract embedded tulipa & observation images (cap raised to 2500 for dual-GIF T15Nav packages)
  const zipImages: ZipImageIndex = {
    byFullPath: new Map(),
    byBaseName: new Map(),
    byStem: new Map(),
    byNumber: new Map(),
    byNumberList: new Map(),
    entries: [],
  };

  const dataEntries: JSZip.JSZipObject[] = [];
  let imgCount = 0;

  for (const entry of allEntries) {
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
    const mime = IMAGE_MIME_MAP[ext];
    if (mime) {
      if (imgCount < 2500) {
        try {
          const bytes = await entry.async('uint8array');
          const dims = parseImageDimensionsFromBytes(bytes, ext);
          const b64 = uint8ToBase64(bytes);
          const dataUrl = `data:${mime};base64,${b64}`;
          const normPath = entry.name.replace(/\\/g, '/').toLowerCase();
          const base = normPath.split('/').pop() || normPath;
          const stem = base.replace(/\.[^.]+$/, '');
          const imgEntry: ZipImageEntry = {
            dataUrl,
            normPath,
            baseName: base,
            stem,
            width: dims.width,
            height: dims.height,
          };
          zipImages.entries.push(imgEntry);
          zipImages.byFullPath.set(normPath, dataUrl);
          zipImages.byBaseName.set(base, dataUrl);
          zipImages.byStem.set(stem, dataUrl);

          const tulNum = extractTulipaNumberFromImagePath(normPath, stem);
          if (tulNum !== null && Number.isFinite(tulNum)) {
            if (!zipImages.byNumber.has(tulNum)) {
              zipImages.byNumber.set(tulNum, dataUrl);
            }
            const existingList = zipImages.byNumberList.get(tulNum) ?? [];
            existingList.push(imgEntry);
            zipImages.byNumberList.set(tulNum, existingList);
          }
          imgCount += 1;
        } catch {
          // Ignore single unreadable image
        }
      }
    } else {
      dataEntries.push(entry);
    }
  }

  // Sort data candidates by relevance
  dataEntries.sort((a, b) => getZipEntryPriority(a.name) - getZipEntryPriority(b.name));

  let bestRoadbook: ParsedRoadbook | null = null;
  const parsedCandidates: ParsedRoadbook[] = [];
  const inspectedNames: string[] = [];

  for (const entry of dataEntries) {
    const entryBuf = await entry.async('arraybuffer');
    inspectedNames.push(`${entry.name} (${Math.max(1, Math.round(entryBuf.byteLength / 1024))} KB)`);

    // Nested ZIP/NBP container
    if (isZipBuffer(entryBuf)) {
      try {
        const nested = await parseZipContainer(entryBuf, outerFileName, depth + 1);
        parsedCandidates.push(applyZipImagesToRoadbook(nested, zipImages));
        if (!bestRoadbook || nested.tulipas.length > bestRoadbook.tulipas.length) {
          bestRoadbook = applyZipImagesToRoadbook(nested, zipImages);
        }
      } catch {
        // Continue trying other entries
      }
      continue;
    }

    // Internal SQLite database inside ZIP (.nbp / .bin)
    if (isSqliteBuffer(entryBuf)) {
      const fromSqlite = await tryParseSqliteBuffer(
        entryBuf,
        outerFileName,
        'NBP-SQLite',
        zipImages
      );
      if (fromSqlite) {
        const enriched = applyZipImagesToRoadbook(fromSqlite, zipImages);
        parsedCandidates.push(enriched);
        if (!bestRoadbook || enriched.tulipas.length > bestRoadbook.tulipas.length) {
          bestRoadbook = enriched;
        }
      }
      continue;
    }

    // Gzip / Zlib compressed entry inside ZIP
    const decompressedEntry = await tryDecompressGzipOrZlib(entryBuf);
    if (decompressedEntry) {
      try {
        const innerParsed = await parseNavigationBuffer(decompressedEntry, outerFileName, 'nbp');
        const enriched = applyZipImagesToRoadbook(innerParsed, zipImages);
        parsedCandidates.push(enriched);
        if (!bestRoadbook || enriched.tulipas.length > bestRoadbook.tulipas.length) {
          bestRoadbook = enriched;
        }
        continue;
      } catch {
        // Continue trying plain text / binary
      }
    }

    const { text, isBinary } = decodeBufferToText(entryBuf);
    if (isBinary) {
      const unwrapped = await tryUnwrapEmbeddedContainer(entryBuf, outerFileName, 'nbp');
      if (unwrapped) {
        const enriched = applyZipImagesToRoadbook(unwrapped, zipImages);
        parsedCandidates.push(enriched);
        if (!bestRoadbook || enriched.tulipas.length > bestRoadbook.tulipas.length) {
          bestRoadbook = enriched;
        }
        continue;
      }
    }

    const parsed = tryParsePlainTextPayload(text, outerFileName, zipImages);
    if (parsed) {
      const tagged = {
        ...parsed,
        sourceFormat: parsed.sourceFormat || 'NBP-ZIP',
      };
      parsedCandidates.push(tagged);
      if (!bestRoadbook || tagged.tulipas.length > bestRoadbook.tulipas.length) {
        bestRoadbook = tagged;
      }
    } else {
      const binRecords = tryParseBinarySequentialRecords(
        entryBuf,
        outerFileName,
        zipImages
      );
      if (binRecords && binRecords.tulipas.length >= 2) {
        const tagged = applyZipImagesToRoadbook(binRecords, zipImages);
        parsedCandidates.push(tagged);
        if (!bestRoadbook || tagged.tulipas.length > bestRoadbook.tulipas.length) {
          bestRoadbook = tagged;
        }
      }
    }
  }

  // Merge matching tulipas + disjoint sections across multiple ZIP entries
  if (parsedCandidates.length > 1 && bestRoadbook) {
    const bySecTul = new Map<string, RoadbookTulipa>();
    const byTulOnly = new Map<number, RoadbookTulipa>();
    for (const t of bestRoadbook.tulipas) {
      bySecTul.set(`${t.section ?? 0}:${t.tulipa}`, t);
      if (!byTulOnly.has(t.tulipa)) byTulOnly.set(t.tulipa, t);
    }

    const extras: RoadbookTulipa[] = [];
    for (const cand of parsedCandidates) {
      if (cand === bestRoadbook) continue;
      for (const t of cand.tulipas) {
        const key = `${t.section ?? 0}:${t.tulipa}`;
        const existing = bySecTul.get(key) ?? (cand.tulipas.length === bestRoadbook.tulipas.length ? byTulOnly.get(t.tulipa) : undefined);
        if (existing) {
          if (!existing.notes && t.notes) existing.notes = t.notes;
          if (!existing.imageDataUrl && t.imageDataUrl) existing.imageDataUrl = t.imageDataUrl;
          if (existing.cap === null && t.cap !== null) existing.cap = t.cap;
          if ((existing.avgSpeedKmh === null || existing.avgSpeedKmh === undefined) && t.avgSpeedKmh) {
            existing.avgSpeedKmh = t.avgSpeedKmh;
          }
          if (existing.idealTimeMs === null && t.idealTimeMs !== null) {
            existing.idealTimeMs = t.idealTimeMs;
            existing.idealTimeStr = t.idealTimeStr;
          }
        } else {
          bySecTul.set(key, t);
          extras.push(t);
        }
      }
    }
    if (extras.length > 0 && bestRoadbook.tulipas.length < 3000) {
      const combined = [...bestRoadbook.tulipas, ...extras].sort(
        (a, b) => (a.section ?? 0) - (b.section ?? 0) || a.tulipa - b.tulipa
      );
      bestRoadbook = {
        ...bestRoadbook,
        tulipas: combined,
      };
    }
  }

  // Fallback for auxiliary note-only files inside a .nbp.zip (e.g., obs.txt or obs.xml keyed by tulipa number)
  if (bestRoadbook && bestRoadbook.tulipas.some((t) => !t.notes)) {
    const tulMap = new Map<number, RoadbookTulipa>();
    for (const t of bestRoadbook.tulipas) {
      if (!tulMap.has(t.tulipa)) tulMap.set(t.tulipa, t);
    }
    for (const entry of dataEntries) {
      if (!/\.(txt|csv|xml|obs|ini|json)$/i.test(entry.name)) continue;
      try {
        const buf = await entry.async('arraybuffer');
        const { text } = decodeBufferToText(buf);
        const xmlNotes = text.includes('<') ? parseXmlNodesUniversal(text).nodes : [];
        if (xmlNotes.length > 0) {
          for (const node of xmlNotes) {
            const num = parseInt(node.fields['tulipa'] || node.fields['tul'] || node.fields['id'] || node.fields['numero'] || node.fields['ref'] || '', 10);
            const target = Number.isFinite(num) ? tulMap.get(num) : undefined;
            if (target && !target.notes) {
              const note = collectNotesWithFallback((k) => node.fields[k] ?? '', Object.entries(node.fields));
              if (note) target.notes = note;
            }
          }
        } else {
          for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
            const m = rawLine.trim().match(/^(\d{1,4})\s*[|;\t=:]\s*(.+)$/);
            if (m) {
              const num = parseInt(m[1], 10);
              const candidateNote = m[2].trim();
              const target = tulMap.get(num);
              if (target && !target.notes && isLikelyNoteText(candidateNote)) {
                target.notes = candidateNote;
              }
            }
          }
        }
      } catch {
        // Ignore unreadable auxiliary file
      }
    }
  }

  if (bestRoadbook) {
    return enrichRoadbookForNavigation({
      ...bestRoadbook,
      fileName: outerFileName,
      sourceFormat: bestRoadbook.sourceFormat || 'NBP-ZIP',
    });
  }

  const previewList = inspectedNames.slice(0, 6).join(', ');
  throw new Error(
    `O arquivo "${outerFileName}" foi descompactado (${previewList || 'sem tabelas'}), porém não foram encontrados registros legíveis de referências, quilometragem ou tempos.`
  );
}

function isSqliteBuffer(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 16) return false;
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 16));
  return head.startsWith('SQLite format 3');
}

function blobBytesToImageDataUrl(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  let mime: string | null = null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    mime = 'image/png';
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mime = 'image/jpeg';
  } else if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    mime = 'image/gif';
  } else if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    mime = 'image/bmp';
  } else {
    const snippet = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 120)).trim();
    if (snippet.startsWith('<svg')) {
      mime = 'image/svg+xml';
    }
  }
  if (!mime) return undefined;

  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function parseSqliteTimeValue(val: unknown): { str: string; ms: number | null } {
  if (val === null || val === undefined) return { str: '', ms: null };
  if (typeof val === 'number' && Number.isFinite(val)) {
    if (val >= 0 && val < 1) {
      // Excel / Delphi TDateTime fractional day
      const ms = Math.round(val * 86400000);
      return { str: formatMsToIdealStr(ms), ms };
    }
    if (val > 86400) {
      // Likely milliseconds or epoch offset
      const ms = val > 1e10 ? Math.round(val % 86400000) : Math.round(val);
      return { str: formatMsToIdealStr(ms), ms };
    }
    const ms = Math.round(val * 1000);
    return { str: formatMsToIdealStr(ms), ms };
  }
  const str = String(val).trim();
  const ms = parseFlexibleTimeToMs(str, 'sec');
  return {
    str: ms !== null && (!str || /^\d+(\.\d+)?$/.test(str)) ? formatMsToIdealStr(ms) : str,
    ms,
  };
}

async function tryParseSqliteBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  sourceFormat = 'SQLite',
  zipImages?: ZipImageIndex
): Promise<ParsedRoadbook | null> {
  if (!isSqliteBuffer(buffer)) return null;

  try {
    const SQL = await getSqlJs();
    const db = new SQL.Database(new Uint8Array(buffer));

    try {
      const tableRes = db.exec(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%';"
      );
      const tableNames = (tableRes[0]?.values ?? [])
        .map((r) => String(r[0]))
        .filter(Boolean);

      if (tableNames.length === 0) return null;

      let eventName = fileName.replace(/\.(nbp|bin|db|sqlite|sqlite3|zip)$/i, '');
      let category: string | undefined;

      // Pass 1: Look for race metadata/parameters table
      for (const tbl of tableNames) {
        const lowerTbl = tbl.toLowerCase();
        if (
          /prova|evento|header|cabecalho|info|param|config|meta|rally/i.test(lowerTbl)
        ) {
          try {
            const safeTbl = `"${tbl.replace(/"/g, '""')}"`;
            const metaRes = db.exec(`SELECT * FROM ${safeTbl} LIMIT 10;`);
            if (metaRes[0] && metaRes[0].values.length > 0) {
              const cols = metaRes[0].columns.map((c) => normKey(c));
              for (const row of metaRes[0].values) {
                cols.forEach((ck, ci) => {
                  const v = row[ci];
                  if (v === null || v === undefined) return;
                  const s = String(v).trim();
                  if (!s) return;
                  if (
                    ck === 'nome' ||
                    ck === 'evento' ||
                    ck === 'prova' ||
                    ck === 'titulo' ||
                    ck === 'name' ||
                    ck === 'eventname'
                  ) {
                    eventName = s.slice(0, 80);
                  } else if (ck.includes('categ') || ck === 'classe' || ck === 'nivel') {
                    category = s;
                  }
                });
              }
            }
          } catch {
            // Ignore unreadable metadata table
          }
        }
      }

      // Pass 2: Find best roadbook references table
      let bestTulipas: RoadbookTulipa[] = [];

      for (const tbl of tableNames) {
        const safeTbl = `"${tbl.replace(/"/g, '""')}"`;
        let res;
        try {
          res = db.exec(`SELECT * FROM ${safeTbl};`);
        } catch {
          continue;
        }
        if (!res[0] || res[0].values.length < 2) continue;

        const cols = res[0].columns;
        const normCols = cols.map((c) => normKey(c));

        const findCol = (candidates: string[]): number => {
          for (const cand of candidates) {
            const nc = normKey(cand);
            const exact = normCols.indexOf(nc);
            if (exact >= 0) return exact;
          }
          for (const cand of candidates) {
            const nc = normKey(cand);
            const partial = normCols.findIndex((c) => c.includes(nc));
            if (partial >= 0) return partial;
          }
          return -1;
        };

        const idxTul = findCol(['tulipa', 'tul', 'numero', 'num', 'ref', 'ordem', 'seq', 'id']);
        const idxTotalKm = findCol([
          'totalkm',
          'kmtotal',
          'disttotal',
          'distanciatotal',
          'odometro',
          'km',
          'dist',
        ]);
        const idxTotalM = findCol(['totalm', 'distm', 'metros', 'distanciametros']);
        const idxInterKm = findCol([
          'interkm',
          'kmparcial',
          'parcial',
          'inter',
          'trechokm',
          'dif',
          'diferenca',
        ]);
        const idxInterM = findCol(['interm', 'parcialm', 'metrosinter']);
        const idxLat = findCol(['lat', 'latitude', 'y']);
        const idxLon = findCol(['lon', 'lng', 'longitude', 'x']);
        const idxCap = findCol(['cap', 'rumo', 'heading', 'azimute', 'direcao']);
        const idxSpeed = findCol([
          'avgspeedkmh',
          'veltdn',
          'tdn',
          'velocidade',
          'velocidademedia',
          'veloc',
          'vel',
          'media',
          'vmedia',
          'vm',
          'pmm',
          'speed',
        ]);
        const idxTime = findCol([
          'idealtime',
          'tempoideal',
          'tempo',
          'horaideal',
          'hora',
          'tempototal',
          'time',
        ]);
        const idxType = findCol(['type', 'typ', 'tipo', 'modo']);
        const idxSec = findCol(['section', 'sec', 'secao', 'trecho']);
        const idxImg = findCol(['imagem', 'img', 'figura', 'tulipaimg', 'icon', 'foto', 'blob']);

        const noteIndices: number[] = [];
        normCols.forEach((nc, i) => {
          if (
            NOTE_FIELD_KEYS.some((k) => nc === k || nc.includes(k)) &&
            !noteIndices.includes(i)
          ) {
            noteIndices.push(i);
          }
        });

        // Must have at least distance or speed/time columns to qualify as roadbook table
        const signalCount =
          (idxTotalKm >= 0 || idxTotalM >= 0 ? 2 : 0) +
          (idxInterKm >= 0 || idxInterM >= 0 ? 1 : 0) +
          (idxSpeed >= 0 ? 1 : 0) +
          (idxTime >= 0 ? 1 : 0) +
          (idxLat >= 0 && idxLon >= 0 ? 1 : 0);

        if (signalCount < 2) continue;

        const parsedRows: RoadbookTulipa[] = [];
        let accKm = 0;

        res[0].values.forEach((row, rIdx) => {
          const readNum = (ci: number): number | null => {
            if (ci < 0) return null;
            const v = row[ci];
            if (v === null || v === undefined) return null;
            if (typeof v === 'number') return Number.isFinite(v) ? v : null;
            return parseFlexNumber(String(v));
          };

          const tulNumRaw = readNum(idxTul);
          const tulipa =
            tulNumRaw !== null && Number.isInteger(tulNumRaw) && tulNumRaw > 0
              ? tulNumRaw
              : rIdx + 1;

          const interKmFromM = readNum(idxInterM);
          const interKmRaw = readNum(idxInterKm);
          const interKm =
            interKmRaw !== null
              ? interKmRaw > 100 && idxInterM < 0 && normCols[idxInterKm].includes('dist')
                ? Number((interKmRaw / 1000).toFixed(3))
                : interKmRaw
              : interKmFromM !== null
                ? Number((interKmFromM / 1000).toFixed(3))
                : 0;

          const totalFromM = readNum(idxTotalM);
          const totalKmRaw = readNum(idxTotalKm);
          let totalKm =
            totalKmRaw !== null
              ? totalKmRaw
              : totalFromM !== null
                ? Number((totalFromM / 1000).toFixed(3))
                : null;
          if (totalKm === null) {
            accKm += interKm;
            totalKm = Number(accKm.toFixed(3));
          } else {
            accKm = totalKm;
          }

          const latRaw = idxLat >= 0 ? row[idxLat] : null;
          const lonRaw = idxLon >= 0 ? row[idxLon] : null;
          const lat =
            typeof latRaw === 'number'
              ? latRaw
              : latRaw !== null && latRaw !== undefined
                ? parseCoordinateValue(String(latRaw)) ?? 0
                : 0;
          const lon =
            typeof lonRaw === 'number'
              ? lonRaw
              : lonRaw !== null && lonRaw !== undefined
                ? parseCoordinateValue(String(lonRaw)) ?? 0
                : 0;

          const capRaw = readNum(idxCap);
          const cap = capRaw !== null ? Math.round(capRaw) : null;
          const rawSpeedCell = idxSpeed >= 0 && row[idxSpeed] !== null ? String(row[idxSpeed]).trim() : '';
          const parsedVelTdn = rawSpeedCell ? parseVelTdnValue(rawSpeedCell) : {};
          const { str: idealTimeStr, ms: idealTimeMs } =
            idxTime >= 0 ? parseSqliteTimeValue(row[idxTime]) : { str: '', ms: null };

          const typeRaw = idxType >= 0 && row[idxType] !== null ? String(row[idxType]) : '';
          const explicitType = typeRaw ? normalizeTypeToken(typeRaw) || normalizeType(typeRaw) : '';
          const type = explicitType || parsedVelTdn.typeHint || 'V';
          const secNum = readNum(idxSec);
          const section = secNum !== null ? Math.round(secNum) : null;

          const noteLines: string[] = [];
          const seenNotes = new Set<string>();
          const pushNote = (val: unknown) => {
            if (val !== null && val !== undefined && !(val instanceof Uint8Array)) {
              const s = String(val).trim();
              if (s && !seenNotes.has(s.toLowerCase())) {
                seenNotes.add(s.toLowerCase());
                noteLines.push(s);
              }
            }
          };
          for (const ni of noteIndices) {
            pushNote(row[ni]);
          }
          if (noteLines.length === 0) {
            const knownCols = new Set([idxTul, idxTotalKm, idxTotalM, idxInterKm, idxInterM, idxLat, idxLon, idxCap, idxSpeed, idxTime, idxType, idxSec, idxImg]);
            normCols.forEach((nc, ci) => {
              if (knownCols.has(ci) || RESERVED_NON_NOTE_KEY_RE.test(nc)) return;
              const rv = row[ci];
              if (typeof rv === 'string' && isLikelyNoteText(rv)) {
                pushNote(rv);
              }
            });
          }

          let imageDataUrl: string | undefined;
          if (idxImg >= 0 && row[idxImg] !== null && row[idxImg] !== undefined) {
            const iv = row[idxImg];
            if (iv instanceof Uint8Array) {
              imageDataUrl = blobBytesToImageDataUrl(iv);
            } else {
              imageDataUrl = lookupZipImage(zipImages, tulipa, String(iv));
            }
          }
          if (!imageDataUrl) {
            imageDataUrl = lookupZipImage(zipImages, tulipa);
          }

          parsedRows.push({
            tulipa,
            totalKm,
            interKm,
            lat,
            lon,
            cap,
            idealTimeStr,
            idealTimeMs,
            type,
            section,
            avgSpeedKmh: parsedVelTdn.avgSpeedKmh ?? null,
            tdnMs: parsedVelTdn.tdnMs ?? null,
            notes: noteLines.length > 0 ? noteLines.join('\n') : undefined,
            imageDataUrl,
          });
        });

        if (parsedRows.length > bestTulipas.length) {
          bestTulipas = parsedRows;
        }
      }

      if (bestTulipas.length === 0) return null;

      return enrichRoadbookForNavigation({
        eventName,
        fileName,
        sourceFormat,
        tulipas: bestTulipas,
        countV: bestTulipas.filter((t) => t.type === 'V').length,
        countD: bestTulipas.filter((t) => t.type === 'D').length,
        countN: bestTulipas.filter((t) => t.type === 'N').length,
        totalKm: bestTulipas[bestTulipas.length - 1]?.totalKm ?? 0,
        raceParameters: {
          category,
          speedsKmh: [],
          notesCount: 0,
          sectionsCount: 0,
          imagesCount: 0,
        },
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function tryDecompressGzipOrZlib(buffer: ArrayBuffer): Promise<ArrayBuffer | null> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || typeof DecompressionStream === 'undefined') return null;

  let format: 'gzip' | 'deflate' | null = null;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    format = 'gzip';
  } else if (bytes[0] === 0x78 && (bytes[1] === 0x9c || bytes[1] === 0xda || bytes[1] === 0x01)) {
    format = 'deflate';
  }
  if (!format) return null;

  try {
    const ds = new DecompressionStream(format);
    const stream = new Blob([buffer]).stream().pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * Extracts structured text lines/records embedded inside proprietary binary roadbook streams
 * (.nbp / .bin) using ASCII, Latin-1 or UTF-16LE scanning when records contain tabular data or observations.
 */
function tryParseBinarySequentialRecords(
  buffer: ArrayBuffer,
  fileName: string,
  zipImages?: ZipImageIndex
): ParsedRoadbook | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 16) return null;

  // 1. Collect readable ASCII/Windows-1252/Latin-1 segments separated by control bytes
  const asciiSegments: string[] = [];
  let currBytes: number[] = [];
  const win1252Decoder = new TextDecoder('windows-1252', { fatal: false });
  const flushCurr = () => {
    if (currBytes.length >= 3) {
      const str = win1252Decoder.decode(new Uint8Array(currBytes)).trim();
      if (str.length >= 3) asciiSegments.push(str);
    }
    currBytes = [];
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if ((b >= 32 && b <= 126) || b >= 128 || b === 9) {
      currBytes.push(b);
    } else {
      flushCurr();
    }
  }
  flushCurr();

  // 2. Also inspect UTF-16LE decoded text lines (common in Windows/Delphi/CE rally exporters)
  const utf16Text = new TextDecoder('utf-16le', { fatal: false })
    .decode(bytes)
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, '\n');

  for (const candidateText of [asciiSegments.join('\n'), utf16Text]) {
    const parsed = tryParsePlainTextPayload(candidateText, fileName, zipImages);
    if (parsed && parsed.tulipas.length >= 2) {
      return {
        ...parsed,
        sourceFormat: 'BIN-Registro',
      };
    }
  }

  return null;
}

/**
 * Scans proprietary binary headers (.nbp, .bin FullRally, .rbk Rabbit) for embedded
 * ZIP, SQLite, Gzip or Zlib streams at non-zero offsets.
 */
async function tryUnwrapEmbeddedContainer(
  buffer: ArrayBuffer,
  fileName: string,
  formatHint: ImportFormatHint
): Promise<ParsedRoadbook | null> {
  const bytes = new Uint8Array(buffer);
  const scanLimit = Math.min(bytes.length - 8, 16384);
  if (scanLimit <= 0) return null;

  for (let offset = 1; offset < scanLimit; offset++) {
    // Embedded PKZIP (`PK\x03\x04`)
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x03 &&
      bytes[offset + 3] === 0x04
    ) {
      try {
        return await parseZipContainer(buffer.slice(offset), fileName, 0);
      } catch {
        // Keep scanning
      }
    }

    // Embedded SQLite (`SQLite format 3`)
    if (
      bytes[offset] === 0x53 &&
      bytes[offset + 1] === 0x51 &&
      bytes[offset + 2] === 0x4c &&
      bytes[offset + 3] === 0x69 &&
      offset + 15 < bytes.length
    ) {
      const slice = buffer.slice(offset);
      if (isSqliteBuffer(slice)) {
        const res = await tryParseSqliteBuffer(
          slice,
          fileName,
          formatHint === 'rbk' ? 'Rabbit-RBK-SQLite' : formatHint === 'bin' ? 'FullRally-BIN-SQLite' : 'NBP-SQLite'
        );
        if (res) return res;
      }
    }

    // Embedded Gzip (`1F 8B 08`) or Zlib (`78 9C` / `78 DA`)
    if (
      (bytes[offset] === 0x1f && bytes[offset + 1] === 0x8b && bytes[offset + 2] === 0x08) ||
      (bytes[offset] === 0x78 && (bytes[offset + 1] === 0x9c || bytes[offset + 1] === 0xda))
    ) {
      const inflated = await tryDecompressGzipOrZlib(buffer.slice(offset));
      if (inflated && inflated.byteLength >= 24) {
        try {
          return await parseNavigationBuffer(inflated, fileName, formatHint);
        } catch {
          // Keep scanning if false signature match
        }
      }
    }
  }

  return null;
}

function tagDetectedSourceFormat(
  parsed: ParsedRoadbook,
  fileName: string,
  formatHint: ImportFormatHint
): ParsedRoadbook {
  const lower = fileName.toLowerCase();
  const existing = parsed.sourceFormat;
  if (formatHint === 'rbk' || lower.endsWith('.rbk')) {
    return { ...parsed, sourceFormat: existing && existing !== 'TXT' ? existing : 'Rabbit-RBK' };
  }
  if (formatHint === 'bin' || lower.endsWith('.bin')) {
    return { ...parsed, sourceFormat: existing && existing !== 'TXT' ? existing : 'FullRally-BIN' };
  }
  if (formatHint === 'nbp' || lower.endsWith('.nbp')) {
    return { ...parsed, sourceFormat: existing && existing !== 'TXT' ? existing : 'T15-NBP' };
  }
  return parsed;
}

export async function parseNavigationBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  formatHint: ImportFormatHint = 'auto'
): Promise<ParsedRoadbook> {
  // 1. Unpack ZIP / compressed containers directly (.nbp T15, .rbk / .zip wrappers)
  if (isZipBuffer(buffer)) {
    const res = await parseZipContainer(buffer, fileName, 0);
    return tagDetectedSourceFormat(res, fileName, formatHint);
  }

  // 2. Direct SQLite database (.nbp / .bin / .rbk / .db / .sqlite)
  if (isSqliteBuffer(buffer)) {
    const lower = fileName.toLowerCase();
    const label =
      formatHint === 'rbk' || lower.endsWith('.rbk')
        ? 'Rabbit-RBK-SQLite'
        : formatHint === 'bin' || lower.endsWith('.bin')
          ? 'FullRally-BIN-SQLite'
          : 'T15-NBP-SQLite';
    const sqliteParsed = await tryParseSqliteBuffer(buffer, fileName, label);
    if (sqliteParsed) return sqliteParsed;
  }

  // 3. Direct Gzip / Zlib compressed payload
  const decompressed = await tryDecompressGzipOrZlib(buffer);
  if (decompressed) {
    return parseNavigationBuffer(decompressed, fileName, formatHint);
  }

  const { text, isBinary, signatureHex } = decodeBufferToText(buffer);

  // 4. If file is clearly binary, check wrapped containers (ZIP / SQLite / Gzip / Zlib) before plain text heuristics
  if (isBinary) {
    const unwrapped = await tryUnwrapEmbeddedContainer(buffer, fileName, formatHint);
    if (unwrapped) return tagDetectedSourceFormat(unwrapped, fileName, formatHint);
  }

  // 5. Plain structured parsers (JSON -> XML/GPX -> TXT -> Flexible/INI)
  const parsed = tryParsePlainTextPayload(text, fileName);
  if (parsed) return tagDetectedSourceFormat(parsed, fileName, formatHint);

  // 6. Embedded container offset scanning fallback for text-headed wrappers
  if (!isBinary) {
    const unwrapped = await tryUnwrapEmbeddedContainer(buffer, fileName, formatHint);
    if (unwrapped) return tagDetectedSourceFormat(unwrapped, fileName, formatHint);
  }

  // 7. Binary sequential record extraction fallback (ASCII / Latin1 / UTF-16LE)
  const binaryRecords = tryParseBinarySequentialRecords(buffer, fileName);
  if (binaryRecords) return tagDetectedSourceFormat(binaryRecords, fileName, formatHint);

  // 7. Honest technical diagnostic tailored to T15 (.NBP), FullRally (.BIN) or Rabbit (.RBK)
  const lower = fileName.toLowerCase();
  const detectedKind =
    formatHint !== 'auto'
      ? formatHint
      : lower.endsWith('.rbk')
        ? 'rbk'
        : lower.endsWith('.bin')
          ? 'bin'
          : lower.endsWith('.nbp')
            ? 'nbp'
            : 'auto';

  if (isBinary) {
    if (detectedKind === 'rbk') {
      throw new Error(
        `O arquivo Rabbit "${fileName}" usa container binário protegido/criptografado (assinatura ${signatureHex}). Arquivos .RBK fechados por senha ou chave proprietária não expõem os dados em aberto; exporte a planilha pelo Rabbit/planilhador em .NBP aberto, .TXT, .CSV ou .XML.`
      );
    }
    if (detectedKind === 'bin') {
      throw new Error(
        `O arquivo FullRally "${fileName}" usa container binário proprietário compilado (assinatura ${signatureHex}) sem fluxo ZIP/SQLite/texto legível exposto. Exporte a prova em .NBP aberto (T15), .TXT, .CSV ou .XML para conversão integral.`
      );
    }
    throw new Error(
      `O arquivo "${fileName}" usa formato binário fechado (assinatura ${signatureHex}) criptografado/proprietário sem registros estruturados expostos. Converta ou exporte a planilha no gerador em .NBP aberto, .TXT, .CSV, .XML ou SQLite sem criptografia.`
    );
  }

  throw new Error(
    `Não foi possível reconhecer a estrutura de "${fileName}". Use um arquivo .NBP (T15), .BIN (FullRally aberto), .RBK (Rabbit aberto), .TXT, .CSV, .XML, .SQLite ou .JSON com os registros do roadbook.`
  );
}

/**
 * Given current odometer distance (km), returns the ideal elapsed time (ms)
 * interpolated linearly between surrounding roadbook tulipas.
 */
export function interpolateIdealTimeAtKm(
  tulipas: RoadbookTulipa[],
  odometerKm: number
): number | null {
  if (tulipas.length === 0) return null;

  const valid = tulipas.filter((t) => t.idealTimeMs !== null);
  if (valid.length === 0) return null;

  if (odometerKm <= valid[0].totalKm) return valid[0].idealTimeMs;
  const last = valid[valid.length - 1];
  if (odometerKm >= last.totalKm) return last.idealTimeMs;

  for (let i = 0; i < valid.length - 1; i++) {
    const a = valid[i];
    const b = valid[i + 1];
    if (odometerKm >= a.totalKm && odometerKm <= b.totalKm) {
      const spanKm = b.totalKm - a.totalKm;
      if (spanKm <= 0) return b.idealTimeMs;
      const ratio = (odometerKm - a.totalKm) / spanKm;
      return Math.round(
        (a.idealTimeMs ?? 0) + ratio * ((b.idealTimeMs ?? 0) - (a.idealTimeMs ?? 0))
      );
    }
  }

  return null;
}

/**
 * Given elapsed race time (ms), returns the ideal odometer position (km)
 * interpolated linearly between surrounding roadbook tulipas (for Knav meters early/late).
 */
export function interpolateKmAtElapsedMs(
  tulipas: RoadbookTulipa[],
  elapsedMs: number
): number | null {
  if (tulipas.length === 0) return null;

  const valid = tulipas.filter((t) => t.idealTimeMs !== null);
  if (valid.length === 0) return null;

  if (elapsedMs <= (valid[0].idealTimeMs ?? 0)) return valid[0].totalKm;
  const last = valid[valid.length - 1];
  if (elapsedMs >= (last.idealTimeMs ?? 0)) return last.totalKm;

  for (let i = 0; i < valid.length - 1; i++) {
    const a = valid[i];
    const b = valid[i + 1];
    const tA = a.idealTimeMs ?? 0;
    const tB = b.idealTimeMs ?? 0;
    if (elapsedMs >= tA && elapsedMs <= tB) {
      const spanMs = tB - tA;
      if (spanMs <= 0) return b.totalKm;
      const ratio = (elapsedMs - tA) / spanMs;
      return Number((a.totalKm + ratio * (b.totalKm - a.totalKm)).toFixed(4));
    }
  }

  return null;
}

/**
 * Finds the active tulipa index matching current odometer km (last tulipa whose totalKm <= odometerKm, or closest).
 */
export function findActiveTulipaIndexByKm(
  tulipas: RoadbookTulipa[],
  effectiveKm: number
): number {
  if (tulipas.length === 0) return 0;
  const firstKm = tulipas[0].totalKm;
  if (effectiveKm <= firstKm + 0.001) {
    return 0;
  }
  let active = 0;
  for (let i = 1; i < tulipas.length; i++) {
    const tKm = tulipas[i].totalKm;
    // Prevent duplicate 0.00 start rows from jumping past Tulipa 1 prematurely
    if (tKm <= firstKm + 0.001 && effectiveKm < firstKm + 0.03) {
      continue;
    }
    if (tKm <= effectiveKm + 0.0005) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}

function extractPrintableStringsSummary(
  bytes: Uint8Array,
  maxBytesToScan = 131072
): {
  hexLines: string[];
  asciiStrings: string[];
  utf16Strings: string[];
} {
  const hexLimit = Math.min(bytes.length, 256);
  const hexLines: string[] = [];
  for (let i = 0; i < hexLimit; i += 16) {
    const slice = bytes.slice(i, Math.min(hexLimit, i + 16));
    const hexPart = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ')
      .padEnd(47, ' ');
    const asciiPart = Array.from(slice)
      .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
      .join('');
    hexLines.push(`${i.toString(16).padStart(4, '0')}: ${hexPart} | ${asciiPart}`);
  }

  const scanLen = Math.min(bytes.length, maxBytesToScan);
  const win1252 = new TextDecoder('windows-1252', { fatal: false });
  const asciiStrings: string[] = [];
  const seenAscii = new Set<string>();
  let curr: number[] = [];
  const flushAscii = () => {
    if (curr.length >= 4) {
      const str = win1252.decode(new Uint8Array(curr)).trim();
      if (str.length >= 4 && /[A-Za-zÀ-ÿ0-9]{2,}/.test(str) && !seenAscii.has(str)) {
        seenAscii.add(str);
        asciiStrings.push(str);
      }
    }
    curr = [];
  };
  for (let i = 0; i < scanLen; i++) {
    const b = bytes[i];
    if ((b >= 32 && b <= 126) || b >= 128 || b === 9) {
      curr.push(b);
    } else {
      flushAscii();
    }
  }
  flushAscii();

  // Also extract UTF-16LE readable strings on both even & odd alignments (Delphi/Windows/Android exports)
  const utf16Strings: string[] = [];
  const seenU16 = new Set<string>();
  const utf16Decoder = new TextDecoder('utf-16le', { fatal: false });
  for (const byteAlign of [0, 1]) {
    if (scanLen <= byteAlign + 2) continue;
    const utf16Raw = utf16Decoder.decode(bytes.slice(byteAlign, scanLen));
    for (const part of utf16Raw.split(/[\u0000-\u001f\uFFFD]+/)) {
      const clean = part.trim();
      if (
        clean.length >= 4 &&
        /[A-Za-zÀ-ÿ0-9]{3,}/.test(clean) &&
        /^[\x20-\x7EÀ-ÿ\s.,;:!?/()\-+'"]+$/.test(clean) &&
        !seenU16.has(clean)
      ) {
        seenU16.add(clean);
        utf16Strings.push(clean);
      }
    }
  }

  return { hexLines, asciiStrings, utf16Strings };
}

/**
 * Generates a concise structural diagnostic report for a .NBP / .NBP.ZIP / roadbook file
 * (container signature, ZIP entries, XML tags/fields, SQLite tables/columns, CSV lines, or binary hex+strings)
 * so any unknown dialect or missing field can be inspected in seconds.
 */
export async function inspectRoadbookFileStructure(
  buffer: ArrayBuffer,
  fileName: string,
  depth = 0
): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const sizeKb = (buffer.byteLength / 1024).toFixed(1);
  const sigHex = Array.from(bytes.slice(0, 12))
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
  const lines: string[] = [
    `Arquivo: ${fileName} (${sizeKb} KB · assinatura ${sigHex || '--'})`,
  ];

  if (isZipBuffer(buffer) && depth < 2) {
    try {
      const zip = await JSZip.loadAsync(buffer);
      const entries = Object.values(zip.files).filter(
        (e) => !e.dir && !e.name.startsWith('__MACOSX/')
      );
      lines.push(`Container: ZIP (${entries.length} arquivos internos)`);
      const imgEntries = entries.filter((e) =>
        Boolean(IMAGE_MIME_MAP[e.name.split('.').pop()?.toLowerCase() ?? ''])
      );
      const nonImgs = entries
        .filter((e) => !IMAGE_MIME_MAP[e.name.split('.').pop()?.toLowerCase() ?? ''])
        .sort((a, b) => getZipEntryPriority(a.name) - getZipEntryPriority(b.name));
      if (imgEntries.length > 0) {
        const sampleImgs: string[] = [];
        for (const ie of imgEntries.slice(0, 15)) {
          try {
            const b = await ie.async('uint8array');
            const ext = ie.name.split('.').pop()?.toLowerCase() ?? '';
            const dims = parseImageDimensionsFromBytes(b, ext);
            sampleImgs.push(
              dims.width > 0 ? `${ie.name} (${dims.width}x${dims.height})` : ie.name
            );
          } catch {
            sampleImgs.push(ie.name);
          }
        }
        lines.push(`Imagens (${imgEntries.length}): ${sampleImgs.join(', ')}`);
      }
      lines.push(
        `Entradas de dados (${nonImgs.length}): ${nonImgs.slice(0, 20).map((e) => e.name).join(', ') || '(somente imagens)'}`
      );
      for (const dataEntry of nonImgs.slice(0, 4)) {
        const innerBuf = await dataEntry.async('arraybuffer');
        lines.push(`--- [${dataEntry.name}] ---`);
        lines.push(await inspectRoadbookFileStructure(innerBuf, dataEntry.name, depth + 1));
      }
      return lines.join('\n').slice(0, 5500);
    } catch {
      lines.push('Container: ZIP inválido/corrompido');
    }
  }

  if (isSqliteBuffer(buffer)) {
    try {
      const SQL = await getSqlJs();
      const db = new SQL.Database(bytes);
      try {
        const tblRes = db.exec(
          "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%';"
        );
        const tables = (tblRes[0]?.values ?? []).map((r) => String(r[0]));
        lines.push(`Container: SQLite (${tables.length} tabelas: ${tables.join(', ')})`);
        for (const tbl of tables.slice(0, 6)) {
          const safeTbl = `"${tbl.replace(/"/g, '""')}"`;
          const sampleRes = db.exec(`SELECT * FROM ${safeTbl} LIMIT 4;`);
          if (sampleRes[0]) {
            lines.push(`Tabela [${tbl}] colunas: ${sampleRes[0].columns.join(' | ')}`);
            sampleRes[0].values.forEach((row, rIdx) => {
              const formatted = row
                .map((v) =>
                  v instanceof Uint8Array ? `<BLOB ${v.length}B>` : String(v ?? '').slice(0, 80)
                )
                .join(' | ');
              lines.push(`  Linha ${rIdx + 1}: ${formatted}`);
            });
          }
        }
      } finally {
        db.close();
      }
      return lines.join('\n').slice(0, 5500);
    } catch {
      lines.push('Container: SQLite (falha ao abrir esquema)');
    }
  }

  if (depth < 2) {
    const decompressed = await tryDecompressGzipOrZlib(buffer);
    if (decompressed) {
      lines.push('Compactação: Gzip/Zlib detectado');
      lines.push(await inspectRoadbookFileStructure(decompressed, fileName, depth + 1));
      return lines.join('\n').slice(0, 5500);
    }
  }

  const { text, isBinary } = decodeBufferToText(buffer);
  lines.push(`Tipo: ${isBinary ? 'Binário / Texto misto' : 'Texto legível'}`);

  if (text.includes('<') && text.includes('>')) {
    const { nodes, rootTitle } = parseXmlNodesUniversal(text);
    if (nodes.length > 0) {
      lines.push(`XML detectado: ${nodes.length} nós (tag "${nodes[0].tag}", título "${rootTitle ?? '-'}")`);
      nodes.slice(0, 3).forEach((n, idx) => {
        const keysSummary = Object.entries(n.fields)
          .map(([k, v]) => `${k}=${v.replace(/\s+/g, ' ').slice(0, 80)}`)
          .join('; ');
        lines.push(`Nó ${idx + 1} <${n.tag}>: ${keysSummary}`);
      });
      return lines.join('\n').slice(0, 5500);
    }
  }

  if (isBinary) {
    const { hexLines, asciiStrings, utf16Strings } = extractPrintableStringsSummary(bytes);
    lines.push('Cabeçalho Hex (primeiros bytes):');
    lines.push(...hexLines.slice(0, 8));
    if (asciiStrings.length > 0) {
      lines.push(`Strings Latin1/UTF-8 (${asciiStrings.length}): ${asciiStrings.slice(0, 35).map((s) => s.slice(0, 80)).join(' | ')}`);
    }
    if (utf16Strings.length > 0) {
      lines.push(`Strings UTF-16LE (${utf16Strings.length}): ${utf16Strings.slice(0, 25).map((s) => s.slice(0, 80)).join(' | ')}`);
    }
    return lines.join('\n').slice(0, 5500);
  }

  const textLines = text
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (textLines.length > 0) {
    lines.push(`Primeiras ${Math.min(12, textLines.length)} linhas (de ${textLines.length}):`);
    textLines.slice(0, 12).forEach((l, i) => {
      lines.push(`${String(i + 1).padStart(2, '0')}: ${l.slice(0, 200)}`);
    });
  }

  return lines.join('\n').slice(0, 5500);
}

/**
 * Generates an expanded plain-text (.TXT) diagnostic bundle stripping image blobs
 * so the user can attach/share .nbp or .nbp.zip contents in chat platforms that only accept .txt/.pdf.
 */
export async function extractRoadbookDiagnosticDataTxt(
  buffer: ArrayBuffer,
  fileName: string,
  depth = 0
): Promise<string> {
  const out: string[] = [];
  if (depth === 0) {
    out.push('=== DIAGNÓSTICO DE DADOS ROADBOOK (.NBP / .NBP.ZIP) ===');
    out.push(await inspectRoadbookFileStructure(buffer, fileName, 0));
    out.push('');
    out.push('=== AMOSTRA DOS DADOS SEM IMAGENS ===');
  }

  if (isZipBuffer(buffer) && depth < 2) {
    try {
      const zip = await JSZip.loadAsync(buffer);
      const entries = Object.values(zip.files)
        .filter((e) => !e.dir && !e.name.startsWith('__MACOSX/'))
        .filter((e) => !IMAGE_MIME_MAP[e.name.split('.').pop()?.toLowerCase() ?? ''])
        .sort((a, b) => getZipEntryPriority(a.name) - getZipEntryPriority(b.name));

      for (const entry of entries.slice(0, 6)) {
        const innerBuf = await entry.async('arraybuffer');
        out.push(`\n>>> ENTRADA: ${entry.name} (${innerBuf.byteLength} bytes) <<<`);
        out.push(await extractRoadbookDiagnosticDataTxt(innerBuf, entry.name, depth + 1));
      }
      return out.join('\n').slice(0, 120000);
    } catch {
      out.push('(Erro ao abrir ZIP interno)');
      return out.join('\n');
    }
  }

  if (depth < 2) {
    const decompressed = await tryDecompressGzipOrZlib(buffer);
    if (decompressed) {
      out.push('(Conteúdo Gzip/Zlib descompactado)');
      out.push(await extractRoadbookDiagnosticDataTxt(decompressed, fileName, depth + 1));
      return out.join('\n').slice(0, 120000);
    }
  }

  const bytes = new Uint8Array(buffer);
  if (isSqliteBuffer(buffer)) {
    try {
      const SQL = await getSqlJs();
      const db = new SQL.Database(bytes);
      try {
        const schemaRes = db.exec("SELECT name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%';");
        for (const row of schemaRes[0]?.values ?? []) {
          const tbl = String(row[0]);
          out.push(`-- Tabela ${tbl}: ${String(row[1] ?? '')}`);
          const dataRes = db.exec(`SELECT * FROM "${tbl.replace(/"/g, '""')}" LIMIT 25;`);
          if (dataRes[0]) {
            out.push(`COLUNAS: ${dataRes[0].columns.join(' | ')}`);
            dataRes[0].values.forEach((r, idx) => {
              out.push(
                `${String(idx + 1).padStart(2, '0')}: ` +
                  r.map((v) => (v instanceof Uint8Array ? `<BLOB ${v.length}B>` : String(v ?? '').replace(/\s+/g, ' ').slice(0, 120))).join(' | ')
              );
            });
          }
        }
      } finally {
        db.close();
      }
      return out.join('\n').slice(0, 120000);
    } catch {
      out.push('(Falha ao ler tabelas SQLite)');
    }
  }

  const { text, isBinary } = decodeBufferToText(buffer);
  if (!isBinary) {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    out.push(...lines.slice(0, 200));
    if (lines.length > 200) {
      out.push(`... (+${lines.length - 200} linhas omitidas)`);
    }
    return out.join('\n').slice(0, 120000);
  }

  const { hexLines, asciiStrings, utf16Strings } = extractPrintableStringsSummary(bytes, 524288);
  out.push('HEX PREVIEW:');
  out.push(...hexLines);
  out.push(`ASCII/WIN1252 STRINGS (${asciiStrings.length}):`);
  out.push(...asciiStrings.slice(0, 150));
  out.push(`UTF-16LE STRINGS (${utf16Strings.length}):`);
  out.push(...utf16Strings.slice(0, 150));
  if (bytes.length <= 65536) {
    let binStr = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binStr += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    out.push('BASE64_DATA_ENTRY_START');
    out.push(btoa(binStr));
    out.push('BASE64_DATA_ENTRY_END');
  }
  return out.join('\n').slice(0, 120000);
}


