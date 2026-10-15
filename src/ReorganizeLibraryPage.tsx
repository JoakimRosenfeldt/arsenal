import { useEffect, useRef, useState, type JSX } from 'react';

import { LIBRARY_ORGANIZATION_SCHEMES, type LibraryOrganizationDestination, type LibraryOrganizationPreview, type LibraryOrganizationProgress, type LibraryOrganizationRequest, type LibraryOrganizationResult } from './shared/dj-library';
import { ARTIST_SEPARATORS, FILENAME_SEPARATORS, ORGANIZATION_FIELDS, organizationFieldValue, type LibraryOrganizationLayout, type OrganizationField } from './shared/library-organization';
import './ReorganizeLibraryPage.css';
import { insufficientCopySpace, OrganizationCopySpace } from './OrganizationCopySpace';

const OrganizationFieldsEditor = ({ label, fields, onChange, disabled, minimum }: Readonly<{
  label: string; fields: readonly OrganizationField[]; onChange: (fields: readonly OrganizationField[]) => void; disabled: boolean; minimum: number;
}>): JSX.Element => <fieldset className="organization-fields" disabled={disabled}>
  <legend>{label}</legend>
  {fields.length === 0 && <p>All files go directly in the destination folder.</p>}
  <ol>{fields.map((field, index) => <li key={index}>
    <select aria-label={`${label} ${index + 1}`} value={field} onChange={(event) => {
      const selected = ORGANIZATION_FIELDS.find((option) => option.value === event.target.value);
      if (selected) onChange(fields.map((current, position) => position === index ? selected.value : current));
    }}>{ORGANIZATION_FIELDS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    <div className="organization-field-actions">
      {([-1, 1] as const).map((direction) => <button className="quiet-button" type="button" key={direction}
        aria-label={`Move ${label.toLowerCase()} ${index + 1} ${direction === -1 ? 'up' : 'down'}`}
        disabled={index + direction < 0 || index + direction >= fields.length} onClick={() => {
          const reordered = [...fields];
          reordered.splice(index, 1);
          reordered.splice(index + direction, 0, field);
          onChange(reordered);
        }}>{direction === -1 ? 'Up' : 'Down'}</button>)}
      <button className="quiet-button" type="button" aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
        disabled={fields.length <= minimum} onClick={() => onChange(fields.filter((_field, position) => position !== index))}>Remove</button>
    </div>
  </li>)}</ol>
  <button className="quiet-button" type="button" disabled={fields.length >= 8}
    onClick={() => onChange([...fields, minimum === 0 ? 'artist' : 'title'])}>Add {minimum === 0 ? 'folder level' : 'filename field'}</button>
</fieldset>;

const EXAMPLE_TRACK = { artist: "Bonobo, O'Flynn feat. Jordan Rakei", album: 'Fragments', genre: 'Electronic', year: 2022, label: 'Ninja Tune',
  title: 'Otomo', trackNumber: 8, discNumber: 1, bpm: 123, musicalKey: 'Am', dateAdded: '2022-01-14' };

export const ReorganizeLibraryPage = ({ busy, hasLibrary, onWorking, onStopPlayback }: Readonly<{
  busy: boolean;
  hasLibrary: boolean;
  onWorking: (working: boolean) => void;
  onStopPlayback: () => void;
}>): JSX.Element => {
  const [destinationRoot, setDestinationRoot] = useState('');
  const [layout, setLayout] = useState<LibraryOrganizationLayout>({ folders: ['artist', 'album'], filename: { kind: 'original' }, artists: { kind: 'all' } });
  const [copy, setCopy] = useState(false);
  const [useCopies, setUseCopies] = useState(false);
  const [destination, setDestination] = useState<Readonly<{ root: string; kind: LibraryOrganizationDestination }> | null>(null);
  const [preview, setPreview] = useState<LibraryOrganizationPreview | null>(null);
  const [result, setResult] = useState<LibraryOrganizationResult | null>(null);
  const [progress, setProgress] = useState<LibraryOrganizationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<'choose' | 'preview' | 'apply' | null>(null);
  const [stopping, setStopping] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [hasAppliedSettings, setHasAppliedSettings] = useState(false);
  const savedSettings = useRef('');
  const saveSequence = useRef(0);
  const pending = useRef(false);
  const working = busy || action !== null || !settingsLoaded;

  useEffect(() => {
    let active = true;
    void Promise.all([window.djLibrary.organizationSettings(), window.djLibrary.organizationRoot()]).then(([settings, root]) => {
      if (!active) return;
      const request = settings.draft ?? settings.applied;
      setHasAppliedSettings(settings.applied !== null);
      const restoredLayout: LibraryOrganizationLayout = request?.layout ?? { folders: LIBRARY_ORGANIZATION_SCHEMES.find((preset) => preset.value === request?.scheme)?.folders ?? ['artist', 'album'],
        artists: { kind: 'all' }, filename: request?.renameFiles ? { kind: 'fields', fields: ['artist', 'title'], separator: ' - ' } : { kind: 'original' } };
      setDestinationRoot(request?.destinationRoot ?? root);
      setLayout(restoredLayout);
      setCopy(request?.operation.kind === 'copy');
      setUseCopies(request?.operation.kind === 'copy' && request.operation.useCopies);
      setSettingsLoaded(true);
    })
      .catch((error: unknown) => { if (active) setError(error instanceof Error ? error.message : 'Could not choose a default folder.'); });
    return () => { active = false; };
  }, []);

  useEffect(() => window.djLibrary.onOrganizationProgress(setProgress), []);

  useEffect(() => {
    if (!settingsLoaded || !destinationRoot.trim()) return;
    const request: LibraryOrganizationRequest = { destinationRoot, scheme: 'artist-album', renameFiles: layout.filename.kind === 'fields', layout,
      operation: copy ? { kind: 'copy', useCopies } : { kind: 'move' } };
    const serialized = JSON.stringify(request);
    if (serialized === savedSettings.current) return;
    savedSettings.current = serialized;
    const sequence = ++saveSequence.current;
    void window.djLibrary.saveOrganizationSettings(request).catch((error: unknown) => {
      if (sequence === saveSequence.current) {
        savedSettings.current = '';
        setError(error instanceof Error ? error.message : 'Could not save organization settings.');
      }
    });
  }, [settingsLoaded, destinationRoot, layout, copy, useCopies]);

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
    setStopping(false);
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
        setPreview(await window.djLibrary.previewOrganization({ destinationRoot, scheme: 'artist-album', renameFiles: layout.filename.kind === 'fields', operation, layout }));
      } else if (preview !== null) {
        if (preview.operation.kind === 'move' || preview.operation.useCopies) onStopPlayback();
        const id = preview.id;
        const applied = await window.djLibrary.applyOrganization(id);
        setResult(applied);
        if (applied.outcome === 'completed') setHasAppliedSettings(true);
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not reorganize the library.'); }
    finally { if (next === 'apply') setPreview(null); pending.current = false; setAction(null); setStopping(false); onWorking(false); }
  };

  const stopCopy = async (): Promise<void> => {
    if (action !== 'apply' || preview?.operation.kind !== 'copy' || stopping) return;
    setStopping(true);
    try { await window.djLibrary.stopOrganizationCopy(preview.id); }
    catch (error) { setStopping(false); setError(error instanceof Error ? error.message : 'Could not stop the copy.'); }
  };

  const space = preview?.copySpace;
  const insufficientSpace = insufficientCopySpace(space);
  const canApply = preview !== null && (preview.moveCount > 0 || hasAppliedSettings && preview.entries.some((entry) => entry.kind === 'skip' && entry.reason === 'Already in place'));
  const canStop = action === 'apply' && preview?.operation.kind === 'copy' &&
    (progress === null || progress.phase === 'validating' || progress.phase === 'copying');
  const skipped = preview?.entries.filter((entry) => entry.kind === 'skip') ?? [];
  const reasons = [...new Set(skipped.map((entry) => entry.reason))];
  const phase = progress?.phase === 'validating' ? 'Validating files and libraries' : progress?.phase === 'moving' ? 'Moving files' : progress?.phase === 'copying' ? 'Copying files' : progress?.phase === 'relinking' ? 'Updating libraries' : 'Restoring files and libraries';
  const preset = LIBRARY_ORGANIZATION_SCHEMES.find((option) => option.folders.length === layout.folders.length && option.folders.every((field, index) => field === layout.folders[index]));
  const exampleValue = (field: OrganizationField) => organizationFieldValue(EXAMPLE_TRACK, field, layout.artists);
  const examplePath = [...layout.folders.map(exampleValue), `${layout.filename.kind === 'original' ? 'original-track' : layout.filename.fields.map(exampleValue).join(layout.filename.separator)}.flac`].join(' / ');

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
        <label htmlFor="organization-scheme">Start from a folder preset</label>
        <select id="organization-scheme" value={preset?.value ?? 'custom'} disabled={working} onChange={(event) => {
          const option = LIBRARY_ORGANIZATION_SCHEMES.find((option) => option.value === event.target.value);
          if (option) { setLayout({ ...layout, folders: option.folders }); invalidate(); }
        }}><option value="custom" disabled>Custom folder structure</option>
          {LIBRARY_ORGANIZATION_SCHEMES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <OrganizationFieldsEditor label="Folder level" fields={layout.folders} minimum={0} disabled={working}
          onChange={(folders) => { setLayout({ ...layout, folders }); invalidate(); }} />
        <label htmlFor="organization-filename">Filename</label>
        <select id="organization-filename" value={layout.filename.kind} disabled={working} onChange={(event) => {
          setLayout({ ...layout, filename: event.target.value === 'original' ? { kind: 'original' } : { kind: 'fields', fields: ['artist', 'title'], separator: ' - ' } }); invalidate();
        }}><option value="original">Keep original filename</option><option value="fields">Build from metadata fields</option></select>
        {layout.filename.kind === 'fields' && <>
          <OrganizationFieldsEditor label="Filename field" fields={layout.filename.fields} minimum={1} disabled={working}
            onChange={(fields) => { if (layout.filename.kind === 'fields') { setLayout({ ...layout, filename: { ...layout.filename, fields } }); invalidate(); } }} />
          <label htmlFor="organization-separator">Between filename fields</label>
          <select id="organization-separator" value={layout.filename.separator} disabled={working} onChange={(event) => {
            const separator = FILENAME_SEPARATORS.find((separator) => separator === event.target.value);
            if (separator !== undefined && layout.filename.kind === 'fields') { setLayout({ ...layout, filename: { ...layout.filename, separator } }); invalidate(); }
          }}>{FILENAME_SEPARATORS.map((separator) => <option key={separator} value={separator}>{separator === ' - ' ? 'Dash (Artist - Title)' : separator === '_' ? 'Underscore (Artist_Title)' : separator === ' ' ? 'Space (Artist Title)' : 'Dot (Artist.Title)'}</option>)}</select>
        </>}
        <label htmlFor="organization-artists">Artist names in folders and filenames</label>
        <select id="organization-artists" value={layout.artists.kind} disabled={working} onChange={(event) => {
          setLayout({ ...layout, artists: event.target.value === 'all' ? { kind: 'all' } : { kind: 'main', separators: ['featured', 'semicolon', 'comma'] } }); invalidate();
        }}><option value="all">All collaborating artists</option><option value="main">Main artist only</option></select>
        {layout.artists.kind === 'main' && <details className="organization-artist-rules"><summary>How to identify the main artist</summary>
          <p>Use the first credited name before these separators. Ampersands and x stay in band names unless selected.</p>
          {ARTIST_SEPARATORS.map((separator) => <label className="reorganize-filename" key={separator.value}>
            <input type="checkbox" disabled={working} checked={layout.artists.kind === 'main' && layout.artists.separators.includes(separator.value)}
              onChange={(event) => { if (layout.artists.kind === 'main') {
                setLayout({ ...layout, artists: { kind: 'main', separators: event.target.checked ? [...layout.artists.separators, separator.value]
                  : layout.artists.separators.filter((value) => value !== separator.value) } }); invalidate();
              } }} />{separator.label}</label>)}
        </details>}
        <div className="organization-example" aria-live="polite"><strong>Example path</strong>
          <p>Example track: {EXAMPLE_TRACK.artist}, {EXAMPLE_TRACK.title}. The original file extension is always kept.</p><code>{examplePath}</code></div>
        <p>{!copy || useCopies ? 'Close connected DJ apps before applying. ' : ''}Missing metadata uses Unknown folders. Collisions get a numbered suffix. Existing files are kept.</p>
        {hasAppliedSettings && <p>New music uses your last applied settings. Preview and apply to change how future files are organized.</p>}
        {copy && <>
          <p>You can stop before library updates begin. Stopping keeps completed copies, removes the unfinished file, and leaves DJ apps on the originals.</p>
          {space ? <OrganizationCopySpace space={space} /> : <p>Preview to estimate space needed and check free space.</p>}
        </>}
        <div className="reorganize-actions"><button className="quiet-button" type="button" disabled={working || !destinationRoot.trim()} onClick={() => void run('preview')}>Preview</button>
          <button className="accent-button" type="button" disabled={working || !canApply || insufficientSpace} onClick={() => void run('apply')}>{preview?.moveCount === 0 && canApply ? 'Apply settings' : copy ? 'Copy files' : 'Apply moves'}</button>
          {canStop && <button className="quiet-button" type="button" disabled={stopping} onClick={() => void stopCopy()}>{stopping ? 'Stopping…' : 'Stop copy'}</button>}</div>
      </div>
      {action !== null && <div className="reorganize-progress" role="status">
        <p>{progress ? `${phase}: ${progress.completed} / ${progress.total}` : action === 'preview' ? 'Checking files and connected libraries...' : action === 'choose' ? 'Choosing folder...' : 'Checking the preview...'}</p>
        {progress && <progress max={Math.max(1, progress.total)} value={progress.completed} />}
      </div>}
      {error && <p className="reorganize-error" role="alert">{error}</p>}
      {result && <div role="status"><p>{result.outcome === 'stopped' ? `Copy stopped. ${result.fileCount} completed ${result.fileCount === 1 ? 'copy' : 'copies'} kept. Original files and library paths kept.`
        : `${result.fileCount} files ${result.operation.kind === 'copy' ? 'copied. Originals kept.' : 'moved.'} ${result.operation.kind === 'copy' && !result.operation.useCopies
          ? 'Arsenal and DJ apps still use the original files.' : 'Arsenal and connected libraries now use the new paths.'}`}</p>
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
