import React, { useEffect, useState } from 'react';
import { Clock, Delete, X } from 'lucide-react';

interface TimeCalculatorModalProps {
  open: boolean;
  onClose: () => void;
}

type OpSymbol = '+' | '-' | '×' | '÷';

function digitsToMinutes(digits: string): number {
  if (!digits) return 0;
  const clean = digits.replace(/\D/g, '');
  if (!clean) return 0;
  const padded = clean.padStart(3, '0');
  const mins = parseInt(padded.slice(-2), 10);
  const hours = parseInt(padded.slice(0, -2), 10);
  return hours * 60 + mins;
}

function formatDigitsAsAtmTime(digits: string): string {
  const clean = digits.replace(/\D/g, '');
  if (!clean) return '0:00';
  const padded = clean.padStart(3, '0');
  const mins = padded.slice(-2);
  const hours = String(parseInt(padded.slice(0, -2), 10));
  return `${hours}:${mins}`;
}

function formatMinutesAsTime(totalMinutes: number, clock24hMode: boolean): string {
  const rounded = Math.round(totalMinutes);
  if (clock24hMode) {
    const wrapped = ((rounded % 1440) + 1440) % 1440;
    const h = Math.floor(wrapped / 60);
    const m = wrapped % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
  }
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}:${String(m).padStart(2, '0')}`;
}

function minutesToCanonicalDigits(totalMinutes: number): string {
  const abs = Math.abs(Math.round(totalMinutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${h}${String(m).padStart(2, '0')}`;
}

export const TimeCalculatorModal: React.FC<TimeCalculatorModalProps> = ({ open, onClose }) => {
  const [rawDigits, setRawDigits] = useState<string>('');
  const [accMinutes, setAccMinutes] = useState<number | null>(null);
  const [pendingOp, setPendingOp] = useState<OpSymbol | null>(null);
  const [historyText, setHistoryText] = useState<string>('');
  const [resultDisplayMinutes, setResultDisplayMinutes] = useState<number | null>(null);
  const [hasTypedAfterOp, setHasTypedAfterOp] = useState<boolean>(false);
  const [clock24hMode, setClock24hMode] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isScalarMode = pendingOp === '×' || pendingOp === '÷';

  const clearAll = () => {
    setRawDigits('');
    setAccMinutes(null);
    setPendingOp(null);
    setHistoryText('');
    setResultDisplayMinutes(null);
    setHasTypedAfterOp(false);
    setErrorMsg(null);
  };

  const applyBinary = (leftMin: number, op: OpSymbol, rightValDigits: string): number | null => {
    if (op === '+') {
      return leftMin + digitsToMinutes(rightValDigits);
    }
    if (op === '-') {
      return leftMin - digitsToMinutes(rightValDigits);
    }
    const factor = parseInt(rightValDigits || '0', 10);
    if (op === '×') {
      return Math.round(leftMin * factor);
    }
    if (op === '÷') {
      if (!factor || factor === 0) {
        setErrorMsg('Divisão por zero');
        return null;
      }
      return Math.round(leftMin / factor);
    }
    return leftMin;
  };

  const pressDigit = (d: string) => {
    setErrorMsg(null);
    setResultDisplayMinutes(null);

    if (d === '00') {
      setRawDigits((prev) => {
        if (!prev) return '';
        if (prev.length >= 7) return prev;
        return `${prev}00`.slice(0, 8);
      });
      setHasTypedAfterOp(true);
      return;
    }

    setRawDigits((prev) => {
      if (prev === '' && d === '0') return '';
      if (prev.length >= 8) return prev;
      return `${prev}${d}`;
    });
    setHasTypedAfterOp(true);
  };

  const pressBackspace = () => {
    setErrorMsg(null);
    if (resultDisplayMinutes !== null) {
      const canonical = minutesToCanonicalDigits(resultDisplayMinutes);
      setResultDisplayMinutes(null);
      setRawDigits(canonical.slice(0, -1));
      setHasTypedAfterOp(true);
      return;
    }
    setRawDigits((prev) => prev.slice(0, -1));
  };

  const pressOperator = (op: OpSymbol) => {
    setErrorMsg(null);

    // Chained calculation if user already entered right operand
    if (accMinutes !== null && pendingOp !== null && hasTypedAfterOp && rawDigits !== '') {
      const computed = applyBinary(accMinutes, pendingOp, rawDigits);
      if (computed === null) return;
      const leftLabel = formatMinutesAsTime(computed, clock24hMode);
      setAccMinutes(computed);
      setPendingOp(op);
      setHistoryText(`${leftLabel} ${op}`);
      setRawDigits('');
      setHasTypedAfterOp(false);
      setResultDisplayMinutes(computed);
      return;
    }

    // Starting or changing operator
    let baseMin = accMinutes;
    if (resultDisplayMinutes !== null && !hasTypedAfterOp) {
      baseMin = resultDisplayMinutes;
    } else if (baseMin === null || hasTypedAfterOp) {
      baseMin = digitsToMinutes(rawDigits);
    }

    setAccMinutes(baseMin);
    setPendingOp(op);
    setHistoryText(`${formatMinutesAsTime(baseMin, clock24hMode)} ${op}`);
    setRawDigits('');
    setHasTypedAfterOp(false);
    setResultDisplayMinutes(baseMin);
  };

  const pressEquals = () => {
    setErrorMsg(null);
    if (accMinutes === null || pendingOp === null) {
      if (rawDigits) {
        const val = digitsToMinutes(rawDigits);
        setHistoryText(`${formatDigitsAsAtmTime(rawDigits)} =`);
        setResultDisplayMinutes(val);
        setRawDigits('');
        setHasTypedAfterOp(false);
      }
      return;
    }

    const rightStr =
      hasTypedAfterOp && rawDigits !== ''
        ? rawDigits
        : isScalarMode
          ? '1'
          : '0';

    const computed = applyBinary(accMinutes, pendingOp, rightStr);
    if (computed === null) return;

    const leftText = formatMinutesAsTime(accMinutes, clock24hMode);
    const rightText = isScalarMode
      ? String(parseInt(rightStr || '0', 10))
      : formatDigitsAsAtmTime(rightStr);

    setHistoryText(`${leftText} ${pendingOp} ${rightText} =`);
    setResultDisplayMinutes(computed);
    setAccMinutes(computed);
    setPendingOp(null);
    setRawDigits('');
    setHasTypedAfterOp(false);
  };

  // Keyboard support inside calculator modal
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        pressDigit(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        pressBackspace();
      } else if (e.key === '+') {
        e.preventDefault();
        pressOperator('+');
      } else if (e.key === '-') {
        e.preventDefault();
        pressOperator('-');
      } else if (e.key === '*') {
        e.preventDefault();
        pressOperator('×');
      } else if (e.key === '/') {
        e.preventDefault();
        pressOperator('÷');
      } else if (e.key === 'Enter' || e.key === '=') {
        e.preventDefault();
        pressEquals();
      } else if (e.key.toLowerCase() === 'c') {
        e.preventDefault();
        clearAll();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!open) return null;

  const mainDisplay = errorMsg
    ? errorMsg
    : hasTypedAfterOp || (resultDisplayMinutes === null && pendingOp === null)
      ? isScalarMode
        ? String(parseInt(rawDigits || '0', 10))
        : formatDigitsAsAtmTime(rawDigits)
      : resultDisplayMinutes !== null
        ? formatMinutesAsTime(resultDisplayMinutes, clock24hMode)
        : '0:00';

  const numBtnClass =
    'min-h-[58px] rounded-xl border border-zinc-700/80 bg-[#F4F4F4] text-2xl font-extrabold text-[#080B0D] shadow-sm transition-transform active:scale-[0.96] hover:bg-white sm:min-h-[64px]';
  const opBtnClass =
    'min-h-[58px] rounded-xl border border-zinc-700 bg-[#2A2D34] text-2xl font-extrabold text-white shadow-sm transition-transform active:scale-[0.96] hover:bg-zinc-700 sm:min-h-[64px]';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-3 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="Calculadora de Tempo"
    >
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-zinc-700/90 bg-[#111214] text-white shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 bg-[#080B0D] px-4 py-3">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-[#E10600]" />
            <span className="font-['Barlow_Condensed'] text-lg font-extrabold tracking-wide uppercase">
              Calculadora de Tempo
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setClock24hMode((v) => !v)}
              className={`rounded-md border px-2 py-1 font-mono text-[10px] font-bold transition-colors ${
                clock24hMode
                  ? 'border-sky-500/60 bg-sky-950/50 text-sky-300'
                  : 'border-zinc-700 bg-[#181A1F] text-[#C0C4C9]'
              }`}
              title="Alterna entre total acumulado (>24h) e relógio de 24 horas"
            >
              {clock24hMode ? 'Relógio 24h' : 'Acumulado >24h'}
            </button>

            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 bg-[#181A1F] text-zinc-400 hover:text-white"
              aria-label="Fechar calculadora"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="p-3.5 sm:p-4 space-y-3">
          {/* Two-line High-Contrast ATM Display */}
          <div className="rounded-xl border border-zinc-800 bg-[#000000] px-4 py-3 text-right font-mono tabular-nums">
            <div className="min-h-[20px] truncate text-sm font-semibold text-[#B5B5B5]">
              {historyText || (isScalarMode ? 'Digite o multiplicador/divisor' : 'Horas & Minutos (digite corrido)')}
            </div>
            <div
              className={`mt-1 truncate font-extrabold tracking-tight ${
                errorMsg
                  ? 'text-2xl text-red-400'
                  : 'text-4xl text-white sm:text-5xl'
              }`}
            >
              {mainDisplay}
            </div>
          </div>

          {/* Exact 4x5 High-Contrast Keypad Grid */}
          <div className="grid grid-cols-4 gap-2 font-mono">
            {/* Row 1: C, Backspace, Divide, Multiply */}
            <button
              type="button"
              onClick={clearAll}
              className="min-h-[58px] rounded-xl border border-orange-500/40 bg-orange-500/20 text-xl font-extrabold text-orange-300 transition-transform active:scale-[0.96] hover:bg-orange-500/30 sm:min-h-[64px]"
            >
              C
            </button>
            <button
              type="button"
              onClick={pressBackspace}
              aria-label="Apagar último dígito"
              className="flex min-h-[58px] items-center justify-center rounded-xl border border-zinc-700 bg-[#1E1E22] text-white transition-transform active:scale-[0.96] hover:bg-zinc-800 sm:min-h-[64px]"
            >
              <Delete className="h-6 w-6" />
            </button>
            <button type="button" onClick={() => pressOperator('÷')} className={opBtnClass}>
              ÷
            </button>
            <button type="button" onClick={() => pressOperator('×')} className={opBtnClass}>
              ×
            </button>

            {/* Row 2: 7, 8, 9, - */}
            <button type="button" onClick={() => pressDigit('7')} className={numBtnClass}>
              7
            </button>
            <button type="button" onClick={() => pressDigit('8')} className={numBtnClass}>
              8
            </button>
            <button type="button" onClick={() => pressDigit('9')} className={numBtnClass}>
              9
            </button>
            <button type="button" onClick={() => pressOperator('-')} className={opBtnClass}>
              −
            </button>

            {/* Row 3: 4, 5, 6, + */}
            <button type="button" onClick={() => pressDigit('4')} className={numBtnClass}>
              4
            </button>
            <button type="button" onClick={() => pressDigit('5')} className={numBtnClass}>
              5
            </button>
            <button type="button" onClick={() => pressDigit('6')} className={numBtnClass}>
              6
            </button>
            <button type="button" onClick={() => pressOperator('+')} className={opBtnClass}>
              +
            </button>

            {/* Row 4 & 5: 1, 2, 3 | 0 (col-span-2), 00 | = (row-span-2) */}
            <button type="button" onClick={() => pressDigit('1')} className={numBtnClass}>
              1
            </button>
            <button type="button" onClick={() => pressDigit('2')} className={numBtnClass}>
              2
            </button>
            <button type="button" onClick={() => pressDigit('3')} className={numBtnClass}>
              3
            </button>
            <button
              type="button"
              onClick={pressEquals}
              className="row-span-2 flex items-center justify-center rounded-xl border border-emerald-400/50 bg-emerald-600 text-3xl font-extrabold text-white shadow-lg transition-transform active:scale-[0.97] hover:bg-emerald-500"
            >
              =
            </button>

            <button
              type="button"
              onClick={() => pressDigit('0')}
              className={`${numBtnClass} col-span-2`}
            >
              0
            </button>
            <button type="button" onClick={() => pressDigit('00')} className={numBtnClass}>
              00
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
