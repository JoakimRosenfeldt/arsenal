import { useEffect, useRef, useState, type JSX } from 'react';
import type { LibraryMusicImportPreview, LibraryOrganizationProgress, LibraryOrganizationResult } from './shared/dj-library';
import { insufficientCopySpace, OrganizationCopySpace } from './OrganizationCopySpace';

export const MusicImportDialog = ({ preview, onWorking, onComplete, onClose }: Readonly<{
  preview: LibraryMusicImportPreview;
  onWorking: (working: boolean) => void;
  onComplete: (result: LibraryOrganizationResult) => void;
  onClose: () => void;
}>): JSX.Element => {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [working, setWorking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<LibraryOrganizationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copy = preview.operation.kind === 'copy';

  useEffect(() => {
    const previousFocus = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, []);
  useEffect(() => window.djLibrary.onOrganizationProgress(setProgress), []);

  const apply = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setWorking(true);
    onWorking(true);
    try { onComplete(await window.djLibrary.applyOrganization(preview.id)); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not add music files.'); }
    finally { setWorking(false); onWorking(false); }
  };
  const stop = async (): Promise<void> => {
    setStopping(true);
    try { await window.djLibrary.stopOrganizationCopy(preview.id); }
    catch (error) { setStopping(false); setError(error instanceof Error ? error.message : 'Could not stop the copy.'); }
  };
  const phases: Record<LibraryOrganizationProgress['phase'], string> = {
    validating: 'Checking files and libraries', copying: 'Copying files', moving: 'Moving files', relinking: 'Updating libraries', 'rolling-back': 'Restoring files and libraries',
  };
  return <dialog className="tracklist-export-dialog music-import-dialog" ref={dialog} aria-labelledby="music-import-title"
    onCancel={(event) => { event.preventDefault(); if (!working) onClose(); }}>
    <h2 id="music-import-title">Add music files</h2>
    <p>{preview.addCount} new {preview.addCount === 1 ? 'track' : 'tracks'} will be added using your last applied organization settings.</p>
    <p>{copy ? 'Copy files and keep the originals.' : 'Move files into the organized library.'} Destination: <code>{preview.destinationRoot}</code></p>
    {copy && <p>{preview.operation.kind === 'copy' && !preview.operation.useCopies
      ? 'Arsenal and DJ apps will use the original files.' : 'Arsenal and DJ apps will use the copies.'} Stopping keeps completed copies without adding tracks or changing library paths.</p>}
    {(!copy || preview.operation.kind === 'copy' && preview.operation.useCopies) && <p>Close connected DJ apps before adding files.</p>}
    {preview.copySpace && <OrganizationCopySpace space={preview.copySpace} />}
    <details><summary>Planned paths ({preview.moveCount})</summary><ul>{preview.entries.filter((entry) => entry.kind === 'move').slice(0, 100).map((entry) =>
      <li key={entry.from}><code>{entry.from}</code> → <code>{entry.to}</code></li>)}</ul>
      {preview.moveCount > 100 && <p>Showing the first 100 paths.</p>}</details>
    {(preview.warnings.length > 0 || preview.skippedCount > 0) && <details><summary>Skipped files and warnings</summary><ul>
      {preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
      {preview.entries.filter((entry) => entry.kind === 'skip').map((entry) => <li key={entry.from}>{entry.from}: {entry.reason}{entry.existingCopy && <> at <code>{entry.existingCopy}</code></>}</li>)}
    </ul></details>}
    {working && <p role="status">{stopping ? 'Stopping copy…' : progress ? `${phases[progress.phase]}: ${progress.completed} / ${progress.total}` : 'Checking the preview…'}</p>}
    {error && <p className="reorganize-error" role="alert">{error} Close this preview and choose the files again.</p>}
    <div className="reorganize-actions">
      <button className="quiet-button" type="button" disabled={working} onClick={onClose}>{error ? 'Close' : 'Cancel'}</button>
      {working && copy && (!progress || progress.phase === 'copying' || progress.phase === 'validating') &&
        <button className="quiet-button" type="button" disabled={stopping} onClick={() => void stop()}>{stopping ? 'Stopping…' : 'Stop copy'}</button>}
      <button className="accent-button" type="button" disabled={working || error !== null || !preview.addCount || insufficientCopySpace(preview.copySpace)} onClick={() => void apply()}>Add files</button>
    </div>
  </dialog>;
};
