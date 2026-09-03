import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

console.log('bootstrapping react app', { mode: import.meta.env?.MODE ?? 'development' });

const container = document.getElementById('root');
if (!container) {
  throw new Error('missing #root');
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App initialCount={2} />
  </React.StrictMode>
);
