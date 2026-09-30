import { useEffect, useRef, useState, type JSX } from 'react';

import type { LibraryStartupPreview } from './shared/dj-library';

export const LibraryChangesDialog = ({ preview, busy, onResolve }: Readonly<{
  preview: LibraryStartupPreview;
  busy: boolean;
  onResolve: (action: 'import' | 'skip') => Promise<void>;
}>): JSX.Element => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [action, setAction] = useState<'import' | 'skip' | null>(null);
  const [failed, setFailed] = useState(false);
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

  const resolve = async (nextAction: 'import' | 'skip'): Promise<void> => {
    if (working || pending.current) return;
    pending.current = true;
    setAction(nextAction);
    setFailed(false);
    try {
      await onResolve(nextAction);
    } catch {
      setFailed(true);
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
        void resolve('skip');
      }}>
      <header className="library-changes-heading">
        <h2 id="library-changes-title">Library changes</h2>
        <p id="library-changes-description">Changes since your last session.</p>
      </header>
      <div className="library-changes-list">
        {preview.libraries.map((library) => (
          <section key={library.id} aria-label={library.name}>
            <h3>{library.name}</h3>
            <ul>{library.changes.map((change, index) => <li key={index}>{change}</li>)}</ul>
          </section>
        ))}
      </div>
      {failed && <p className="library-changes-error" role="alert">Could not finish. Try again.</p>}
      <footer className="library-changes-actions">
        {action !== null && <span className="library-changes-progress" role="status">
          <span className="loading-mark" aria-hidden="true" />
          {action === 'skip' ? 'Closing…' : preview.syncAfterImport ? 'Importing and syncing…' : 'Importing changes…'}
        </span>}
        <button className="quiet-button" type="button" disabled={working} autoFocus onClick={() => void resolve('skip')}>Not now</button>
        <button className="accent-button" type="button" disabled={working} onClick={() => void resolve('import')}>
          {preview.syncAfterImport ? 'Import and sync' : 'Import changes'}
        </button>
      </footer>
    </dialog>
  );
};
