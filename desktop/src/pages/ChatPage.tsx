import { AlertTriangle, ArrowUp, ChevronDown, Copy, Cpu, RotateCcw, Square } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { NodePicker } from '@/components/NodePicker';
import { conversations, newId } from '@/lib/conversations';
import { fmt, shortId } from '@/lib/format';
import { useSettings } from '@/lib/settings';
import { errorMessage, isTauri, native } from '@/lib/tauri';
import type { ChatMessage, ChatTarget, Conversation } from '@/lib/types';

const Markdown = lazy(() => import('@/components/Markdown'));

interface Props {
  conversation: Conversation | null;
  onCreated: (id: string) => void;
  pendingTarget: ChatTarget | null;
  clearPendingTarget: () => void;
  pendingModel?: string | null;
  clearPendingModel?: () => void;
}

export default function ChatPage({ conversation, onCreated, pendingTarget, clearPendingTarget, pendingModel, clearPendingModel }: Props) {
  const [settings] = useSettings();
  const [input, setInput] = useState('');
  const [picker, setPicker] = useState(false);
  const [pickerModel, setPickerModel] = useState<string | undefined>();
  const [draftTarget, setDraftTarget] = useState<ChatTarget | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const target = conversation?.target ?? draftTarget;
  const messages = useMemo(() => conversation?.messages ?? [], [conversation?.messages]);

  useEffect(() => {
    if (pendingTarget) {
      setDraftTarget(pendingTarget);
      clearPendingTarget();
    }
  }, [pendingTarget, clearPendingTarget]);

  useEffect(() => {
    if (pendingModel) {
      setPickerModel(pendingModel);
      setPicker(true);
      clearPendingModel?.();
    }
  }, [pendingModel, clearPendingModel]);

  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [messages]);
  useEffect(() => inputRef.current?.focus(), [conversation?.id]);

  const setTarget = (t: ChatTarget) => {
    if (conversation) conversations.update(conversation.id, { target: t });
    else setDraftTarget(t);
    setPicker(false);
  };

  const run = async (convId: string, history: ChatMessage[], chatTarget: ChatTarget) => {
    const aiId = newId();
    conversations.setMessages(convId, () => [...history, { id: aiId, role: 'assistant', content: '', meta: { streaming: true } }]);
    setBusyId(aiId);
    let text = '';
    let pending = '';
    let frame = 0;
    const flush = () => {
      frame = 0;
      text += pending;
      pending = '';
      conversations.setMessages(convId, (ms) => ms.map((m) => (m.id === aiId ? { ...m, content: text } : m)));
    };
    try {
      const done = await native.chat(
        aiId,
        {
          addr: chatTarget.addr,
          model: chatTarget.model ?? null,
          messages: history.filter((m) => !m.meta?.error).map(({ role, content }) => ({ role, content })),
          max_tokens: settings.maxTokens,
          temperature: settings.temperature,
        },
        (delta) => {
          pending += delta;
          if (!frame) frame = requestAnimationFrame(flush);
        },
      );
      if (frame) cancelAnimationFrame(frame);
      flush();
      conversations.setMessages(convId, (ms) =>
        ms.map((m) => (m.id === aiId ? { ...m, content: text, meta: { streaming: false, provider: done.provider, backend: done.backend, completion_tokens: done.completion_tokens, latency_ms: done.latency_ms, tokens_per_sec: done.tokens_per_sec } } : m)),
      );
    } catch (e) {
      if (frame) cancelAnimationFrame(frame);
      flush();
      const msg = errorMessage(e);
      conversations.setMessages(convId, (ms) => ms.map((m) => (m.id === aiId ? { ...m, meta: { streaming: false, error: msg === 'cancelled' ? 'Stopped' : msg } } : m)));
    } finally {
      setBusyId(null);
    }
  };

  const send = async () => {
    const content = input.trim();
    if (!content || busyId) return;
    if (!target) {
      setPicker(true);
      return;
    }
    let conv = conversation;
    if (!conv) {
      conv = conversations.create(target);
      setDraftTarget(null);
      onCreated(conv.id);
    }
    setInput('');
    await run(conv.id, [...conv.messages, { id: newId(), role: 'user', content }], target);
  };

  const regenerate = () => {
    if (!conversation || !target || busyId) return;
    const lastUser = conversation.messages.map((m) => m.role).lastIndexOf('user');
    if (lastUser < 0) return;
    run(conversation.id, conversation.messages.slice(0, lastUser + 1), target);
  };

  return (
    <div className="flex flex-col h-full">
      <header className="h-14 shrink-0 flex items-center px-4 gap-3 border-b border-border/60">
        <button onClick={() => setPicker(true)} className="flex items-center gap-2 px-3 h-9 rounded-lg hover:bg-muted text-left" aria-label="Choose node">
          <span className="font-semibold text-[15px]">{target ? target.model || 'Default model' : 'Choose a node'}</span>
          {target && <span className="text-sm text-fg-muted truncate max-w-[280px]">on {target.name || shortId(target.peerId) || target.addr}</span>}
          <ChevronDown className="w-4 h-4 text-fg-muted" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
            <h1 className="text-3xl font-semibold">What can the mesh do for you?</h1>
            <p className="text-sm text-fg-muted max-w-md">
              {target
                ? `Messages go straight from this computer to ${target.name || target.addr}. The node's operator can read them, so avoid sensitive data.`
                : 'Pick any node on the network, one of your own, or connect by address.'}
            </p>
            {!target && <button className="btn-primary mt-2" onClick={() => setPicker(true)}>Choose a node</button>}
            {!isTauri() && <p className="text-xs text-warn">Browser preview: chatting requires the desktop app.</p>}
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
            {messages.map((m, i) => (
              <Message key={m.id} m={m} last={i === messages.length - 1} onRegenerate={regenerate} busy={Boolean(busyId)} />
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="shrink-0 px-4 pb-4">
        <form className="max-w-3xl mx-auto" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <div className="flex items-end gap-2 rounded-[26px] bg-muted border border-border px-4 py-2.5 focus-within:border-fg-muted">
            <textarea
              ref={inputRef}
              aria-label="Message"
              rows={1}
              value={input}
              maxLength={32000}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={target ? 'Message' : 'Choose a node first'}
              className="flex-1 resize-none bg-transparent outline-none focus-visible:outline-none py-1.5 text-[15px] placeholder:text-fg-muted max-h-[200px]"
            />
            {busyId ? (
              <button type="button" aria-label="Stop generating" onClick={() => native.cancelChat(busyId)} className="w-9 h-9 rounded-full bg-accent text-accent-fg flex items-center justify-center shrink-0">
                <Square className="w-3.5 h-3.5 fill-current" />
              </button>
            ) : (
              <button type="submit" aria-label="Send" disabled={!input.trim()} className="w-9 h-9 rounded-full bg-accent text-accent-fg flex items-center justify-center shrink-0 disabled:opacity-30">
                <ArrowUp className="w-4 h-4" />
              </button>
            )}
          </div>
          <p className="text-[11px] text-center text-fg-muted mt-2">Answers come from community-run models and can be wrong.</p>
        </form>
      </div>

      {picker && <NodePicker onClose={() => setPicker(false)} onPick={setTarget} initialModel={pickerModel ?? target?.model} />}
    </div>
  );
}

function Message({ m, last, onRegenerate, busy }: { m: ChatMessage; last: boolean; onRegenerate: () => void; busy: boolean }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="selectable max-w-[80%] whitespace-pre-wrap rounded-3xl bg-muted px-5 py-2.5 text-[15px] leading-7">{m.content}</p>
      </div>
    );
  }
  return (
    <div className="flex gap-4 group">
      <span className="w-8 h-8 shrink-0 rounded-full border border-border flex items-center justify-center mt-0.5">
        <Cpu className="w-4 h-4" aria-hidden />
      </span>
      <div className="flex-1 min-w-0">
        {m.content ? (
          <Suspense fallback={<p className="whitespace-pre-wrap">{m.content}</p>}>
            <Markdown>{m.content}</Markdown>
          </Suspense>
        ) : m.meta?.streaming ? (
          <span className="inline-block w-3 h-3 rounded-full bg-fg animate-pulse mt-2" aria-label="Thinking" />
        ) : null}
        {m.meta?.error && (
          <p className="mt-2 flex items-center gap-2 text-sm text-danger"><AlertTriangle className="w-4 h-4" /> {m.meta.error}</p>
        )}
        {!m.meta?.streaming && (
          <div className="flex items-center gap-3 mt-2 text-xs text-fg-muted opacity-0 group-hover:opacity-100 transition-opacity">
            <button aria-label="Copy answer" className="p-1 rounded hover:bg-muted" onClick={() => navigator.clipboard.writeText(m.content)}><Copy className="w-3.5 h-3.5" /></button>
            {last && <button aria-label="Regenerate" disabled={busy} className="p-1 rounded hover:bg-muted" onClick={onRegenerate}><RotateCcw className="w-3.5 h-3.5" /></button>}
            {m.meta?.provider && (
              <span className="font-mono">
                {shortId(m.meta.provider)}{m.meta.backend ? ` · ${m.meta.backend}` : ''} · {fmt(m.meta.completion_tokens)} tokens · {fmt(m.meta.tokens_per_sec, 1)} tok/s · {((m.meta.latency_ms ?? 0) / 1000).toFixed(1)}s
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
