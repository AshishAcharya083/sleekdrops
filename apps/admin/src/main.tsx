import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { boot } from './analytics';
import { App, INITIAL_TAB } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';

// Before render, so the operator is identified and the trace id exists by the
// time the first page's poll issues its first request.
boot(INITIAL_TAB);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
