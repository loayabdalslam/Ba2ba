import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './index.css';
import { reportClientError } from './lib/api';
import { loadAnalytics } from './lib/consent';

window.addEventListener('error', (e) => reportClientError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => reportClientError(e.reason));
loadAnalytics();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
