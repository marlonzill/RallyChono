import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC<{ variant?: 'header' | 'card' }> = ({
  variant = 'header',
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    if (variant === 'card') {
      return (
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-400">
          Aplicativo já instalado neste aparelho
        </span>
      );
    }
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="rally-btn-orange inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 whitespace-nowrap shrink-0"
      >
        <Download className="h-4 w-4 shrink-0" />
        <span>Instalar App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-slate-700 bg-[#161b26] px-4 py-2 text-sm font-semibold text-slate-100 transition-colors hover:bg-[#1e2533] whitespace-nowrap shrink-0"
        >
          <Smartphone className="h-4 w-4 shrink-0 text-orange-400" />
          <span>Instalar no iPhone</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
            <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-slate-700 bg-[#12161f] text-slate-100 shadow-2xl">
              <div aria-hidden="true" className="h-1 w-full rally-track-stripe" />
              <div className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <h3 className="font-['Barlow_Condensed'] text-xl font-bold text-white">
                    Instalar no iPhone / iPad
                  </h3>
                  <button
                    type="button"
                    onClick={() => setShowIOSGuide(false)}
                    className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
                    aria-label="Fechar"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <ol className="mt-4 space-y-2.5 text-sm text-slate-300">
                  <li>
                    1. Toque no botão <strong className="text-white">Compartilhar</strong> na barra inferior do Safari.
                  </li>
                  <li>
                    2. Role para baixo e selecione{' '}
                    <strong className="text-white">Adicionar à Tela de Início</strong>.
                  </li>
                  <li>3. Toque em <strong className="text-white">Adicionar</strong> no canto superior direito.</li>
                </ol>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="rally-btn-orange mt-6 w-full min-h-[44px] rounded-xl px-4 py-2.5 text-sm font-bold text-white"
                >
                  Entendi
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
