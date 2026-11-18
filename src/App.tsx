import { Suspense, lazy, useState } from 'react';
import { Compass, Flag, Gauge, Home, Settings } from 'lucide-react';
import { CompetitorCollector } from './components/CompetitorCollector';
import { InitialStatusTab } from './components/InitialStatusTab';
import { NavigationCockpit } from './components/NavigationCockpit';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PitStopLogo } from './components/PitStopLogo';
import { PublicStandingsView } from './components/PublicStandingsView';
import { SettingsTab } from './components/SettingsTab';
import { VelocityCockpit } from './components/VelocityCockpit';
import type { ActiveTab, CompetitorResultFile } from './types/rally';

const isCompetitorEnv = import.meta.env.VITE_APP_TARGET === 'competitor';

function readUrlRoute(): {
  isApuracao: boolean;
  publicResultSlug: string | null;
} {
  if (typeof window === 'undefined') {
    return { isApuracao: false, publicResultSlug: null };
  }
  const params = new URLSearchParams(window.location.search);
  const path = window.location.pathname.toLowerCase();
  const publicResultSlug = params.get('resultado')?.trim() || null;
  const isApuracao =
    !isCompetitorEnv &&
    !publicResultSlug &&
    (params.get('apuracao') === '1' ||
      params.get('modo') === 'apuracao' ||
      path === '/apuracao' ||
      path === '/apuracao/');
  return { isApuracao, publicResultSlug };
}

const OrganizerBackoffice = isCompetitorEnv
  ? null
  : lazy(() =>
      import('./components/OrganizerBackoffice').then((m) => ({
        default: m.OrganizerBackoffice,
      }))
    );

export type SettingsSubMenu =
  | 'hub'
  | 'roadbooks'
  | 'pairing'
  | 'pilot'
  | 'calibration'
  | 'alerts'
  | 'system';

export default function App() {
  const [{ isApuracao, publicResultSlug }, setRouteState] = useState(() =>
    readUrlRoute()
  );
  const [activeTab, setActiveTab] = useState<ActiveTab>('inicial');
  const [settingsMenu, setSettingsMenu] = useState<SettingsSubMenu>('hub');
  const [backofficeResults, setBackofficeResults] = useState<CompetitorResultFile[]>([]);

  const handleAddBackofficeResults = (newItems: CompetitorResultFile[]) => {
    setBackofficeResults((prev) => {
      const merged = [...prev];
      for (const item of newItems) {
        const existingIdx = merged.findIndex(
          (x) =>
            x.id === item.id ||
            (x.carNumber === item.carNumber && x.fileName === item.fileName)
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

  const openSettingsSection = (menu: SettingsSubMenu = 'hub') => {
    setSettingsMenu(menu);
    setActiveTab('configuracoes');
  };

  const exitPortalToApp = () => {
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('apuracao');
      url.searchParams.delete('modo');
      url.searchParams.delete('resultado');
      if (url.pathname.toLowerCase().startsWith('/apuracao')) {
        url.pathname = '/';
      }
      window.history.replaceState({}, '', url.toString());
    }
    setRouteState({ isApuracao: false, publicResultSlug: null });
    setActiveTab('inicial');
  };

  return (
    <div className="min-h-screen bg-rally-asphalt text-[#F4F4F4] flex flex-col">
      {/* PitStop Sports Safe-Area Top Header */}
      <header className="sticky top-0 z-30 pt-safe border-b border-zinc-800/95 bg-[#080B0D]/95 text-white backdrop-blur-md">
        <div className="relative overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-44 bg-rally-checkered opacity-20 [mask-image:linear-gradient(to_left,black,transparent)]"
          />

          <div className="relative mx-auto flex min-h-[54px] max-w-7xl items-center justify-between gap-1.5 px-2 sm:min-h-[62px] sm:gap-4 sm:px-6 lg:px-8">
            {/* Mobile: stylized P badge only | Desktop: real transparent PitStop Sports logo */}
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                if (isApuracao || publicResultSlug) {
                  exitPortalToApp();
                } else {
                  setActiveTab('inicial');
                }
              }}
              className="flex items-center whitespace-nowrap shrink-0 group"
              aria-label="PitStop Sports Início"
            >
              <PitStopLogo
                variant="icon"
                className="h-9 w-9 transition-transform group-hover:scale-105 sm:hidden"
              />
              <PitStopLogo
                variant="horizontal"
                className="hidden h-11 w-auto transition-transform group-hover:scale-[1.03] sm:block"
              />
            </a>

            {/* 5 Clean Motorsport Top Tabs: zero horizontal scrollbar on mobile */}
            {!isApuracao && !publicResultSlug ? (
              <nav
                aria-label="Navegação principal"
                className="grid flex-1 grid-cols-5 gap-0.5 rounded-lg border border-zinc-800 bg-[#111214] p-0.5 sm:flex sm:flex-none sm:items-center sm:gap-1 sm:p-1"
              >
                <button
                  type="button"
                  onClick={() => setActiveTab('inicial')}
                  className={`inline-flex min-h-[38px] items-center justify-center gap-1 rounded-md px-1 text-[10.5px] font-bold transition-colors whitespace-nowrap sm:px-3 sm:text-sm sm:gap-1.5 ${
                    activeTab === 'inicial'
                      ? 'pitstop-btn-red text-white'
                      : 'text-[#B5B5B5] hover:text-white'
                  }`}
                >
                  <Home className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                  <span>Início</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('navegacao')}
                  className={`inline-flex min-h-[38px] items-center justify-center gap-1 rounded-md px-1 text-[10.5px] font-bold transition-colors whitespace-nowrap sm:px-3 sm:text-sm sm:gap-1.5 ${
                    activeTab === 'navegacao'
                      ? 'pitstop-btn-red text-white'
                      : 'text-[#B5B5B5] hover:text-white'
                  }`}
                >
                  <Gauge className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                  <span className="sm:hidden">Nav.</span>
                  <span className="hidden sm:inline">Navegação</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('velocidade')}
                  className={`inline-flex min-h-[38px] items-center justify-center gap-1 rounded-md px-1 text-[10.5px] font-bold transition-colors whitespace-nowrap sm:px-3 sm:text-sm sm:gap-1.5 ${
                    activeTab === 'velocidade'
                      ? 'pitstop-btn-red text-white'
                      : 'text-[#B5B5B5] hover:text-white'
                  }`}
                >
                  <Flag className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                  <span className="sm:hidden">Veloc.</span>
                  <span className="hidden sm:inline">Velocidade</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('competidor')}
                  className={`inline-flex min-h-[38px] items-center justify-center gap-1 rounded-md px-1 text-[10.5px] font-bold transition-colors whitespace-nowrap sm:px-3 sm:text-sm sm:gap-1.5 ${
                    activeTab === 'competidor'
                      ? 'pitstop-btn-red text-white'
                      : 'text-[#B5B5B5] hover:text-white'
                  }`}
                >
                  <Compass className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                  <span className="sm:hidden">Colet.</span>
                  <span className="hidden sm:inline">Coletor</span>
                </button>

                <button
                  type="button"
                  onClick={() => openSettingsSection('hub')}
                  className={`inline-flex min-h-[38px] items-center justify-center gap-1 rounded-md px-1 text-[10.5px] font-bold transition-colors whitespace-nowrap sm:px-3 sm:text-sm sm:gap-1.5 ${
                    activeTab === 'configuracoes'
                      ? 'pitstop-btn-red text-white'
                      : 'text-[#B5B5B5] hover:text-white'
                  }`}
                >
                  <Settings className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                  <span className="sm:hidden">Config.</span>
                  <span className="hidden sm:inline">Configurações</span>
                </button>
              </nav>
            ) : (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] font-bold tracking-wider text-[#E10600] uppercase">
                  {publicResultSlug ? 'Resultado Oficial' : 'Portal de Apuração'}
                </span>
                <button
                  type="button"
                  onClick={exitPortalToApp}
                  className="rounded-lg border border-zinc-700 bg-[#1E1E22] px-3 py-1.5 text-xs font-semibold text-[#F4F4F4] hover:bg-zinc-800 whitespace-nowrap"
                >
                  Ir p/ App
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-2 pt-2.5 pb-4 sm:px-6 sm:pt-5 lg:px-8">
        {publicResultSlug ? (
          <PublicStandingsView slug={publicResultSlug} />
        ) : isApuracao && OrganizerBackoffice ? (
          <Suspense
            fallback={
              <div className="rounded-xl border border-zinc-800 bg-[#111214] p-8 text-center text-sm text-[#B5B5B5]">
                Carregando portal de apuração PitStop Sports...
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
        ) : (
          <>
            {activeTab === 'inicial' && (
              <InitialStatusTab
                onNavigate={(tab) => {
                  if (tab === 'configuracoes') openSettingsSection('hub');
                  else setActiveTab(tab);
                }}
              />
            )}
            {activeTab === 'competidor' && <CompetitorCollector />}
            {activeTab === 'navegacao' && (
              <NavigationCockpit
                onOpenRoadbookSettings={() => openSettingsSection('roadbooks')}
              />
            )}
            {activeTab === 'velocidade' && <VelocityCockpit />}
            {activeTab === 'configuracoes' && (
              <SettingsTab
                initialMenu={settingsMenu}
                onMenuChange={setSettingsMenu}
                onOpenNavigation={() => setActiveTab('navegacao')}
              />
            )}
          </>
        )}
      </main>

      <footer className="mx-auto w-full max-w-7xl px-4 pb-safe pt-2 text-center">
        <p className="text-[11px] tracking-wide text-zinc-500">
          Desenvolvido por Márlon Zill · PitStop Sports
        </p>
      </footer>

      <OfflineIndicator />
    </div>
  );
}
