import { Globe, Laptop, Link2, Loader2, Search } from 'lucide-react';
import { useEffect, useState } from 'react';

import { directory } from '@/lib/directory';
import { fmt, shortId } from '@/lib/format';
import { errorMessage, isTauri, native } from '@/lib/tauri';
import type { ChatTarget, DeploymentView, DirectoryNode, NodeInfo } from '@/lib/types';

import { Badge, Dot, ErrorNote, Modal } from './ui';

type Tab = 'network' | 'mine' | 'manual';

export function NodePicker({ onPick, onClose, initialModel }: { onPick: (t: ChatTarget) => void; onClose: () => void; initialModel?: string }) {
  const [tab, setTab] = useState<Tab>('network');
  return (
    <Modal title="Choose a node to chat with" onClose={onClose} wide>
      <div className="flex gap-1 mb-4 p-1 bg-muted rounded-xl w-fit" role="tablist">
        {([['network', 'Network', Globe], ['mine', 'My nodes', Laptop], ['manual', 'Address', Link2]] as const).map(([t, label, Icon]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`flex items-center gap-2 px-3 h-8 rounded-lg text-sm ${tab === t ? 'bg-elevated shadow-sm font-medium' : 'text-fg-muted'}`}>
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>
      {tab === 'network' && <NetworkTab onPick={onPick} initialModel={initialModel} />}
      {tab === 'mine' && <MineTab onPick={onPick} />}
      {tab === 'manual' && <ManualTab onPick={onPick} />}
    </Modal>
  );
}

function ModelButtons({ models, onChoose }: { models: string[]; onChoose: (m: string | undefined) => void }) {
  if (!models.length) return <button className="btn-ghost h-8" onClick={() => onChoose(undefined)}>Use default model</button>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {models.map((m) => (
        <button key={m} className="btn-ghost h-8 px-3 text-xs" onClick={() => onChoose(m)}>{m}</button>
      ))}
    </div>
  );
}

function NetworkTab({ onPick, initialModel }: { onPick: (t: ChatTarget) => void; initialModel?: string }) {
  const [q, setQ] = useState(initialModel ?? '');
  const [nodes, setNodes] = useState<DirectoryNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      directory
        .nodes({ q: q || undefined, reachable: 'true', sort: 'tps', limit: 50 }, ctrl.signal)
        .then((r) => { setNodes(r.nodes); setError(''); })
        .catch((e) => { if (!ctrl.signal.aborted) setError(errorMessage(e)); })
        .finally(() => setLoading(false));
    }, 250);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-3 text-fg-muted" />
        <input autoFocus className="field pl-9!" placeholder="Search by node, model, provider or region" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search nodes" />
      </div>
      {error && <ErrorNote>Could not reach the directory: {error}. Check Settings → Directory URL.</ErrorNote>}
      {loading && <p className="text-sm text-fg-muted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Searching…</p>}
      {!loading && !error && nodes.length === 0 && <p className="text-sm text-fg-muted">No reachable nodes match.</p>}
      <ul className="divide-y divide-border">
        {nodes.map((n) => (
          <li key={n.peer_id} className="py-3 flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium flex items-center gap-2"><Dot on={n.online} /> {n.name} <span className="text-xs text-fg-muted">{n.region}</span></p>
              <p className="text-xs text-fg-muted font-mono mt-0.5">{shortId(n.peer_id)} · {fmt(n.tokens_per_sec, 1)} tok/s · {fmt(n.latency_ms)} ms</p>
              <div className="flex flex-wrap gap-1 mt-1.5">{[...new Set(n.models.map((m) => m.provider))].map((p) => <Badge key={p}>{p}</Badge>)}</div>
            </div>
            <ModelButtons models={n.models.map((m) => m.name)} onChoose={(model) => onPick({ addr: n.addr, peerId: n.peer_id, name: n.name, model })} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function MineTab({ onPick }: { onPick: (t: ChatTarget) => void }) {
  const [items, setItems] = useState<DeploymentView[] | null>(null);
  useEffect(() => {
    if (isTauri()) native.deployList().then(setItems).catch(() => setItems([]));
    else setItems([]);
  }, []);
  const running = (items ?? []).filter((d) => d.state.state === 'running');
  if (items === null) return <p className="text-sm text-fg-muted">Loading…</p>;
  if (!running.length) return <p className="text-sm text-fg-muted">No local node is running. Start one from “Deploy nodes”.</p>;
  return (
    <ul className="divide-y divide-border">
      {running.map((d) => (
        <li key={d.config.id} className="py-3 flex items-center gap-4">
          <div className="flex-1">
            <p className="font-medium">{d.config.name}</p>
            <p className="text-xs text-fg-muted">{d.config.backend} · ws://127.0.0.1:{d.config.port}</p>
          </div>
          <ModelButtons models={[d.config.model]} onChoose={(model) => onPick({ addr: `ws://127.0.0.1:${d.config.port}`, name: d.config.name, model })} />
        </li>
      ))}
    </ul>
  );
}

function ManualTab({ onPick }: { onPick: (t: ChatTarget) => void }) {
  const [addr, setAddr] = useState('');
  const [info, setInfo] = useState<NodeInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const test = async () => {
    setBusy(true);
    setError('');
    setInfo(null);
    try {
      setInfo(await native.probe(addr.trim()));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); test(); }}>
        <input className="field" placeholder="wss://node.example.com or ws://192.168.1.20:4003" value={addr} onChange={(e) => setAddr(e.target.value)} aria-label="Node address" />
        <button className="btn-primary shrink-0" disabled={!addr.trim() || busy || !isTauri()}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Connect'}</button>
      </form>
      <p className="text-xs text-fg-muted">The app verifies the node's cryptographic identity before chatting.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      {info && (
        <div className="card p-4 space-y-3">
          <p className="text-sm"><b>{shortId(info.peer_id)}</b> · {info.region || 'unknown region'} · {info.latency_ms} ms · {info.providers.join(', ') || 'no providers'}</p>
          <ModelButtons models={info.models} onChoose={(model) => onPick({ addr: addr.trim(), peerId: info.peer_id, name: shortId(info.peer_id), model })} />
        </div>
      )}
    </div>
  );
}
