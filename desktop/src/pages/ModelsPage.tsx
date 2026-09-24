import { Boxes, Download, Loader2, Rocket, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Badge, Empty, ErrorNote, PageHeader } from '@/components/ui';
import { directory } from '@/lib/directory';
import { fmt, fmtBytes, timeAgo } from '@/lib/format';
import { useSettings } from '@/lib/settings';
import { errorMessage, isTauri, native } from '@/lib/tauri';
import type { DeploymentConfig, DirectoryStats, OllamaModel, PullProgress } from '@/lib/types';

const SUGGESTED = ['llama3.2', 'qwen2.5:7b', 'gemma3', 'mistral', 'phi4-mini', 'deepseek-r1:7b'];

export default function ModelsPage({ onServe }: { onServe: (prefill: Partial<DeploymentConfig>) => void }) {
  const [settings] = useSettings();
  const [models, setModels] = useState<OllamaModel[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [pull, setPull] = useState<{ model: string; progress: PullProgress } | null>(null);
  const [network, setNetwork] = useState<DirectoryStats['models']>([]);
  const [hfModel, setHfModel] = useState('');

  const refresh = useCallback(() => {
    if (!isTauri()) return setModels([]);
    native.ollamaList(settings.ollamaHost).then((m) => { setModels(m); setError(''); }).catch((e) => { setModels([]); setError(errorMessage(e)); });
  }, [settings.ollamaHost]);
  useEffect(refresh, [refresh]);
  useEffect(() => { directory.models().then((r) => setNetwork(r.models)).catch(() => setNetwork([])); }, []);

  const doPull = async (model: string) => {
    if (!model.trim()) return;
    setPull({ model, progress: { status: 'starting', completed: 0, total: 0 } });
    setError('');
    try {
      await native.ollamaPull(settings.ollamaHost, model.trim(), (progress) => setPull({ model, progress }));
      setName('');
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPull(null);
    }
  };

  const pct = pull && pull.progress.total ? Math.round((pull.progress.completed / pull.progress.total) * 100) : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-8 py-8 space-y-8">
        <PageHeader title="Models" subtitle="Pull models into Ollama, then serve them to the network with one click." />

        <section className="card p-5 space-y-4">
          <h2 className="font-semibold">Pull an Ollama model</h2>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); doPull(name); }}>
            <input className="field" placeholder="Model name, e.g. llama3.2 or qwen2.5:7b" value={name} onChange={(e) => setName(e.target.value)} aria-label="Model to pull" />
            <button className="btn-primary shrink-0" disabled={!name.trim() || Boolean(pull) || !isTauri()}><Download className="w-4 h-4" /> Pull</button>
          </form>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED.map((m) => <button key={m} className="btn-ghost h-7 px-3 text-xs" disabled={Boolean(pull)} onClick={() => doPull(m)}>{m}</button>)}
          </div>
          {pull && (
            <div aria-live="polite">
              <div className="flex justify-between text-sm mb-1"><span>{pull.model}: {pull.progress.status}</span><span className="tabular-nums">{pct !== null ? `${pct}% · ${fmtBytes(pull.progress.completed)} / ${fmtBytes(pull.progress.total)}` : ''}</span></div>
              <div className="h-2 rounded-full bg-muted overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${pct ?? 5}%` }} /></div>
            </div>
          )}
          {error && <ErrorNote>{error.includes('connect') || error.includes('error sending') ? `Ollama is not reachable at ${settings.ollamaHost}. Install it from ollama.com and start it.` : error}</ErrorNote>}
        </section>

        <section>
          <h2 className="font-semibold mb-3">Installed in Ollama</h2>
          {models === null ? (
            <p className="text-sm text-fg-muted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
          ) : models.length === 0 ? (
            <Empty icon={<Boxes className="w-5 h-5" />} title="No local models">Pull a model above to get started.</Empty>
          ) : (
            <div className="card divide-y divide-border">
              {models.map((m) => (
                <div key={m.name} className="flex items-center gap-4 px-4 py-3">
                  <div className="flex-1">
                    <p className="font-medium">{m.name}</p>
                    <p className="text-xs text-fg-muted">{fmtBytes(m.size)}{m.parameter_size ? ` · ${m.parameter_size}` : ''}{m.quantization ? ` · ${m.quantization}` : ''} · updated {timeAgo(m.modified_at)}</p>
                  </div>
                  <button className="btn-primary h-8" onClick={() => onServe({ backend: 'ollama', model: m.name, name: `${m.name.split(':')[0]} node` })}><Rocket className="w-3.5 h-3.5" /> Serve</button>
                  <button aria-label={`Delete ${m.name}`} className="p-2 rounded-lg hover:bg-muted text-danger" onClick={async () => { if (confirm(`Delete ${m.name} from Ollama?`)) { await native.ollamaDelete(settings.ollamaHost, m.name).catch((e) => setError(errorMessage(e))); refresh(); } }}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card p-5 space-y-3">
          <h2 className="font-semibold">Serve a Hugging Face model</h2>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (hfModel.trim()) onServe({ backend: 'hf', model: hfModel.trim(), name: `${hfModel.split('/').pop()} node` }); }}>
            <input className="field" placeholder="e.g. Qwen/Qwen2.5-0.5B-Instruct" value={hfModel} onChange={(e) => setHfModel(e.target.value)} aria-label="Hugging Face model id" />
            <button className="btn-ghost shrink-0" disabled={!hfModel.trim()}>Run locally</button>
            <button type="button" className="btn-ghost shrink-0" disabled={!hfModel.trim()} onClick={() => onServe({ backend: 'hf_remote', model: hfModel.trim(), name: `${hfModel.split('/').pop()} (HF API)` })}>Use Inference API</button>
          </form>
        </section>

        <section>
          <h2 className="font-semibold mb-3">Popular on the network</h2>
          {network.length === 0 ? <p className="text-sm text-fg-muted">No data from the directory yet.</p> : (
            <div className="grid md:grid-cols-2 gap-2">
              {network.slice(0, 12).map((m) => (
                <div key={m.model} className="card px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="font-medium">{m.model}</p>
                    <p className="text-xs text-fg-muted">{m.nodes} node(s) · best {fmt(m.best_tokens_per_sec, 1)} tok/s</p>
                  </div>
                  <div className="flex gap-1">{m.providers.map((p) => <Badge key={p}>{p}</Badge>)}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
