import { useEffect, useRef, useState, type JSX } from 'react';

import type { LibraryStartupAction, LibraryStartupPreview } from './shared/dj-library';

export const LibraryChangesDialog = ({ preview, busy, onResolve }: Readonly<{
  preview: LibraryStartupPreview;
  busy: boolean;
  onResolve: (action: LibraryStartupAction) => Promise<void>;
}>): JSX.Element => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [action, setAction] = useState<LibraryStartupAction | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const recovery = preview.organizationRecovery;
  const working = busy || action !== null;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const resolve = async (nextAction: LibraryStartupAction): Promise<void> => {
    if (working || pending.current) return;
    pending.current = true;
    setAction(nextAction);
    setFailed(null);
    try {
      await onResolve(nextAction);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : 'Could not finish. Try again.');
    } finally {
      pending.current = false;
      setAction(null);
    }
  };

  return (
    <dialog className="tracklist-export-dialog library-changes-dialog" ref={dialogRef}
      aria-labelledby="library-changes-title" aria-describedby="library-changes-description"
      aria-busy={working} onCancel={(event) => {
        event.preventDefault();
        if (!recovery) void resolve('skip');
      }}>
      <header className="library-changes-heading">
        <h2 id="library-changes-title">{recovery ? 'Unfinished reorganization' : 'Library changes'}</h2>
        <p id="library-changes-description">{recovery ? `${recovery.moveCount} planned moves may have been interrupted. Undo restores library backups and audio where possible. Keep updates every library to use the audio at its current location.` : 'Changes since your last session.'}</p>
      </header>
      {recovery && <p>Recovery journal: <code>{recovery.journalPath}</code>. Backups remain available after either choice.</p>}
      <div className="library-changes-list">
        {preview.libraries.map((library) => (
          <section key={library.id} aria-label={library.name}>
            <h3>{library.name}</h3>
            <ul>{library.changes.length ? library.changes.map((change, index) => <li key={index}>{change}</li>)
              : <li>No new track or playlist changes to import.</li>}</ul>
          </section>
        ))}
      </div>
      {failed && <p className="library-changes-error" role="alert">{failed}</p>}
      <footer className="library-changes-actions">
        {action !== null && <span className="library-changes-progress" role="status">
          <span className="loading-mark" aria-hidden="true" />
          {recovery ? 'Recovering…' : action === 'skip' ? 'Closing…' : preview.syncAfterImport ? 'Importing and syncing…' : 'Importing changes…'}
        </span>}
        <button className="quiet-button" type="button" disabled={working} autoFocus onClick={() => void resolve(recovery ? 'keep-reorganization' : 'skip')}>{recovery ? 'Keep current locations' : 'Not now'}</button>
        <button className="accent-button" type="button" disabled={working} onClick={() => void resolve(recovery ? 'undo-reorganization' : 'import')}>
          {recovery ? 'Undo reorganization' : preview.syncAfterImport ? 'Import and sync' : 'Import changes'}
        </button>
      </footer>
    </dialog>
  );
};
