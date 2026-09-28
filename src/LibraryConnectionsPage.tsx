import { useEffect, useRef, useState, type JSX } from 'react';

import { UiIcon } from './UiIcon';
import { SyncLibrarySettings } from './SyncLibrarySettings';
import { LibraryBackupSettings } from './LibraryBackupSettings';
import type { LibraryConnection, LibraryConnectionAction, LibraryConnectionResult, LibraryConnections, LibrarySourceKind, SyncMissingFileAction, SyncRequest, SyncResult } from './shared/dj-library';

const libraryKinds = [
  { kind: 'rekordbox', label: 'Rekordbox XML' },
  { kind: 'serato', label: 'Serato library' },
] satisfies readonly { kind: LibrarySourceKind; label: string }[];

export const LibraryConnectionsPage = ({ busy, state, onConnect, onManage, onSync, onResolveMissing, onImportBackup }: Readonly<{
  busy: boolean;
  state: LibraryConnections | null;
  onConnect: (kind: LibrarySourceKind) => Promise<LibraryConnectionResult>;
  onManage: (action: LibraryConnectionAction) => Promise<LibraryConnectionResult>;
  onSync: (request: SyncRequest) => Promise<SyncResult>;
  onResolveMissing: (action: SyncMissingFileAction) => Promise<SyncResult>;
  onImportBackup: () => Promise<LibraryConnectionResult>;
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

  return (
    <section className="workspace-page library-connections-page" aria-labelledby="library-connections-title">
      <header className="page-header">
        <div className="page-title-line"><h1 id="library-connections-title">Connections</h1></div>
      </header>

      <div className="library-connections-content" aria-busy={working}>
        {state === null ? <p role="status">Loading connections…</p> : <div className="library-connection-grid">
          {libraryKinds.flatMap(({ kind, label }) => {
            const connected = connections.filter((connection) => connection.kind === kind);
            return connected.length === 0 ? [
              <button key={kind} className="library-connect-button" type="button" disabled={working}
                onClick={() => void run(() => onConnect(kind), `Connecting ${label}…`)}>
                <span><UiIcon name="plus" size={20} /> Connect {label}</span>
                <span className="library-connection-empty-status">Not connected</span>
              </button>,
            ] : connected.map((connection) => {
              const primary = connection.id === state.sourceOfTruthId;
              return (
                <section key={connection.id} className={`library-connection-card${primary ? ' is-primary' : ''}`}
                  aria-label={`${connection.origin === 'portable' ? 'Imported library' : label}: ${connection.name}`}>
                  <div className="library-connection-heading">
                    <h2><button type="button" disabled={working} title="Open library"
                      aria-label={`Open ${connection.name}`}
                      onClick={() => void run(() => onManage({ kind: 'open', id: connection.id }), 'Opening library…')}>{connection.origin === 'portable' ? connection.name : label}</button></h2>
                    <span className={`library-connection-status${connection.available ? ' is-connected' : ' is-unavailable'}`}>
                      {connection.available && <UiIcon name="check" size={14} />}
                      {connection.available ? 'Connected' : 'Unavailable'}
                    </span>
                  </div>
                  {connection.origin === 'portable' && <p className="library-connection-empty-status">Imported library</p>}
                  <p className="library-connection-path">{connection.path}</p>
                  <div className="library-connection-actions">
                    <button className={`quiet-button${primary ? ' is-primary' : ''}`} type="button" disabled={working || primary}
                      aria-pressed={primary} onClick={() => void run(() => onManage({ kind: 'source-of-truth', id: connection.id }),
                        'Saving primary library…')}>
                      {primary && <UiIcon name="check" size={14} />}{primary ? 'Primary' : 'Set as primary'}
                    </button>
                    <button className="quiet-button" type="button" disabled={working} onClick={() => setRemoving(connection)}>
                      <UiIcon name="close" size={14} /> Remove
                    </button>
                  </div>
                </section>
              );
            });
          })}
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

        <LibraryBackupSettings busy={working} connectionId={state?.activeConnectionId ?? null}
          connectionName={connections.find((connection) => connection.id === state?.activeConnectionId)?.name ?? null}
          onBusy={setPending} onImport={() => run(onImportBackup, 'Importing backup…')} />
        <SyncLibrarySettings busy={working} connections={state} onSync={onSync} onResolveMissing={onResolveMissing} />
      </div>

      {removing !== null && <dialog className="tracklist-export-dialog library-connection-remove-dialog" ref={removeDialogRef}
        aria-labelledby="library-remove-title" aria-describedby="library-remove-description" onClose={() => setRemoving(null)}>
        <div className="tracklist-export-heading">
          <h2 id="library-remove-title">Remove connection?</h2>
          <button className="inspector-close" type="button" onClick={() => removeDialogRef.current?.close()} aria-label="Cancel removal">×</button>
        </div>
        <p className="library-connection-path">{removing.path}</p>
        <p id="library-remove-description">Library and music files stay on disk.</p>
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
