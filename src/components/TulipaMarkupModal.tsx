import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Highlighter,
  Mic,
  PenTool,
  RotateCcw,
  Save,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { RoadbookTulipa } from '../types/rally';
import {
  extractDesenhoSquare,
  extractObservationRectangle,
} from '../utils/imageCrop';
import {
  buildMarkupId,
  deleteTulipaMarkup,
  saveTulipaMarkup,
  type TulipaMarkup,
} from '../utils/tulipaMarkings';

type DrawTool = 'pen' | 'highlighter' | 'arrow';
type PenColor = '#dc2626' | '#0284c7' | '#0f172a';

const QUICK_TAGS = ['ROUBO', 'PERIGO', 'RADAR', 'LOMBADA', 'BURACO', 'CURVA CEGA'];

interface TulipaMarkupModalProps {
  open: boolean;
  roadbookKey: string;
  tulipa: RoadbookTulipa;
  initialMarkup?: TulipaMarkup;
  onClose: () => void;
  onSaved: (markup: TulipaMarkup) => void;
  onDeleted: (tulipaNum: number) => void;
}

export const TulipaMarkupModal: React.FC<TulipaMarkupModalProps> = ({
  open,
  roadbookKey,
  tulipa,
  initialMarkup,
  onClose,
  onSaved,
  onDeleted,
}) => {
  const [tool, setTool] = useState<DrawTool>('pen');
  const [penColor, setPenColor] = useState<PenColor>('#dc2626');
  const [noteText, setNoteText] = useState(initialMarkup?.noteText ?? '');
  const [audioDataUrl, setAudioDataUrl] = useState<string | undefined>(
    initialMarkup?.audioDataUrl
  );
  const [audioDurationSec, setAudioDurationSec] = useState<number | undefined>(
    initialMarkup?.audioDurationSec
  );
  const [isRecording, setIsRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [croppedDesenho, setCroppedDesenho] = useState<string | undefined>(
    tulipa.imageDataUrl
  );
  const [croppedObs, setCroppedObs] = useState<string | undefined>(
    tulipa.notesImageDataUrl
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const historyRef = useRef<string[]>([]);
  const isDrawingRef = useRef(false);
  const startPtRef = useRef<{ x: number; y: number } | null>(null);
  const arrowSnapshotRef = useRef<HTMLImageElement | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recordStartMsRef = useRef<number>(0);

  // Sync cropped underlying images
  useEffect(() => {
    if (!open) return;
    let active = true;
    const rawDes = tulipa.imageDataUrl;
    const rawObs =
      tulipa.notesImageDataUrl ||
      (tulipa.imageIsComposite ? tulipa.imageDataUrl : undefined);

    if (rawDes && tulipa.imageIsComposite) {
      extractDesenhoSquare(rawDes).then((url) => {
        if (active) setCroppedDesenho(url);
      });
    } else {
      setCroppedDesenho(rawDes);
    }

    if (rawObs) {
      extractObservationRectangle(rawObs).then((url) => {
        if (active) setCroppedObs(url);
      });
    } else {
      setCroppedObs(undefined);
    }

    return () => {
      active = false;
    };
  }, [open, tulipa]);

  // Restore saved drawing into canvas
  useEffect(() => {
    if (!open) return;
    setNoteText(initialMarkup?.noteText ?? '');
    setAudioDataUrl(initialMarkup?.audioDataUrl);
    setAudioDurationSec(initialMarkup?.audioDurationSec);
    setMicError(null);
    historyRef.current = [];

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (initialMarkup?.drawingDataUrl) {
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        historyRef.current = [canvas.toDataURL('image/png')];
      };
      img.src = initialMarkup.drawingDataUrl;
    }
  }, [open, initialMarkup]);

  // Cleanup recorder on close/unmount
  const stopAudioStream = useCallback(() => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== 'inactive'
      ) {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // Ignore
        }
      }
      stopAudioStream();
      setIsRecording(false);
    }
    return () => {
      stopAudioStream();
    };
  }, [open, stopAudioStream]);

  if (!open) return null;

  const getCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, rect.width);
    const scaleY = canvas.height / Math.max(1, rect.height);
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const pushHistory = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    historyRef.current.push(canvas.toDataURL('image/png'));
    if (historyRef.current.length > 20) {
      historyRef.current.shift();
    }
  };

  const drawArrowHead = (
    ctx: CanvasRenderingContext2D,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    color: string
  ) => {
    const headLen = 18;
    const angle = Math.atan2(toY - fromY, toX - fromX);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 4.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(
      toX - headLen * Math.cos(angle - Math.PI / 6),
      toY - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      toX - headLen * Math.cos(angle + Math.PI / 6),
      toY - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pushHistory();
    isDrawingRef.current = true;
    const pt = getCanvasPoint(e);
    startPtRef.current = pt;

    if (tool === 'arrow') {
      const snap = new Image();
      snap.src = canvas.toDataURL('image/png');
      arrowSnapshotRef.current = snap;
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (tool === 'highlighter') {
      ctx.strokeStyle = '#facc15';
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 22;
    } else {
      ctx.strokeStyle = penColor;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 4;
    }
    ctx.lineTo(pt.x + 0.1, pt.y + 0.1);
    ctx.stroke();
    ctx.restore();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const pt = getCanvasPoint(e);

    if (tool === 'arrow' && startPtRef.current) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (arrowSnapshotRef.current?.complete) {
        ctx.drawImage(arrowSnapshotRef.current, 0, 0, canvas.width, canvas.height);
      }
      drawArrowHead(
        ctx,
        startPtRef.current.x,
        startPtRef.current.y,
        pt.x,
        pt.y,
        penColor
      );
      return;
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (tool === 'highlighter') {
      ctx.strokeStyle = '#facc15';
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 22;
    } else {
      ctx.strokeStyle = penColor;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 4;
    }
    if (startPtRef.current) {
      ctx.beginPath();
      ctx.moveTo(startPtRef.current.x, startPtRef.current.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      startPtRef.current = pt;
    }
    ctx.restore();
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    startPtRef.current = null;
    arrowSnapshotRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  };

  const handleUndo = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const prevUrl = historyRef.current.pop();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (prevUrl) {
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.src = prevUrl;
    }
  };

  const handleClearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    pushHistory();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  const toggleQuickTag = (tag: string) => {
    setNoteText((prev) => {
      const upper = prev.trim();
      if (!upper) return tag;
      if (upper.toUpperCase().includes(tag)) return prev;
      return `${upper} · ${tag}`;
    });
  };

  const startRecording = async () => {
    setMicError(null);
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    ) {
      setMicError('Gravação de áudio não suportada neste aparelho/navegador.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          audioChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = () => {
        const elapsed = Math.max(
          1,
          Math.round((Date.now() - recordStartMsRef.current) / 1000)
        );
        const blob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        const reader = new FileReader();
        reader.onloadend = () => {
          if (typeof reader.result === 'string') {
            setAudioDataUrl(reader.result);
            setAudioDurationSec(elapsed);
          }
        };
        reader.readAsDataURL(blob);
        stopAudioStream();
        setIsRecording(false);
      };

      recordStartMsRef.current = Date.now();
      setRecordSec(0);
      setIsRecording(true);
      recorder.start();
      recordTimerRef.current = window.setInterval(() => {
        setRecordSec(Math.round((Date.now() - recordStartMsRef.current) / 1000));
      }, 250);
    } catch {
      setMicError('Permissão do microfone negada ou microfone ocupado.');
      stopAudioStream();
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== 'inactive'
    ) {
      mediaRecorderRef.current.stop();
    } else {
      stopAudioStream();
      setIsRecording(false);
    }
  };

  const isCanvasBlank = (canvas: HTMLCanvasElement): boolean => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return true;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] > 10) return false;
    }
    return true;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const canvas = canvasRef.current;
      const hasDrawing = canvas && !isCanvasBlank(canvas);
      const drawingDataUrl = hasDrawing ? canvas!.toDataURL('image/png') : undefined;
      const cleanNote = noteText.trim() || undefined;

      if (!drawingDataUrl && !cleanNote && !audioDataUrl) {
        await deleteTulipaMarkup(roadbookKey, tulipa.tulipa);
        onDeleted(tulipa.tulipa);
        onClose();
        return;
      }

      const markup: TulipaMarkup = {
        id: buildMarkupId(roadbookKey, tulipa.tulipa),
        roadbookKey,
        tulipaNum: tulipa.tulipa,
        drawingDataUrl,
        noteText: cleanNote,
        audioDataUrl,
        audioDurationSec,
        updatedAtMs: Date.now(),
      };
      await saveTulipaMarkup(markup);
      onSaved(markup);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAll = async () => {
    setSaving(true);
    try {
      await deleteTulipaMarkup(roadbookKey, tulipa.tulipa);
      onDeleted(tulipa.tulipa);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-3 backdrop-blur-xs">
      <div className="w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl border border-slate-700 bg-[#0d131f] text-slate-100 shadow-2xl">
        <div aria-hidden="true" className="h-1.5 w-full rally-track-stripe" />
        <div className="p-4 sm:p-5">
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-3">
            <div>
              <span className="text-[10px] font-bold tracking-widest text-sky-400 uppercase">
                Marcar Roubo / Levantamento
              </span>
              <h3 className="font-['Barlow_Condensed'] text-2xl font-extrabold italic text-white">
                Tulipa #{tulipa.tulipa} · {(tulipa.displayKm ?? tulipa.totalKm).toFixed(3).replace('.', ',')} km
              </h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-white"
              aria-label="Fechar marcações"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Drawing Toolbar */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setTool('pen')}
                className={`inline-flex min-h-[34px] items-center gap-1 rounded-lg px-2.5 text-xs font-semibold ${
                  tool === 'pen'
                    ? 'bg-sky-600 text-white'
                    : 'border border-slate-700 bg-slate-900 text-slate-300'
                }`}
              >
                <PenTool className="h-3.5 w-3.5" />
                <span>Caneta</span>
              </button>
              <button
                type="button"
                onClick={() => setTool('highlighter')}
                className={`inline-flex min-h-[34px] items-center gap-1 rounded-lg px-2.5 text-xs font-semibold ${
                  tool === 'highlighter'
                    ? 'bg-yellow-400 text-slate-950'
                    : 'border border-slate-700 bg-slate-900 text-slate-300'
                }`}
              >
                <Highlighter className="h-3.5 w-3.5" />
                <span>Marca-Texto</span>
              </button>
              <button
                type="button"
                onClick={() => setTool('arrow')}
                className={`inline-flex min-h-[34px] items-center gap-1 rounded-lg px-2.5 text-xs font-semibold ${
                  tool === 'arrow'
                    ? 'bg-sky-600 text-white'
                    : 'border border-slate-700 bg-slate-900 text-slate-300'
                }`}
              >
                <ArrowUpRight className="h-3.5 w-3.5" />
                <span>Seta</span>
              </button>

              {tool !== 'highlighter' && (
                <div className="ml-1 flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-2 py-1">
                  {(['#dc2626', '#0284c7', '#0f172a'] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setPenColor(c)}
                      aria-label={`Cor ${c}`}
                      className={`h-5 w-5 rounded-full border-2 ${
                        penColor === c ? 'border-white scale-110' : 'border-slate-600'
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleUndo}
                className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-xs font-semibold text-slate-200 hover:bg-slate-800"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Desfazer</span>
              </button>
              <button
                type="button"
                onClick={handleClearCanvas}
                className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-xs font-semibold text-red-300 hover:bg-slate-800"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Limpar</span>
              </button>
            </div>
          </div>

          {/* Drawing Canvas over Tulipa Preview */}
          <div className="relative mt-3 overflow-hidden rounded-xl border-2 border-slate-700 bg-white text-slate-950">
            <div className="pointer-events-none flex min-h-[168px] items-center gap-3 p-3 select-none">
              <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-slate-50 p-1">
                {croppedDesenho ? (
                  <img
                    src={croppedDesenho}
                    alt="Desenho da tulipa"
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <span className="font-mono text-xs font-bold text-slate-500">
                    CAP {tulipa.cap ?? 0}°
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                {croppedObs && (
                  <img
                    src={croppedObs}
                    alt="Observação"
                    className="max-h-24 w-full object-contain object-left"
                  />
                )}
                {tulipa.notes && (
                  <p className="text-xs font-extrabold uppercase text-slate-900">
                    {tulipa.notes}
                  </p>
                )}
              </div>
            </div>

            <canvas
              ref={canvasRef}
              width={720}
              height={220}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
            />
          </div>

          {/* Quick Tags + Text Note */}
          <div className="mt-4 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {QUICK_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleQuickTag(tag)}
                  className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 font-mono text-[11px] font-bold text-amber-300 hover:border-sky-500 hover:text-white"
                >
                  + {tag}
                </button>
              ))}
            </div>
            <textarea
              rows={2}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Anotação de roubo, pegadinha ou referência visual..."
              className="w-full rounded-xl border border-slate-700 bg-[#070b12] px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
            />
          </div>

          {/* Voice Recorder */}
          <div className="mt-4 rounded-xl border border-slate-800 bg-[#070b12] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <Mic className={`h-4 w-4 ${isRecording ? 'animate-pulse text-red-500' : 'text-sky-400'}`} />
                <span>
                  {isRecording
                    ? `Gravando áudio... 00:${String(recordSec).padStart(2, '0')}`
                    : 'Nota de Voz (Levantamento)'}
                </span>
              </div>

              <div className="flex items-center gap-2">
                {!isRecording ? (
                  <button
                    type="button"
                    onClick={startRecording}
                    className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg bg-red-600 px-3 text-xs font-bold text-white hover:bg-red-500"
                  >
                    <Mic className="h-3.5 w-3.5" />
                    <span>{audioDataUrl ? 'Regravar Áudio' : 'Gravar Áudio'}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={stopRecording}
                    className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg bg-amber-400 px-3 text-xs font-extrabold text-slate-950"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" />
                    <span>Parar</span>
                  </button>
                )}

                {audioDataUrl && !isRecording && (
                  <button
                    type="button"
                    onClick={() => {
                      setAudioDataUrl(undefined);
                      setAudioDurationSec(undefined);
                    }}
                    className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-xs font-semibold text-red-400 hover:bg-slate-800"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Excluir</span>
                  </button>
                )}
              </div>
            </div>

            {micError && (
              <p className="mt-2 text-xs text-red-400">{micError}</p>
            )}

            {audioDataUrl && (
              <div className="mt-2.5 flex items-center gap-3">
                <audio controls src={audioDataUrl} className="h-9 flex-1" />
                {audioDurationSec ? (
                  <span className="font-mono text-xs text-slate-400">
                    {audioDurationSec}s
                  </span>
                ) : null}
              </div>
            )}
          </div>

          {/* Footer Buttons */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
            <button
              type="button"
              disabled={saving}
              onClick={handleDeleteAll}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-red-500/40 bg-red-950/30 px-3.5 text-xs font-semibold text-red-300 hover:bg-red-950/60"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Remover Marcação</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="min-h-[40px] rounded-xl border border-slate-700 bg-slate-900 px-4 text-xs font-semibold text-slate-200 hover:bg-slate-800"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleSave}
                className="pitstop-btn-blue inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-5 text-xs font-extrabold tracking-wide text-white uppercase"
              >
                <Save className="h-3.5 w-3.5" />
                <span>{saving ? 'Salvando...' : 'Salvar Marcação'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
