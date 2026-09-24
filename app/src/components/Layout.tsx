import { Layers } from 'lucide-react';
import type { ReactNode } from 'react';

import { useAuth } from '@/lib/auth';
import { Link, useRouter } from '@/lib/router';

export function Nav() {
  const { path } = useRouter();
  const { enabled, session } = useAuth();
  const item = (to: string, label: string) => (
    <Link to={to} className={`text-xs font-semibold tracking-tight transition-colors ${path === to ? 'text-black' : 'text-gray-400 hover:text-black'}`}>
      {label}
    </Link>
  );
  return (
    <nav className="fixed top-0 inset-x-0 z-40 bg-white/80 backdrop-blur-xl border-b border-black/5">
      <div className="max-w-6xl mx-auto h-16 px-6 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2">
          <span className="w-8 h-8 bg-black rounded-lg flex items-center justify-center">
            <Layers className="w-4 h-4 text-white" aria-hidden />
          </span>
          <span className="font-bold text-sm tracking-tight">CoitHub</span>
        </Link>
        <div className="flex items-center gap-6">
          {item('/chat', 'Chat')}
          {item('/docs', 'Run a node')}
          {enabled && item('/account', session ? 'Account' : 'Sign in')}
        </div>
      </div>
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-gray-100 py-10 px-6 text-xs text-gray-400">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row gap-4 justify-between">
        <p>© {new Date().getFullYear()} ConnectIT / Bee2Bee contributors · MIT licensed</p>
        <div className="flex gap-6">
          <Link to="/privacy" className="hover:text-black">Privacy</Link>
          <Link to="/terms" className="hover:text-black">Terms</Link>
          <a href="https://github.com/Chatit-cloud/BEE2BEE" target="_blank" rel="noreferrer" className="hover:text-black">GitHub</a>
        </div>
      </div>
    </footer>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Nav />
      <main className="flex-1 pt-16">{children}</main>
      <Footer />
    </div>
  );
}
