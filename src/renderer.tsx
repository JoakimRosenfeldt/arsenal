import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import '@fontsource-variable/archivo/wght.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import './index.css';

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Cuebox could not find its application root');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
