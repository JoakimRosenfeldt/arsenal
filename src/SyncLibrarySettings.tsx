import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';

import type { LibraryConnections, LibrarySourceKind, SyncDirection, SyncFields, SyncMissingFileAction, SyncPreferences, SyncRequest, SyncResult } from './shared/dj-library';

const directions = [
  { value: 'both', label: 'Both ways' },
  { value: 'rekordbox-to-serato', label: 'Rekordbox to Serato' },
  { value: 'serato-to-rekordbox', label: 'Serato to Rekordbox' },
] satisfies readonly { value: SyncDirection; label: string }[];

const fieldOptions = [
  { value: 'tracks', label: 'Tracks' },
  { value: 'metadata', label: 'Track metadata' },
  { value: 'playlists', label: 'Playlists and crates' },
  { value: 'hotCues', label: 'Hot cues' },
  { value: 'loops', label: 'Loops' },
  { value: 'beatgrids', label: 'Beatgrids' },
] satisfies readonly { value: keyof SyncFields; label: string }[];

const libraryKinds = [
  { kind: 'rekordbox', label: 'Rekordbox XML', key: 'rekordboxPath' },
  { kind: 'serato', label: 'Serato library', key: 'seratoPath' },
] satisfies readonly { kind: LibrarySourceKind; label: string; key: 'rekordboxPath' | 'seratoPath' }[];

export const SyncLibrarySettings = ({ busy, connections, onSync, onResolveMissing }: Readonly<{
  busy: boolean;
  connections: LibraryConnections | null;
  onSync: (request: SyncRequest) => Promise<SyncResult>;
  onResolveMissing: (action: SyncMissingFileAction) => Promise<SyncResult>;
}>): JSX.Element => {
  const resultRef = useRef<HTMLElement>(null);
  const savedRequestKey = useRef<string | null>(null);
  const savedPrimaryId = useRef<string | null | undefined>(undefined);
  const [preferences, setPreferences] = useState<SyncPreferences | null>(null);
  const [preferencesFor, setPreferencesFor] = useState<LibraryConnections | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [direction, setDirection] = useState<SyncDirection>('both');
  const [mode, setMode] = useState<NonNullable<SyncRequest['mode']>>('merge');
  const [conflictSource, setConflictSource] = useState<SyncRequest['conflictSource']>('rekordbox');
  const [fields, setFields] = useState<SyncFields>({
    tracks: true, metadata: true, playlists: true, hotCues: true, loops: true, beatgrids: true,
  });
  const [result, setResult] = useState<Exclude<SyncResult, { kind: 'cancelled' }> | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [removePath, setRemovePath] = useState<string | null>(null);
  const [timingOffset, setTimingOffset] = useState('0');
  const sourceKind = direction === 'both' ? null : direction === 'rekordbox-to-serato' ? 'rekordbox' : 'serato';
  const destinationName = direction === 'rekordbox-to-serato' ? 'Serato' : 'Rekordbox XML';
  const loadingPreferences = preferencesFor !== connections;
  const working = busy || pending || loadingPreferences;
  const needsLibraries = !connections?.connections.some((entry) => entry.kind === 'rekordbox' && entry.available && entry.path === preferences?.rekordboxPath) ||
    !connections?.connections.some((entry) => entry.kind === 'serato' && entry.available && entry.path === preferences?.seratoPath);
  const libraryChoices = libraryKinds.flatMap(({ kind, label, key }) => {
    const options = connections?.connections.filter((entry) => entry.kind === kind) ?? [];
    const selected = options.find((entry) => entry.path === preferences?.[key]);
    return options.length > 1 || options.length === 1 && selected === undefined ? [{ kind, label, options, selected }] : [];
  });
  const hasFields = Object.values(fields).some(Boolean);
  const hasPerformance = fields.hotCues || fields.loops || fields.beatgrids;
  const parsedTimingOffset = Number(timingOffset);
  const validOffset = timingOffset.trim() !== '' && Number.isSafeInteger(parsedTimingOffset) && Math.abs(parsedTimingOffset) <= 1000;
  const timingOffsetMs = validOffset ? parsedTimingOffset : 0;
  const validTiming = !hasPerformance || validOffset;
  const missingFiles = result?.kind === 'missing-files' ? result.files : null;
  const hasMissingFiles = missingFiles !== null && missingFiles.length > 0;
  const hasIssues = result !== null && (result.kind === 'rejected' || hasMissingFiles || result.warnings.length > 0 ||
    result.kind === 'synced' && result.skippedTrackCount > 0);

  useEffect(() => {
    let active = true;
    void window.djLibrary.syncPreferences().then((saved) => {
      if (!active) return;
      setPreferences(saved);
      const requestKey = JSON.stringify(saved.request);
      const primaryId = connections?.sourceOfTruthId ?? null;
      if (saved.request !== null && (requestKey !== savedRequestKey.current || primaryId !== savedPrimaryId.current)) {
        setDirection(saved.request.direction);
        setMode(saved.request.mode ?? 'merge');
        setConflictSource(saved.request.conflictSource);
        setFields(saved.request.fields);
        setTimingOffset(String(saved.request.timingOffsetMs));
      }
      savedRequestKey.current = requestKey;
      savedPrimaryId.current = primaryId;
    }).catch((error: unknown) => {
      if (!active) return;
      const message = `Could not load sync settings. ${error instanceof Error ? error.message : 'Reopen Connections to try again.'}`;
      setPreferences(null);
      setRepairError(message);
      setResult((current) => current?.kind === 'missing-files' ? current
        : { kind: 'rejected', warnings: [], backupPaths: [], message });
    }).finally(() => { if (active) setPreferencesFor(connections); });
    return () => { active = false; };
  }, [connections]);

  useEffect(() => {
    if (result !== null) {
      resultRef.current?.focus({ preventScroll: true });
      resultRef.current?.scrollIntoView({ block: 'start' });
    }
  }, [result]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (working || preferences === null || needsLibraries || !hasFields || !validTiming) return;
    setPending(true);
    setResult(null);
    setRepairError(null);
    setRemovePath(null);
    try {
      let next = await onSync({ direction, mode, conflictSource: sourceKind ?? conflictSource, fields, timingOffsetMs });
      try {
        const saved = await window.djLibrary.syncPreferences();
        setPreferences(saved);
        savedRequestKey.current = JSON.stringify(saved.request);
      } catch {
        const message = 'Could not load library locations. Reopen Connections before syncing again.';
        setPreferences(null);
        next = next.kind === 'cancelled' ? { kind: 'rejected', message, warnings: [], backupPaths: [] }
          : { ...next, warnings: [...next.warnings, message] };
      }
      setResult(next.kind === 'cancelled' ? result : result?.kind === 'missing-files'
        ? { ...next, backupPaths: [...new Set([...result.backupPaths, ...next.backupPaths])] } : next);
    } catch (error: unknown) {
      setResult({ kind: 'rejected', warnings: result?.warnings ?? [], backupPaths: result?.backupPaths ?? [],
        message: error instanceof Error ? error.message : 'Could not sync the libraries. Try again.',
      });
    } finally {
      setPending(false);
    }
  };

  const chooseLibrary = async (id: string): Promise<void> => {
    if (!id || working) return;
    setPending(true);
    try {
      setPreferences(await window.djLibrary.selectSyncLibrary(id));
      setResult((current) => current?.kind === 'missing-files' ? current : null);
      setRepairError(null);
      setRemovePath(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not choose the library. Try again.';
      if (missingFiles !== null) setRepairError(message);
      else setResult({ kind: 'rejected', warnings: [], backupPaths: [], message });
    } finally {
      setPending(false);
    }
  };

  const resolveMissing = async (action: SyncMissingFileAction): Promise<void> => {
    if (working) return;
    setPending(true);
    setRepairError(null);
    try {
      const next = await onResolveMissing(action);
      if (next.kind === 'cancelled') return;
      if (next.kind === 'rejected') {
        setRepairError(next.message);
        setResult((current) => current?.kind === 'missing-files'
          ? { ...current, warnings: [...new Set([...current.warnings, ...next.warnings])],
            backupPaths: [...new Set([...current.backupPaths, ...next.backupPaths])] }
          : next);
      } else {
        setResult((current) => ({ ...next,
          warnings: [...new Set([...(current?.warnings ?? []), ...next.warnings])],
          backupPaths: [...new Set([...(current?.backupPaths ?? []), ...next.backupPaths])],
        }));
        setRemovePath(null);
      }
    } catch (error: unknown) {
      setRepairError(error instanceof Error ? error.message : 'Could not update the missing file. Try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="library-sync-settings" aria-labelledby="library-sync-title">
      <form onSubmit={(event) => void submit(event)}>
        <h2 id="library-sync-title">Sync settings</h2>

        {result !== null && (
          <section className={`library-sync-result${hasIssues ? ' library-sync-result-warning' : ''}`} ref={resultRef}
            tabIndex={-1} role={hasIssues ? 'alert' : 'status'} aria-labelledby="library-sync-result-title">
            <h3 id="library-sync-result-title">{result.kind === 'missing-files'
              ? hasMissingFiles ? 'Missing audio files' : 'Missing files resolved'
              : result.kind === 'rejected' ? 'Sync stopped'
              : hasIssues ? 'Sync completed with issues' : 'Sync completed'}</h3>
            <p>{result.message}</p>
            {missingFiles !== null && (
              <div className="library-sync-recovery" aria-busy={working}>
                {repairError !== null && <p className="library-sync-recovery-error" role="alert">{repairError}</p>}
                {hasMissingFiles ? (
                  <>
                    <p>Relinking updates every connected library that references the file, regardless of sync direction. After reconnecting a drive, check files again.</p>
                    <ul className="library-sync-missing-list" aria-label="Missing audio files">
                      {missingFiles.map((file) => {
                        const collections = file.libraries.map((kind) => kind === 'rekordbox' ? 'Rekordbox XML' : 'Serato').join(' and ');
                        return (
                          <li key={file.path} className="library-sync-missing-file">
                            <strong>{file.title || 'Untitled track'}{file.artist ? ` · ${file.artist}` : ''}</strong>
                            <p className="library-sync-file-path">{file.path}</p>
                            <p>In {collections}</p>
                            {file.libraryPaths !== undefined && file.libraryPaths.length > 0 && (
                              <details>
                                <summary>Connected library files ({file.libraryPaths.length})</summary>
                                <ul className="library-sync-result-list" aria-label={`Connected libraries for ${file.path}`}>
                                  {file.libraryPaths.map((path) => <li key={path}>{path}</li>)}
                                </ul>
                              </details>
                            )}
                            {file.candidates.length > 0 ? (
                              <>
                                <p>Possible matches</p>
                                <ul className="library-sync-candidates" aria-label={`Possible matches for ${file.path}`}>
                                  {file.candidates.slice(0, 3).map((path) => (
                                    <li key={path}>
                                      <span className="library-sync-file-path">{path}</span>
                                      <button className="quiet-button" type="button" disabled={working}
                                        aria-label={`Use ${path} for ${file.path}`}
                                        onClick={() => void resolveMissing({ kind: 'relink', path: file.path, replacementPath: path })}>Use this file</button>
                                    </li>
                                  ))}
                                </ul>
                                {file.candidates.length > 3 && <p>Showing 3 of {file.candidates.length} matches. Use Choose file to select another.</p>}
                              </>
                            ) : <p>No matches found.</p>}
                            <div className="library-sync-file-actions">
                              <button className="quiet-button" type="button" disabled={working}
                                onClick={() => void resolveMissing({ kind: 'search', path: file.path })}>Search folder…</button>
                              <button className="quiet-button" type="button" disabled={working}
                                onClick={() => void resolveMissing({ kind: 'locate', path: file.path })}>Choose file…</button>
                              <button className="quiet-button" type="button" disabled={working}
                                onClick={() => setRemovePath(file.path)}>Remove entry…</button>
                            </div>
                            {removePath === file.path && (
                              <div className="library-sync-remove-confirmation">
                                <p>Remove this entry from the connected {collections} collections?</p>
                                <p className="library-sync-file-path">{file.path}</p>
                                {file.libraryPaths !== undefined && file.libraryPaths.length > 0 && (
                                  <ul className="library-sync-result-list" aria-label="Collections to remove from">
                                    {file.libraryPaths.map((path) => <li key={path}>{path}</li>)}
                                  </ul>
                                )}
                                <p>Removes the track and its playlist memberships from these collections. Audio files stay on disk.</p>
                                <div className="library-sync-file-actions">
                                  <button className="quiet-button" type="button" disabled={working} onClick={() => setRemovePath(null)}>Keep entry</button>
                                  <button className="quiet-button" type="button" disabled={working}
                                    onClick={() => void resolveMissing({ kind: 'remove', path: file.path })}>Remove from collections</button>
                                </div>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : (
                  <div className="library-sync-file-actions">
                    <button className="accent-button" type="submit" disabled={working || preferences === null || needsLibraries || !hasFields || !validTiming}>Retry sync</button>
                  </div>
                )}
                {working && <p role="status">Updating libraries…</p>}
              </div>
            )}
            {result.warnings.length > 0 && (
              <>
                <h4>Warnings ({result.warnings.length})</h4>
                <ul className="library-sync-result-list" aria-label="Sync warnings" tabIndex={0}>
                  {result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                </ul>
              </>
            )}
            {result.backupPaths.length > 0 && (
              <details>
                <summary>Backup files ({result.backupPaths.length})</summary>
                <ul className="library-sync-result-list" aria-label="Sync backup files" tabIndex={0}>
                  {result.backupPaths.map((path, index) => <li key={index}>{path}</li>)}
                </ul>
              </details>
            )}
          </section>
        )}

        {preferences === null && loadingPreferences && <p className="library-sync-description" role="status">Loading sync settings…</p>}

        <div className="library-sync-settings-grid">
          <fieldset className="tracklist-export-options library-sync-directions" disabled={working || preferences === null}>
            <legend>Direction</legend>
            <div>
              {directions.map((option) => (
                <label key={option.value}>
                  <input type="radio" name="sync-direction" checked={direction === option.value}
                    onChange={() => { setDirection(option.value); if (option.value === 'both') setMode('merge'); }} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {direction !== 'both' && (
            <fieldset className="tracklist-export-options" disabled={working || preferences === null}>
              <legend>Update {destinationName}</legend>
              <div>
                <label><input type="radio" name="sync-mode" checked={mode === 'merge'}
                  onChange={() => setMode('merge')} /> Merge</label>
                <label><input type="radio" name="sync-mode" checked={mode === 'replace'}
                  onChange={() => setMode('replace')} /> Overwrite</label>
              </div>
            </fieldset>
          )}

          {libraryChoices.length > 0 && <fieldset className="tracklist-export-options library-sync-locations" disabled={working || preferences === null}>
            <legend>Libraries</legend>
            <div>
              {libraryChoices.map(({ kind, label, options, selected }) => (
                  <div className="library-sync-location" key={kind}>
                    <label><strong>{label}</strong>
                      <select aria-label={label} value={selected?.id ?? ''} onChange={(event) => void chooseLibrary(event.currentTarget.value)}>
                        <option value="" disabled>Choose a connected library</option>
                        {options.map((entry) => <option key={entry.id} value={entry.id} disabled={!entry.available}>
                          {entry.name}{entry.id === connections?.sourceOfTruthId ? ' · Primary' : ''}{entry.available ? '' : ' · Unavailable'}
                        </option>)}
                      </select>
                    </label>
                  </div>
              ))}
            </div>
          </fieldset>}

          <fieldset className="tracklist-export-options library-sync-fields" disabled={working || preferences === null}>
            <legend>Sync</legend>
            <div>
              {fieldOptions.map((option) => (
                <label key={option.value}>
                  <input type="checkbox" checked={fields[option.value]}
                    onChange={(event) => setFields({ ...fields, [option.value]: event.currentTarget.checked })} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {direction === 'both' && (
            <fieldset className="tracklist-export-options" disabled={working || preferences === null}>
              <legend>If track data differs, use</legend>
              <div>
                <label><input type="radio" name="conflict-source" checked={conflictSource === 'rekordbox'}
                  onChange={() => setConflictSource('rekordbox')} /> Rekordbox</label>
                <label><input type="radio" name="conflict-source" checked={conflictSource === 'serato'}
                  onChange={() => setConflictSource('serato')} /> Serato</label>
              </div>
            </fieldset>
          )}
        </div>

        {hasPerformance && (
          <details className="library-sync-timing">
            <summary>Timing correction</summary>
            <label htmlFor="sync-timing-offset">Correction in milliseconds
              <input id="sync-timing-offset" type="number" min={-1000} max={1000} step={1} required
                value={timingOffset} disabled={working || preferences === null} onChange={(event) => setTimingOffset(event.currentTarget.value)} />
            </label>
            <p>Added for Serato, subtracted for Rekordbox. Leave 0 to keep stored positions.</p>
          </details>
        )}

        <div className="library-sync-description">
          {mode === 'replace' && <p>Overwrite replaces checked categories in {destinationName}. Absent tracks and playlists are removed when checked. Audio files stay on disk.</p>}
          <p>Close Serato before syncing.</p>
        </div>

        {!hasFields && <p className="tracklist-export-note">Choose at least one category to sync.</p>}
        {needsLibraries && <p className="tracklist-export-note">Connect and select an available Rekordbox XML and Serato library.</p>}
        {!validTiming && <p className="tracklist-export-note">Enter a whole number between -1000 and 1000 milliseconds.</p>}
        <div className="library-sync-actions">
          <button className="accent-button" type="submit" disabled={working || preferences === null || needsLibraries || !hasFields || !validTiming}>
            {pending ? 'Working…' : hasMissingFiles ? 'Check files again' : missingFiles !== null ? 'Retry sync' : mode === 'replace'
              ? 'Overwrite library' : 'Sync libraries'}
          </button>
        </div>
      </form>
    </section>
  );
};
