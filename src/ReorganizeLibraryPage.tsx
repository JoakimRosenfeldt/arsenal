import { useEffect, useRef, useState, type JSX } from 'react';

import { LIBRARY_ORGANIZATION_SCHEMES, type LibraryOrganizationPreview, type LibraryOrganizationProgress, type LibraryOrganizationRequest, type LibraryOrganizationResult } from './shared/dj-library';
import './ReorganizeLibraryPage.css';

export const ReorganizeLibraryPage = ({ busy, hasLibrary, onWorking, onStopPlayback }: Readonly<{
  busy: boolean;
  hasLibrary: boolean;
  onWorking: (working: boolean) => void;
  onStopPlayback: () => void;
}>): JSX.Element => {
  const [destinationRoot, setDestinationRoot] = useState('');
  const [scheme, setScheme] = useState<LibraryOrganizationRequest['scheme']>('artist-album');
  const [renameFiles, setRenameFiles] = useState(false);
  const [preview, setPreview] = useState<LibraryOrganizationPreview | null>(null);
  const [result, setResult] = useState<LibraryOrganizationResult | null>(null);
  const [progress, setProgress] = useState<LibraryOrganizationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<'choose' | 'preview' | 'apply' | null>(null);
  const pending = useRef(false);
  const working = busy || action !== null;

  useEffect(() => {
    let active = true;
    void window.djLibrary.organizationRoot().then((root) => { if (active) setDestinationRoot(root); })
      .catch((error: unknown) => { if (active) setError(error instanceof Error ? error.message : 'Could not choose a default folder.'); });
    return () => { active = false; };
  }, []);

  useEffect(() => window.djLibrary.onOrganizationProgress(setProgress), []);

  const invalidate = (): void => { setPreview(null); setResult(null); setError(null); setProgress(null); };
  const run = async (next: 'choose' | 'preview' | 'apply'): Promise<void> => {
    if (working || pending.current) return;
    pending.current = true;
    setAction(next);
    setError(null);
    setResult(null);
    setProgress(null);
    onWorking(true);
    try {
      if (next === 'choose') {
        const root = await window.djLibrary.chooseOrganizationRoot();
        if (root !== null) { setDestinationRoot(root); setPreview(null); }
      } else if (next === 'preview') {
        setPreview(null);
        setPreview(await window.djLibrary.previewOrganization({ destinationRoot, scheme, renameFiles }));
      } else if (preview !== null) {
        onStopPlayback();
        const id = preview.id;
        setPreview(null);
        setResult(await window.djLibrary.applyOrganization(id));
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not reorganize the library.'); }
    finally { pending.current = false; setAction(null); onWorking(false); }
  };

  const skipped = preview?.entries.filter((entry) => entry.kind === 'skip') ?? [];
  const reasons = [...new Set(skipped.map((entry) => entry.reason))];
  const phase = progress?.phase === 'moving' ? 'Moving files' : progress?.phase === 'relinking' ? 'Updating libraries' : 'Restoring files and libraries';

  return <section className="workspace-page reorganize-page" aria-labelledby="reorganize-title" aria-busy={working}>
    <header className="page-heading"><div><h1 id="reorganize-title">Reorganize files</h1>
      <p>Move your library's local audio files and update their paths in Arsenal and every connected library.</p></div></header>
    {!hasLibrary ? <p>Import a library in Connections first.</p> : <>
      <div className="reorganize-settings">
        <label htmlFor="organization-root">Destination folder</label>
        <div className="reorganize-destination"><input id="organization-root" value={destinationRoot} disabled={working}
          onChange={(event) => { setDestinationRoot(event.target.value); invalidate(); }} />
          <button className="quiet-button" type="button" disabled={working} onClick={() => void run('choose')}>Choose folder</button></div>
        <label htmlFor="organization-scheme">Folder structure</label>
        <select id="organization-scheme" value={scheme} disabled={working} onChange={(event) => {
          const option = LIBRARY_ORGANIZATION_SCHEMES.find((option) => option.value === event.target.value);
          if (option) { setScheme(option.value); invalidate(); }
        }}>{LIBRARY_ORGANIZATION_SCHEMES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <label className="reorganize-filename"><input type="checkbox" checked={renameFiles} disabled={working}
          onChange={(event) => { setRenameFiles(event.target.checked); invalidate(); }} />Rename files to Artist - Title, keeping the extension</label>
        <p>Close connected DJ apps before applying. Missing metadata uses Unknown folders. Collisions get a numbered suffix. Existing files are kept.</p>
        <div className="reorganize-actions"><button className="quiet-button" type="button" disabled={working || !destinationRoot.trim()} onClick={() => void run('preview')}>Preview</button>
          <button className="accent-button" type="button" disabled={working || !preview?.moveCount} onClick={() => void run('apply')}>Apply moves</button></div>
      </div>
      {action !== null && <div className="reorganize-progress" role="status">
        <p>{progress ? `${phase}: ${progress.completed} / ${progress.total}` : action === 'preview' ? 'Checking files and connected libraries...' : action === 'choose' ? 'Choosing folder...' : 'Checking the preview...'}</p>
        {progress && <progress max={Math.max(1, progress.total)} value={progress.completed} />}
      </div>}
      {error && <p className="reorganize-error" role="alert">{error}</p>}
      {result && <div role="status"><p>{result.movedCount} files moved. Arsenal and connected libraries now use the new paths.</p>
        {result.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        {!!result.backupPaths.length && <details><summary>Library backups ({result.backupPaths.length})</summary>
          <ul>{result.backupPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></details>}</div>}
      {preview && <div className="reorganize-preview">
        <h2>Preview</h2><p>{preview.moveCount} files to move. {preview.skippedCount} skipped. {preview.collisionCount} collisions resolved with numbered suffixes.</p>
        <p>Destination: <code>{preview.destinationRoot}</code></p>
        {reasons.map((reason) => <p key={reason}>{reason}: {skipped.filter((entry) => entry.reason === reason).length}</p>)}
        <div className="reorganize-paths"><table><caption>First 100 planned moves</caption><thead><tr><th>Current path</th><th>New path</th></tr></thead>
          <tbody>{preview.entries.filter((entry) => entry.kind === 'move').slice(0, 100).map((entry) => <tr key={entry.from}>
            <td><code>{entry.from}</code></td><td><code>{entry.to}</code>{entry.collision && <span>Numbered to avoid a collision</span>}</td></tr>)}</tbody></table></div>
        {!!skipped.length && <details><summary>Skipped files ({skipped.length})</summary><ul>{skipped.slice(0, 100).map((entry) => <li key={entry.from}><code>{entry.from}</code>: {entry.reason}</li>)}</ul>
          {skipped.length > 100 && <p>Showing the first 100 skipped files.</p>}</details>}
      </div>}
    </>}
  </section>;
};
