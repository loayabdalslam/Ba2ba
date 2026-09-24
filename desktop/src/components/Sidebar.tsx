import { Boxes, Check, Compass, Cpu, LayoutDashboard, MoreHorizontal, Pencil, Rocket, Settings, SquarePen, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { conversations, groupByDate, useConversations } from '@/lib/conversations';
import { shortId } from '@/lib/format';

export type View = 'chat' | 'dashboard' | 'explore' | 'deploy' | 'models' | 'settings';

interface Props {
  view: View;
  activeId: string | null;
  peerId: string | null;
  version: string | null;
  onNavigate: (v: View) => void;
  onOpenChat: (id: string | null) => void;
}

const NAV: { view: View; label: string; icon: typeof Compass }[] = [
  { view: 'dashboard', label: 'Control center', icon: LayoutDashboard },
  { view: 'explore', label: 'Explore network', icon: Compass },
  { view: 'deploy', label: 'Deploy nodes', icon: Rocket },
  { view: 'models', label: 'Models', icon: Boxes },
];

export function Sidebar({ view, activeId, peerId, version, onNavigate, onOpenChat }: Props) {
  const list = useConversations();
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);

  return (
    <aside className="w-[260px] shrink-0 bg-sidebar border-r border-border flex flex-col" aria-label="Sidebar">
      <div className="h-14 px-3 flex items-center justify-between">
        <div className="flex items-center gap-2 px-2">
          <span className="w-7 h-7 rounded-lg bg-accent text-accent-fg flex items-center justify-center">
            <Cpu className="w-4 h-4" aria-hidden />
          </span>
          <span className="font-semibold">Bee2Bee</span>
        </div>
        <button aria-label="New chat" title="New chat" className="p-2 rounded-lg hover:bg-muted" onClick={() => onOpenChat(null)}>
          <SquarePen className="w-4 h-4" />
        </button>
      </div>

      <nav className="px-2 space-y-0.5">
        {NAV.map(({ view: v, label, icon: Icon }) => (
          <button
            key={v}
            onClick={() => onNavigate(v)}
            className={`w-full flex items-center gap-3 px-3 h-9 rounded-lg text-sm ${view === v ? 'bg-muted font-medium' : 'hover:bg-muted text-fg/90'}`}
          >
            <Icon className="w-4 h-4" aria-hidden /> {label}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto px-2 mt-4 pb-4">
        {groupByDate(list).map((g) => (
          <div key={g.label} className="mb-4">
            <p className="px-3 py-1 text-xs font-medium text-fg-muted">{g.label}</p>
            {g.items.map((c) => (
              <div key={c.id} className={`group relative flex items-center rounded-lg ${view === 'chat' && c.id === activeId ? 'bg-muted' : 'hover:bg-muted'}`}>
                {editing?.id === c.id ? (
                  <form
                    className="flex items-center w-full px-2 h-9 gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      conversations.rename(c.id, editing.title);
                      setEditing(null);
                    }}
                  >
                    <input autoFocus aria-label="Conversation title" className="flex-1 bg-transparent text-sm outline-none" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
                    <button aria-label="Save title" type="submit"><Check className="w-3.5 h-3.5" /></button>
                    <button aria-label="Cancel rename" type="button" onClick={() => setEditing(null)}><X className="w-3.5 h-3.5" /></button>
                  </form>
                ) : (
                  <>
                    <button className="flex-1 text-left truncate px-3 h-9 text-sm" onClick={() => onOpenChat(c.id)} title={c.title}>
                      {c.title}
                    </button>
                    <button aria-label={`Options for ${c.title}`} className="opacity-0 group-hover:opacity-100 p-1.5 mr-1 rounded-md hover:bg-border" onClick={() => setMenu(menu === c.id ? null : c.id)}>
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                  </>
                )}
                {menu === c.id && (
                  <div className="absolute right-1 top-9 z-20 card shadow-lg py-1 w-36 text-sm" onMouseLeave={() => setMenu(null)}>
                    <button className="w-full flex items-center gap-2 px-3 h-8 hover:bg-muted" onClick={() => { setEditing({ id: c.id, title: c.title }); setMenu(null); }}>
                      <Pencil className="w-3.5 h-3.5" /> Rename
                    </button>
                    <button className="w-full flex items-center gap-2 px-3 h-8 hover:bg-muted text-danger" onClick={() => { conversations.remove(c.id); if (c.id === activeId) onOpenChat(null); setMenu(null); }}>
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        {list.length === 0 && <p className="px-3 text-xs text-fg-muted">Your chats are stored on this computer only.</p>}
      </div>

      <div className="border-t border-border p-2">
        <button onClick={() => onNavigate('settings')} className={`w-full flex items-center gap-3 px-3 h-11 rounded-lg text-left ${view === 'settings' ? 'bg-muted' : 'hover:bg-muted'}`}>
          <Settings className="w-4 h-4 shrink-0" aria-hidden />
          <span className="min-w-0">
            <span className="block text-sm">Settings</span>
            <span className="block text-[11px] text-fg-muted font-mono truncate">{peerId ? shortId(peerId) : 'browser preview'}{version ? ` · v${version}` : ''}</span>
          </span>
        </button>
      </div>
    </aside>
  );
}
