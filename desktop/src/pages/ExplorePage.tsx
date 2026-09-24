import { Loader2, MessageSquare, Plug, RefreshCw, Search, Server } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Badge, Dot, Empty, ErrorNote, Modal, PageHeader, Stat } from '@/components/ui';
import { directory, type NodeQuery } from '@/lib/directory';
import { fmt, fmtPct, shortId, timeAgo } from '@/lib/format';
import { errorMessage, isTauri, native } from '@/lib/tauri';
import type { ChatTarget, DirectoryNode, DirectoryStats, NodeInfo } from '@/lib/types';

const PAGE = 25;

export default function ExplorePage({ onChat }: { onChat: (t: ChatTarget) => void }) {
  const [stats, setStats] = useState<DirectoryStats | null>(null);
  const [query, setQuery] = useState<NodeQuery>({ online: 'true', sort: 'tps' });
  const [text, setText] = useState('');
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{ total: number; nodes: DirectoryNode[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    directory.stats().then(setStats).catch(() => setStats(null));
  }, [tick]);

  useEffect(() => {
    const t = setTimeout(() => setQuery((q) => ({ ...q, q: text || undefined })), 300);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => setPage(0), [query]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    directory
      .nodes({ ...query, limit: PAGE, offset: page * PAGE }, ctrl.signal)
      .then((r) => { setResult(r); setError(''); })
      .catch((e) => { if (!ctrl.signal.aborted) setError(errorMessage(e)); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [query, page, tick]);

  useEffect(() => {
    const id = setInterval(() => document.visibilityState === 'visible' && setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const set = (patch: Partial<NodeQuery>) => setQuery((q) => ({ ...q, ...patch }));
  const totalPages = result ? Math.max(1, Math.ceil(result.total / PAGE)) : 1;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-8 py-8">
        <PageHeader
          title="Explore network"
          subtitle="Nodes registered with the directory, their models, providers and performance."
          actions={<button className="btn-ghost" onClick={() => setTick((t) => t + 1)}><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>}
        />
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
          <Stat label="Online nodes" value={fmt(stats?.online_nodes)} hint={stats ? `${stats.total_nodes} registered` : undefined} />
          <Stat label="Reachable" value={fmt(stats?.reachable_nodes)} hint="verified by the directory" />
          <Stat label="Models" value={fmt(stats?.models_count)} />
          <Stat label="Providers" value={fmt(stats?.providers_count)} />
          <Stat label="Capacity" value={`${fmt(stats?.total_tokens_per_sec)} tok/s`} hint="self-reported" />
        </div>

        <div className="card p-3 mb-4 grid grid-cols-2 lg:grid-cols-7 gap-2">
          <div className="relative col-span-2">
            <Search className="w-4 h-4 absolute left-3 top-3 text-fg-muted" />
            <input className="field pl-9!" placeholder="Search name, model, provider…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search" />
          </div>
          <select className="field" aria-label="Model" value={query.model ?? ''} onChange={(e) => set({ model: e.target.value || undefined })}>
            <option value="">All models</option>
            {stats?.models.map((m) => <option key={m.model} value={m.model}>{m.model} ({m.nodes})</option>)}
          </select>
          <select className="field" aria-label="Provider" value={query.provider ?? ''} onChange={(e) => set({ provider: e.target.value || undefined })}>
            <option value="">All providers</option>
            {stats?.providers.map((p) => <option key={p.provider} value={p.provider}>{p.provider} ({p.nodes})</option>)}
          </select>
          <select className="field" aria-label="Region" value={query.region ?? ''} onChange={(e) => set({ region: e.target.value || undefined })}>
            <option value="">All regions</option>
            {stats?.regions.map((r) => <option key={r.region} value={r.region}>{r.region} ({r.nodes})</option>)}
          </select>
          <select className="field" aria-label="Status" value={`${query.online}|${query.reachable ?? ''}`} onChange={(e) => { const [online, reachable] = e.target.value.split('|'); set({ online: online as NodeQuery['online'], reachable: reachable as NodeQuery['reachable'] }); }}>
            <option value="true|">Online</option>
            <option value="true|true">Online & reachable</option>
            <option value="false|">Offline</option>
            <option value="any|">Any status</option>
          </select>
          <select className="field" aria-label="Sort" value={query.sort} onChange={(e) => set({ sort: e.target.value as NodeQuery['sort'] })}>
            <option value="tps">Fastest</option>
            <option value="latency">Lowest latency</option>
            <option value="uptime">Best uptime</option>
            <option value="name">Name</option>
            <option value="last_seen">Recently seen</option>
          </select>
          <label className="col-span-2 lg:col-span-3 flex items-center gap-3 text-sm text-fg-muted px-1">
            Min speed
            <input type="range" min={0} max={100} step={5} value={Number(query.min_tps || 0)} onChange={(e) => set({ min_tps: Number(e.target.value) || '' })} aria-label="Minimum tokens per second" className="flex-1 accent-current" />
            <span className="tabular-nums w-20">{query.min_tps || 0} tok/s</span>
          </label>
        </div>

        {error && <ErrorNote>Could not reach the directory ({error}). Check Settings → Directory URL.</ErrorNote>}

        {result && result.nodes.length === 0 && !loading ? (
          <Empty icon={<Server className="w-5 h-5" />} title="No nodes match these filters">Try clearing the filters, or deploy your own node.</Empty>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-fg-muted border-b border-border">
                <tr>
                  <th className="px-4 py-3 font-medium">Node</th>
                  <th className="px-4 py-3 font-medium">Models</th>
                  <th className="px-4 py-3 font-medium text-right">Speed</th>
                  <th className="px-4 py-3 font-medium text-right">Latency</th>
                  <th className="px-4 py-3 font-medium text-right">Uptime 7d</th>
                  <th className="px-4 py-3 font-medium">Seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result?.nodes.map((n) => (
                  <tr key={n.peer_id} className="hover:bg-muted cursor-pointer" onClick={() => setSelected(n.peer_id)}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 font-medium"><Dot on={n.online} /> {n.name}</div>
                      <div className="text-xs text-fg-muted mt-0.5">{n.region} · {n.reachable ? <span className="text-ok">reachable</span> : <span className="text-warn">not reachable</span>}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1 max-w-sm">
                        {n.models.slice(0, 4).map((m) => <Badge key={m.name + m.provider}>{m.name} · {m.provider}</Badge>)}
                        {n.models.length > 4 && <Badge>+{n.models.length - 4}</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmt(n.tokens_per_sec, 1)} <span className="text-fg-muted text-xs">tok/s</span></td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmt(n.latency_ms)} <span className="text-fg-muted text-xs">ms</span></td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmtPct(n.uptime_7d)}</td>
                    <td className="px-4 py-3 text-fg-muted text-xs">{timeAgo(n.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result && result.total > PAGE && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-border text-sm">
                <span className="text-fg-muted">{result.total} nodes</span>
                <div className="flex gap-2">
                  <button className="btn-ghost h-8" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
                  <span className="px-2 py-1.5 text-fg-muted">{page + 1} / {totalPages}</span>
                  <button className="btn-ghost h-8" disabled={page + 1 >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {selected && <NodeDetails peerId={selected} onClose={() => setSelected(null)} onChat={onChat} />}
    </div>
  );
}

function NodeDetails({ peerId, onClose, onChat }: { peerId: string; onClose: () => void; onChat: (t: ChatTarget) => void }) {
  const [node, setNode] = useState<DirectoryNode | null>(null);
  const [error, setError] = useState('');
  const [probe, setProbe] = useState<{ busy: boolean; info?: NodeInfo; error?: string }>({ busy: false });

  useEffect(() => {
    directory.node(peerId).then(setNode).catch((e) => setError(errorMessage(e)));
  }, [peerId]);

  const test = useCallback(async () => {
    if (!node) return;
    setProbe({ busy: true });
    try {
      setProbe({ busy: false, info: await native.probe(node.addr) });
    } catch (e) {
      setProbe({ busy: false, error: errorMessage(e) });
    }
  }, [node]);

  return (
    <Modal title={node?.name ?? 'Node'} onClose={onClose} wide>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!node && !error && <p className="text-sm text-fg-muted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>}
      {node && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Speed" value={`${fmt(node.tokens_per_sec, 1)} tok/s`} hint="self-reported" />
            <Stat label="Latency" value={`${fmt(node.latency_ms)} ms`} hint="from the directory" />
            <Stat label="Uptime (7 days)" value={fmtPct(node.uptime_7d)} />
            <Stat label="CPU / RAM" value={`${fmtPct(node.cpu_percent)} / ${fmtPct(node.memory_percent)}`} />
          </div>
          <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
            <dt className="text-fg-muted">Peer id</dt><dd className="font-mono text-xs selectable break-all">{node.peer_id}</dd>
            <dt className="text-fg-muted">Address</dt><dd className="font-mono text-xs selectable break-all">{node.addr}</dd>
            <dt className="text-fg-muted">Region</dt><dd>{node.region}</dd>
            <dt className="text-fg-muted">Version</dt><dd>{node.version ?? '—'}</dd>
            <dt className="text-fg-muted">Status</dt>
            <dd className="flex items-center gap-2"><Dot on={node.online} /> {node.online ? 'online' : 'offline'} · {node.reachable ? 'reachable' : `not reachable${node.probe_error ? ` (${node.probe_error})` : ''}`}</dd>
            <dt className="text-fg-muted">First seen</dt><dd>{new Date(node.first_seen).toLocaleString()}</dd>
          </dl>
          {node.uptime_history && node.uptime_history.length > 0 && (
            <div>
              <p className="label mb-2">Daily uptime (last 30 days)</p>
              <div className="flex items-end gap-1 h-16" aria-label="Uptime history">
                {node.uptime_history.map((d) => (
                  <div key={d.day} title={`${d.day}: ${d.uptime}%`} className="flex-1 bg-ok/70 rounded-sm min-h-[2px]" style={{ height: `${Math.max(3, d.uptime)}%` }} />
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="label mb-2">Models</p>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {node.models.map((m) => (
                  <tr key={m.name + m.provider}>
                    <td className="py-2 font-medium">{m.name}</td>
                    <td className="py-2"><Badge>{m.provider}</Badge></td>
                    <td className="py-2 text-right tabular-nums text-fg-muted">{fmt(m.tokens_per_sec, 1)} tok/s</td>
                    <td className="py-2 text-right">
                      <button className="btn-primary h-8" disabled={!isTauri()} onClick={() => { onChat({ addr: node.addr, peerId: node.peer_id, name: node.name, model: m.name }); onClose(); }}>
                        <MessageSquare className="w-3.5 h-3.5" /> Chat
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3">
            <button className="btn-ghost" onClick={test} disabled={probe.busy || !isTauri()}>
              {probe.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />} Test connection from this computer
            </button>
            {probe.info && <span className="text-sm text-ok">Verified {shortId(probe.info.peer_id)} in {probe.info.latency_ms} ms</span>}
            {probe.error && <span className="text-sm text-danger">{probe.error}</span>}
          </div>
        </div>
      )}
    </Modal>
  );
}
