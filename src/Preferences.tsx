import { useEffect, useRef, useState, type JSX } from 'react';

import { AppUpdates } from './AppUpdates';
import coffeeIconUrl from '../assets/buy-me-a-coffee.svg';
import type { LibrarySettings, OpenRouterSettings } from './shared/preferences';
import './Preferences.css';

export const Preferences = ({ onCancel, onError }: Readonly<{
  onCancel?: () => void;
  onError?: (message: string) => void;
}> = {}): JSX.Element => {
  const [library, setLibrary] = useState<LibrarySettings | null>(null);
  const [settings, setSettings] = useState<OpenRouterSettings | null>(null);
  const [seconds, setSeconds] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const keyRevision = useRef(0);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      window.preferences.library(),
      window.preferences.openRouter(),
    ]).then(([libraryResult, keyResult]) => {
      if (!active) return;
      const failures: string[] = [];
      if (libraryResult.status === 'fulfilled') {
        setLibrary(libraryResult.value);
        setSeconds(String(libraryResult.value.minimumSongLengthSeconds));
      } else {
        failures.push('Could not load library settings.');
      }
      if (keyResult.status === 'fulfilled') {
        setSettings(keyResult.value);
      } else {
        failures.push('Could not load OpenRouter settings.');
      }
      if (onError && failures.length > 0) onError(failures.join(' '));
      else setErrors(failures);
    });
    return () => { active = false; };
  }, [onError]);

  const valid = seconds.trim() !== '' && Number.isSafeInteger(Number(seconds)) && Number(seconds) >= 0;
  const ready = library !== null && settings !== null;

  const save = async (): Promise<void> => {
    if (saving || !ready || !valid) return;
    setSaving(true);
    setErrors([]);
    const submittedKeyRevision = keyRevision.current;
    const keyChanged = removeKey || apiKey.trim() !== '';
    if (keyChanged) setSettings({ ...settings, hasApiKey: !removeKey });
    setApiKey('');
    setRemoveKey(false);
    setShowKey(false);
    const [libraryResult, keyResult] = await Promise.allSettled([
      Number(seconds) === library.minimumSongLengthSeconds
        ? Promise.resolve(library)
        : window.preferences.saveMinimumSongLength(Number(seconds)),
      keyChanged
        ? window.preferences.saveOpenRouterKey(removeKey ? '' : apiKey)
        : Promise.resolve(settings),
    ]);
    const failures: string[] = [];
    if (libraryResult.status === 'fulfilled') {
      setLibrary(libraryResult.value);
    } else {
      failures.push('Could not save the minimum track length. Try again.');
    }
    if (keyResult.status === 'fulfilled') {
      setSettings(keyResult.value);
    } else {
      setSettings(settings);
      if (keyRevision.current === submittedKeyRevision) {
        setApiKey(apiKey);
        setRemoveKey(removeKey);
      }
      failures.push('Could not save the API key. Check the key and try again.');
    }
    setSaving(false);
    if (onError && failures.length > 0) onError(failures.join(' '));
    else setErrors(failures);
  };

  const keyStatus = removeKey
    ? 'Key will be removed on save.'
    : settings === null
      ? 'Loading…'
      : settings.hasApiKey
        ? settings.keyStorage === 'session' ? 'Connected for this session.' : 'Connected'
        : 'Not connected';

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
                disabled={library === null}
                onChange={(event) => setSeconds(event.currentTarget.value)} />
              <span id="minimum-song-length-unit">seconds</span>
            </div>
          </div>
        </section>
        <section className="preferences-section" aria-labelledby="ai-preferences-title">
          <h2 id="ai-preferences-title">Music recommendations</h2>
          <div className="preferences-setting-row preferences-key-row">
            <div className="preferences-explanation">
              <label htmlFor="playlist-api-key">OpenRouter API key</label>
              <p id="playlist-api-key-help">Used for playlist suggestions.</p>
            </div>
            <div className="preferences-key-entry">
              <div className="preferences-key-input">
                <input id="playlist-api-key" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false}
                  value={apiKey} maxLength={4_096} aria-describedby="playlist-api-key-help playlist-api-key-status"
                  placeholder={settings?.hasApiKey && !removeKey ? 'Replace saved API key' : 'Paste your API key'}
                  disabled={settings === null || removeKey}
                  onChange={(event) => { keyRevision.current += 1; setApiKey(event.currentTarget.value); }} />
                <button className="preferences-key-visibility" type="button" aria-label={showKey ? 'Hide API key' : 'Show API key'}
                  aria-pressed={showKey} disabled={settings === null || removeKey} onClick={() => setShowKey(!showKey)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                    <circle cx="12" cy="12" r="3" />
                    {showKey && <path d="m3 3 18 18" />}
                  </svg>
                </button>
              </div>
              <div className="preferences-key-status">
                <p id="playlist-api-key-status">{keyStatus}</p>
                {settings?.hasApiKey && <button type="button" className="preferences-remove-key"
                  onClick={() => { keyRevision.current += 1; setRemoveKey(!removeKey); }}>{removeKey ? 'Keep key' : 'Remove key'}</button>}
              </div>
            </div>
          </div>
        </section>
        <section className="preferences-section" aria-labelledby="update-preferences-title">
          <h2 id="update-preferences-title">App updates</h2>
          <AppUpdates {...(onError ? { onError } : {})} />
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
        <button className="preferences-secondary-button" type="button" disabled={saving && onError === undefined}
          onClick={onCancel ?? (() => window.close())}>Cancel</button>
        <button className="preferences-save-button" type="submit" disabled={!ready || saving || !valid}>{saving ? 'Saving…' : 'Save'}</button>
      </footer>
    </form>
  );
};
