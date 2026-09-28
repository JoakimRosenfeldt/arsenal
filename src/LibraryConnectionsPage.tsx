import { useState, type JSX } from 'react';

import { UiIcon } from './UiIcon';
import type { LibraryConnectionAction, LibraryConnectionResult, LibraryConnections, LibrarySourceKind } from './shared/dj-library';

export const LibraryConnectionsPage = ({ busy, state, onConnect, onManage, onSync }: Readonly<{
  busy: boolean;
  state: LibraryConnections | null;
  onConnect: (kind: LibrarySourceKind) => Promise<LibraryConnectionResult>;
  onManage: (action: LibraryConnectionAction) => Promise<LibraryConnectionResult>;
  onSync: () => void;
}>): JSX.Element => {
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Readonly<{
    failed: boolean;
    message: string;
    warnings: readonly string[];
  }> | null>(null);
  const working = busy || pending !== null;
  const connections = state?.connections ?? [];
  const sourceOfTruth = connections.find((connection) => connection.id === state?.sourceOfTruthId);
  const canSync = connections.some((connection) => connection.kind === 'rekordbox' && connection.available) &&
    connections.some((connection) => connection.kind === 'serato' && connection.available);

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
        <div className="page-title-line"><h1 id="library-connections-title">Libraries</h1></div>
        <div className="header-actions">
          <button className="accent-button" type="button" disabled={working || !canSync} onClick={onSync}>
            <UiIcon name="refresh" size={16} /> Sync libraries
          </button>
        </div>
      </header>

      <div className="library-connections-content" aria-busy={working}>
        <section className="library-connect-section" aria-labelledby="library-connect-title">
          <h2 id="library-connect-title">Connect a library</h2>
          <p>Keep your library locations in Arsenal. Open a connection to work on its tracks and playlists.</p>
          <div className="library-connection-actions">
            <button className="quiet-button" type="button" disabled={working || state === null}
              onClick={() => void run(() => onConnect('rekordbox'), 'Connecting Rekordbox XML…', 'Rekordbox XML connected.')}>
              <UiIcon name="plus" size={16} /> Connect Rekordbox XML
            </button>
            <button className="quiet-button" type="button" disabled={working || state === null}
              onClick={() => void run(() => onConnect('serato'), 'Connecting Serato library…', 'Serato library connected.')}>
              <UiIcon name="plus" size={16} /> Connect Serato library
            </button>
          </div>
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

        <section className="library-connect-section" aria-labelledby="connected-libraries-title">
          <h2 id="connected-libraries-title">Connected libraries</h2>
          {state === null ? <p role="status">Loading library connections…</p>
            : connections.length === 0 ? <p>No libraries connected yet. Choose a library above to get started.</p>
            : <ul className="library-connection-list">
              {connections.map((connection) => {
                const active = connection.id === state.activeConnectionId;
                const preferred = connection.id === state.sourceOfTruthId;
                const kindLabel = connection.kind === 'rekordbox' ? 'Rekordbox XML' : 'Serato';
                return (
                  <li key={connection.id} className="library-connection-row">
                    <div className="library-connection-heading">
                      <h3>{connection.name}</h3>
                      <div className="library-connection-badges" aria-label="Connection status">
                        <span>{kindLabel}</span>
                        {active && <span className="is-active">Active</span>}
                        {preferred && <span className="is-preferred">Source of truth</span>}
                        {!connection.available && <span className="is-unavailable">Unavailable</span>}
                      </div>
                    </div>
                    <p className="library-connection-path">{connection.path}</p>
                    {!connection.available && <p className="library-connection-unavailable">Reconnect its drive and refresh, or change the location.</p>}
                    <div className="library-connection-actions">
                      <button className="quiet-button" type="button" disabled={working || active || !connection.available}
                        onClick={() => void run(() => onManage({ kind: 'open', id: connection.id }), 'Opening library…', `${connection.name} is open.`)}>Open</button>
                      <button className="quiet-button" type="button" disabled={working}
                        onClick={() => void run(() => onManage({ kind: 'refresh', id: connection.id }), 'Refreshing library…', `${connection.name} refreshed.`)}>Refresh</button>
                      <button className="quiet-button" type="button" disabled={working}
                        onClick={() => void run(() => onManage({ kind: 'locate', id: connection.id }), 'Choosing library location…', `${connection.name} location updated.`)}>Change location…</button>
                      {!preferred && <button className="quiet-button" type="button" disabled={working}
                        onClick={() => void run(() => onManage({ kind: 'source-of-truth', id: connection.id }), 'Saving source of truth…', `${connection.name} is the source of truth.`)}>Set as source of truth</button>}
                      <button className="quiet-button" type="button" disabled={working}
                        onClick={() => void run(() => onManage({ kind: 'disconnect', id: connection.id }), 'Disconnecting library…', `${connection.name} disconnected. No files were deleted.`)}>Disconnect</button>
                    </div>
                  </li>
                );
              })}
            </ul>}
          {connections.length > 0 && <p>Disconnect only forgets the connection. It never deletes library or audio files.</p>}
        </section>

        <section className="library-connect-section library-connection-help" aria-labelledby="library-source-title">
          <h2 id="library-source-title">Source of truth</h2>
          <p>{sourceOfTruth === undefined ? 'Choose a connected library as your source of truth.' : `${sourceOfTruth.name} is your source of truth.`} It is the default sync source and wins conflicts when track data differs. You can change those choices before each sync.</p>
          <p>Sync runs only when you start it. Refresh reads changes from the connected library.</p>
          <p>Rekordbox connects through an XML file. Import the updated XML into Rekordbox to apply changes there.</p>
          <p>Serato connects to its library folder. Arsenal keeps a working copy; sync manually to send your edits to Serato. Close Serato before syncing.</p>
        </section>
      </div>
    </section>
  );
};
