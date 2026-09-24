import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" role="dialog" aria-modal="true" aria-label={title} onMouseDown={onClose}>
      <div className={`card w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} max-h-[85vh] flex flex-col shadow-2xl`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 h-14 border-b border-border shrink-0">
          <h2 className="font-semibold">{title}</h2>
          <button aria-label="Close" className="p-1.5 rounded-lg hover:bg-muted" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="label">{label}</p>
      <p className="text-2xl font-semibold mt-1 tabular-nums">{value}</p>
      {hint && <p className="text-xs text-fg-muted mt-1">{hint}</p>}
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'danger' }) {
  const tones = {
    neutral: 'bg-muted text-fg-muted',
    ok: 'bg-ok/15 text-ok',
    warn: 'bg-warn/15 text-warn',
    danger: 'bg-danger/15 text-danger',
  };
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function Dot({ on }: { on: boolean }) {
  return <span aria-hidden className={`inline-block w-2 h-2 rounded-full ${on ? 'bg-ok' : 'bg-fg-muted/40'}`} />;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-fg-muted mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 gap-3 text-fg-muted">
      <div className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center">{icon}</div>
      <p className="font-medium text-fg">{title}</p>
      {children && <div className="text-sm max-w-md">{children}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p className="text-sm text-danger bg-danger/10 rounded-xl px-3 py-2" role="alert">{children}</p>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="block text-xs text-fg-muted">{hint}</span>}
    </label>
  );
}
