import { useEffect, useRef, useState, type JSX } from 'react';

import { UiIcon } from './UiIcon';
import type { LibraryConnection, LibraryConnectionAction, LibraryConnectionResult, LibraryConnections, LibrarySourceKind } from './shared/dj-library';

const libraryKinds = [
  { kind: 'rekordbox', label: 'Rekordbox XML' },
  { kind: 'serato', label: 'Serato library' },
] satisfies readonly { kind: LibrarySourceKind; label: string }[];

export const LibraryConnectionsPage = ({ busy, state, onConnect, onManage, onSync }: Readonly<{
  busy: boolean;
  state: LibraryConnections | null;
  onConnect: (kind: LibrarySourceKind) => Promise<LibraryConnectionResult>;
  onManage: (action: LibraryConnectionAction) => Promise<LibraryConnectionResult>;
  onSync: () => void;
}>): JSX.Element => {
  const [pending, setPending] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LibraryConnection | null>(null);
  const removeDialogRef = useRef<HTMLDialogElement>(null);
  const [feedback, setFeedback] = useState<Readonly<{
    failed: boolean;
    message: string;
    warnings: readonly string[];
  }> | null>(null);
  const working = busy || pending !== null;
  const connections = state?.connections ?? [];
  const canSync = connections.some((connection) => connection.kind === 'rekordbox' && connection.available) &&
    connections.some((connection) => connection.kind === 'serato' && connection.available);

  useEffect(() => {
    if (removing !== null && removeDialogRef.current && !removeDialogRef.current.open) removeDialogRef.current.showModal();
  }, [removing]);

  const run = async (operation: () => Promise<LibraryConnectionResult>, progress: string, success: string): Promise<void> => {
    if (working) return;
    setPending(progress);
    try {
      const result = await operation();
      if (result.kind === 'cancelled') return;
      setFeedback(result.kind === 'rejected'
        ? { failed: true, message: result.message, warnings: feedback?.warnings ?? [] }
        : { failed: false, message: success, warnings: result.warnings });
    } catch (error: unknown) {
      setFeedback({ failed: true, message: error instanceof Error ? error.message : 'Could not update the library connection. Try again.',
        warnings: feedback?.warnings ?? [] });
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="workspace-page library-connections-page" aria-labelledby="library-connections-title">
      <header className="page-header">
        <div className="page-title-line"><h1 id="library-connections-title">Connections</h1></div>
        <div className="header-actions">
          <button className="accent-button" type="button" disabled={working || !canSync} onClick={onSync}>
            <UiIcon name="refresh" size={16} /> Sync libraries
          </button>
        </div>
      </header>

      <div className="library-connections-content" aria-busy={working}>
        <section className="library-connect-section" aria-labelledby="library-connect-title">
          <h2 id="library-connect-title">Your libraries</h2>
          <p>The primary library is the default sync source and wins conflicts. The first library you connect becomes primary.</p>
          {state === null ? <p role="status">Loading library connections…</p> : <div className="library-connection-grid">
            {libraryKinds.map(({ kind, label }) => {
              const connected = connections.filter((connection) => connection.kind === kind);
              return (
                <div className="library-connection-slot" key={kind}>
                  {connected.length === 0 ? (
                    <button className="library-connect-button" type="button" disabled={working}
                      onClick={() => void run(() => onConnect(kind), `Connecting ${label}…`, `${label} connected.`)}>
                      <span><UiIcon name="plus" size={20} /> Connect {label}</span>
                      <span className="library-connection-empty-status">Not connected</span>
                    </button>
                  ) : connected.map((connection) => {
                    const primary = connection.id === state.sourceOfTruthId;
                    return (
                      <section key={connection.id} className={`library-connection-card${primary ? ' is-primary' : ''}`}
                        aria-label={`${label}: ${connection.name}`}>
                        <div className="library-connection-heading">
                          <h3><button type="button" disabled={working} title="Open library"
                            aria-label={`Open ${connection.name}`}
                            onClick={() => void run(() => onManage({ kind: 'open', id: connection.id }), 'Opening library…', `${connection.name} is open.`)}>{label}</button></h3>
                          <span className={`library-connection-status${connection.available ? ' is-connected' : ' is-unavailable'}`}>
                            {connection.available && <UiIcon name="check" size={14} />}
                            {connection.available ? 'Connected' : 'Unavailable'}
                          </span>
                        </div>
                        <p className="library-connection-name">{connection.name}</p>
                        <p className="library-connection-path">{connection.path}</p>
                        <div className="library-connection-actions">
                          <button className={`quiet-button${primary ? ' is-primary' : ''}`} type="button" disabled={working || primary}
                            aria-pressed={primary} onClick={() => void run(() => onManage({ kind: 'source-of-truth', id: connection.id }),
                              'Saving primary library…', `${connection.name} is now primary.`)}>
                            {primary && <UiIcon name="check" size={14} />}{primary ? 'Primary' : 'Set as primary'}
                          </button>
                          <button className="quiet-button" type="button" disabled={working} onClick={() => setRemoving(connection)}>
                            <UiIcon name="close" size={14} /> Remove
                          </button>
                        </div>
                      </section>
                    );
                  })}
                </div>
              );
            })}
          </div>}
          {!canSync && <p>Connect an available Rekordbox XML file and Serato library to sync between them.</p>}
        </section>

        {pending !== null && <p className="library-connection-progress" role="status">{pending}</p>}
        {feedback !== null && (
          <section className={`library-connections-feedback${feedback.failed || feedback.warnings.length > 0 ? ' has-warning' : ''}`}
            role={feedback.failed || feedback.warnings.length > 0 ? 'alert' : 'status'} aria-label="Library connection result">
            <p>{feedback.message}</p>
            {feedback.warnings.length > 0 && <ul aria-label="Library connection warnings">
              {feedback.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
            </ul>}
          </section>
        )}

      </div>

      {removing !== null && <dialog className="tracklist-export-dialog library-connection-remove-dialog" ref={removeDialogRef}
        aria-labelledby="library-remove-title" aria-describedby="library-remove-description" onClose={() => setRemoving(null)}>
        <div className="tracklist-export-heading">
          <h2 id="library-remove-title">Remove library connection?</h2>
          <button className="inspector-close" type="button" onClick={() => removeDialogRef.current?.close()} aria-label="Cancel removal">×</button>
        </div>
        <p>{removing.name}</p>
        <p className="library-connection-path">{removing.path}</p>
        <p id="library-remove-description">Disconnect this library, or connect another in its place. Your library and music files stay on disk.</p>
        <div className="library-connection-remove-actions">
          <button className="quiet-button" type="button" autoFocus onClick={() => removeDialogRef.current?.close()}>Cancel</button>
          <button className="quiet-button" type="button" onClick={() => {
            removeDialogRef.current?.close();
            void run(() => onManage({ kind: 'disconnect', id: removing.id }), 'Disconnecting library…', `${removing.name} disconnected.`);
          }}>Disconnect</button>
          <button className="accent-button" type="button" onClick={() => {
            removeDialogRef.current?.close();
            void run(() => onManage({ kind: 'replace', id: removing.id }), 'Choosing another library…', 'Library connection replaced.');
          }}>Connect another library</button>
        </div>
      </dialog>}
    </section>
  );
};
