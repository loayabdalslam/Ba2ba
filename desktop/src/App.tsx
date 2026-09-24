import { useCallback, useEffect, useRef, useState } from 'react';

import { Sidebar, type View } from '@/components/Sidebar';
import { conversations, useConversations } from '@/lib/conversations';
import { useSettings } from '@/lib/settings';
import { isTauri, native, type AppInfo } from '@/lib/tauri';
import type { ChatTarget, DeploymentConfig } from '@/lib/types';
import ChatPage from '@/pages/ChatPage';
import DashboardPage from '@/pages/DashboardPage';
import { launchOptions } from '@/lib/launch';
import DeployPage from '@/pages/DeployPage';
import ExplorePage from '@/pages/ExplorePage';
import ModelsPage from '@/pages/ModelsPage';
import SettingsPage from '@/pages/SettingsPage';

function useTheme(theme: 'system' | 'light' | 'dark') {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches));
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

export default function App() {
  const [settings] = useSettings();
  useTheme(settings.theme);
  const [view, setView] = useState<View>('chat');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingTarget, setPendingTarget] = useState<ChatTarget | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [deployPrefill, setDeployPrefill] = useState<Partial<DeploymentConfig> | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const started = useRef(false);
  useConversations();

  useEffect(() => {
    if (!isTauri() || started.current) return;
    started.current = true;
    native.appInfo().then(setInfo).catch(() => {});
    // Start deployments marked "auto start".
    native.deployList().then((list) => list.filter((d) => d.config.auto_start && d.state.state !== 'running')
      .forEach((d) => native.deployStart(d.config.id, launchOptions()).catch(() => {})));
  }, []);

  const openChat = useCallback((id: string | null) => {
    setActiveId(id);
    setView('chat');
  }, []);

  const chatWith = useCallback((target: ChatTarget) => {
    const conv = conversations.create(target);
    setActiveId(conv.id);
    setView('chat');
  }, []);

  const clearTarget = useCallback(() => setPendingTarget(null), []);
  const clearPrefill = useCallback(() => setDeployPrefill(null), []);

  return (
    <div className="flex h-full">
      <Sidebar view={view} activeId={activeId} peerId={info?.peer_id ?? null} version={info?.version ?? null} onNavigate={setView} onOpenChat={openChat} />
      <main className="flex-1 min-w-0 bg-surface">
        {view === 'chat' && (
          <ChatPage key={activeId ?? 'new'} conversation={conversations.get(activeId)} onCreated={setActiveId} pendingTarget={pendingTarget} clearPendingTarget={clearTarget} pendingModel={pendingModel} clearPendingModel={() => setPendingModel(null)} />
        )}
        {view === 'dashboard' && (
          <DashboardPage info={info} onNavigate={setView} onOpenChat={openChat} onChatModel={(model) => { setActiveId(null); setPendingModel(model); setView('chat'); }} />
        )}
        {view === 'explore' && <ExplorePage onChat={chatWith} />}
        {view === 'deploy' && <DeployPage onChat={chatWith} prefill={deployPrefill} clearPrefill={clearPrefill} />}
        {view === 'models' && <ModelsPage onServe={(p) => { setDeployPrefill(p); setView('deploy'); }} />}
        {view === 'settings' && <SettingsPage info={info} />}
      </main>
    </div>
  );
}
