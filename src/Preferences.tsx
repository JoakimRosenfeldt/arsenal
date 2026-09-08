import { useState, type JSX } from 'react';

import { AppUpdates } from './AppUpdates';

export const PreferencesButton = (): JSX.Element => {
  const [failed, setFailed] = useState(false);
  return (
    <div className="preferences-link">
      <button className="quiet-button" type="button" onClick={() => {
        setFailed(false);
        void window.preferences.open().catch(() => setFailed(true));
      }}>Preferences</button>
      {failed && <p role="alert">Could not open Preferences. Try again.</p>}
    </div>
  );
};

export const Preferences = (): JSX.Element => {
  const [section, setSection] = useState<'ai' | 'updates'>('ai');
  return (
    <div className="preferences-window">
      <header className="preferences-header">
        <h1>Preferences</h1>
        <span>Arsenal</span>
      </header>
      <nav className="preferences-navigation" aria-label="Preferences sections">
        <button type="button" aria-current={section === 'ai' ? 'page' : undefined} onClick={() => setSection('ai')}>Music recommendations</button>
        <button type="button" aria-current={section === 'updates' ? 'page' : undefined} onClick={() => setSection('updates')}>App updates</button>
      </nav>
      <main className="preferences-content" id="main-content">
        <section hidden={section !== 'ai'} aria-labelledby="ai-preferences-title">
          <h2 id="ai-preferences-title">Music recommendations</h2>
          <p>CLAP matches your description and starting tracks to the sound of your local music.</p>
          <p>The first request downloads about 210 MB of model files and analyzes your tracks. Your audio stays on this computer. Saved analysis is reused until a file changes.</p>
          <p>No API key or Ollama setup is needed. Describe the sound, instruments and mood. Add a tempo such as "124 to 128 BPM" to filter by Rekordbox BPM.</p>
          <p>Streaming tracks and files that cannot be read are skipped. Starting tracks must have readable local audio.</p>
        </section>
        <section hidden={section !== 'updates'} aria-labelledby="update-preferences-title">
          <h2 id="update-preferences-title">App updates</h2>
          <p>Arsenal checks for new releases automatically. You choose when to download and install them.</p>
          <AppUpdates />
        </section>
      </main>
    </div>
  );
};
