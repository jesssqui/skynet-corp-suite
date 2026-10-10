import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './ui/index.js';
import App from './App.jsx';
import { registerServiceWorker } from './sw/register.js';
import { captureAcceptedParams } from './modules/ebay/acceptedParams.js';
import './ui/theme.css';

// D13: eBay's sign-in code leaves the address bar before anything renders (kept for /ebay/accepted).
captureAcceptedParams();

// The service worker keeps the built app so it opens with no signal (production builds only).
if (import.meta.env.PROD) registerServiceWorker();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
