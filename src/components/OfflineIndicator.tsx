import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-lg border border-amber-700/30 bg-amber-950 px-3.5 py-2 text-xs font-medium text-amber-100 shadow-lg"
    >
      <WifiOff className="h-3.5 w-3.5 text-amber-400 shrink-0" />
      <span>Modo Offline — Coleta GPS e salvamento local seguem ativos</span>
    </div>
  );
};
