import { lazy, Suspense } from 'react';

import { ConsentBanner } from '@/components/ConsentBanner';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AuthProvider } from '@/lib/auth';
import { Router, useRouter } from '@/lib/router';
import Landing from '@/pages/Landing';

const Chat = lazy(() => import('@/pages/Chat'));
const Register = lazy(() => import('@/pages/Register'));
const Account = lazy(() => import('@/pages/Account'));
const Docs = lazy(() => import('@/pages/Docs'));
const NotFound = lazy(() => import('@/pages/NotFound'));
const Privacy = lazy(() => import('@/pages/Legal').then((m) => ({ default: m.Privacy })));
const Terms = lazy(() => import('@/pages/Legal').then((m) => ({ default: m.Terms })));

function Routes() {
  const { path, search } = useRouter();
  // Legacy deep links: /?link=... used to open registration.
  if (path === '/register' || (path === '/' && search.get('link'))) return <Register />;
  switch (path) {
    case '/':
      return <Landing />;
    case '/chat':
    case '/dashboard':
      return <Chat />;
    case '/account':
      return <Account />;
    case '/docs':
      return <Docs />;
    case '/privacy':
      return <Privacy />;
    case '/terms':
      return <Terms />;
    default:
      return <NotFound />;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Router>
        <AuthProvider>
          <Suspense fallback={<div className="min-h-screen" />}>
            <Routes />
          </Suspense>
          <ConsentBanner />
        </AuthProvider>
      </Router>
    </ErrorBoundary>
  );
}
