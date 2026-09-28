import React from 'react'
import ReactDOM from 'react-dom/client'
import { initSentry, ErrorBoundary } from './lib/sentry.js'
import App from './App.jsx'

// No-op when VITE_SENTRY_DSN / window.KNOWL_SENTRY_DSN are unset.
initSentry()

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary
    fallback={({ error, resetError }) => (
      <div style={{
        padding: 40, fontFamily: 'system-ui, sans-serif',
        maxWidth: 480, margin: '80px auto', textAlign: 'center',
      }}>
        <h1 style={{ fontSize: 18, marginBottom: 12 }}>Something broke.</h1>
        <p style={{ fontSize: 13, color: '#666', marginBottom: 20 }}>
          The error has been reported. Try reloading.
        </p>
        <button
          onClick={resetError}
          style={{
            padding: '8px 16px', borderRadius: 8, border: 'none',
            background: '#58a6ff', color: '#fff', cursor: 'pointer',
            fontSize: 13, fontWeight: 600,
          }}
        >Retry</button>
      </div>
    )}
  >
    <App />
  </ErrorBoundary>
)
