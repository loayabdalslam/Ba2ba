import { useEffect, useState } from 'react';

import { newId } from '@/lib/conversations';
import { nextPorts } from '@/lib/ports';
import { session } from '@/lib/session';
import { useSettings } from '@/lib/settings';
import { isTauri, native } from '@/lib/tauri';
import type { Backend, DeploymentConfig, DeploymentView, OllamaModel } from '@/lib/types';

import { ErrorNote, Field, Modal } from './ui';

const BACKENDS: { value: Backend; label: string; hint: string }[] = [
  { value: 'ollama', label: 'Ollama (local GPU/CPU)', hint: 'Serves a model you pulled into Ollama on this computer.' },
  { value: 'hf', label: 'Hugging Face (local)', hint: 'Downloads weights and runs them with transformers. Needs bee2bee[hf,torch].' },
  { value: 'hf_remote', label: 'Hugging Face Inference API', hint: 'Proxies to Hugging Face servers using your token.' },
  { value: 'echo', label: 'Echo (test)', hint: 'Repeats the prompt. Useful to test networking.' },
];

export function DeploymentForm({
  initial,
  existing,
  onClose,
  onSaved,
}: {
  initial?: Partial<DeploymentConfig>;
  existing: DeploymentView[];
  onClose: () => void;
  onSaved: (cfg: DeploymentConfig, start: boolean) => void;
}) {
  const [settings] = useSettings();
  const [cfg, setCfg] = useState<DeploymentConfig>(() => ({
    id: newId(),
    name: 'My node',
    backend: 'ollama',
    model: '',
    region: 'Auto',
    price: 0,
    auto_start: false,
    announce_addr: '',
    public_host: '',
    bootstrap: '',
    ...nextPorts(existing),
    ...initial,
  }));
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[] | null>(null);
  const [token, setToken] = useState(session.getHfToken());
  const [error, setError] = useState('');
  const editing = existing.some((d) => d.config.id === cfg.id);

  useEffect(() => {
    if (cfg.backend === 'ollama' && isTauri()) native.ollamaList(settings.ollamaHost).then(setOllamaModels).catch(() => setOllamaModels([]));
  }, [cfg.backend, settings.ollamaHost]);

  const set = (patch: Partial<DeploymentConfig>) => setCfg((c) => ({ ...c, ...patch }));

  const save = async (start: boolean) => {
    setError('');
    if (!cfg.model.trim()) return setError('Choose a model.');
    if (cfg.backend === 'hf_remote' && !token) return setError('A Hugging Face token is required for the Inference API.');
    if (cfg.announce_addr && !/^wss?:\/\/.+/.test(cfg.announce_addr)) return setError('Public address must start with ws:// or wss://');
    session.setHfToken(token);
    const clean: DeploymentConfig = {
      ...cfg,
      name: cfg.name.trim(),
      model: cfg.model.trim(),
      announce_addr: cfg.announce_addr?.trim() || null,
      public_host: cfg.public_host?.trim() || null,
      bootstrap: cfg.bootstrap?.trim() || null,
    };
    try {
      await native.deploySave(clean);
      onSaved(clean, start);
    } catch (e) {
      setError(String(e));
    }
  };

  const backend = BACKENDS.find((b) => b.value === cfg.backend)!;
  return (
    <Modal title={editing ? 'Edit deployment' : 'Deploy a node'} onClose={onClose} wide>
      <div className="grid md:grid-cols-2 gap-4">
        <Field label="Display name" hint="Shown to everyone in the network directory.">
          <input className="field" value={cfg.name} maxLength={64} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Region">
          <input className="field" value={cfg.region} maxLength={64} onChange={(e) => set({ region: e.target.value })} placeholder="e.g. egypt, eu-west" />
        </Field>
        <Field label="Backend" hint={backend.hint}>
          <select className="field" value={cfg.backend} onChange={(e) => set({ backend: e.target.value as Backend, model: '' })}>
            {BACKENDS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </Field>
        <Field label="Model" hint={cfg.backend === 'ollama' && ollamaModels?.length === 0 ? 'No models found in Ollama. Pull one from the Models page.' : undefined}>
          {cfg.backend === 'ollama' && ollamaModels && ollamaModels.length > 0 ? (
            <select className="field" value={cfg.model} onChange={(e) => set({ model: e.target.value })}>
              <option value="">Select a model…</option>
              {ollamaModels.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
          ) : (
            <input className="field" value={cfg.model} onChange={(e) => set({ model: e.target.value })} placeholder={cfg.backend === 'echo' ? 'echo' : cfg.backend === 'ollama' ? 'llama3.2' : 'Qwen/Qwen2.5-0.5B-Instruct'} />
          )}
        </Field>
        {cfg.backend === 'hf_remote' && (
          <Field label="Hugging Face token" hint="Kept in memory for this session only.">
            <input className="field" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="hf_…" autoComplete="off" />
          </Field>
        )}
        <Field label="P2P port">
          <input className="field" type="number" min={1} max={65535} value={cfg.port} onChange={(e) => set({ port: Number(e.target.value) })} />
        </Field>
        <Field label="Local API port">
          <input className="field" type="number" min={1} max={65535} value={cfg.api_port} onChange={(e) => set({ api_port: Number(e.target.value) })} />
        </Field>
        <Field label="Public address (optional)" hint="wss:// URL if you expose the node through a tunnel or reverse proxy. Otherwise the node detects it (UPnP) or uses the public host below.">
          <input className="field" value={cfg.announce_addr ?? ''} onChange={(e) => set({ announce_addr: e.target.value })} placeholder="wss://mynode.example.com" />
        </Field>
        <Field label="Public host (optional)" hint="Your public IP or DNS name if the port is forwarded on your router.">
          <input className="field" value={cfg.public_host ?? ''} onChange={(e) => set({ public_host: e.target.value })} placeholder="203.0.113.7" />
        </Field>
        <Field label="Bootstrap peer (optional)">
          <input className="field" value={cfg.bootstrap ?? ''} onChange={(e) => set({ bootstrap: e.target.value })} placeholder="wss://mesh.example.com" />
        </Field>
        <Field label="Price per token">
          <input className="field" type="number" min={0} step="0.0001" value={cfg.price} onChange={(e) => set({ price: Number(e.target.value) })} />
        </Field>
        <label className="flex items-center gap-2 text-sm md:col-span-2">
          <input type="checkbox" checked={cfg.auto_start} onChange={(e) => set({ auto_start: e.target.checked })} /> Start automatically when the app opens
        </label>
        <p className="text-xs text-fg-muted md:col-span-2">
          {settings.registerDeployments ? `The node will announce itself to the directory at ${settings.directoryUrl}.` : 'Directory registration is off (Settings).'}
        </p>
      </div>
      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      <div className="flex justify-end gap-2 mt-6">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-ghost" onClick={() => save(false)}>Save</button>
        <button className="btn-primary" onClick={() => save(true)}>Save & start</button>
      </div>
    </Modal>
  );
}
