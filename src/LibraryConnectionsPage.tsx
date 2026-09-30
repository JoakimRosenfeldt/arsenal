import { useEffect, useRef, useState, type JSX } from 'react';

import { UiIcon } from './UiIcon';
import { SyncLibrarySettings } from './SyncLibrarySettings';
import { LibraryBackupConnections } from './LibraryBackupConnections';
import type { LibraryConnection, LibraryConnectionAction, LibraryConnectionResult, LibraryConnections, LibrarySourceKind, SyncMissingFileAction, SyncRequest, SyncResult } from './shared/dj-library';

const libraryKinds = [
  { kind: 'rekordbox', label: 'Rekordbox Collection' },
  { kind: 'serato', label: 'Serato library' },
] satisfies readonly { kind: LibrarySourceKind; label: string }[];

export const LibraryConnectionsPage = ({ busy, state, onConnect, onManage, onSync, onResolveMissing, onImportBackup, initialSyncResult, onError }: Readonly<{
  busy: boolean;
  onError: (message: string) => void;
  state: LibraryConnections | null;
  onConnect: (kind: LibrarySourceKind) => Promise<LibraryConnectionResult>;
  onManage: (action: LibraryConnectionAction) => Promise<LibraryConnectionResult>;
  onSync: (request: SyncRequest) => Promise<SyncResult>;
  onResolveMissing: (action: SyncMissingFileAction) => Promise<SyncResult>;
  onImportBackup: (mode: 'folder' | 'snapshot') => Promise<LibraryConnectionResult>;
  initialSyncResult?: Exclude<SyncResult, { kind: 'cancelled' }> | null;
}>): JSX.Element => {
  const [pending, setPending] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LibraryConnection | null>(null);
  const removeDialogRef = useRef<HTMLDialogElement>(null);
  const [resetSource, setResetSource] = useState<string | null>(null);
  const resetDialogRef = useRef<HTMLDialogElement>(null);
  const [adding, setAdding] = useState(false);
  const [connectingFolder, setConnectingFolder] = useState(false);
  const addDialogRef = useRef<HTMLDialogElement>(null);
  const working = busy || pending !== null;
  const connections = state?.connections ?? [];
  const arsenal = connections.find((connection) => connection.origin === 'arsenal');
  const resetSources = connections.filter((connection) => connection.origin !== 'arsenal' && connection.available);
  useEffect(() => {
    if (removing !== null && removeDialogRef.current && !removeDialogRef.current.open) removeDialogRef.current.showModal();
  }, [removing]);
  useEffect(() => {
    if (adding && addDialogRef.current && !addDialogRef.current.open) addDialogRef.current.showModal();
  }, [adding]);
  useEffect(() => {
    if (resetSource !== null && resetDialogRef.current && !resetDialogRef.current.open) resetDialogRef.current.showModal();
  }, [resetSource]);

  const run = async (operation: () => Promise<LibraryConnectionResult>, progress: string): Promise<void> => {
    if (working) return;
    setPending(progress);
    try {
      const result = await operation();
      if (result.kind === 'cancelled') return;
      if (result.kind === 'rejected') onError(result.message);
      else if (result.warnings.length > 0) onError(result.warnings.join(' '));
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : 'Could not update the connection. Try again.');
    } finally {
      setPending(null);
    }
  };

  const connectionCard = (connection: LibraryConnection, kindLabel: string): JSX.Element => {
    const label = connection.kind === 'rekordbox' && connection.format !== 'rekordbox-database' ? 'Rekordbox XML' : kindLabel;
    return (
      <section key={connection.id} className="library-connection-card"
        aria-label={`${connection.origin === 'portable' ? 'Arsenal library' : label}: ${connection.name}`}>
        <div className="library-connection-heading">
          <h2>{connection.origin === 'portable' ? connection.name : label}</h2>
          <span className={`library-connection-status${connection.available ? ' is-connected' : ' is-unavailable'}`}>
            {connection.available && <UiIcon name="check" size={14} />}
            {connection.available ? 'Connected' : 'Unavailable'}
          </span>
        </div>
        <p className="library-connection-empty-status">{connection.origin === 'portable' ? 'Arsenal library' : connection.name}</p>
        <div className="library-connection-actions">
          <button className="quiet-button" type="button" disabled={working}
            aria-label={`Import ${connection.name} into Arsenal`}
            onClick={() => void run(() => onManage({ kind: 'open', id: connection.id }), 'Importing into Arsenal…')}>
            Import into Arsenal
          </button>
          <button className="quiet-button" type="button" disabled={working} onClick={() => setRemoving(connection)}>
            <UiIcon name="close" size={14} /> Remove
          </button>
        </div>
      </section>
    );
  };

  return (
    <section className="workspace-page library-connections-page" aria-labelledby="library-connections-title">
      <header className="page-header">
        <div className="page-title-line"><h1 id="library-connections-title">Connections</h1></div>
        {arsenal && <div className="header-actions">
          <button className="quiet-button" type="button" disabled={working} onClick={() => setResetSource(arsenal.id)}>Reset library…</button>
        </div>}
      </header>

      <div className="library-connections-content" aria-busy={working}>
        {state === null ? <p role="status">Loading connections…</p> : <div className="library-connection-grid">
          {libraryKinds.flatMap(({ kind, label }) => connections
            .filter((connection) => connection.kind === kind && connection.origin === undefined)
            .map((connection) => connectionCard(connection, label)))}
          {connections.filter((connection) => connection.origin === 'portable').map((connection) => connectionCard(connection, 'Arsenal library'))}
          <LibraryBackupConnections busy={working} connections={state} onError={onError}
            connecting={connectingFolder} onConnectClose={() => setConnectingFolder(false)} />
          <button className="library-connect-button" type="button" disabled={working} onClick={() => setAdding(true)}>
            <span><UiIcon name="plus" size={20} /> Add connection</span>
          </button>
        </div>}

        {pending !== null && <p className="library-connection-progress" role="status">{pending}</p>}
        <SyncLibrarySettings busy={working} connections={state} onSync={onSync} onResolveMissing={onResolveMissing}
          initialResult={initialSyncResult ?? null} onError={onError} />
      </div>

      {removing !== null && <dialog className="tracklist-export-dialog library-connection-remove-dialog" ref={removeDialogRef}
        aria-labelledby="library-remove-title" aria-describedby="library-remove-description" onClose={() => setRemoving(null)}>
        <div className="tracklist-export-heading">
          <h2 id="library-remove-title">Remove connection?</h2>
          <button className="inspector-close" type="button" onClick={() => removeDialogRef.current?.close()} aria-label="Cancel removal"><UiIcon name="close" size={16} /></button>
        </div>
        <p>{removing.name}</p>
        <p id="library-remove-description">Your Arsenal library, the connected library, and music files are kept.</p>
        <div className="library-connection-remove-actions">
          <button className="quiet-button" type="button" autoFocus onClick={() => removeDialogRef.current?.close()}>Cancel</button>
          <button className="quiet-button" type="button" onClick={() => {
            removeDialogRef.current?.close();
            void run(() => onManage({ kind: 'disconnect', id: removing.id }), 'Disconnecting library…');
          }}>Disconnect</button>
          <button className="accent-button" type="button" onClick={() => {
            removeDialogRef.current?.close();
            void run(() => onManage({ kind: 'replace', id: removing.id }), 'Choosing another library…');
          }}>Connect another library</button>
        </div>
      </dialog>}

      {adding && <dialog className="tracklist-export-dialog library-add-dialog" ref={addDialogRef}
        aria-labelledby="library-add-title" onClose={() => setAdding(false)}>
        <div className="tracklist-export-heading">
          <h2 id="library-add-title">Add connection</h2>
          <button className="inspector-close" type="button" onClick={() => addDialogRef.current?.close()} aria-label="Close"><UiIcon name="close" size={16} /></button>
        </div>
        <div className="library-add-options">
          <button className="quiet-button" type="button" onClick={() => {
            addDialogRef.current?.close();
            void run(() => onImportBackup('snapshot'), 'Connecting Arsenal library…');
          }}>Arsenal library</button>
          {libraryKinds.filter(({ kind }) => {
            const connected = connections.filter((connection) => connection.kind === kind && connection.origin === undefined);
            return kind === 'rekordbox' ? !connected.some((connection) => connection.format === 'rekordbox-database') : connected.length === 0;
          }).map(({ kind, label }) => <button key={kind} className="quiet-button" type="button" onClick={() => {
            addDialogRef.current?.close();
            void run(() => onConnect(kind), `Connecting ${label}…`);
          }}>{label}</button>)}
          <button className="quiet-button" type="button" onClick={() => {
            addDialogRef.current?.close();
            setConnectingFolder(true);
          }}>Backup folder</button>
        </div>
      </dialog>}

      {resetSource !== null && arsenal && <dialog className="tracklist-export-dialog library-connection-remove-dialog" ref={resetDialogRef}
        aria-labelledby="library-reset-title" aria-describedby="library-reset-description" onClose={() => setResetSource(null)}>
        <div className="tracklist-export-heading">
          <h2 id="library-reset-title">Reset library?</h2>
          <button className="inspector-close" type="button" onClick={() => resetDialogRef.current?.close()} aria-label="Cancel reset"><UiIcon name="close" size={16} /></button>
        </div>
        <div className="library-sync-location"><label>Start from
          <select value={resetSource} onChange={(event) => setResetSource(event.currentTarget.value)}>
            <option value={arsenal.id}>Empty library</option>
            {resetSources.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
          </select>
        </label></div>
        <p id="library-reset-description">{resetSource === arsenal.id
          ? 'Removes all tracks, playlists, and connections from Arsenal.'
          : 'Replaces all tracks and playlists in Arsenal with this library.'} Ongoing sync stops. Music files stay on disk.</p>
        <div className="library-connection-remove-actions">
          <button className="quiet-button" type="button" autoFocus onClick={() => resetDialogRef.current?.close()}>Cancel</button>
          <button className="danger-button" type="button" onClick={() => {
            resetDialogRef.current?.close();
            void run(() => onManage({ kind: 'reset', id: resetSource }), 'Resetting library…');
          }}>Reset</button>
        </div>
      </dialog>}
    </section>
  );
};
