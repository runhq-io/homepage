import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { initAnalytics } from './analytics';
import { bootEvolve } from './evolve/bootConfig';
import { bootWidgetScript } from './widget';

initAnalytics();
// Before React mounts: the hero's variation config must already be in flight at
// first paint, and the SDK adopts this request instead of making its own.
bootEvolve();
// Same moment, same reason: the SDK must be running by the time the hero reads
// its surface (ruling R45). index.html has already preloaded it.
bootWidgetScript(window.location.pathname);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
