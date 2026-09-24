import { Component, type ErrorInfo, type ReactNode } from 'react';

import { reportClientError } from '@/lib/api';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientError(Object.assign(error, { stack: `${error.stack}\n${info.componentStack}` }));
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
          <h1 className="text-2xl font-light">Something went wrong.</h1>
          <p className="text-sm text-gray-500">The error was reported. Reload the page to continue.</p>
          <button className="pill-btn bg-black text-white" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
