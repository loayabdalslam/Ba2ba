import { CheckCircle2, Download, Loader2, MessageSquare, Pencil, Play, Plus, Rocket, ScrollText, Square, Trash2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { DeploymentForm } from '@/components/DeploymentForm';
import { Badge, Empty, ErrorNote, Modal, PageHeader } from '@/components/ui';
import { shortId, timeAgo } from '@/lib/format';
import { launchOptions } from '@/lib/launch';
import { useSettings } from '@/lib/settings';
import { errorMessage, isTauri, native } from '@/lib/tauri';
import type { ChatTarget, DeploymentConfig, DeploymentView, EnvStatus } from '@/lib/types';

function StateBadge({ d }: { d: DeploymentView }) {
  const s = d.state;
  if (s.state === 'running') return <Badge tone="ok">running · {timeAgo(s.started_at * 1000)}</Badge>;
  if (s.state === 'failed') return <Badge tone="danger">failed</Badge>;
  if (s.state === 'exited') return <Badge tone={s.code === 0 || s.code === null ? 'neutral' : 'danger'}>exited{s.code !== null ? ` (${s.code})` : ''}</Badge>;
  return <Badge>stopped</Badge>;
}

export function EnvPanel() {
  const [settings] = useSettings();
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [installing, setInstalling] = useState<string[] | null>(null);
  const [installError, setInstallError] = useState('');

  const check = useCallback(() => {
    if (isTauri()) native.envCheck(settings.bee2beeCommand, settings.ollamaHost).then(setEnv);
  }, [settings.bee2beeCommand, settings.ollamaHost]);
  useEffect(check, [check]);

  const install = async () => {
    setInstalling([]);
    setInstallError('');
    try {
      await native.installBee2bee(settings.pythonCommand, (line) => setInstalling((l) => [...(l ?? []), line].slice(-400)));
      check();
    } catch (e) {
      setInstallError(errorMessage(e));
    }
  };

  const Row = ({ ok, label, detail }: { ok: boolean | undefined; label: string; detail: string }) => (
    <div className="flex items-center gap-2 text-sm">
      {ok === undefined ? <Loader2 className="w-4 h-4 animate-spin" /> : ok ? <CheckCircle2 className="w-4 h-4 text-ok" /> : <XCircle className="w-4 h-4 text-danger" />}
      <span className="font-medium">{label}</span>
      <span className="text-fg-muted truncate">{detail}</span>
    </div>
  );

  return (
    <div className="card p-4 mb-6 flex flex-wrap items-center gap-x-8 gap-y-2">
      <Row ok={env?.bee2bee.ok} label="bee2bee CLI" detail={env ? env.bee2bee.version ?? env.bee2bee.error ?? '' : 'checking…'} />
      <Row ok={env?.ollama.ok} label="Ollama" detail={env ? (env.ollama.ok ? `v${env.ollama.version}` : 'not running (only needed for Ollama models)') : 'checking…'} />
      <div className="ml-auto flex gap-2">
        {env && !env.bee2bee.ok && (
          <button className="btn-primary" onClick={install} disabled={installing !== null && !installError}>
            <Download className="w-4 h-4" /> Install bee2bee
          </button>
        )}
        <button className="btn-ghost" onClick={check}>Re-check</button>
      </div>
      {installing && (
        <Modal title="Installing bee2bee" onClose={() => setInstalling(null)}>
          <pre className="selectable text-xs bg-muted rounded-xl p-3 h-72 overflow-auto whitespace-pre-wrap">{installing.join('\n') || 'Starting pip…'}</pre>
          {installError && <div className="mt-3"><ErrorNote>{installError}. Check the Python command in Settings.</ErrorNote></div>}
        </Modal>
      )}
    </div>
  );
}

function LogsModal({ d, onClose }: { d: DeploymentView; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    native.deployLogs(d.config.id).then(setLines);
    native.onDeployLog((e) => { if (e.id === d.config.id) setLines((l) => [...l, e.line].slice(-2000)); }).then((u) => (off = u));
    return () => off?.();
  }, [d.config.id]);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [lines]);
  return (
    <Modal title={`Logs · ${d.config.name}`} onClose={onClose} wide>
      <pre ref={box} className="selectable text-xs font-mono bg-[#0d0d0d] text-gray-200 rounded-xl p-4 h-[60vh] overflow-auto whitespace-pre-wrap">{lines.join('\n') || 'No output yet.'}</pre>
      <p className="text-xs text-fg-muted mt-2">Node data directory: <span className="selectable font-mono">{d.home}</span></p>
    </Modal>
  );
}

export default function DeployPage({ onChat, prefill, clearPrefill }: { onChat: (t: ChatTarget) => void; prefill: Partial<DeploymentConfig> | null; clearPrefill: () => void }) {
  const [items, setItems] = useState<DeploymentView[]>([]);
  const [form, setForm] = useState<Partial<DeploymentConfig> | null>(null);
  const [logs, setLogs] = useState<DeploymentView | null>(null);
  const [status, setStatus] = useState<Record<string, { peers: number; peer_id?: string; addr?: string }>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    const list = await native.deployList();
    setItems(list);
    const next: typeof status = {};
    await Promise.all(list.filter((d) => d.state.state === 'running').map(async (d) => {
      try {
        const s = await native.deployStatus(d.config.id);
        next[d.config.id] = { peers: Array.isArray(s.peers) ? s.peers.length : 0, peer_id: s.node.peer_id as string, addr: s.node.addr as string };
      } catch { /* node still starting */ }
    }));
    setStatus(next);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (prefill) {
      setForm(prefill);
      clearPrefill();
    }
  }, [prefill, clearPrefill]);

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-8 py-8">
        <PageHeader
          title="Deploy nodes"
          subtitle="Run Bee2Bee nodes on this computer and share your models with the network."
          actions={<button className="btn-primary" disabled={!isTauri()} onClick={() => setForm({})}><Plus className="w-4 h-4" /> New deployment</button>}
        />
        {isTauri() ? <EnvPanel /> : <ErrorNote>Deployments are available in the desktop app.</ErrorNote>}
        {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}
        {items.length === 0 ? (
          <Empty icon={<Rocket className="w-5 h-5" />} title="No deployments yet">Create one to serve an Ollama or Hugging Face model to the mesh.</Empty>
        ) : (
          <div className="space-y-3">
            {items.map((d) => {
              const running = d.state.state === 'running';
              const st = status[d.config.id];
              return (
                <div key={d.config.id} className="card p-4 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold">{d.config.name}</p>
                      <StateBadge d={d} />
                      {d.config.auto_start && <Badge>auto-start</Badge>}
                    </div>
                    <p className="text-sm text-fg-muted mt-0.5">{d.config.backend} · {d.config.model} · P2P :{d.config.port} · API :{d.config.api_port} · {d.config.region}</p>
                    {running && st && <p className="text-xs text-fg-muted mt-1 font-mono">{shortId(st.peer_id)} · {st.addr} · {st.peers} peer(s)</p>}
                    {d.state.state === 'failed' && <p className="text-xs text-danger mt-1">{d.state.error}</p>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {running ? (
                      <>
                        <button className="btn-ghost h-8" onClick={() => onChat({ addr: `ws://127.0.0.1:${d.config.port}`, name: d.config.name, model: d.config.model, peerId: st?.peer_id })}><MessageSquare className="w-3.5 h-3.5" /> Chat</button>
                        <button className="btn-ghost h-8" disabled={busy === d.config.id} onClick={() => act(d.config.id, () => native.deployStop(d.config.id))}>
                          {busy === d.config.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />} Stop
                        </button>
                      </>
                    ) : (
                      <button className="btn-primary h-8" disabled={busy === d.config.id} onClick={() => act(d.config.id, () => native.deployStart(d.config.id, launchOptions()))}>
                        {busy === d.config.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Start
                      </button>
                    )}
                    <button aria-label={`Logs for ${d.config.name}`} className="p-2 rounded-lg hover:bg-muted" onClick={() => setLogs(d)}><ScrollText className="w-4 h-4" /></button>
                    <button aria-label={`Edit ${d.config.name}`} className="p-2 rounded-lg hover:bg-muted disabled:opacity-30" disabled={running} onClick={() => setForm(d.config)}><Pencil className="w-4 h-4" /></button>
                    <button aria-label={`Delete ${d.config.name}`} className="p-2 rounded-lg hover:bg-muted text-danger" onClick={() => { if (confirm(`Delete "${d.config.name}"? Its identity key is kept on disk.`)) act(d.config.id, () => native.deployRemove(d.config.id)); }}><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {form && (
        <DeploymentForm
          initial={form}
          existing={items}
          onClose={() => setForm(null)}
          onSaved={(cfg, start) => {
            setForm(null);
            if (start) act(cfg.id, () => native.deployStart(cfg.id, launchOptions()));
            else refresh();
          }}
        />
      )}
      {logs && <LogsModal d={logs} onClose={() => setLogs(null)} />}
    </div>
  );
}
