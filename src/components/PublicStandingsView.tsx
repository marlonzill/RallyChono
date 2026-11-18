import React, { useEffect, useState } from 'react';
import {
  Award,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  ShieldAlert,
  Trophy,
} from 'lucide-react';
import type { PublishedStandingsSnapshot } from '../types/rally';
import { fetchPublicStandings } from '../utils/baseApi';
import { PitStopLogo } from './PitStopLogo';

interface PublicStandingsViewProps {
  slug: string;
}

export const PublicStandingsView: React.FC<PublicStandingsViewProps> = ({ slug }) => {
  const [snapshot, setSnapshot] = useState<PublishedStandingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchPublicStandings(slug)
      .then((data) => {
        if (active) setSnapshot(data);
      })
      .catch((err) => {
        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : 'Não foi possível carregar o resultado oficial.'
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [slug]);

  const downloadText = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl rounded-2xl border border-slate-800 bg-[#101622] p-10 text-center text-slate-300">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-sky-400" />
        <p className="mt-3 text-sm font-medium">Carregando classificação oficial...</p>
      </div>
    );
  }

  if (error || !snapshot) {
    return (
      <div className="mx-auto max-w-2xl rounded-2xl border border-red-800/60 bg-[#101622] p-8 text-center text-slate-200">
        <ShieldAlert className="mx-auto h-9 w-9 text-red-400" />
        <h2 className="mt-3 font-['Barlow_Condensed'] text-2xl font-bold text-white">
          Resultado não encontrado
        </h2>
        <p className="mt-1.5 text-sm text-slate-400">
          {error || 'Verifique se o link compartilhado está completo ou peça um novo link à organização PitStop Sports.'}
        </p>
      </div>
    );
  }

  const leader = snapshot.rows[0] ?? null;
  const second = snapshot.rows[1] ?? null;
  const third = snapshot.rows[2] ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-[#111214] text-[#F4F4F4] shadow-2xl">
        <div aria-hidden="true" className="pitstop-racing-line h-[10px] w-full sm:h-[12px]" />
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-center gap-4">
            <PitStopLogo
              variant="horizontal"
              className="h-10 w-auto shrink-0 sm:h-12"
            />
            <div>
              <p className="text-[11px] font-bold tracking-[0.18em] text-[#E10600] uppercase">
                Classificação Oficial · PitStop Sports
              </p>
              <h1 className="font-['Barlow_Condensed'] text-2xl font-extrabold italic text-white sm:text-3xl">
                {snapshot.eventName}
              </h1>
              <p className="mt-0.5 text-xs text-[#B5B5B5]">
                Publicado em {new Date(snapshot.publishedAtIso || snapshot.createdAt).toLocaleString('pt-BR')} ·{' '}
                {snapshot.rows.length} carros apurados · Penalidade NC: {snapshot.missedPenaltyPts} pts
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {snapshot.txtReport && (
              <button
                type="button"
                onClick={() =>
                  downloadText(
                    snapshot.txtReport,
                    `classificacao_${snapshot.slug}.txt`,
                    'text/plain;charset=utf-8'
                  )
                }
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3.5 text-xs font-semibold text-slate-100 hover:bg-slate-800"
              >
                <Download className="h-4 w-4 text-sky-400" />
                <span>Baixar TXT</span>
              </button>
            )}
            {snapshot.csvReport && (
              <button
                type="button"
                onClick={() =>
                  downloadText(
                    snapshot.csvReport,
                    `classificacao_${snapshot.slug}.csv`,
                    'text/csv;charset=utf-8'
                  )
                }
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3.5 text-xs font-semibold text-slate-100 hover:bg-slate-800"
              >
                <FileSpreadsheet className="h-4 w-4 text-emerald-400" />
                <span>Planilha CSV</span>
              </button>
            )}
          </div>
        </div>
      </section>

      {leader && (
        <section className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
          {[leader, second, third].map((row, idx) => {
            if (!row) return null;
            return (
              <div
                key={`${row.carNumber}-${row.position}`}
                className={`rounded-2xl border p-4 bg-[#101622] ${
                  idx === 0
                    ? 'border-red-500/50'
                    : idx === 1
                      ? 'border-sky-500/40'
                      : 'border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`inline-flex h-10 w-10 items-center justify-center rounded-xl font-['Barlow_Condensed'] text-xl font-extrabold italic text-white ${
                      idx === 0
                        ? 'rally-btn-red'
                        : idx === 1
                          ? 'pitstop-btn-blue'
                          : 'rally-btn-amber text-slate-950'
                    }`}
                  >
                    {row.position}º
                  </span>
                  <div className="text-right">
                    <div className="font-mono text-2xl font-extrabold text-white tabular-nums">
                      {row.finalTotalPoints}
                    </div>
                    <div className="text-[10px] font-bold tracking-wider text-sky-400 uppercase">
                      pontos perdidos
                    </div>
                  </div>
                </div>
                <div className="mt-3">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-300">
                    {idx === 0 ? (
                      <Trophy className="h-3.5 w-3.5 text-amber-400" />
                    ) : (
                      <Award className="h-3.5 w-3.5 text-sky-400" />
                    )}
                    <span>Carro #{row.carNumber}</span>
                  </div>
                  <p className="truncate text-sm font-semibold text-white">{row.crewName}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-400">
                    PCs: {row.recordedV}/{row.totalV} · Adiant: -{row.earlySecondsTotal.toFixed(1)}s · Atras: +{row.lateSecondsTotal.toFixed(1)}s
                  </p>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#101622] shadow-xl">
        <div className="border-b border-slate-800 px-5 py-3.5">
          <h2 className="font-['Barlow_Condensed'] text-xl font-bold text-white">
            Tabela Geral de Classificação
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-[#080c14] text-xs font-semibold text-slate-400">
                <th className="py-3 pl-5 pr-3">Pos</th>
                <th className="px-3 py-3">Carro / Dupla</th>
                <th className="px-3 py-3 text-right">PCs V</th>
                <th className="px-3 py-3 text-right">Adiant.</th>
                <th className="px-3 py-3 text-right">Atras.</th>
                <th className="px-3 py-3 text-right">Pts V</th>
                <th className="px-3 py-3 text-right">Penal. NC</th>
                <th className="py-3 pl-3 pr-5 text-right">Total Pontos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 font-mono tabular-nums">
              {snapshot.rows.map((row) => (
                <tr key={`${row.position}-${row.carNumber}`} className="hover:bg-slate-800/35">
                  <td className="py-3 pl-5 pr-3 font-bold text-white">
                    {row.position}º
                  </td>
                  <td className="px-3 py-3 font-sans">
                    <div className="font-mono text-sm font-bold text-white">
                      #{row.carNumber}
                    </div>
                    <div className="text-xs text-slate-400">{row.crewName}</div>
                  </td>
                  <td className="px-3 py-3 text-right text-xs text-slate-300">
                    {row.recordedV}/{row.totalV}
                  </td>
                  <td className="px-3 py-3 text-right text-xs text-emerald-400">
                    -{row.earlySecondsTotal.toFixed(1)}s
                  </td>
                  <td className="px-3 py-3 text-right text-xs text-red-400">
                    +{row.lateSecondsTotal.toFixed(1)}s
                  </td>
                  <td className="px-3 py-3 text-right text-xs text-slate-200">
                    {row.pointsFromV ?? Math.max(0, row.finalTotalPoints - row.missedV * snapshot.missedPenaltyPts)}
                  </td>
                  <td className="px-3 py-3 text-right text-xs text-red-400">
                    {row.missedPenaltyPoints ?? row.missedV * snapshot.missedPenaltyPts}
                  </td>
                  <td className="py-3 pl-3 pr-5 text-right text-base font-bold text-sky-400">
                    {row.finalTotalPoints}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-slate-400">
        <a
          href="https://www.instagram.com/pitstop.sports/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:text-sky-400"
        >
          <span>Instagram @pitstop.sports</span>
          <ExternalLink className="h-3 w-3" />
        </a>
        <span>·</span>
        <a
          href="https://pitstopere.wixsite.com/news"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:text-sky-400"
        >
          <span>Portal PitStop News</span>
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
};
