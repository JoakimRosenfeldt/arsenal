import { useEffect, useState, type JSX } from 'react';

import { AppUpdates } from './AppUpdates';
import coffeeIconUrl from '../assets/buy-me-a-coffee.svg';
import type { LibrarySettings } from './shared/preferences';
import './Preferences.css';

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

export const Preferences = ({ onCancel, onSaved }: Readonly<{
  onCancel?: () => void;
  onSaved?: () => void;
}> = {}): JSX.Element => {
  const [library, setLibrary] = useState<LibrarySettings | null>(null);
  const [seconds, setSeconds] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);

  useEffect(() => {
    let active = true;
    void window.preferences.library().then((settings) => {
      if (!active) return;
      setLibrary(settings);
      setSeconds(String(settings.minimumSongLengthSeconds));
    }).catch(() => {
      if (active) setErrors(['Could not load library settings. Reopen Preferences to try again.']);
    });
    return () => { active = false; };
  }, []);

  const valid = seconds.trim() !== '' && Number.isSafeInteger(Number(seconds)) && Number(seconds) >= 0;
  const ready = library !== null;

  const save = async (): Promise<void> => {
    if (saving || !ready || !valid) return;
    setSaving(true);
    setMessage(null);
    setErrors([]);
    try {
      const settings = Number(seconds) === library.minimumSongLengthSeconds
        ? library
        : await window.preferences.saveMinimumSongLength(Number(seconds));
      setLibrary(settings);
      setSeconds(String(settings.minimumSongLengthSeconds));
      setMessage('Changes saved.');
      onSaved?.();
    } catch {
      setErrors(['Could not save the minimum track length. Try again.']);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="preferences-page" aria-labelledby="preferences-title" onSubmit={(event) => {
      event.preventDefault();
      void save();
    }}>
      <header className="preferences-page-header">
        <h1 id="preferences-title">Preferences</h1>
      </header>
      <div className="preferences-page-content">
        <section className="preferences-section" aria-labelledby="library-preferences-title">
          <h2 id="library-preferences-title">Library</h2>
          <div className="preferences-setting-row">
            <div className="preferences-explanation">
              <label htmlFor="minimum-song-length">Minimum track length</label>
              <p id="minimum-song-length-help">Hide shorter tracks from the library and playlists.</p>
            </div>
            <div className="preferences-length-input">
              <input id="minimum-song-length" type="number" min="0" step="1" required value={seconds}
                aria-describedby="minimum-song-length-help minimum-song-length-unit"
                disabled={library === null || saving}
                onChange={(event) => { setSeconds(event.currentTarget.value); setMessage(null); }} />
              <span id="minimum-song-length-unit">seconds</span>
            </div>
          </div>
        </section>
        <section className="preferences-section" aria-labelledby="ai-preferences-title">
          <h2 id="ai-preferences-title">Music recommendations</h2>
          <div className="preferences-explanation">
            <p>The bundled Laya model suggests tracks offline on this computer. No API key is needed.</p>
          </div>
        </section>
        <section className="preferences-section" aria-labelledby="update-preferences-title">
          <h2 id="update-preferences-title">App updates</h2>
          <AppUpdates />
        </section>
        <section className="preferences-section" aria-labelledby="support-preferences-title">
          <h2 id="support-preferences-title">Support Arsenal</h2>
          <a className="preferences-support" href="https://www.buymeacoffee.com/joakim_mellonn"
            target="_blank" rel="noopener noreferrer" aria-label="Buy me a coffee" title="Buy me a coffee, opens in your browser">
            <img src={coffeeIconUrl} alt="" width={18} height={26} />
            <span>Buy me a coffee</span>
          </a>
        </section>
        {errors.length > 0 && <div className="preferences-errors" role="alert">{errors.map((error) => <p key={error}>{error}</p>)}</div>}
      </div>
      <footer className="preferences-page-actions">
        {message !== null && <p role="status">{message}</p>}
        <button className="preferences-secondary-button" type="button" disabled={saving} onClick={onCancel ?? (() => window.close())}>Cancel</button>
        <button className="preferences-save-button" type="submit" disabled={!ready || saving || !valid}>{saving ? 'Saving...' : 'Save changes'}</button>
      </footer>
    </form>
  );
};
