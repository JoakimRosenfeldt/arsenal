import { useEffect, useRef, useState, type JSX } from 'react';

import { UiIcon } from './UiIcon';
import type { LibraryConnections } from './shared/dj-library';
import { MUSIC_ORGANIZATION_OPTIONS, readMusicOrganization, type BackupConfiguration, type BackupConnection } from './shared/library-backup';

export const LibraryBackupConnections = ({ busy, connections, onBusy, onImport }: Readonly<{
  busy: boolean;
  connections: LibraryConnections;
  onBusy: (message: string | null) => void;
  onImport: (mode: 'folder' | 'snapshot') => Promise<void>;
}>): JSX.Element => {
  const [backups, setBackups] = useState(connections.backupConnections);
  const [editing, setEditing] = useState<BackupConfiguration | null>(null);
  const [removing, setRemoving] = useState<BackupConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const removeDialog = useRef<HTMLDialogElement>(null);
  const statusSequence = useRef(0);

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      const sequence = ++statusSequence.current;
      try {
        const next = await window.djLibrary.backupStatus();
        if (!active || sequence !== statusSequence.current) return;
        setBackups(next);
        setStatusError(null);
      } catch {
        if (active && sequence === statusSequence.current) setStatusError('Could not read folder connections. Reopen Connections to retry.');
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 2000);
    return () => { active = false; window.clearInterval(interval); };
  }, [connections]);

  useEffect(() => {
    if (editing !== null && settingsDialog.current && !settingsDialog.current.open) settingsDialog.current.showModal();
  }, [editing]);
  useEffect(() => {
    if (removing !== null && removeDialog.current && !removeDialog.current.open) removeDialog.current.showModal();
  }, [removing]);

  const working = busy || backups.some((backup) => backup.state === 'saving');
  const run = async (operation: () => Promise<unknown>, message: string): Promise<void> => {
    if (working) return;
    onBusy(message);
    setError(null);
    ++statusSequence.current;
    try {
      await operation();
      const sequence = ++statusSequence.current;
      const next = await window.djLibrary.backupStatus();
      if (sequence === statusSequence.current) {
        setBackups(next);
        setStatusError(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the folder connection. Try again.');
    } finally { onBusy(null); }
  };
  const hasLibrary = connections.sourceOfTruthId !== null;

  return <>
    {backups.map((backup) => <section key={backup.id} className="library-connection-card" aria-label={`Folder backup: ${backup.directory}`}>
      <div className="library-connection-heading">
        <h2>Folder backup</h2>
        <span className={`library-connection-status ${backup.state === 'error' ? 'is-unavailable' : 'is-connected'}`}>
          {backup.state === 'ready' && <UiIcon name="check" size={14} />}
          {backup.state === 'saving' ? 'Saving…' : backup.state === 'error' ? 'Needs attention' : 'Connected'}
        </span>
      </div>
      <p className="library-connection-path">{backup.directory}</p>
      <p className="library-folder-summary">Arsenal library<br />
        Automatic backup · {backup.includeMusic ? 'With music' : 'Library data only'}
        {backup.includeMusic && <><br />Music folders: {MUSIC_ORGANIZATION_OPTIONS.find((option) => option.value === backup.musicOrganization)?.label}</>}
      </p>
      {backup.lastSavedAt && <p className="library-connection-empty-status">Last saved {new Date(backup.lastSavedAt).toLocaleString()}</p>}
      {backup.message && <p className="tracklist-export-note" role={backup.state === 'error' ? 'alert' : undefined}>{backup.message}</p>}
      <div className="library-connection-actions">
        <button className="quiet-button" type="button" disabled={working} onClick={() => {
          setError(null);
          setEditing({ kind: 'update', id: backup.id, includeMusic: backup.includeMusic, musicOrganization: backup.musicOrganization });
        }}>Settings</button>
        <button className="quiet-button" type="button" disabled={working || !hasLibrary}
          onClick={() => void run(() => window.djLibrary.backupNow(backup.id), 'Saving backup…')}>Back up now</button>
        <button className="quiet-button" type="button" disabled={working} onClick={() => setRemoving(backup)}>
          <UiIcon name="close" size={14} /> Remove
        </button>
      </div>
    </section>)}
    <button className="library-connect-button" type="button" disabled={working} onClick={() => {
      setError(null);
      setEditing({ kind: 'connect', includeMusic: true, musicOrganization: 'artist' });
    }}>
      <span><UiIcon name="plus" size={20} /> Connect folder</span>
      <span className="library-connection-empty-status">Backup or transfer your Arsenal library</span>
    </button>
    {(statusError || error && editing === null) && <p className="library-folder-error tracklist-export-note" role="alert">{error ?? statusError}</p>}

    {editing !== null && <dialog className="tracklist-export-dialog library-folder-dialog" ref={settingsDialog}
      aria-labelledby="folder-settings-title" onClose={() => setEditing(null)}>
      <div className="tracklist-export-heading">
        <h2 id="folder-settings-title">{editing.kind === 'connect' ? 'Connect folder' : 'Folder connection settings'}</h2>
        <button className="inspector-close" type="button" disabled={busy} onClick={() => settingsDialog.current?.close()} aria-label="Close folder settings"><UiIcon name="close" size={16} /></button>
      </div>
      <p>Save your Arsenal library to a local folder, an external drive, or a folder synced by your cloud app.
        Arsenal updates one <strong>Arsenal Library.json</strong> file automatically while it is open.</p>
      {editing.kind === 'update' && <p className="library-connection-path">{backups.find((backup) => backup.id === editing.id)?.directory}</p>}
      {!hasLibrary && <p>Open or import a library in Arsenal before creating a backup.</p>}
      <label className="library-backup-music">
        <input type="checkbox" checked={editing.includeMusic} disabled={working}
          onChange={(event) => setEditing({ ...editing, includeMusic: event.currentTarget.checked })} />
        Include music files
      </label>
      <p>{editing.includeMusic
        ? 'Music is saved in a Music folder beside the library file. Keep them together to open your library on another computer without locating files again.'
        : 'Only library data is saved. On another computer, choose your music folder to find moved or renamed files.'}</p>
      {editing.includeMusic && <div className="library-sync-location">
        <label>Organize music by
          <select value={editing.musicOrganization} disabled={working}
            onChange={(event) => setEditing({ ...editing, musicOrganization: readMusicOrganization(event.currentTarget.value) })}>
            {MUSIC_ORGANIZATION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <p className="library-connection-path">{MUSIC_ORGANIZATION_OPTIONS.find((option) => option.value === editing.musicOrganization)?.example}</p>
      </div>}
      {editing.kind === 'update' && backups.find((backup) => backup.id === editing.id)?.manifestPath && <details>
        <summary>Library file</summary>
        <p className="library-connection-path">{backups.find((backup) => backup.id === editing.id)?.manifestPath}</p>
      </details>}
      {error && <p className="tracklist-export-note" role="alert">{error}</p>}
      <div className="library-connection-remove-actions">
        <button className="quiet-button" type="button" disabled={busy} onClick={() => settingsDialog.current?.close()}>Cancel</button>
        <button className="accent-button" type="button" disabled={working || !hasLibrary}
          onClick={() => void run(async () => {
            const saved = await window.djLibrary.configureBackup(editing);
            if (saved !== null) settingsDialog.current?.close();
          }, editing.kind === 'connect' ? 'Connecting backup folder…' : 'Saving folder settings…')}>
          {editing.kind === 'connect' ? 'Choose folder…' : 'Save settings'}
        </button>
      </div>
      {editing.kind === 'connect' && <div className="library-folder-import">
        <p>Have your Arsenal library on another computer? Open its backup folder or library file.
          Arsenal checks for changes when it opens and asks before importing and syncing.</p>
        <button className="quiet-button" type="button" disabled={working} onClick={() => {
          settingsDialog.current?.close();
          void onImport('folder');
        }}>Open library folder…</button>
        <button className="quiet-button" type="button" disabled={working} onClick={() => {
          settingsDialog.current?.close();
          void onImport('snapshot');
        }}>Open library file…</button>
      </div>}
    </dialog>}

    {removing !== null && <dialog className="tracklist-export-dialog library-connection-remove-dialog" ref={removeDialog}
      aria-labelledby="folder-remove-title" aria-describedby="folder-remove-description" onClose={() => setRemoving(null)}>
      <div className="tracklist-export-heading">
        <h2 id="folder-remove-title">Remove folder connection?</h2>
        <button className="inspector-close" type="button" onClick={() => removeDialog.current?.close()} aria-label="Cancel folder removal"><UiIcon name="close" size={16} /></button>
      </div>
      <p className="library-connection-path">{removing.directory}</p>
      <p id="folder-remove-description">Automatic backups stop. Your saved library and music files stay on disk.</p>
      <div className="library-connection-remove-actions">
        <button className="quiet-button" type="button" autoFocus onClick={() => removeDialog.current?.close()}>Cancel</button>
        <button className="accent-button" type="button" disabled={working} onClick={() => {
          removeDialog.current?.close();
          void run(() => window.djLibrary.stopBackup(removing.id), 'Disconnecting backup folder…');
        }}>Disconnect</button>
      </div>
    </dialog>}
  </>;
};
