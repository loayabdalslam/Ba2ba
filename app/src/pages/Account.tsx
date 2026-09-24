import { Copy, KeyRound, LogOut, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Page } from '@/components/Layout';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtNumber } from '@/lib/format';
import type { ApiKey } from '@/lib/types';

function SignIn() {
  const { signInWithEmail, signInWithGitHub } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const github = import.meta.env.VITE_AUTH_GITHUB === 'true';

  return (
    <div className="max-w-sm mx-auto card space-y-6">
      <h1 className="text-2xl font-light">Sign in</h1>
      <p className="text-sm text-gray-500">Get chat history, higher rate limits and API keys.</p>
      {sent ? (
        <p className="text-sm">Check <b>{email}</b> for a sign-in link.</p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            try {
              await signInWithEmail(email);
              setSent(true);
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not send the link');
            }
          }}
        >
          <label htmlFor="email" className="label">Email</label>
          <input id="email" type="email" required className="field" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          <button className="w-full h-12 rounded-full bg-black text-white text-xs font-bold uppercase tracking-widest">Email me a link</button>
        </form>
      )}
      {github && (
        <button onClick={() => signInWithGitHub().catch((e) => setError(e.message))} className="w-full h-12 rounded-full border border-gray-200 text-xs font-bold uppercase tracking-widest">
          Continue with GitHub
        </button>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

export default function Account() {
  const { enabled, session, token, email, loading, signOut } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [usage, setUsage] = useState<Record<string, { used: number; quota: number }>>({});
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [k, u] = await Promise.all([api.listKeys(token), api.usage(token)]);
      setKeys(k.keys);
      setUsage(Object.fromEntries(u.usage.map((x) => [x.key_id, x])));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load keys');
    }
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);

  if (!enabled) {
    return <Page><p className="max-w-md mx-auto py-24 px-6 text-center text-gray-500">Accounts are not enabled on this deployment.</p></Page>;
  }
  if (loading) return <Page><p className="py-24 text-center text-gray-400">Loading…</p></Page>;
  if (!session || !token) return <Page><div className="py-24 px-6"><SignIn /></div></Page>;

  const origin = window.location.origin;
  return (
    <Page>
      <div className="max-w-3xl mx-auto px-6 py-16 space-y-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-light">Account</h1>
            <p className="text-sm text-gray-500 mt-1">{email}</p>
          </div>
          <button onClick={signOut} className="flex items-center gap-2 text-xs font-semibold text-gray-500 hover:text-black">
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>

        <section className="card space-y-6">
          <div className="flex items-center gap-3">
            <KeyRound className="w-5 h-5" aria-hidden />
            <h2 className="text-xl font-light">API keys</h2>
          </div>
          <form
            className="flex gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setError('');
              try {
                const res = await api.createKey(token, name || 'default');
                setSecret(res.secret);
                setName('');
                load();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : 'Could not create key');
              }
            }}
          >
            <label htmlFor="keyname" className="sr-only">Key name</label>
            <input id="keyname" className="field" placeholder="Key name (e.g. laptop)" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            <button className="h-12 px-6 rounded-2xl bg-black text-white text-xs font-bold shrink-0">Create key</button>
          </form>
          {secret && (
            <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 space-y-2" role="alert">
              <p className="text-xs font-semibold">Copy your key now. It will not be shown again.</p>
              <div className="flex gap-2 items-center">
                <code className="flex-1 text-xs break-all">{secret}</code>
                <button aria-label="Copy key" onClick={() => navigator.clipboard.writeText(secret)} className="p-2 hover:bg-amber-100 rounded-lg"><Copy className="w-4 h-4" /></button>
              </div>
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <ul className="divide-y divide-gray-100">
            {keys.length === 0 && <li className="py-3 text-sm text-gray-400">No keys yet.</li>}
            {keys.map((k) => (
              <li key={k.id} className="py-3 flex items-center gap-4 text-sm">
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{k.name} {k.revoked_at && <span className="text-xs text-red-500 ml-2">revoked</span>}</p>
                  <p className="text-xs text-gray-400 font-mono">{k.prefix}… · created {new Date(k.created_at).toLocaleDateString()}</p>
                </div>
                {!k.revoked_at && (
                  <p className="text-xs text-gray-500">{fmtNumber(usage[k.id]?.used)} / {fmtNumber(k.monthly_token_quota)} tokens this month</p>
                )}
                {!k.revoked_at && (
                  <button aria-label={`Revoke ${k.name}`} onClick={async () => { await api.revokeKey(token, k.id).catch(() => {}); load(); }} className="p-2 hover:bg-red-50 rounded-lg">
                    <Trash2 className="w-4 h-4 text-red-500" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="card space-y-4">
          <h2 className="text-xl font-light">Quick start</h2>
          <pre className="bg-[#0d0d0d] text-gray-200 text-xs p-6 rounded-2xl overflow-x-auto">{`from openai import OpenAI

client = OpenAI(base_url="${origin}/v1", api_key="b2b_...")
reply = client.chat.completions.create(
    model="llama3.2",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)`}</pre>
        </section>
      </div>
    </Page>
  );
}
