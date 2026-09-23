import './index.css';
import './FocusedShell.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { Preferences } from './Preferences';
import { PlaylistWindow } from './PlaylistWindow';
import '@fontsource-variable/archivo/wght.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Arsenal could not find its application root');
}

const windowKind = new URL(window.location.href).searchParams.get('window');

createRoot(rootElement).render(
  <StrictMode>
    {windowKind === 'preferences' ? <Preferences /> : windowKind === 'playlist' ? <PlaylistWindow /> : <App />}
  </StrictMode>,
);
