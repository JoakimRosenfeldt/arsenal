import { useEffect, useState, type JSX } from 'react';

import { AppUpdates } from './AppUpdates';
import { HelpTooltip } from './HelpTooltip';
import type { OpenRouterSettings } from './shared/preferences';

const LibraryPreferences = (): JSX.Element => {
  const [seconds, setSeconds] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void window.preferences.library().then((settings) => {
      if (active) { setSeconds(String(settings.minimumSongLengthSeconds)); setLoaded(true); }
    }).catch(() => { if (active) setError('Could not load library settings. Reopen Preferences to try again.'); });
    return () => { active = false; };
  }, []);

  const valid = seconds.trim() !== '' && Number.isSafeInteger(Number(seconds)) && Number(seconds) >= 0;
  const save = async (): Promise<void> => {
    if (saving || !valid) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const settings = await window.preferences.saveMinimumSongLength(Number(seconds));
      setSeconds(String(settings.minimumSongLengthSeconds));
      setMessage('Saved.');
    } catch {
      setError('Could not save the minimum song length. Try again.');
    } finally { setSaving(false); }
  };

  return (
    <form className="library-preferences" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="playlist-name-field">
        <div className="help-label">
          <label htmlFor="minimum-song-length">Minimum song length (seconds)</label>
          <HelpTooltip label="Minimum song length">Shorter tracks are hidden throughout the app. Use 0 to show all tracks.</HelpTooltip>
        </div>
        <input id="minimum-song-length" type="number" min="0" step="1" required value={seconds}
          disabled={!loaded || saving}
          onChange={(event) => { setSeconds(event.currentTarget.value); setMessage(null); }} />
      </div>
      <button className="quiet-button" type="submit" disabled={!loaded || saving || !valid}>{saving ? 'Saving…' : 'Save'}</button>
      {message !== null && <p role="status">{message}</p>}
      {error !== null && <p role="alert">{error}</p>}
    </form>
  );
};

const OpenRouterPreferences = (): JSX.Element => {
  const [settings, setSettings] = useState<OpenRouterSettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void window.preferences.openRouter().then((value) => { if (active) setSettings(value); })
      .catch(() => { if (active) setError('Could not load OpenRouter settings. Reopen Preferences to try again.'); });
    return () => { active = false; };
  }, []);

  const save = async (key: string): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const next = await window.preferences.saveOpenRouterKey(key);
      setSettings(next);
      setApiKey('');
      setMessage(next.hasApiKey ? 'API key saved.' : 'API key removed.');
    } catch {
      setError('Could not save the API key. Check the key and try again.');
    } finally { setSaving(false); }
  };

  return (
    <div className="ai-model-picker">
      <form className="ai-key-form" onSubmit={(event) => { event.preventDefault(); if (apiKey.trim()) void save(apiKey); }}>
        <fieldset disabled={saving || settings === null}>
          <legend className="visually-hidden">OpenRouter connection</legend>
          <div className="help-label">
            <label htmlFor="playlist-api-key">OpenRouter API key</label>
            {settings?.hasApiKey && settings.keyStorage === 'session' && <HelpTooltip label="Saved API key">Key saved for this session only.</HelpTooltip>}
          </div>
          <div className="ai-input-action">
            <input id="playlist-api-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} maxLength={4_096}
              placeholder={settings?.hasApiKey ? 'Replace saved key' : 'Paste API key'}
              onChange={(event) => setApiKey(event.currentTarget.value)} />
            <button className="quiet-button" type="submit" disabled={!apiKey.trim()}>Save key</button>
            {settings?.hasApiKey && <button className="quiet-button" type="button" onClick={() => void save('')}>Remove key</button>}
          </div>
        </fieldset>
      </form>
      {settings === null && error === null && <p role="status">Loading…</p>}
      {message !== null && <p role="status">{message}</p>}
      {error !== null && <p role="alert">{error}</p>}
    </div>
  );
};

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
  const [section, setSection] = useState<'library' | 'ai' | 'updates'>('library');
  return (
    <div className="preferences-window">
      <header className="preferences-header">
        <h1>Preferences</h1>
      </header>
      <nav className="preferences-navigation" aria-label="Preferences sections">
        <button type="button" aria-current={section === 'library' ? 'page' : undefined} onClick={() => setSection('library')}>Library</button>
        <button type="button" aria-current={section === 'ai' ? 'page' : undefined} onClick={() => setSection('ai')}>Music recommendations</button>
        <button type="button" aria-current={section === 'updates' ? 'page' : undefined} onClick={() => setSection('updates')}>App updates</button>
      </nav>
      <main className="preferences-content" id="main-content">
        <section hidden={section !== 'library'} aria-labelledby="library-preferences-title">
          <h2 id="library-preferences-title">Library</h2>
          <LibraryPreferences />
        </section>
        <section hidden={section !== 'ai'} aria-labelledby="ai-preferences-title">
          <h2 id="ai-preferences-title">Music recommendations</h2>
          <OpenRouterPreferences />
        </section>
        <section hidden={section !== 'updates'} aria-labelledby="update-preferences-title">
          <h2 id="update-preferences-title">App updates</h2>
          <AppUpdates />
        </section>
      </main>
    </div>
  );
};
