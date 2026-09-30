import { useEffect, useRef, useState, type JSX } from 'react';

import { UiIcon } from './UiIcon';
import type { LibraryConnections } from './shared/dj-library';
import { MUSIC_ORGANIZATION_OPTIONS, readMusicOrganization, type BackupConfiguration, type BackupConnection } from './shared/library-backup';

const folderName = (directory: string): string => directory.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Backup folder';

export const LibraryBackupConnections = ({ busy, connections, onError, connecting, onConnectClose }: Readonly<{
  busy: boolean;
  connections: LibraryConnections;
  onError?: (message: string) => void;
  connecting: boolean;
  onConnectClose: () => void;
}>): JSX.Element => {
  const [backups, setBackups] = useState(connections.backupConnections);
  const [draft, setEditing] = useState<BackupConfiguration | null>(null);
  const editing: BackupConfiguration | null = draft ?? (connecting ? { kind: 'connect', includeMusic: true, musicOrganization: 'artist' } : null);
  const [removing, setRemoving] = useState<BackupConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const removeDialog = useRef<HTMLDialogElement>(null);
  const statusSequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    let reportedFailure = false;
    const refresh = async (): Promise<void> => {
      if (pendingRef.current) return;
      const sequence = ++statusSequence.current;
      try {
        const next = await window.djLibrary.backupStatus();
        if (!active || sequence !== statusSequence.current) return;
        setBackups(next);
        setStatusError(null);
        reportedFailure = false;
      } catch {
        if (!active || sequence !== statusSequence.current) return;
        const message = 'Could not read backup folders.';
        if (onError) {
          if (!reportedFailure) onError(message);
          reportedFailure = true;
        } else setStatusError(message);
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 2000);
    return () => { active = false; window.clearInterval(interval); };
  }, [connections, onError]);

  const editingOpen = editing !== null;
  useEffect(() => {
    if (editingOpen && settingsDialog.current && !settingsDialog.current.open) settingsDialog.current.showModal();
  }, [editingOpen]);
  useEffect(() => {
    if (removing !== null && removeDialog.current && !removeDialog.current.open) removeDialog.current.showModal();
  }, [removing]);

  const working = busy || pending;
  const run = async (operation: () => Promise<BackupConnection | null | void>, optimisticBackups?: readonly BackupConnection[]): Promise<void> => {
    if (working || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    ++statusSequence.current;
    if (optimisticBackups !== undefined) setBackups(optimisticBackups);
    try {
      const result = await operation();
      if (!mounted.current && result?.message) onError?.(result.message);
    } catch (cause) {
      if (optimisticBackups !== undefined) setBackups(backups);
      const message = cause instanceof Error ? cause.message : 'Could not update the folder connection. Try again.';
      if (onError) onError(message);
      else setError(message);
    }
    try {
      const sequence = ++statusSequence.current;
      const next = await window.djLibrary.backupStatus();
      if (sequence === statusSequence.current) {
        setBackups(next);
        setStatusError(null);
      }
    } catch {
      const message = 'Could not read backup folders.';
      if (onError) onError(message);
      else setStatusError(message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const hasLibrary = connections.sourceOfTruthId !== null;

  return <>
    {backups.map((backup) => <section key={backup.id} className="library-connection-card" aria-label={`Folder backup: ${folderName(backup.directory)}`}>
      <div className="library-connection-heading">
        <h2>Folder backup</h2>
        <span className={`library-connection-status ${backup.state === 'error' ? 'is-unavailable' : 'is-connected'}`}>
          {backup.state === 'ready' && <UiIcon name="check" size={14} />}
          {backup.state === 'saving' ? 'Saving…' : backup.state === 'error' ? 'Needs attention' : 'Connected'}
        </span>
      </div>
      <p className="library-connection-empty-status">{folderName(backup.directory)}</p>
      <p className="library-folder-summary">{backup.includeMusic
        ? `With music · ${MUSIC_ORGANIZATION_OPTIONS.find((option) => option.value === backup.musicOrganization)?.label ?? ''}`
        : 'Library data only'}</p>
      {backup.lastSavedAt && <p className="library-connection-empty-status">Last saved {new Date(backup.lastSavedAt).toLocaleString()}</p>}
      {backup.message && <p className="tracklist-export-note" role={backup.state === 'error' ? 'alert' : undefined}>{backup.message}</p>}
      <div className="library-connection-actions">
        <button className="quiet-button" type="button" disabled={working} onClick={() => {
          setError(null);
          setEditing({ kind: 'update', id: backup.id, includeMusic: backup.includeMusic, musicOrganization: backup.musicOrganization });
        }}>Settings</button>
        <button className="quiet-button" type="button" disabled={working} onClick={() => setRemoving(backup)}>
          <UiIcon name="close" size={14} /> Remove
        </button>
      </div>
    </section>)}
    {(statusError || error && editing === null) && <p className="library-folder-error tracklist-export-note" role="alert">{error ?? statusError}</p>}

    {editing !== null && <dialog className="tracklist-export-dialog library-folder-dialog" ref={settingsDialog}
      aria-labelledby="folder-settings-title" onClose={() => { setEditing(null); onConnectClose(); }}>
      <div className="tracklist-export-heading">
        <h2 id="folder-settings-title">{editing.kind === 'connect' ? 'Connect folder' : 'Folder connection settings'}</h2>
        <button className="inspector-close" type="button" onClick={() => settingsDialog.current?.close()} aria-label="Close folder settings"><UiIcon name="close" size={16} /></button>
      </div>
      <p>Arsenal keeps <strong>Arsenal Library.json</strong> in this folder up to date.</p>
      {editing.kind === 'update' && <p>{folderName(backups.find((backup) => backup.id === editing.id)?.directory ?? '')}</p>}
      {!hasLibrary && <p>Import a library first.</p>}
      <label className="library-backup-music">
        <input type="checkbox" checked={editing.includeMusic} disabled={working}
          onChange={(event) => setEditing({ ...editing, includeMusic: event.currentTarget.checked })} />
        Include music files
      </label>
      {editing.includeMusic && <div className="library-sync-location">
        <label>Organize music by
          <select value={editing.musicOrganization} disabled={working}
            onChange={(event) => setEditing({ ...editing, musicOrganization: readMusicOrganization(event.currentTarget.value) })}>
            {MUSIC_ORGANIZATION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <p className="library-connection-path">{MUSIC_ORGANIZATION_OPTIONS.find((option) => option.value === editing.musicOrganization)?.example}</p>
      </div>}
      {error && <p className="tracklist-export-note" role="alert">{error}</p>}
      <div className="library-connection-remove-actions">
        <button className="quiet-button" type="button" onClick={() => settingsDialog.current?.close()}>Cancel</button>
        <button className="accent-button" type="button" disabled={working || !hasLibrary}
          onClick={() => {
            settingsDialog.current?.close();
            void run(() => window.djLibrary.configureBackup(editing), editing.kind === 'update'
              ? backups.map((backup) => backup.id === editing.id
                ? { ...backup, includeMusic: editing.includeMusic, musicOrganization: editing.musicOrganization, state: 'saving', message: null }
                : backup) : undefined);
          }}>
          {editing.kind === 'connect' ? 'Choose folder…' : 'Save settings'}
        </button>
      </div>
    </dialog>}

    {removing !== null && <dialog className="tracklist-export-dialog library-connection-remove-dialog" ref={removeDialog}
      aria-labelledby="folder-remove-title" aria-describedby="folder-remove-description" onClose={() => setRemoving(null)}>
      <div className="tracklist-export-heading">
        <h2 id="folder-remove-title">Remove folder connection?</h2>
        <button className="inspector-close" type="button" onClick={() => removeDialog.current?.close()} aria-label="Cancel folder removal"><UiIcon name="close" size={16} /></button>
      </div>
      <p>{folderName(removing.directory)}</p>
      <p id="folder-remove-description">Backups stop. Saved files stay on disk.</p>
      <div className="library-connection-remove-actions">
        <button className="quiet-button" type="button" autoFocus onClick={() => removeDialog.current?.close()}>Cancel</button>
        <button className="accent-button" type="button" disabled={working} onClick={() => {
          removeDialog.current?.close();
          void run(() => window.djLibrary.stopBackup(removing.id), backups.filter((backup) => backup.id !== removing.id));
        }}>Disconnect</button>
      </div>
    </dialog>}
  </>;
};
