import { Activity, CheckCircle2, Plus, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Page } from '@/components/Layout';
import { useMeshStatus } from '@/hooks/useMeshStatus';
import { api, ApiError } from '@/lib/api';
import { fmtPercent, shortId } from '@/lib/format';
import { parseJoinLink } from '@/lib/joinLink';
import { Link, useRouter } from '@/lib/router';
import type { MeshNode } from '@/lib/types';

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/5 p-6 rounded-[24px] border border-white/10">
      <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2">{label}</p>
      <p className="text-2xl font-mono">{value}</p>
    </div>
  );
}

export default function Register() {
  const { search } = useRouter();
  const [manual, setManual] = useState('');
  const initial = useMemo(() => {
    const link = search.get('link');
    return link ? parseJoinLink(link, search) : null;
  }, [search]);
  const info = initial ?? (manual ? parseJoinLink(manual) : null);
  const [state, setState] = useState<'form' | 'verifying' | 'done' | 'error'>('form');
  const [error, setError] = useState('');
  const [node, setNode] = useState<MeshNode | null>(null);
  const { status } = useMeshStatus(5000);
  const live = node ? status.peers.find((p) => p.peer_id === node.peer_id) ?? node : null;

  const register = async () => {
    if (!info) return;
    setState('verifying');
    setError('');
    try {
      const res = await api.register(info.link);
      setNode(res.node);
      setState('done');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Registration failed');
      setState('error');
    }
  };

  if (state === 'done' && live) {
    const m = live.metrics || {};
    return (
      <div className="min-h-screen bg-black text-white p-6 md:p-10 flex flex-col items-center justify-center text-center">
        <Activity className={`w-14 h-14 mb-6 ${live.connected ? 'text-emerald-500' : 'text-amber-400'}`} aria-hidden />
        <h1 className="text-3xl font-light mb-2">Node verified</h1>
        <p className="text-xs text-gray-400 font-mono break-all">{live.peer_id}</p>
        <p className="text-xs text-gray-500 mt-1">{live.region} · {live.models.join(', ') || 'no models announced'}</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full max-w-3xl mt-10">
          <Metric label="Status" value={live.connected ? 'online' : 'offline'} />
          <Metric label="CPU" value={fmtPercent(m.cpu_percent)} />
          <Metric label="Memory" value={fmtPercent(m.memory_percent)} />
          <Metric label="Latency" value={typeof live.latency_ms === 'number' ? `${Math.round(live.latency_ms)} ms` : '—'} />
        </div>
        <p className="text-[11px] text-gray-500 mt-6 max-w-md">
          Metrics are reported by the node and refresh every few seconds. "—" means the node has not reported that value.
        </p>
        <Link to="/chat" className="pill-btn bg-white text-black mt-10">Open chat</Link>
      </div>
    );
  }

  return (
    <Page>
      <div className="max-w-md mx-auto px-6 py-20 space-y-8">
        <div className="text-center">
          <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Plus className="w-8 h-8 text-blue-600" aria-hidden />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Register a node</h1>
          <p className="text-sm text-gray-500 mt-2">
            The gateway connects to your node and verifies its cryptographic identity before listing it.
          </p>
        </div>
        {!initial && (
          <div className="space-y-2">
            <label className="label" htmlFor="link">Join link printed by your node</label>
            <textarea id="link" className="field h-28 py-3" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="coithub.org://join?…" />
          </div>
        )}
        {info ? (
          <dl className="card p-6 text-sm space-y-2">
            <div className="flex justify-between gap-4"><dt className="text-gray-400">Address</dt><dd className="font-mono text-xs break-all">{info.addr}</dd></div>
            {info.model && <div className="flex justify-between"><dt className="text-gray-400">Model</dt><dd>{info.model}</dd></div>}
            {info.region && <div className="flex justify-between"><dt className="text-gray-400">Region</dt><dd>{info.region}</dd></div>}
          </dl>
        ) : (
          (initial === null && search.get('link')) || manual ? <p className="text-sm text-red-600">This link is not a valid Bee2Bee join link.</p> : null
        )}
        {state === 'error' && (
          <p className="flex items-start gap-2 text-sm text-red-600"><XCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}</p>
        )}
        <button
          onClick={register}
          disabled={!info || state === 'verifying'}
          className="w-full h-14 bg-black text-white rounded-3xl font-bold uppercase tracking-widest text-xs disabled:opacity-40"
        >
          {state === 'verifying' ? 'Verifying node…' : 'Verify & register'}
        </button>
        <p className="text-xs text-gray-400 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden />
          Your node must be reachable from the internet at the address above. Nodes started with a registry URL register
          themselves automatically. Current mesh: {status.connectedNodes} node(s){status.activeNode ? `, e.g. ${shortId(status.peers[0]?.peer_id)}` : ''}.
        </p>
      </div>
    </Page>
  );
}
