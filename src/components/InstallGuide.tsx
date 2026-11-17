import React from 'react';
import { BatteryCharging, CheckSquare, FileArchive, MapPin, Smartphone } from 'lucide-react';
import { PWAInstallButton } from './PWAInstallButton';

export const InstallGuide: React.FC = () => {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <section className="relative overflow-hidden rounded-2xl border border-slate-800 bg-[#12161f] text-slate-100 shadow-xl">
        <div aria-hidden="true" className="h-1.5 w-full rally-track-stripe" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1.5 right-0 h-28 w-44 bg-rally-checkered opacity-35 [mask-image:linear-gradient(to_bottom_left,black,transparent)]"
        />

        <div className="relative p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[11px] font-bold tracking-[0.18em] text-orange-400 uppercase">
                Distribuição Android
              </p>
              <h2 className="mt-0.5 font-['Barlow_Condensed'] text-2xl font-bold tracking-wide text-white sm:text-3xl">
                Gerar APK Exclusivo do Competidor &amp; Instalar no Android
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                O aplicativo compilado para os competidores inclui apenas o Coletor GPS e Navegação, removendo totalmente a tela de Apuração da organização.
              </p>
            </div>
            <PWAInstallButton variant="card" />
          </div>

          <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-[#0a0d13] p-5">
              <div className="flex items-center gap-2.5 text-white">
                <FileArchive className="h-5 w-5 text-orange-400 shrink-0" />
                <h3 className="text-base font-semibold">
                  1. Como gerar o arquivo .APK
                </h3>
              </div>
              <ol className="mt-3 space-y-2 text-sm text-slate-300">
                <li>1. Exporte este projeto para um repositório no <strong className="text-white">GitHub</strong>.</li>
                <li>2. Na aba <strong className="text-white">Actions</strong> do GitHub, o fluxo <strong className="text-white">Gerar APK Competidor (RallyChrono)</strong> compila o Android automaticamente na nuvem.</li>
                <li>3. Baixe o artefato <strong className="text-white">RallyChrono-Coletor-APK</strong> (<code className="text-amber-300">app-debug.apk</code>) e envie no WhatsApp dos competidores.</li>
              </ol>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#0a0d13] p-5">
              <div className="flex items-center gap-2.5 text-white">
                <Smartphone className="h-5 w-5 text-orange-400 shrink-0" />
                <h3 className="text-base font-semibold">
                  2. Alternativa rápida sem APK (PWA)
                </h3>
              </div>
              <ol className="mt-3 space-y-2 text-sm text-slate-300">
                <li>1. Envie aos competidores o link com <code className="text-amber-300">?modo=competidor</code> ou instale via Chrome.</li>
                <li>2. Toque em <strong className="text-white">Instalar App</strong> (ou menu <strong className="text-white">⋮ &rarr; Adicionar à tela inicial</strong>).</li>
                <li>3. Funciona offline após a primeira abertura.</li>
              </ol>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#0a0d13] p-5">
              <div className="flex items-center gap-2.5 text-white">
                <MapPin className="h-5 w-5 text-orange-400 shrink-0" />
                <h3 className="text-base font-semibold">
                  3. Precisão Máxima de GPS
                </h3>
              </div>
              <ul className="mt-3 space-y-2 text-sm text-slate-300">
                <li>• Ao testar o GPS antes da largada, selecione <strong className="text-white">Permitir durante o uso do app</strong> e ative <strong className="text-white">Localização Precisa</strong>.</li>
                <li>• O raio de detecção pode ser ajustado a partir de <strong className="text-white">2 metros</strong>; em estradas rápidas, entre <strong className="text-white">15m e 40m</strong> evita falhas por velocidade.</li>
              </ul>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#0a0d13] p-5">
              <div className="flex items-center gap-2.5 text-white">
                <BatteryCharging className="h-5 w-5 text-orange-400 shrink-0" />
                <h3 className="text-base font-semibold">
                  4. Bateria e Tela na Prova
                </h3>
              </div>
              <ul className="mt-3 space-y-2 text-sm text-slate-300">
                <li>• Use o botão <strong className="text-white">Escurecer Tela</strong> dentro do app em vez de desligar a tela no botão físico do celular.</li>
                <li>• Em <em>Configurações &rarr; Apps &rarr; RallyChrono &rarr; Bateria</em>, selecione <strong className="text-white">Irrestrito</strong> para evitar suspensão pelo Android.</li>
              </ul>
            </div>
          </div>

          <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-4 text-xs text-slate-300">
            <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span>
              <strong className="text-white">Separação Competidor × Retaguarda:</strong> O build gerado pelo script{' '}
              <code className="font-mono text-amber-300">npm run cap:sync</code> usa{' '}
              <code className="font-mono text-amber-300">VITE_APP_TARGET=competitor</code>, removendo completamente o módulo de apuração do APK enviado aos carros.
            </span>
          </div>
        </div>
      </section>
    </div>
  );
};
