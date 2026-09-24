import { Compass, MessageSquarePlus, Rocket } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Badge, Dot, PageHeader, Stat } from '@/components/ui';
import { useConversations } from '@/lib/conversations';
import { directory } from '@/lib/directory';
import { fmt, shortId, timeAgo } from '@/lib/format';
import { isTauri, native, type AppInfo } from '@/lib/tauri';
import type { DeploymentView, DirectoryStats } from '@/lib/types';

import type { View } from '@/components/Sidebar';

export default function DashboardPage({ info, onNavigate, onOpenChat, onChatModel }: {
  info: AppInfo | null;
  onNavigate: (v: View) => void;
  onOpenChat: (id: string | null) => void;
  onChatModel: (model: string) => void;
}) {
  const [stats, setStats] = useState<DirectoryStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [deployments, setDeployments] = useState<DeploymentView[]>([]);
  const chats = useConversations();

  useEffect(() => {
    const load = () => {
      directory.stats().then((s) => { setStats(s); setStatsError(false); }).catch(() => setStatsError(true));
      if (isTauri()) native.deployList().then(setDeployments).catch(() => {});
    };
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  const running = deployments.filter((d) => d.state.state === 'running');

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-8 py-8 space-y-8">
        <PageHeader title="Control center" subtitle="Your view of the Bee2Bee mesh and the nodes you run." />

        <div className="grid grid-cols-3 gap-3">
          <button className="card p-5 text-left hover:bg-muted" onClick={() => onOpenChat(null)}>
            <MessageSquarePlus className="w-5 h-5 mb-3" /><p className="font-semibold">New chat</p><p className="text-sm text-fg-muted">Talk to any node on the network.</p>
          </button>
          <button className="card p-5 text-left hover:bg-muted" onClick={() => onNavigate('explore')}>
            <Compass className="w-5 h-5 mb-3" /><p className="font-semibold">Explore network</p><p className="text-sm text-fg-muted">Search nodes by model, provider and speed.</p>
          </button>
          <button className="card p-5 text-left hover:bg-muted" onClick={() => onNavigate('deploy')}>
            <Rocket className="w-5 h-5 mb-3" /><p className="font-semibold">Deploy a node</p><p className="text-sm text-fg-muted">Share your GPU and models.</p>
          </button>
        </div>

        <section>
          <h2 className="font-semibold mb-3">Network {statsError && <span className="text-sm font-normal text-danger">· directory unreachable</span>}</h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Online nodes" value={fmt(stats?.online_nodes)} hint={stats ? `${stats.reachable_nodes} reachable` : undefined} />
            <Stat label="Models" value={fmt(stats?.models_count)} hint={stats ? `${stats.providers_count} providers` : undefined} />
            <Stat label="Capacity" value={`${fmt(stats?.total_tokens_per_sec)} tok/s`} />
            <Stat label="Avg. latency" value={`${fmt(stats?.avg_latency_ms)} ms`} />
          </div>
        </section>

        <div className="grid lg:grid-cols-2 gap-6">
          <section className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">My nodes</h2>
              <Badge tone={running.length ? 'ok' : 'neutral'}>{running.length} / {deployments.length} running</Badge>
            </div>
            {deployments.length === 0 ? (
              <p className="text-sm text-fg-muted">You are not running any node. <button className="underline" onClick={() => onNavigate('deploy')}>Deploy one</button>.</p>
            ) : (
              <ul className="space-y-2">
                {deployments.map((d) => (
                  <li key={d.config.id} className="flex items-center gap-2 text-sm"><Dot on={d.state.state === 'running'} /> <span className="font-medium">{d.config.name}</span> <span className="text-fg-muted">{d.config.backend} · {d.config.model}</span></li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-5">
            <h2 className="font-semibold mb-3">Top models on the network</h2>
            {stats?.models.length ? (
              <ul className="divide-y divide-border">
                {stats.models.slice(0, 6).map((m) => (
                  <li key={m.model} className="py-2 flex items-center justify-between text-sm">
                    <span><span className="font-medium">{m.model}</span> <span className="text-fg-muted">· {m.nodes} node(s) · {m.providers.join(', ')}</span></span>
                    <button className="btn-ghost h-7 px-3 text-xs" onClick={() => onChatModel(m.model)}>Chat</button>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-fg-muted">No models reported yet.</p>}
          </section>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          <section className="card p-5">
            <h2 className="font-semibold mb-3">Recent chats</h2>
            {chats.length === 0 ? <p className="text-sm text-fg-muted">No chats yet.</p> : (
              <ul className="space-y-1">
                {chats.slice(0, 6).map((c) => (
                  <li key={c.id}><button className="w-full flex justify-between text-sm px-2 py-1.5 rounded-lg hover:bg-muted" onClick={() => onOpenChat(c.id)}><span className="truncate">{c.title}</span><span className="text-fg-muted shrink-0 ml-3">{timeAgo(c.updatedAt)}</span></button></li>
                ))}
              </ul>
            )}
          </section>
          <section className="card p-5 text-sm space-y-2">
            <h2 className="font-semibold mb-1">This device</h2>
            <p><span className="text-fg-muted">Client identity:</span> <span className="font-mono selectable">{info ? shortId(info.peer_id) : 'browser preview'}</span></p>
            <p><span className="text-fg-muted">App version:</span> {info?.version ?? '—'}</p>
            <p className="text-fg-muted text-xs">Your identity key proves who you are to nodes. It never leaves this computer.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
