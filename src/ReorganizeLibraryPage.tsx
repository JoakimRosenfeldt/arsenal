import { useEffect, useRef, useState, type JSX } from 'react';

import { LIBRARY_ORGANIZATION_SCHEMES, type LibraryOrganizationDestination, type LibraryOrganizationPreview, type LibraryOrganizationProgress, type LibraryOrganizationRequest, type LibraryOrganizationResult } from './shared/dj-library';
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
  const [copy, setCopy] = useState(false);
  const [useCopies, setUseCopies] = useState(false);
  const [destination, setDestination] = useState<Readonly<{ root: string; kind: LibraryOrganizationDestination }> | null>(null);
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

  useEffect(() => {
    if (!copy || !destinationRoot.trim()) return;
    let active = true;
    const timeout = setTimeout(() => {
      void window.djLibrary.organizationDestination(destinationRoot).then((kind) => {
        if (active) setDestination({ root: destinationRoot, kind });
      }).catch(() => { if (active) setDestination({ root: destinationRoot, kind: 'unknown' }); });
    }, 200);
    return () => { active = false; clearTimeout(timeout); };
  }, [copy, destinationRoot]);

  const drive = destination?.root === destinationRoot ? destination.kind : null;
  const operation: LibraryOrganizationRequest['operation'] = copy ? { kind: 'copy', useCopies: useCopies && drive === 'internal' } : { kind: 'move' };
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
        if (root !== null) {
          setDestinationRoot(root); setUseCopies(false); setPreview(null);
          if (root !== destinationRoot) setDestination(null);
        }
      } else if (next === 'preview') {
        setPreview(null);
        setPreview(await window.djLibrary.previewOrganization({ destinationRoot, scheme, renameFiles, operation }));
      } else if (preview !== null) {
        if (preview.operation.kind === 'move' || preview.operation.useCopies) onStopPlayback();
        const id = preview.id;
        setPreview(null);
        setResult(await window.djLibrary.applyOrganization(id));
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not reorganize the library.'); }
    finally { pending.current = false; setAction(null); onWorking(false); }
  };

  const skipped = preview?.entries.filter((entry) => entry.kind === 'skip') ?? [];
  const reasons = [...new Set(skipped.map((entry) => entry.reason))];
  const phase = progress?.phase === 'validating' ? 'Validating files and libraries' : progress?.phase === 'moving' ? 'Moving files' : progress?.phase === 'copying' ? 'Copying files' : progress?.phase === 'relinking' ? 'Updating libraries' : 'Restoring files and libraries';

  return <section className="workspace-page reorganize-page" aria-labelledby="reorganize-title" aria-busy={working}>
    <header className="page-heading"><div><h1 id="reorganize-title">Reorganize files</h1>
      <p>Move or copy your library's local audio files into a new folder structure.</p></div></header>
    {!hasLibrary ? <p>Import a library in Connections first.</p> : <>
      <div className="reorganize-settings">
        <label htmlFor="organization-operation">What to do</label>
        <select id="organization-operation" value={copy ? 'copy' : 'move'} disabled={working} onChange={(event) => {
          setCopy(event.target.value === 'copy'); setUseCopies(false); setDestination(null); invalidate();
        }}><option value="move">Move files and update library paths</option><option value="copy">Copy files and keep the originals</option></select>
        <label htmlFor="organization-root">Destination folder</label>
        <div className="reorganize-destination"><input id="organization-root" value={destinationRoot} disabled={working}
          onChange={(event) => { setDestinationRoot(event.target.value); setUseCopies(false); setDestination(null); invalidate(); }} />
          <button className="quiet-button" type="button" disabled={working} onClick={() => void run('choose')}>Choose folder</button></div>
        {copy && <div>
          {drive === 'internal' && <label className="reorganize-filename"><input type="checkbox" checked={useCopies} disabled={working}
            onChange={(event) => { setUseCopies(event.target.checked); invalidate(); }} />Use the copied files in Arsenal and connected DJ apps</label>}
          <p>{drive === 'external' ? 'External-drive copies keep Arsenal and DJ apps on the original files.'
            : drive === 'unknown' ? 'Drive type could not be verified. Arsenal and DJ apps will keep using the original files.'
              : drive === null ? 'Checking destination drive. DJ apps will keep using the original files by default.'
                : useCopies ? 'Library paths will switch to the copies. Original audio files stay where they are.' : 'Arsenal and DJ apps will keep using the original files.'}</p>
        </div>}
        <label htmlFor="organization-scheme">Folder structure</label>
        <select id="organization-scheme" value={scheme} disabled={working} onChange={(event) => {
          const option = LIBRARY_ORGANIZATION_SCHEMES.find((option) => option.value === event.target.value);
          if (option) { setScheme(option.value); invalidate(); }
        }}>{LIBRARY_ORGANIZATION_SCHEMES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <label className="reorganize-filename"><input type="checkbox" checked={renameFiles} disabled={working}
          onChange={(event) => { setRenameFiles(event.target.checked); invalidate(); }} />Rename files to Artist - Title, keeping the extension</label>
        <p>{!copy || useCopies ? 'Close connected DJ apps before applying. ' : ''}Missing metadata uses Unknown folders. Collisions get a numbered suffix. Existing files are kept.</p>
        <div className="reorganize-actions"><button className="quiet-button" type="button" disabled={working || !destinationRoot.trim()} onClick={() => void run('preview')}>Preview</button>
          <button className="accent-button" type="button" disabled={working || !preview?.moveCount} onClick={() => void run('apply')}>{copy ? 'Copy files' : 'Apply moves'}</button></div>
      </div>
      {action !== null && <div className="reorganize-progress" role="status">
        <p>{progress ? `${phase}: ${progress.completed} / ${progress.total}` : action === 'preview' ? 'Checking files and connected libraries...' : action === 'choose' ? 'Choosing folder...' : 'Checking the preview...'}</p>
        {progress && <progress max={Math.max(1, progress.total)} value={progress.completed} />}
      </div>}
      {error && <p className="reorganize-error" role="alert">{error}</p>}
      {result && <div role="status"><p>{result.fileCount} files {result.operation.kind === 'copy' ? 'copied. Originals kept.' : 'moved.'} {result.operation.kind === 'copy' && !result.operation.useCopies
        ? 'Arsenal and DJ apps still use the original files.' : 'Arsenal and connected libraries now use the new paths.'}</p>
        {result.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        {!!result.backupPaths.length && <details><summary>Library backups ({result.backupPaths.length})</summary>
          <ul>{result.backupPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></details>}</div>}
      {preview && <div className="reorganize-preview">
        <h2>Preview</h2><p>{preview.moveCount} files to {preview.operation.kind}. {preview.skippedCount} skipped. {preview.collisionCount} collisions resolved with numbered suffixes.</p>
        <p>Destination: <code>{preview.destinationRoot}</code></p>
        {reasons.map((reason) => <p key={reason}>{reason}: {skipped.filter((entry) => entry.reason === reason).length}</p>)}
        <p>{preview.operation.kind === 'copy' && !preview.operation.useCopies ? 'Library paths will stay on the originals.' : 'Library paths will use the new locations.'}</p>
        <div className="reorganize-paths"><table><caption>First 100 planned {preview.operation.kind === 'copy' ? 'copies' : 'moves'}</caption><thead><tr><th>Current path</th><th>New path</th></tr></thead>
          <tbody>{preview.entries.filter((entry) => entry.kind === 'move').slice(0, 100).map((entry) => <tr key={entry.from}>
            <td><code>{entry.from}</code></td><td><code>{entry.to}</code>{entry.collision && <span>Numbered to avoid a collision</span>}</td></tr>)}</tbody></table></div>
        {!!skipped.length && <details><summary>Skipped files ({skipped.length})</summary><ul>{skipped.slice(0, 100).map((entry) => <li key={entry.from}><code>{entry.from}</code>: {entry.reason}</li>)}</ul>
          {skipped.length > 100 && <p>Showing the first 100 skipped files.</p>}</details>}
      </div>}
    </>}
  </section>;
};
