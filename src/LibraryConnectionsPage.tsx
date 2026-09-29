import { useEffect, useRef, useState, type JSX } from 'react';

import { UiIcon } from './UiIcon';
import { SyncLibrarySettings } from './SyncLibrarySettings';
import { LibraryBackupConnections } from './LibraryBackupConnections';
import type { LibraryConnection, LibraryConnectionAction, LibraryConnectionResult, LibraryConnections, LibrarySourceKind, SyncMissingFileAction, SyncRequest, SyncResult } from './shared/dj-library';

const libraryKinds = [
  { kind: 'rekordbox', label: 'Rekordbox XML' },
  { kind: 'serato', label: 'Serato library' },
] satisfies readonly { kind: LibrarySourceKind; label: string }[];

export const LibraryConnectionsPage = ({ busy, state, onConnect, onManage, onSync, onResolveMissing, onImportBackup, initialSyncResult }: Readonly<{
  busy: boolean;
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
  const [feedback, setFeedback] = useState<Readonly<{
    message: string;
    warnings: readonly string[];
  }> | null>(null);
  const working = busy || pending !== null;
  const connections = state?.connections ?? [];
  useEffect(() => {
    if (removing !== null && removeDialogRef.current && !removeDialogRef.current.open) removeDialogRef.current.showModal();
  }, [removing]);

  const run = async (operation: () => Promise<LibraryConnectionResult>, progress: string): Promise<void> => {
    if (working) return;
    setPending(progress);
    try {
      const result = await operation();
      if (result.kind === 'cancelled') return;
      setFeedback(result.kind === 'rejected'
        ? { message: result.message, warnings: feedback?.warnings ?? [] }
        : result.warnings.length > 0 ? { message: '', warnings: result.warnings } : null);
    } catch (error: unknown) {
      setFeedback({ message: error instanceof Error ? error.message : 'Could not update the library connection. Try again.',
        warnings: feedback?.warnings ?? [] });
    } finally {
      setPending(null);
    }
  };

  const connectionCard = (connection: LibraryConnection, label: string): JSX.Element => {
    const owned = connection.origin === 'arsenal';
    return (
      <section key={connection.id} className={`library-connection-card${owned ? ' is-primary' : ''}`}
        aria-label={`${owned ? 'Arsenal library' : connection.origin === 'portable' ? 'Portable library' : label}: ${connection.name}`}>
        <div className="library-connection-heading">
          <h2>{owned ? 'Arsenal library' : connection.origin === 'portable' ? connection.name : label}</h2>
          <span className={`library-connection-status${connection.available ? ' is-connected' : ' is-unavailable'}`}>
            {connection.available && <UiIcon name="check" size={14} />}
            {connection.available ? owned ? 'Saved locally' : 'Connected' : 'Unavailable'}
          </span>
        </div>
        {owned ? <p className="library-folder-summary">Primary library<br />Your tracks, edits, and smart playlist rules are saved on this computer.</p>
          : <>
            {connection.origin === 'portable' && <p className="library-connection-empty-status">Portable library</p>}
            <p className="library-connection-path">{connection.path}</p>
          </>}
        <div className="library-connection-actions">
          <button className="quiet-button" type="button" disabled={working}
            aria-label={owned ? 'Open Arsenal library' : `Import ${connection.name} into Arsenal`}
            onClick={() => void run(() => onManage({ kind: 'open', id: connection.id }), owned ? 'Opening Arsenal library…' : 'Importing into Arsenal…')}>
            {owned ? 'Open' : 'Import into Arsenal'}
          </button>
          {!owned && <button className="quiet-button" type="button" disabled={working} onClick={() => setRemoving(connection)}>
            <UiIcon name="close" size={14} /> Remove
          </button>}
        </div>
      </section>
    );
  };

  return (
    <section className="workspace-page library-connections-page" aria-labelledby="library-connections-title">
      <header className="page-header">
        <div className="page-title-line"><h1 id="library-connections-title">Connections</h1></div>
      </header>

      <div className="library-connections-content" aria-busy={working}>
        <p>Arsenal saves your library locally. Connect DJ apps to import and sync, or connect a folder for automatic backups.</p>
        {state === null ? <p role="status">Loading connections…</p> : <div className="library-connection-grid">
          {connections.filter((connection) => connection.origin === 'arsenal').map((connection) => connectionCard(connection, 'Arsenal library'))}
          {libraryKinds.flatMap(({ kind, label }) => {
            const connected = connections.filter((connection) => connection.kind === kind && connection.origin === undefined);
            return connected.length === 0 ? [
              <button key={kind} className="library-connect-button" type="button" disabled={working}
                onClick={() => void run(() => onConnect(kind), `Connecting ${label}…`)}>
                <span><UiIcon name="plus" size={20} /> Connect {label}</span>
                <span className="library-connection-empty-status">Not connected</span>
              </button>,
            ] : connected.map((connection) => connectionCard(connection, label));
          })}
          {connections.filter((connection) => connection.origin === 'portable').map((connection) => connectionCard(connection, 'Portable library'))}
          <LibraryBackupConnections busy={working} connections={state} onBusy={setPending}
            onImport={(mode) => run(() => onImportBackup(mode), 'Opening Arsenal library…')} />
        </div>}

        {pending !== null && <p className="library-connection-progress" role="status">{pending}</p>}
        {feedback !== null && (
          <section className="library-connections-feedback has-warning" role="alert" aria-label="Library connection result">
            {feedback.message && <p>{feedback.message}</p>}
            {feedback.warnings.length > 0 && <ul aria-label="Library connection warnings">
              {feedback.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
            </ul>}
          </section>
        )}

        <SyncLibrarySettings busy={working} connections={state} onSync={onSync} onResolveMissing={onResolveMissing}
          initialResult={initialSyncResult ?? null} />
      </div>

      {removing !== null && <dialog className="tracklist-export-dialog library-connection-remove-dialog" ref={removeDialogRef}
        aria-labelledby="library-remove-title" aria-describedby="library-remove-description" onClose={() => setRemoving(null)}>
        <div className="tracklist-export-heading">
          <h2 id="library-remove-title">Remove connection?</h2>
          <button className="inspector-close" type="button" onClick={() => removeDialogRef.current?.close()} aria-label="Cancel removal"><UiIcon name="close" size={16} /></button>
        </div>
        <p className="library-connection-path">{removing.path}</p>
        <p id="library-remove-description">Your Arsenal library stays saved. The connected library and music files stay on disk.</p>
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
    </section>
  );
};
