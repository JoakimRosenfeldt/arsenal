import { useEffect, useRef, useState, type JSX } from 'react';

import { UiIcon } from './UiIcon';
import type { LibraryConnections } from './shared/dj-library';
import type { BackupConfiguration, BackupConnection } from './shared/library-backup';

export const LibraryBackupConnections = ({ busy, connections, onBusy, onImport }: Readonly<{
  busy: boolean;
  connections: LibraryConnections;
  onBusy: (message: string | null) => void;
  onImport: () => Promise<void>;
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
  const editingSource = connections.connections.find((connection) => connection.id === editing?.sourceConnectionId);

  return <>
    {backups.map((backup) => {
      const source = connections.connections.find((connection) => connection.id === backup.sourceConnectionId);
      return <section key={backup.id} className="library-connection-card" aria-label={`Folder backup: ${backup.directory}`}>
        <div className="library-connection-heading">
          <h2>Folder backup</h2>
          <span className={`library-connection-status ${backup.state === 'error' ? 'is-unavailable' : 'is-connected'}`}>
            {backup.state === 'ready' && <UiIcon name="check" size={14} />}
            {backup.state === 'saving' ? 'Saving…' : backup.state === 'error' ? 'Needs attention' : 'Connected'}
          </span>
        </div>
        <p className="library-connection-path">{backup.directory}</p>
        <p className="library-folder-summary">Source: {source?.name ?? 'Disconnected library'}<br />
          Automatic backup · {backup.includeMusic ? 'With music' : 'Library data only'}</p>
        {backup.lastSavedAt && <p className="library-connection-empty-status">Last saved {new Date(backup.lastSavedAt).toLocaleString()}</p>}
        {backup.message && <p className="tracklist-export-note" role={backup.state === 'error' ? 'alert' : undefined}>{backup.message}</p>}
        <div className="library-connection-actions">
          <button className="quiet-button" type="button" disabled={working} onClick={() => {
            setError(null);
            setEditing({ kind: 'update', id: backup.id, sourceConnectionId: backup.sourceConnectionId, includeMusic: backup.includeMusic });
          }}>Settings</button>
          <button className="quiet-button" type="button" disabled={working || !source?.available}
            onClick={() => void run(() => window.djLibrary.backupNow(backup.id), 'Saving backup…')}>Back up now</button>
          <button className="quiet-button" type="button" disabled={working} onClick={() => setRemoving(backup)}>
            <UiIcon name="close" size={14} /> Remove
          </button>
        </div>
      </section>;
    })}
    <button className="library-connect-button" type="button" disabled={working} onClick={() => {
      setError(null);
      setEditing({ kind: 'connect', sourceConnectionId: connections.sourceOfTruthId ?? connections.activeConnectionId ?? '', includeMusic: false });
    }}>
      <span><UiIcon name="plus" size={20} /> Connect folder</span>
      <span className="library-connection-empty-status">Backup or transfer a library</span>
    </button>
    {(statusError || error && editing === null) && <p className="library-folder-error tracklist-export-note" role="alert">{error ?? statusError}</p>}

    {editing !== null && <dialog className="tracklist-export-dialog library-folder-dialog" ref={settingsDialog}
      aria-labelledby="folder-settings-title" onClose={() => setEditing(null)}>
      <div className="tracklist-export-heading">
        <h2 id="folder-settings-title">{editing.kind === 'connect' ? 'Connect folder' : 'Folder connection settings'}</h2>
        <button className="inspector-close" type="button" disabled={busy} onClick={() => settingsDialog.current?.close()} aria-label="Close folder settings">×</button>
      </div>
      <p>Save a library to a local folder, an external drive, or a folder synced by your cloud app.
        Arsenal backs up changes automatically while it is open.</p>
      {editing.kind === 'update' && <p className="library-connection-path">{backups.find((backup) => backup.id === editing.id)?.directory}</p>}
      <label className="library-folder-source">Source library
        <select value={editing.sourceConnectionId} disabled={working}
          onChange={(event) => setEditing({ ...editing, sourceConnectionId: event.currentTarget.value })}>
          {!editingSource && <option value={editing.sourceConnectionId}>{editing.sourceConnectionId ? 'Disconnected library' : 'Choose a library'}</option>}
          {connections.connections.map((connection) => <option key={connection.id} value={connection.id} disabled={!connection.available}>
            {connection.name}{connection.id === connections.sourceOfTruthId ? ' · Primary' : ''}{connection.available ? '' : ' · Unavailable'}
          </option>)}
        </select>
      </label>
      <label className="library-backup-music">
        <input type="checkbox" checked={editing.includeMusic} disabled={working}
          onChange={(event) => setEditing({ ...editing, includeMusic: event.currentTarget.checked })} />
        Include music files
      </label>
      <p>Without music, the backup keeps your library data and file fingerprints.
        On another computer, choose your music folder during import to find moved or renamed files.</p>
      {editing.kind === 'update' && backups.find((backup) => backup.id === editing.id)?.manifestPath && <details>
        <summary>Latest snapshot</summary>
        <p className="library-connection-path">{backups.find((backup) => backup.id === editing.id)?.manifestPath}</p>
      </details>}
      {error && <p className="tracklist-export-note" role="alert">{error}</p>}
      <div className="library-connection-remove-actions">
        <button className="quiet-button" type="button" disabled={busy} onClick={() => settingsDialog.current?.close()}>Cancel</button>
        <button className="accent-button" type="button" disabled={working || !editingSource?.available}
          onClick={() => void run(async () => {
            const saved = await window.djLibrary.configureBackup(editing);
            if (saved !== null) settingsDialog.current?.close();
          }, editing.kind === 'connect' ? 'Connecting backup folder…' : 'Saving folder settings…')}>
          {editing.kind === 'connect' ? 'Choose folder…' : 'Save settings'}
        </button>
      </div>
      {editing.kind === 'connect' && <div className="library-folder-import">
        <p>Have a backup from another computer? Import its snapshot to connect the library.
          Arsenal checks for newer snapshots when it opens and asks before importing and syncing.</p>
        <button className="quiet-button" type="button" disabled={working} onClick={() => {
          settingsDialog.current?.close();
          void onImport();
        }}>Import existing backup…</button>
      </div>}
    </dialog>}

    {removing !== null && <dialog className="tracklist-export-dialog library-connection-remove-dialog" ref={removeDialog}
      aria-labelledby="folder-remove-title" aria-describedby="folder-remove-description" onClose={() => setRemoving(null)}>
      <div className="tracklist-export-heading">
        <h2 id="folder-remove-title">Remove folder connection?</h2>
        <button className="inspector-close" type="button" onClick={() => removeDialog.current?.close()} aria-label="Cancel folder removal">×</button>
      </div>
      <p className="library-connection-path">{removing.directory}</p>
      <p id="folder-remove-description">Automatic backups stop. Saved snapshots and music files stay on disk.</p>
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
