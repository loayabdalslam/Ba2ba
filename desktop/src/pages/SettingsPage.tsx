import { useState } from 'react';

import { Field, PageHeader } from '@/components/ui';
import { conversations } from '@/lib/conversations';
import { DEFAULT_SETTINGS, useSettings } from '@/lib/settings';
import type { AppInfo } from '@/lib/tauri';

export default function SettingsPage({ info }: { info: AppInfo | null }) {
  const [s, update] = useSettings();
  const [dir, setDir] = useState(s.directoryUrl);
  const [saved, setSaved] = useState(false);

  const saveDir = () => {
    const url = dir.trim().replace(/\/$/, '');
    if (!/^https?:\/\//.test(url)) return;
    update({ directoryUrl: url });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-8">
        <PageHeader title="Settings" />

        <section className="card p-5 space-y-4">
          <h2 className="font-semibold">Network</h2>
          <Field label="Directory server" hint="The central server that lists online nodes (server/ on Vercel).">
            <div className="flex gap-2">
              <input className="field" value={dir} onChange={(e) => setDir(e.target.value)} onBlur={saveDir} aria-label="Directory URL" />
              <button className="btn-ghost shrink-0" onClick={saveDir}>{saved ? 'Saved' : 'Save'}</button>
            </div>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.registerDeployments} onChange={(e) => update({ registerDeployments: e.target.checked })} />
            Announce my deployed nodes in the directory
          </label>
        </section>

        <section className="card p-5 space-y-4">
          <h2 className="font-semibold">Chat</h2>
          <Field label={`Max output tokens: ${s.maxTokens}`}>
            <input type="range" min={64} max={4096} step={64} value={s.maxTokens} onChange={(e) => update({ maxTokens: Number(e.target.value) })} className="w-full" aria-label="Max output tokens" />
          </Field>
          <Field label={`Temperature: ${s.temperature.toFixed(1)}`}>
            <input type="range" min={0} max={2} step={0.1} value={s.temperature} onChange={(e) => update({ temperature: Number(e.target.value) })} className="w-full" aria-label="Temperature" />
          </Field>
          <button className="btn-danger" onClick={() => { if (confirm('Delete all chats stored on this computer?')) conversations.clear(); }}>Delete all chats</button>
        </section>

        <section className="card p-5 space-y-4">
          <h2 className="font-semibold">Local tools</h2>
          <Field label="bee2bee command" hint='How to run the CLI, e.g. "bee2bee" or "python3 -m bee2bee".'>
            <input className="field" value={s.bee2beeCommand} onChange={(e) => update({ bee2beeCommand: e.target.value })} />
          </Field>
          <Field label="Python command" hint="Used to install or upgrade bee2bee with pip.">
            <input className="field" value={s.pythonCommand} onChange={(e) => update({ pythonCommand: e.target.value })} />
          </Field>
          <Field label="Ollama address">
            <input className="field" value={s.ollamaHost} onChange={(e) => update({ ollamaHost: e.target.value })} />
          </Field>
        </section>

        <section className="card p-5 space-y-4">
          <h2 className="font-semibold">Appearance</h2>
          <div className="flex gap-2" role="radiogroup" aria-label="Theme">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button key={t} role="radio" aria-checked={s.theme === t} className={s.theme === t ? 'btn-primary' : 'btn-ghost'} onClick={() => update({ theme: t })}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
        </section>

        <section className="card p-5 space-y-2 text-sm">
          <h2 className="font-semibold mb-2">About</h2>
          <p><span className="text-fg-muted">Version:</span> {info?.version ?? '—'}</p>
          <p><span className="text-fg-muted">Client peer id:</span> <span className="font-mono selectable break-all">{info?.peer_id ?? '—'}</span></p>
          <p><span className="text-fg-muted">Data folder:</span> <span className="font-mono selectable break-all">{info?.data_dir ?? '—'}</span></p>
          <button className="btn-ghost mt-2" onClick={() => { update(DEFAULT_SETTINGS); setDir(DEFAULT_SETTINGS.directoryUrl); }}>Reset settings</button>
        </section>
      </div>
    </div>
  );
}
