import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { initAnalytics } from './analytics';
import { bootEvolve, renderWhenConfigRead } from './evolve/bootConfig';

initAnalytics();
// Before React mounts: the Evolve surfaces decide their copy from this config at
// first render (R114). index.html has already preloaded it. The SDK itself loads
// after first paint (widget.ts `loadWidgetScript`, R115) and adopts this request.
const evolveBoot = bootEvolve();

// If the preloaded config has already arrived, read it before the first render
// so every surface's copy is decided in that render (bootConfig.ts).
renderWhenConfigRead(evolveBoot, () => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
