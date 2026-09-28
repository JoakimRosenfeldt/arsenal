import { useEffect, useState, type JSX } from 'react';

import type { BackupStatus } from './shared/library-backup';

export const LibraryBackupSettings = ({ busy, connectionId, connectionName, onBusy, onImport }: Readonly<{
  busy: boolean;
  connectionId: string | null;
  connectionName: string | null;
  onBusy: (message: string | null) => void;
  onImport: () => Promise<void>;
}>): JSX.Element => {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [includeMusic, setIncludeMusic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let initial = true;
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.djLibrary.backupStatus();
        if (!active) return;
        setStatus(next);
        if (initial) { setIncludeMusic(next.includeMusic); initial = false; }
        setStatusError(null);
      } catch {
        if (active) setStatusError('Could not read backup status. Reopen Connections to retry.');
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 2000);
    return () => { active = false; window.clearInterval(interval); };
  }, [connectionId]);

  const current = status?.connectionId === connectionId ? status : null;
  const working = busy || current?.state === 'saving';
  const enabled = current?.directory !== null && current?.directory !== undefined;

  const run = async (operation: () => Promise<BackupStatus | null>, message: string): Promise<void> => {
    if (working) return;
    onBusy(message);
    setError(null);
    try {
      const next = await operation();
      if (next !== null) { setStatus(next); setIncludeMusic(next.includeMusic); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the backup. Try again.');
    } finally { onBusy(null); }
  };

  return (
    <section className="library-sync-settings library-backup-settings" aria-labelledby="library-backup-title">
      <h2 id="library-backup-title">Backup and transfer</h2>
      <p className="library-sync-description">Choose a local folder, an external drive, or a folder synced by your cloud app.
        Arsenal saves changes automatically while it is open. Import a saved snapshot on another computer.</p>
      {connectionName === null ? <p>Open a connected library to set up its backup.</p> : <p>Library: <strong>{connectionName}</strong></p>}

      <label className="library-backup-music">
        <input type="checkbox" checked={includeMusic} disabled={working || connectionId === null || current === null}
          onChange={(event) => setIncludeMusic(event.currentTarget.checked)} />
        Include music files
      </label>
      <p className="library-sync-description">Without music, the backup keeps your library data and file fingerprints.
        During import, choose your music folder to find moved or renamed files.</p>

      {enabled && <div className="library-backup-status" role="status">
        <p>{current?.state === 'saving' ? 'Saving backup…' : current?.state === 'error' ? 'Backup needs attention' : 'Automatic backup is on'}
          {current?.state !== 'saving' && ` · ${current?.includeMusic ? 'With music' : 'Library data only'}`}</p>
        <p className="library-connection-path">{current?.directory}</p>
        {current?.lastSavedAt && <p>Last saved {new Date(current.lastSavedAt).toLocaleString()}</p>}
        {current?.manifestPath && <details><summary>Latest snapshot</summary><p className="library-connection-path">{current.manifestPath}</p></details>}
        {current?.message && <p className="tracklist-export-note" role={current.state === 'error' ? 'alert' : undefined}>{current.message}</p>}
      </div>}
      {(error || statusError) && <p className="tracklist-export-note" role="alert">{error ?? statusError}</p>}

      <div className="library-connection-actions">
        <button className="accent-button" type="button" disabled={working || connectionId === null || current === null}
          onClick={() => void run(() => window.djLibrary.configureBackup(includeMusic), 'Setting up automatic backup…')}>
          {enabled ? 'Change backup settings…' : 'Choose folder and enable…'}
        </button>
        {enabled && <>
          <button className="quiet-button" type="button" disabled={working}
            onClick={() => void run(() => window.djLibrary.backupNow(), 'Saving backup…')}>Back up now</button>
          <button className="quiet-button" type="button" disabled={working}
            onClick={() => void run(() => window.djLibrary.stopBackup(), 'Stopping automatic backup…')}>Stop automatic backup</button>
        </>}
        <button className="quiet-button" type="button" disabled={working}
          onClick={() => void onImport()}>Import backup…</button>
      </div>
      {enabled && current?.includeMusic !== includeMusic && <p className="tracklist-export-note">Use Change backup settings to apply the music option.</p>}
      <p className="library-sync-description">Import creates a separate library. Your cloud app transfers the backup folder.
        Changes from other computers are imported when you choose a snapshot.</p>
    </section>
  );
};
