import { AlertTriangle, Cpu, Layers, MessageSquarePlus, Send, Settings2, Square, Trash2, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useMeshStatus } from '@/hooks/useMeshStatus';
import { ApiError, generate } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtNumber, newId, shortId } from '@/lib/format';
import { createConversation, deleteConversation, listConversations, loadMessages, saveMessages, type Conversation } from '@/lib/history';
import { Link } from '@/lib/router';
import type { ChatMessage } from '@/lib/types';

const Markdown = lazy(() => import('@/components/Markdown'));

const SETTINGS_KEY = 'coithub_chat_settings';

interface Settings {
  model: string;
  targetNode: string;
  maxTokens: number;
  temperature: number;
  saveHistory: boolean;
}

function loadSettings(): Settings {
  const defaults: Settings = { model: '', targetNode: '', maxTokens: 1024, temperature: 0.7, saveHistory: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'no_provider') return 'No node is currently serving this model. Pick another model or try again later.';
    if (e.code === 'rate_limited') return e.message;
    if (e.code === 'timeout') return 'The node took too long to answer.';
    return e.message;
  }
  return e instanceof Error ? e.message : 'Unknown error';
}

export default function Chat() {
  const { status, error: statusError } = useMeshStatus();
  const { session, token, enabled: accountsEnabled } = useAuth();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages]);

  const refreshConversations = useCallback(() => {
    if (session) listConversations().then(setConversations).catch(() => setConversations([]));
    else setConversations([]);
  }, [session]);
  useEffect(refreshConversations, [refreshConversations]);

  const connectedNodes = useMemo(() => status.peers.filter((p) => p.connected), [status.peers]);
  const models = status.models;
  const model = settings.model && models.includes(settings.model) ? settings.model : models[0] || '';

  const openConversation = async (id: string) => {
    abortRef.current?.abort();
    setConversationId(id);
    setMessages(await loadMessages(id).catch(() => []));
  };

  const newChat = () => {
    abortRef.current?.abort();
    setConversationId(null);
    setMessages([]);
  };

  const removeConversation = async (id: string) => {
    await deleteConversation(id).catch(() => {});
    if (id === conversationId) newChat();
    refreshConversations();
  };

  const send = async () => {
    const content = input.trim();
    if (!content || busy) return;
    setInput('');
    const userMsg: ChatMessage = { id: newId(), role: 'user', content };
    const aiId = newId();
    const history = [...messages.filter((m) => !m.meta?.error), userMsg];
    setMessages([...messages, userMsg, { id: aiId, role: 'assistant', content: '', meta: { streaming: true } }]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let text = '';
    const update = (patch: Partial<ChatMessage>) =>
      setMessages((prev) => prev.map((m) => (m.id === aiId ? { ...m, ...patch, meta: { ...m.meta, ...patch.meta } } : m)));
    try {
      const final = await generate({
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        model: model || null,
        targetNode: settings.targetNode || null,
        maxTokens: settings.maxTokens,
        temperature: settings.temperature,
        token,
        signal: controller.signal,
        onText: (delta) => {
          text += delta;
          update({ content: text });
        },
      });
      const meta = {
        streaming: false,
        provider: final?.provider,
        via: final?.via,
        latency_ms: final?.latency_ms,
        completion_tokens: final?.usage?.completion_tokens,
      };
      update({ content: text, meta });
      if (session && settings.saveHistory) {
        try {
          let convId = conversationId;
          if (!convId) {
            const conv = await createConversation(session.user.id, content);
            convId = conv.id;
            setConversationId(conv.id);
          }
          await saveMessages(session.user.id, convId, [userMsg, { id: aiId, role: 'assistant', content: text, meta }], model || null);
          refreshConversations();
        } catch {
          /* history is best effort */
        }
      }
    } catch (e) {
      if (controller.signal.aborted) update({ meta: { streaming: false, error: 'Stopped' } });
      else update({ meta: { streaming: false, error: errorText(e) } });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="flex h-screen bg-white text-black">
      <aside className="hidden md:flex w-64 border-r border-gray-100 flex-col p-4 gap-4">
        <Link to="/" className="flex items-center gap-2 px-2 mt-2 mb-4">
          <span className="w-8 h-8 bg-black rounded-lg flex items-center justify-center">
            <Layers className="w-4 h-4 text-white" aria-hidden />
          </span>
          <span className="font-bold text-sm tracking-tight">CoitHub</span>
        </Link>
        <button onClick={newChat} className="flex items-center gap-2 h-10 px-3 rounded-xl border border-gray-100 hover:border-black text-xs font-medium">
          <MessageSquarePlus className="w-4 h-4" /> New chat
        </button>
        <div className="p-4 bg-gray-50 rounded-2xl">
          <p className="label mb-1">Nodes online</p>
          <p className="text-xl font-light">{status.connectedNodes}</p>
          <p className="text-[10px] text-gray-400 mt-1">{models.length} model{models.length === 1 ? '' : 's'} available</p>
        </div>
        <div className="flex-1 overflow-y-auto no-scrollbar space-y-1">
          {session ? (
            conversations.map((c) => (
              <div key={c.id} className={`group flex items-center gap-2 px-3 h-9 rounded-lg text-xs cursor-pointer ${c.id === conversationId ? 'bg-gray-100' : 'hover:bg-gray-50'}`}>
                <button className="flex-1 text-left truncate" onClick={() => openConversation(c.id)}>{c.title}</button>
                <button aria-label="Delete conversation" className="opacity-0 group-hover:opacity-100" onClick={() => removeConversation(c.id)}>
                  <Trash2 className="w-3.5 h-3.5 text-gray-400 hover:text-red-500" />
                </button>
              </div>
            ))
          ) : accountsEnabled ? (
            <p className="text-[11px] text-gray-400 px-2 leading-relaxed">
              <Link to="/account" className="underline">Sign in</Link> to keep your chat history and get higher limits.
            </p>
          ) : null}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 relative">
        <header className="h-16 border-b border-black/5 flex items-center justify-between px-4 md:px-8 gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button aria-label="New chat" onClick={newChat} className="md:hidden w-9 h-9 rounded-full bg-gray-50 flex items-center justify-center shrink-0">
              <MessageSquarePlus className="w-4 h-4" />
            </button>
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${status.connected ? 'bg-emerald-500' : 'bg-red-500'}`} aria-hidden />
            <span className="text-xs font-semibold truncate">
              {statusError ? 'Gateway unreachable' : status.connected ? `${status.connectedNodes} node(s) connected` : 'No nodes connected'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="model">Model</label>
            <select
              id="model"
              value={model}
              onChange={(e) => setSettings({ ...settings, model: e.target.value })}
              className="h-9 max-w-[200px] bg-gray-50 rounded-full px-3 text-xs font-medium outline-none"
              disabled={!models.length}
            >
              {models.length ? models.map((m) => <option key={m} value={m}>{m}</option>) : <option value="">No models</option>}
            </select>
            <button aria-label="Chat settings" onClick={() => setShowSettings(true)} className="w-9 h-9 rounded-full bg-gray-50 hover:bg-gray-100 flex items-center justify-center">
              <Settings2 className="w-4 h-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto pt-8 pb-40">
          <div className="max-w-3xl mx-auto px-4 md:px-6 space-y-10">
            {messages.length === 0 && (
              <div className="py-16 text-center space-y-4">
                <h1 className="text-3xl md:text-5xl font-light tracking-tight text-gray-300">How can the mesh help?</h1>
                <p className="text-xs text-gray-400 max-w-md mx-auto leading-relaxed">
                  Answers come from models run by independent community nodes. Do not share passwords, personal or confidential data.
                </p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`flex items-start gap-3 max-w-[90%] ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  {m.role === 'assistant' && (
                    <span className="w-8 h-8 rounded-full bg-black flex items-center justify-center shrink-0 mt-1">
                      <Cpu className="w-4 h-4 text-white" aria-hidden />
                    </span>
                  )}
                  <div className="min-w-0">
                    {m.role === 'user' ? (
                      <p className="text-[15px] leading-relaxed whitespace-pre-wrap bg-gray-100 py-3 px-5 rounded-[24px] rounded-tr-none">{m.content}</p>
                    ) : (
                      <>
                        {m.content ? (
                          <Suspense fallback={<p className="whitespace-pre-wrap text-[15px]">{m.content}</p>}>
                            <Markdown>{m.content}</Markdown>
                          </Suspense>
                        ) : m.meta?.streaming ? (
                          <div className="space-y-2 py-3 w-64 animate-pulse" aria-label="Waiting for response">
                            <div className="h-2 bg-gray-100 rounded-full w-3/4" />
                            <div className="h-2 bg-gray-100 rounded-full w-1/2" />
                          </div>
                        ) : null}
                        {m.meta?.error && (
                          <p className="mt-2 flex items-center gap-2 text-xs text-red-600">
                            <AlertTriangle className="w-3.5 h-3.5" /> {m.meta.error}
                          </p>
                        )}
                        {!m.meta?.streaming && m.meta?.provider && (
                          <p className="mt-3 text-[10px] text-gray-400 font-mono">
                            node {shortId(m.meta.provider)}
                            {m.meta.via && m.meta.via !== m.meta.provider ? ` via ${shortId(m.meta.via)}` : ''}
                            {m.meta.completion_tokens !== undefined ? ` · ${fmtNumber(m.meta.completion_tokens)} tokens` : ''}
                            {m.meta.latency_ms !== undefined ? ` · ${(m.meta.latency_ms / 1000).toFixed(1)}s` : ''}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        </div>

        <div className="absolute bottom-0 inset-x-0 p-4 md:p-8 bg-gradient-to-t from-white via-white/95 to-transparent">
          <form
            className="max-w-3xl mx-auto"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <div className="flex items-end gap-2 p-2 pl-5 bg-[#f0f2f5] focus-within:bg-white border border-transparent focus-within:border-gray-200 rounded-[28px] transition-colors">
              <label htmlFor="prompt" className="sr-only">Message</label>
              <textarea
                id="prompt"
                rows={1}
                value={input}
                maxLength={32000}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={models.length ? 'Message the mesh…' : 'Waiting for a node to come online…'}
                className="flex-1 resize-none max-h-40 py-3 bg-transparent text-[15px] outline-none focus-visible:outline-none"
              />
              {busy ? (
                <button type="button" aria-label="Stop generating" onClick={() => abortRef.current?.abort()} className="w-11 h-11 rounded-full bg-black text-white flex items-center justify-center">
                  <Square className="w-4 h-4" />
                </button>
              ) : (
                <button type="submit" aria-label="Send" disabled={!input.trim()} className="w-11 h-11 rounded-full flex items-center justify-center bg-black text-white disabled:bg-transparent disabled:text-gray-300">
                  <Send className="w-4 h-4" />
                </button>
              )}
            </div>
            <p className="text-[10px] text-center text-gray-400 mt-3">
              Models can be wrong. Prompts are processed by third-party nodes. <Link to="/privacy" className="underline">Privacy</Link>
            </p>
          </form>
        </div>
      </main>

      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/10 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Chat settings">
          <div className="card max-w-lg w-full space-y-6 relative">
            <button aria-label="Close" onClick={() => setShowSettings(false)} className="absolute top-6 right-6 p-2 hover:bg-gray-100 rounded-full">
              <X className="w-4 h-4" />
            </button>
            <h2 className="text-2xl font-light">Settings</h2>
            <div className="space-y-2">
              <label className="label" htmlFor="node">Route to node (optional)</label>
              <select id="node" className="field" value={settings.targetNode} onChange={(e) => setSettings({ ...settings, targetNode: e.target.value })}>
                <option value="">Automatic (best available)</option>
                {connectedNodes.map((n) => (
                  <option key={n.peer_id} value={n.peer_id}>
                    {n.region} · {shortId(n.peer_id)} · {n.models.join(', ')}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between"><label className="label" htmlFor="maxTokens">Max output tokens</label><span className="text-xs font-mono">{settings.maxTokens}</span></div>
              <input id="maxTokens" type="range" min={64} max={4096} step={64} value={settings.maxTokens} onChange={(e) => setSettings({ ...settings, maxTokens: Number(e.target.value) })} className="w-full accent-black" />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between"><label className="label" htmlFor="temperature">Temperature</label><span className="text-xs font-mono">{settings.temperature.toFixed(1)}</span></div>
              <input id="temperature" type="range" min={0} max={2} step={0.1} value={settings.temperature} onChange={(e) => setSettings({ ...settings, temperature: Number(e.target.value) })} className="w-full accent-black" />
            </div>
            {session && (
              <label className="flex items-center gap-3 text-sm">
                <input type="checkbox" checked={settings.saveHistory} onChange={(e) => setSettings({ ...settings, saveHistory: e.target.checked })} className="accent-black w-4 h-4" />
                Save chat history to my account
              </label>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
