/**
 * Crops composite T15 / roadbook GIF strips that contain 3 squares on the left
 * (Distance | Desenho | Vel/TDN) + 1 observation rectangle on the right.
 * Removes cell border strokes, trims uniform outer margins around actual ink/text,
 * and makes the light cell background transparent so cropped graphics blend cleanly
 * at maximum readable size on any row background (white, yellow, blue, green, dark).
 */

const obsRectCache = new Map<string, string>();
const desSquareCache = new Map<string, string>();

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load error'));
    img.src = src;
  });
}

function detectVerticalGridDividers(
  data: Uint8ClampedArray,
  width: number,
  height: number
): number[] {
  const rawXs: number[] = [];
  const yStart = Math.max(1, Math.floor(height * 0.08));
  const yEnd = Math.min(height - 1, Math.ceil(height * 0.92));
  const spanY = Math.max(1, yEnd - yStart);

  for (let x = 0; x < width; x++) {
    let darkCount = 0;
    for (let y = yStart; y < yEnd; y++) {
      const idx = (y * width + x) * 4;
      const a = data[idx + 3];
      if (a < 30) continue;
      const lum = (data[idx] * 299 + data[idx + 1] * 587 + data[idx + 2] * 114) / 1000;
      if (lum < 155) {
        darkCount += 1;
      }
    }
    if (darkCount / spanY >= 0.72) {
      rawXs.push(x);
    }
  }

  const dividers: number[] = [];
  for (const x of rawXs) {
    if (dividers.length === 0 || x - dividers[dividers.length - 1] > 4) {
      dividers.push(x);
    } else {
      dividers[dividers.length - 1] = x;
    }
  }
  return dividers;
}

function detectHorizontalFrameInset(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  sx: number,
  sw: number
): { topY: number; bottomY: number } {
  const checkRowDarkRatio = (y: number) => {
    let dark = 0;
    const xEnd = Math.min(width, sx + sw);
    const total = Math.max(1, xEnd - sx);
    for (let x = sx; x < xEnd; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx + 3] < 30) continue;
      const lum = (data[idx] * 299 + data[idx + 1] * 587 + data[idx + 2] * 114) / 1000;
      if (lum < 155) dark += 1;
    }
    return dark / total;
  };

  let topY = 2;
  for (let y = 0; y < Math.min(8, Math.floor(height * 0.15)); y++) {
    if (checkRowDarkRatio(y) >= 0.65) {
      topY = y + 2;
    }
  }

  let bottomY = height - 2;
  for (let y = height - 1; y >= Math.max(0, height - Math.min(8, Math.floor(height * 0.15))); y--) {
    if (checkRowDarkRatio(y) >= 0.65) {
      bottomY = y - 1;
    }
  }

  return {
    topY: Math.max(0, Math.min(height - 12, topY)),
    bottomY: Math.max(topY + 10, Math.min(height, bottomY)),
  };
}

/**
 * Normalizes light uniform cell background to transparent and trims empty margins around
 * ink pixels so the graphic/text renders at maximum scale without background tint mismatches.
 */
function cropTightCleanCell(
  sourceCanvas: HTMLCanvasElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  padPx = 3
): string | null {
  if (sw <= 6 || sh <= 6) return null;
  const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!srcCtx) return null;

  const region = srcCtx.getImageData(sx, sy, sw, sh);
  const d = region.data;

  // Estimate corner/background light color inside cell
  let bgR = 255;
  let bgG = 255;
  let bgB = 255;
  let lightSamples = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let y = 0; y < sh; y += 2) {
    for (let x = 0; x < sw; x += 2) {
      const idx = (y * sw + x) * 4;
      if (d[idx + 3] < 40) continue;
      const lum = (d[idx] * 299 + d[idx + 1] * 587 + d[idx + 2] * 114) / 1000;
      if (lum >= 210) {
        sumR += d[idx];
        sumG += d[idx + 1];
        sumB += d[idx + 2];
        lightSamples += 1;
      }
    }
  }
  if (lightSamples > 0) {
    bgR = sumR / lightSamples;
    bgG = sumG / lightSamples;
    bgB = sumB / lightSamples;
  }

  let minX = sw;
  let minY = sh;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const idx = (y * sw + x) * 4;
      const a = d[idx + 3];
      if (a < 30) continue;

      const r = d[idx];
      const g = d[idx + 1];
      const b = d[idx + 2];
      const lum = (r * 299 + g * 587 + b * 114) / 1000;
      const distBg = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);

      // Strip uniform light background pixels so no grey/off-white tint box appears
      const isBackground = lum >= 205 && distBg < 48;
      if (isBackground) {
        d[idx + 3] = 0;
      } else {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Empty cell -> return small transparent/fallback
  if (maxX < minX || maxY < minY) {
    const emptyOut = document.createElement('canvas');
    emptyOut.width = sw;
    emptyOut.height = sh;
    const eCtx = emptyOut.getContext('2d');
    if (eCtx) eCtx.putImageData(region, 0, 0);
    return emptyOut.toDataURL('image/png');
  }

  const tightX = Math.max(0, minX - padPx);
  const tightY = Math.max(0, minY - padPx);
  const tightW = Math.min(sw - tightX, maxX - tightX + 1 + padPx);
  const tightH = Math.min(sh - tightY, maxY - tightY + 1 + padPx);

  const stage = document.createElement('canvas');
  stage.width = sw;
  stage.height = sh;
  const stageCtx = stage.getContext('2d');
  if (!stageCtx) return null;
  stageCtx.putImageData(region, 0, 0);

  const out = document.createElement('canvas');
  out.width = Math.max(1, tightW);
  out.height = Math.max(1, tightH);
  const outCtx = out.getContext('2d');
  if (!outCtx) return null;
  outCtx.drawImage(stage, tightX, tightY, tightW, tightH, 0, 0, tightW, tightH);
  return out.toDataURL('image/png');
}

/**
 * Preserves the vertical cell height of observation rectangles so 1-line, 2-line, and
 * 3-line rows keep uniform font scale, while trimming empty horizontal margins around the
 * actual ink/text on the left and right sides so text fills mobile columns cleanly.
 */
function cleanCellPreserveScale(
  sourceCanvas: HTMLCanvasElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  padX = 4
): string | null {
  if (sw <= 6 || sh <= 6) return null;
  const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!srcCtx) return null;

  const region = srcCtx.getImageData(sx, sy, sw, sh);
  const d = region.data;

  let bgR = 255;
  let bgG = 255;
  let bgB = 255;
  let lightSamples = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let y = 0; y < sh; y += 2) {
    for (let x = 0; x < sw; x += 2) {
      const idx = (y * sw + x) * 4;
      if (d[idx + 3] < 40) continue;
      const lum = (d[idx] * 299 + d[idx + 1] * 587 + d[idx + 2] * 114) / 1000;
      if (lum >= 210) {
        sumR += d[idx];
        sumG += d[idx + 1];
        sumB += d[idx + 2];
        lightSamples += 1;
      }
    }
  }
  if (lightSamples > 0) {
    bgR = sumR / lightSamples;
    bgG = sumG / lightSamples;
    bgB = sumB / lightSamples;
  }

  let minX = sw;
  let maxX = -1;

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const idx = (y * sw + x) * 4;
      const a = d[idx + 3];
      if (a < 30) continue;

      const r = d[idx];
      const g = d[idx + 1];
      const b = d[idx + 2];
      const lum = (r * 299 + g * 587 + b * 114) / 1000;
      const distBg = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);

      if (lum >= 205 && distBg < 48) {
        d[idx + 3] = 0;
      } else {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }

  const stage = document.createElement('canvas');
  stage.width = sw;
  stage.height = sh;
  const stageCtx = stage.getContext('2d');
  if (!stageCtx) return null;
  stageCtx.putImageData(region, 0, 0);

  // If no visible ink in observation box, keep tight empty output
  if (maxX < minX) {
    const emptyOut = document.createElement('canvas');
    emptyOut.width = 4;
    emptyOut.height = sh;
    return emptyOut.toDataURL('image/png');
  }

  const tightX = Math.max(0, minX - padX);
  const tightW = Math.min(sw - tightX, maxX - tightX + 1 + padX);

  const out = document.createElement('canvas');
  out.width = Math.max(4, tightW);
  out.height = sh;
  const outCtx = out.getContext('2d');
  if (!outCtx) return null;
  outCtx.drawImage(stage, tightX, 0, tightW, sh, 0, 0, tightW, sh);
  return out.toDataURL('image/png');
}

export async function extractObservationRectangle(src: string): Promise<string> {
  if (!src || typeof document === 'undefined') return src;
  const cached = obsRectCache.get(src);
  if (cached) return cached;

  try {
    const img = await loadImageElement(src);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return src;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return src;
    ctx.drawImage(img, 0, 0);

    // Non-composite observation image: preserve exact aspect & scale while stripping light bg
    if (w < h * 1.9) {
      const cleaned = cleanCellPreserveScale(canvas, 0, 0, w, h) || src;
      obsRectCache.set(src, cleaned);
      return cleaned;
    }

    const imgData = ctx.getImageData(0, 0, w, h);
    const allDividers = detectVerticalGridDividers(imgData.data, w, h);
    const internalDividers = allDividers.filter(
      (x) => x > Math.max(8, w * 0.05) && x < w - Math.max(16, w * 0.12)
    );

    let cropX = 0;
    if (internalDividers.length >= 2) {
      const rightMost = internalDividers[internalDividers.length - 1];
      if (w - rightMost >= h * 1.05) {
        cropX = rightMost + 3;
      } else if (internalDividers.length >= 3) {
        cropX = internalDividers[2] + 3;
      }
    }

    if (cropX === 0) {
      cropX = Math.min(Math.round(w * 0.56), Math.round(h * 3.02));
      if (cropX >= w - Math.max(30, h * 0.9)) {
        cropX = Math.round(w * 0.5);
      }
    }

    const rightEdge = allDividers.find((x) => x >= w - 6) ?? w;
    const sx = Math.max(0, Math.min(w - 16, cropX));
    const sw = Math.max(12, rightEdge - sx - 3);
    const { topY, bottomY } = detectHorizontalFrameInset(imgData.data, w, h, sx, sw);
    const sh = Math.max(10, bottomY - topY);

    const cropped = cleanCellPreserveScale(canvas, sx, topY, sw, sh) || src;
    obsRectCache.set(src, cropped);
    return cropped;
  } catch {
    return src;
  }
}

export async function extractDesenhoSquare(src: string): Promise<string> {
  if (!src || typeof document === 'undefined') return src;
  const cached = desSquareCache.get(src);
  if (cached) return cached;

  try {
    const img = await loadImageElement(src);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return src;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return src;
    ctx.drawImage(img, 0, 0);

    if (w < h * 1.9) {
      const cleaned = cropTightCleanCell(canvas, 0, 0, w, h, 3) || src;
      desSquareCache.set(src, cleaned);
      return cleaned;
    }

    const imgData = ctx.getImageData(0, 0, w, h);
    const allDividers = detectVerticalGridDividers(imgData.data, w, h);
    const internalDividers = allDividers.filter(
      (x) => x > Math.max(6, w * 0.04) && x < w - 16
    );

    let sx = Math.round(h);
    let sw = Math.round(h);
    if (internalDividers.length >= 2) {
      sx = internalDividers[0] + 3;
      sw = Math.max(16, internalDividers[1] - internalDividers[0] - 5);
    } else if (internalDividers.length === 1) {
      sx = 3;
      sw = Math.max(16, internalDividers[0] - 5);
    }

    const { topY, bottomY } = detectHorizontalFrameInset(imgData.data, w, h, sx, sw);
    const sh = Math.max(10, bottomY - topY);

    const cropped = cropTightCleanCell(canvas, sx, topY, sw, sh, 3) || src;
    desSquareCache.set(src, cropped);
    return cropped;
  } catch {
    return src;
  }
}
