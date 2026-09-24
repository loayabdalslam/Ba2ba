import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { conversations } from '@/lib/conversations';

const chat = vi.fn();
vi.mock('@/lib/tauri', () => ({
  isTauri: () => true,
  errorMessage: (e: unknown) => String(e),
  native: {
    chat: (...args: unknown[]) => chat(...args),
    cancelChat: vi.fn(),
    deployList: vi.fn().mockResolvedValue([]),
  },
}));

import ChatPage from './ChatPage';

function renderWith(convId: string | null) {
  return render(<ChatPage conversation={conversations.get(convId)} onCreated={() => {}} pendingTarget={null} clearPendingTarget={() => {}} />);
}

describe('ChatPage', () => {
  beforeEach(() => {
    conversations.clear();
    chat.mockReset();
  });

  it('asks for a node before chatting', () => {
    renderWith(null);
    expect(screen.getAllByText('Choose a node').length).toBeGreaterThan(0);
  });

  it('streams an answer from the node and shows provenance', async () => {
    const conv = conversations.create({ addr: 'ws://node:4003', name: 'Cairo GPU', model: 'llama3.2', peerId: 'peer-abcdef0123456789abcdef0123456789' });
    chat.mockImplementation(async (_id: string, req: { messages: unknown[]; model: string }, onText: (t: string) => void) => {
      expect(req.model).toBe('llama3.2');
      expect(req.messages).toEqual([{ role: 'user', content: 'hello' }]);
      onText('Hi ');
      onText('there');
      return { provider: 'peer-abcdef0123456789abcdef0123456789', backend: 'ollama', prompt_tokens: 1, completion_tokens: 2, latency_ms: 1500, tokens_per_sec: 1.3 };
    });
    const { rerender } = renderWith(conv.id);
    expect(screen.getByText('llama3.2')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Message'), 'hello{Enter}');
    await waitFor(() => expect(conversations.get(conv.id)?.messages.at(-1)?.meta?.completion_tokens).toBe(2));
    rerender(<ChatPage conversation={conversations.get(conv.id)} onCreated={() => {}} pendingTarget={null} clearPendingTarget={() => {}} />);
    expect(await screen.findByText('Hi there')).toBeInTheDocument();
    expect(screen.getByText(/2 tokens/)).toBeInTheDocument();
    expect(conversations.get(conv.id)?.title).toBe('hello');
  });

  it('shows node errors on the message', async () => {
    const conv = conversations.create({ addr: 'ws://node:4003', model: 'x' });
    chat.mockRejectedValue('no_provider: this node does not serve model x');
    renderWith(conv.id);
    await act(async () => {
      await userEvent.type(screen.getByLabelText('Message'), 'hi{Enter}');
    });
    await waitFor(() => expect(conversations.get(conv.id)?.messages.at(-1)?.meta?.error).toContain('no_provider'));
  });
});
