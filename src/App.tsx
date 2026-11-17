import { Suspense, lazy, useState } from 'react';
import { ClipboardList, Compass, Gauge, Home, Smartphone } from 'lucide-react';
import { CompetitorCollector } from './components/CompetitorCollector';
import { InitialStatusTab } from './components/InitialStatusTab';
import { InstallGuide } from './components/InstallGuide';
import { NavigationCockpit } from './components/NavigationCockpit';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PWAInstallButton } from './components/PWAInstallButton';
import type { ActiveTab, CompetitorResultFile } from './types/rally';

const isCompetitorEnv = import.meta.env.VITE_APP_TARGET === 'competitor';
const isCompetitorQuery =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('modo') === 'competidor';
const isCompetitorBuild = isCompetitorEnv || isCompetitorQuery;

const OrganizerBackoffice = isCompetitorEnv
  ? null
  : lazy(() =>
      import('./components/OrganizerBackoffice').then((m) => ({
        default: m.OrganizerBackoffice,
      }))
    );

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('inicial');
  const [backofficeResults, setBackofficeResults] = useState<CompetitorResultFile[]>([]);

  const handleAddBackofficeResults = (newItems: CompetitorResultFile[]) => {
    setBackofficeResults((prev) => {
      const merged = [...prev];
      for (const item of newItems) {
        const existingIdx = merged.findIndex(
          (x) => x.carNumber === item.carNumber && x.fileName === item.fileName
        );
        if (existingIdx >= 0) {
          merged[existingIdx] = item;
        } else {
          merged.push(item);
        }
      }
      return merged;
    });
  };

  const handleRemoveBackofficeResult = (id: string) => {
    setBackofficeResults((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div className="min-h-screen bg-rally-asphalt text-slate-100 flex flex-col">
      {/* Motorsport Carbon Header + Segmented Track Speed Stripe + Checkered Edge */}
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-[#0b0e14]/95 text-white backdrop-blur-md">
        <div aria-hidden="true" className="h-1.5 w-full rally-track-stripe" />
        <div className="relative overflow-hidden">
          {/* Subtle Checkered Fade Right */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-48 bg-rally-checkered opacity-50 [mask-image:linear-gradient(to_left,black,transparent)]"
          />

          <div className="relative mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-3 sm:h-16 sm:gap-6 sm:px-6 lg:px-8">
            {/* Zone 1: RallyChrono Emblem + Brand Lockup */}
            <a
              href="#top"
              onClick={(e) => {
                e.preventDefault();
                setActiveTab('inicial');
              }}
              className="flex items-center gap-2.5 whitespace-nowrap shrink-0 group sm:gap-3"
            >
              <svg
                viewBox="0 0 48 36"
                className="h-7 w-9 shrink-0 transition-transform group-hover:scale-105 sm:h-8 sm:w-10"
                aria-hidden="true"
              >
                {/* Orange speed streaks */}
                <path d="M1 8 H14 L12 11 H1 Z" fill="#dc2626" />
                <path d="M3 16 H17 L15 19 H3 Z" fill="#f97316" />
                <path d="M0 24 H13 L11 27 H0 Z" fill="#f59e0b" />
                {/* Skewed checkered flag blocks */}
                <g transform="skewX(-12)">
                  <rect x="20" y="5" width="7" height="6" fill="#f8fafc" />
                  <rect x="27" y="5" width="7" height="6" fill="#1e293b" />
                  <rect x="34" y="5" width="7" height="6" fill="#f8fafc" />
                  <rect x="20" y="11" width="7" height="6" fill="#1e293b" />
                  <rect x="27" y="11" width="7" height="6" fill="#f8fafc" />
                  <rect x="34" y="11" width="7" height="6" fill="#1e293b" />
                  <rect x="20" y="17" width="7" height="6" fill="#f8fafc" />
                  <rect x="27" y="17" width="7" height="6" fill="#1e293b" />
                  <rect x="34" y="17" width="7" height="6" fill="#f8fafc" />
                </g>
              </svg>

              <div className="leading-none">
                <div className="font-['Barlow_Condensed'] text-xl font-extrabold italic tracking-wide text-white sm:text-2xl lg:text-3xl">
                  Rally<span className="text-orange-500">Chrono</span>
                </div>
                <div className="mt-0.5 text-[8px] font-bold tracking-[0.2em] text-slate-400 uppercase sm:text-[9px]">
                  Cronometragem de Rally
                </div>
              </div>
            </a>

            {/* Zone 2: Concise single-line navigation links */}
            <nav
              aria-label="Navegação principal"
              className="hidden md:flex items-center gap-7 text-sm font-semibold"
            >
              <button
                type="button"
                onClick={() => setActiveTab('inicial')}
                className={`min-h-[64px] border-b-2 px-1 transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'inicial'
                    ? 'border-orange-500 text-white'
                    : 'border-transparent text-slate-400 hover:text-white'
                }`}
              >
                Inicial
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('competidor')}
                className={`min-h-[64px] border-b-2 px-1 transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'competidor'
                    ? 'border-orange-500 text-white'
                    : 'border-transparent text-slate-400 hover:text-white'
                }`}
              >
                Coletor GPS
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('navegacao')}
                className={`min-h-[64px] border-b-2 px-1 transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'navegacao'
                    ? 'border-orange-500 text-white'
                    : 'border-transparent text-slate-400 hover:text-white'
                }`}
              >
                Navegação
              </button>
              {!isCompetitorBuild && (
                <button
                  type="button"
                  onClick={() => setActiveTab('apuracao')}
                  className={`min-h-[64px] border-b-2 px-1 transition-colors whitespace-nowrap shrink-0 ${
                    activeTab === 'apuracao'
                      ? 'border-orange-500 text-white'
                      : 'border-transparent text-slate-400 hover:text-white'
                  }`}
                >
                  Apuração{backofficeResults.length > 0 ? ` (${backofficeResults.length})` : ''}
                </button>
              )}
              {!isCompetitorBuild && (
                <button
                  type="button"
                  onClick={() => setActiveTab('instalar')}
                  className={`min-h-[64px] border-b-2 px-1 transition-colors whitespace-nowrap shrink-0 ${
                    activeTab === 'instalar'
                      ? 'border-orange-500 text-white'
                      : 'border-transparent text-slate-400 hover:text-white'
                  }`}
                >
                  Instalar App
                </button>
              )}
            </nav>

            {/* Zone 3: Single Primary Action */}
            <div className="flex items-center shrink-0">
              {!isCompetitorBuild && <PWAInstallButton variant="header" />}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-2.5 pt-3 pb-4 sm:px-6 sm:pt-6 md:pt-8 lg:px-8">
        {activeTab === 'inicial' && <InitialStatusTab onNavigate={setActiveTab} />}
        {activeTab === 'competidor' && <CompetitorCollector />}
        {activeTab === 'navegacao' && <NavigationCockpit />}

        {!isCompetitorBuild && activeTab === 'apuracao' && OrganizerBackoffice && (
          <Suspense
            fallback={
              <div className="rounded-2xl border border-slate-800 bg-[#12161f] p-8 text-center text-sm text-slate-400">
                Carregando módulo de apuração...
              </div>
            }
          >
            <OrganizerBackoffice
              results={backofficeResults}
              onAddResults={handleAddBackofficeResults}
              onRemoveResult={handleRemoveBackofficeResult}
              onClearAll={() => setBackofficeResults([])}
            />
          </Suspense>
        )}

        {!isCompetitorBuild && activeTab === 'instalar' && <InstallGuide />}
      </main>

      <footer className="mx-auto w-full max-w-7xl px-4 pb-16 pt-2 text-center md:pb-6">
        <p className="text-[11px] tracking-wide text-slate-500">
          Desenvolvido por Márlon Zill
        </p>
      </footer>

      {/* Mobile Bottom Tab Bar */}
      <nav
        aria-label="Menu móvel"
        className={`fixed bottom-0 left-0 right-0 z-30 grid h-14 border-t border-slate-800 bg-[#0b0e14]/95 text-slate-400 backdrop-blur-md md:hidden ${
          isCompetitorBuild ? 'grid-cols-3' : 'grid-cols-5'
        }`}
      >
        <button
          type="button"
          onClick={() => setActiveTab('inicial')}
          className={`flex flex-col items-center justify-center gap-0.5 border-t-2 text-[10px] font-semibold transition-colors ${
            activeTab === 'inicial'
              ? 'border-orange-500 text-orange-400'
              : 'border-transparent text-slate-400'
          }`}
        >
          <Home className="h-5 w-5" />
          <span>Inicial</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('competidor')}
          className={`flex flex-col items-center justify-center gap-0.5 border-t-2 text-[10px] font-semibold transition-colors ${
            activeTab === 'competidor'
              ? 'border-orange-500 text-orange-400'
              : 'border-transparent text-slate-400'
          }`}
        >
          <Compass className="h-5 w-5" />
          <span>Coletor</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('navegacao')}
          className={`flex flex-col items-center justify-center gap-0.5 border-t-2 text-[10px] font-semibold transition-colors ${
            activeTab === 'navegacao'
              ? 'border-orange-500 text-orange-400'
              : 'border-transparent text-slate-400'
          }`}
        >
          <Gauge className="h-5 w-5" />
          <span>Navegação</span>
        </button>

        {!isCompetitorBuild && (
          <button
            type="button"
            onClick={() => setActiveTab('apuracao')}
            className={`flex flex-col items-center justify-center gap-0.5 border-t-2 text-[10px] font-semibold transition-colors ${
              activeTab === 'apuracao'
                ? 'border-orange-500 text-orange-400'
                : 'border-transparent text-slate-400'
            }`}
          >
            <ClipboardList className="h-5 w-5" />
            <span>
              Apuração{backofficeResults.length > 0 ? ` (${backofficeResults.length})` : ''}
            </span>
          </button>
        )}

        {!isCompetitorBuild && (
          <button
            type="button"
            onClick={() => setActiveTab('instalar')}
            className={`flex flex-col items-center justify-center gap-0.5 border-t-2 text-[10px] font-semibold transition-colors ${
              activeTab === 'instalar'
                ? 'border-orange-500 text-orange-400'
                : 'border-transparent text-slate-400'
            }`}
          >
            <Smartphone className="h-5 w-5" />
            <span>Instalar</span>
          </button>
        )}
      </nav>

      <OfflineIndicator />
    </div>
  );
}
