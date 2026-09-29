import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';

import type { LibraryConnections, LibrarySourceKind, SyncActivity, SyncDirection, SyncFields, SyncMissingFileAction, SyncPreferences, SyncRequest, SyncResult } from './shared/dj-library';

const directions = [
  { value: 'both', label: 'Arsenal to connected libraries' },
  { value: 'rekordbox-to-serato', label: 'Arsenal to Serato' },
  { value: 'serato-to-rekordbox', label: 'Arsenal to Rekordbox' },
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

export const SyncLibrarySettings = ({ busy, connections, onSync, onResolveMissing, initialResult = null }: Readonly<{
  busy: boolean;
  connections: LibraryConnections | null;
  onSync: (request: SyncRequest) => Promise<SyncResult>;
  onResolveMissing: (action: SyncMissingFileAction) => Promise<SyncResult>;
  initialResult?: Exclude<SyncResult, { kind: 'cancelled' }> | null;
}>): JSX.Element => {
  const resultRef = useRef<HTMLElement>(null);
  const removalRef = useRef<HTMLDivElement>(null);
  const savedRequestKey = useRef<string | null>(null);
  const draftChanged = useRef(false);
  const activityResultKey = useRef<string | null>(null);
  const backgroundResult = useRef<SyncActivity['result']>(null);
  const [preferences, setPreferences] = useState<SyncPreferences | null>(null);
  const [preferencesFor, setPreferencesFor] = useState<LibraryConnections | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [activity, setActivity] = useState<SyncActivity | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [cadence, setCadence] = useState<NonNullable<SyncRequest['cadence']>>('ongoing');
  const [direction, setDirection] = useState<SyncDirection>('both');
  const [mode, setMode] = useState<NonNullable<SyncRequest['mode']>>('merge');
  const [fields, setFields] = useState<SyncFields>({
    tracks: true, metadata: true, playlists: true, hotCues: true, loops: true, beatgrids: true,
  });
  const [result, setResult] = useState<Exclude<SyncResult, { kind: 'cancelled' }> | null>(initialResult);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<readonly string[]>([]);
  const [removePaths, setRemovePaths] = useState<readonly string[]>([]);
  const [timingOffset, setTimingOffset] = useState('0');
  const destinationName = direction === 'rekordbox-to-serato' ? 'Serato' : 'Rekordbox XML';
  const loadingPreferences = preferencesFor !== connections;
  const working = busy || pending || loadingPreferences || activity?.state === 'syncing';
  const ongoing = activity !== null && activity.state !== 'off';
  const destinationKinds = libraryKinds.filter(({ kind }) => direction === 'both' || kind === (direction === 'rekordbox-to-serato' ? 'serato' : 'rekordbox'));
  const nativeConnections = connections?.connections.filter((entry) => entry.origin === undefined) ?? [];
  const destinations = destinationKinds.flatMap(({ kind, key }) => nativeConnections.filter((entry) => entry.kind === kind && entry.path === preferences?.[key]));
  const needsLibraries = destinations.length === 0 || destinations.some((entry) => !entry.available);
  const includesSerato = destinations.some((entry) => entry.kind === 'serato');
  const libraryChoices = destinationKinds.flatMap(({ kind, label, key }) => {
    const options = nativeConnections.filter((entry) => entry.kind === kind);
    const selected = options.find((entry) => entry.path === preferences?.[key]);
    return options.length > 1 || options.length === 1 && selected === undefined ? [{ kind, label, options, selected }] : [];
  });
  const hasFields = Object.values(fields).some(Boolean);
  const hasPerformance = fields.hotCues || fields.loops || fields.beatgrids;
  const parsedTimingOffset = Number(timingOffset);
  const validOffset = timingOffset.trim() !== '' && Number.isSafeInteger(parsedTimingOffset) && Math.abs(parsedTimingOffset) <= 1000;
  const timingOffsetMs = validOffset ? parsedTimingOffset : 0;
  const validTiming = !hasPerformance || !includesSerato || validOffset;
  const missingFiles = result?.kind === 'missing-files' ? result.files : null;
  const selectedPathSet = new Set(selectedPaths);
  const selectedFiles = missingFiles?.filter((file) => selectedPathSet.has(file.path)) ?? [];
  const selectedMatches = selectedFiles.flatMap((file) => file.candidates.length === 1
    ? file.candidates.map((replacementPath) => ({ path: file.path, replacementPath })) : []);
  const removePathSet = new Set(removePaths);
  const removalFiles = missingFiles?.filter((file) => removePathSet.has(file.path)) ?? [];
  const removalLibraries = [...new Set(removalFiles.flatMap((file) => file.libraryPaths ?? []))];
  const hasMissingFiles = missingFiles !== null && missingFiles.length > 0;
  const hasIssues = result !== null && (result.kind === 'rejected' || hasMissingFiles || result.warnings.length > 0 ||
    result.kind === 'synced' && result.skippedTrackCount > 0);

  useEffect(() => {
    let active = true;
    void window.djLibrary.syncPreferences().then((saved) => {
      if (!active) return;
      setPreferences(saved);
      const requestKey = JSON.stringify(saved.request);
      if (!draftChanged.current && saved.request !== null && requestKey !== savedRequestKey.current) {
        setCadence(saved.request.cadence ?? 'once');
        setDirection(saved.request.direction);
        setMode(saved.request.mode ?? 'merge');
        setFields(saved.request.fields);
        setTimingOffset(String(saved.request.timingOffsetMs));
      }
      savedRequestKey.current = requestKey;
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
    let active = true;
    let receivedUpdate = false;
    const updateActivity = (next: SyncActivity): void => {
      if (!active) return;
      setActivity(next);
      setActivityError(null);
      const resultKey = JSON.stringify(next.result);
      if (resultKey === activityResultKey.current) return;
      activityResultKey.current = resultKey;
      if (next.result === null) return;
      backgroundResult.current = next.result;
      setResult(next.result);
      setRepairError(null);
      const remainingPaths = new Set(next.result.kind === 'missing-files' ? next.result.files.map((file) => file.path) : []);
      setSelectedPaths((current) => current.filter((path) => remainingPaths.has(path)));
      setRemovePaths([]);
    };
    const unsubscribe = window.djLibrary.onSyncActivity((next) => {
      receivedUpdate = true;
      updateActivity(next);
    });
    void window.djLibrary.syncActivity().then((next) => {
      if (!receivedUpdate) updateActivity(next);
    }).catch((error: unknown) => {
      if (!active || receivedUpdate) return;
      setActivityError(error instanceof Error ? error.message : 'Could not load ongoing sync status. Reopen Connections to try again.');
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (result !== null && result !== backgroundResult.current) {
      resultRef.current?.focus({ preventScroll: true });
      resultRef.current?.scrollIntoView({ block: 'start' });
    }
  }, [result]);

  useEffect(() => {
    if (removePaths.length > 0) {
      removalRef.current?.focus({ preventScroll: true });
      removalRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [removePaths]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (working || preferences === null || needsLibraries || !hasFields || !validTiming) return;
    setPending(true);
    setResult(null);
    setRepairError(null);
    setSelectedPaths([]);
    setRemovePaths([]);
    try {
      let next = await onSync({ cadence, direction, mode, conflictSource: 'rekordbox', fields, timingOffsetMs });
      try {
        const saved = await window.djLibrary.syncPreferences();
        setPreferences(saved);
        savedRequestKey.current = JSON.stringify(saved.request);
        draftChanged.current = false;
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

  const stopOngoingSync = async (): Promise<void> => {
    if (busy || pending) return;
    setPending(true);
    try {
      setActivity(await window.djLibrary.stopOngoingSync());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Could not stop ongoing sync. Try again.';
      setRepairError(message);
      setResult((current) => current?.kind === 'missing-files' ? current
        : { kind: 'rejected', message, warnings: [], backupPaths: [] });
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
      setRemovePaths([]);
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
        const remainingPaths = new Set(next.kind === 'missing-files' ? next.files.map((file) => file.path) : []);
        setSelectedPaths((current) => current.filter((path) => remainingPaths.has(path)));
        setRemovePaths([]);
      }
    } catch (error: unknown) {
      setRepairError(error instanceof Error ? error.message : 'Could not update the missing files. Try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="library-sync-settings" aria-labelledby="library-sync-title">
      <form onSubmit={(event) => void submit(event)}>
        <h2 id="library-sync-title">Sync settings</h2>

        {activity !== null && (
          <div className="library-sync-activity">
            <p role="status">{activity.state === 'watching' ? 'Ongoing sync is on. App edits sync automatically.'
              : activity.state === 'syncing' ? 'Ongoing sync is updating your libraries…'
              : activity.state === 'attention' ? 'Ongoing sync needs attention. Resolve the issue below, then start it again.'
              : 'Ongoing sync is off.'}
              {activity.lastSyncedAt !== null && <> Last synced <time dateTime={activity.lastSyncedAt}>{new Date(activity.lastSyncedAt).toLocaleString()}</time>.</>}
            </p>
            {ongoing && <button className="quiet-button" type="button" disabled={busy || pending}
              onClick={() => void stopOngoingSync()}>Stop ongoing sync</button>}
          </div>
        )}
        {activityError !== null && <p className="library-sync-recovery-error" role="alert">{activityError}</p>}

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
                    <p>Changes apply to your Arsenal library and connected libraries.</p>
                    <div className="library-sync-bulk-actions" aria-label="Missing file selection">
                      <label className="library-sync-file-selection">
                        <input type="checkbox" disabled={working} checked={selectedFiles.length === missingFiles.length}
                          ref={(input) => { if (input !== null) input.indeterminate = selectedFiles.length > 0 && selectedFiles.length < missingFiles.length; }}
                          onChange={(event) => setSelectedPaths(event.currentTarget.checked ? missingFiles.map((file) => file.path) : [])} />
                        <span>Select all</span>
                      </label>
                      <span aria-live="polite">{selectedFiles.length} selected</span>
                      <button className="quiet-button" type="button" disabled={working || selectedFiles.length === 0}
                        onClick={() => void resolveMissing({ kind: 'search-many', paths: selectedFiles.map((file) => file.path) })}>Search folder…</button>
                      <button className="quiet-button" type="button" disabled={working || selectedMatches.length === 0}
                        onClick={() => void resolveMissing({ kind: 'relink-many', replacements: selectedMatches })}>
                        {selectedMatches.length > 0 ? `Use ${selectedMatches.length} ${selectedMatches.length === 1 ? 'match' : 'matches'}` : 'Use matches'}
                      </button>
                      <button className="quiet-button" type="button" disabled={working || selectedFiles.length === 0}
                        onClick={() => setRemovePaths(selectedFiles.map((file) => file.path))}>Remove selected…</button>
                    </div>
                    {selectedFiles.length > 0 && <p>Use matches relinks songs with one possible match. Review multiple matches individually.</p>}
                    {removalFiles.length > 0 && (
                      <div className="library-sync-remove-confirmation" ref={removalRef} tabIndex={-1}
                        role="group" aria-labelledby="library-sync-remove-title">
                        <strong id="library-sync-remove-title">Remove {removalFiles.length === 1 ? 'this song' : `${removalFiles.length} songs`} from Arsenal and connected libraries?</strong>
                        <ul className="library-sync-result-list" aria-label="Songs to remove">
                          {removalFiles.map((file) => <li key={file.path}>{file.title || 'Untitled track'}
                            <div className="library-sync-file-path">{file.path}</div>
                          </li>)}
                        </ul>
                        {removalLibraries.length > 0 && (
                          <details>
                            <summary>Libraries affected ({removalLibraries.length})</summary>
                            <ul className="library-sync-result-list" aria-label="Collections to remove from">
                              {removalLibraries.map((path) => <li key={path}>{path}</li>)}
                            </ul>
                          </details>
                        )}
                        <p>Removes the songs and their playlist memberships. Audio files stay on disk.</p>
                        <div className="library-sync-file-actions">
                          <button className="quiet-button" type="button" disabled={working} onClick={() => setRemovePaths([])}>Cancel</button>
                          <button className="quiet-button" type="button" disabled={working}
                            onClick={() => void resolveMissing({ kind: 'remove-many', paths: removalFiles.map((file) => file.path) })}>Remove from collections</button>
                        </div>
                      </div>
                    )}
                    <ul className="library-sync-missing-list" aria-label="Missing audio files">
                      {missingFiles.map((file) => {
                        const namedLibraries = connections?.connections.filter((connection) => file.libraryPaths?.includes(connection.path)) ?? [];
                        const collections = namedLibraries.length ? namedLibraries.map((connection) => connection.name).join(' and ')
                          : 'Arsenal or a connected library';
                        return (
                          <li key={file.path} className="library-sync-missing-file">
                            <label className="library-sync-file-selection">
                              <input type="checkbox" disabled={working} checked={selectedPathSet.has(file.path)}
                                aria-label={`Select ${file.title || 'Untitled track'} (${file.path})`}
                                onChange={(event) => {
                                  const checked = event.currentTarget.checked;
                                  setSelectedPaths((current) => checked ? [...current, file.path] : current.filter((path) => path !== file.path));
                                }} />
                              <strong>{file.title || 'Untitled track'}{file.artist ? ` · ${file.artist}` : ''}</strong>
                            </label>
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
                                onClick={() => setRemovePaths([file.path])}>Remove entry…</button>
                            </div>
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
            <legend>Frequency</legend>
            <div>
              <label><input type="radio" name="sync-cadence" checked={cadence === 'ongoing'}
                onChange={() => { draftChanged.current = true; setCadence('ongoing'); }} /> Ongoing</label>
              <label><input type="radio" name="sync-cadence" checked={cadence === 'once'}
                onChange={() => { draftChanged.current = true; setCadence('once'); }} /> One time</label>
            </div>
          </fieldset>

          <fieldset className="tracklist-export-options library-sync-directions" disabled={working || preferences === null}>
            <legend>Destination</legend>
            <div>
              {directions.map((option) => (
                <label key={option.value}>
                  <input type="radio" name="sync-direction" checked={direction === option.value}
                    onChange={() => { draftChanged.current = true; setDirection(option.value); if (option.value === 'both') setMode('merge'); }} />
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
                  onChange={() => { draftChanged.current = true; setMode('merge'); }} /> Merge</label>
                <label><input type="radio" name="sync-mode" checked={mode === 'replace'}
                  onChange={() => { draftChanged.current = true; setMode('replace'); }} /> Overwrite</label>
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
                          {entry.name}{entry.available ? '' : ' · Unavailable'}
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
                    onChange={(event) => { draftChanged.current = true; setFields({ ...fields, [option.value]: event.currentTarget.checked }); }} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

        </div>

        {hasPerformance && includesSerato && (
          <details className="library-sync-timing">
            <summary>Timing correction</summary>
            <label htmlFor="sync-timing-offset">Correction in milliseconds
              <input id="sync-timing-offset" type="number" min={-1000} max={1000} step={1} required
                value={timingOffset} disabled={working || preferences === null}
                onChange={(event) => { draftChanged.current = true; setTimingOffset(event.currentTarget.value); }} />
            </label>
            <p>Added when exporting to Serato. Leave 0 to keep stored positions.</p>
          </details>
        )}

        <div className="library-sync-description">
          <p>{cadence === 'ongoing' ? 'Ongoing sync updates the selected DJ libraries after edits made in Arsenal.'
            : 'One time sync applies these settings once and stops any ongoing sync.'}</p>
          <p>Every edit and smart playlist rule is saved in your Arsenal library, even when DJ apps are disconnected.</p>
          <p>Smart playlists sync with their current matching tracks. Their rules stay in Arsenal.</p>
          {mode === 'replace' && <p>Overwrite replaces checked categories in {destinationName}. Absent tracks and playlists are removed when checked. Audio files stay on disk.</p>}
          {includesSerato && <p>{cadence === 'ongoing' ? 'Keep Serato closed while ongoing sync is on.' : 'Close Serato before syncing.'}</p>}
          {ongoing && <p>Changed settings take effect when you sync.</p>}
        </div>

        {!hasFields && <p className="tracklist-export-note">Choose at least one category to sync.</p>}
        {needsLibraries && <p className="tracklist-export-note">Connect and select an available DJ library for this destination.</p>}
        {!validTiming && <p className="tracklist-export-note">Enter a whole number between -1000 and 1000 milliseconds.</p>}
        <div className="library-sync-actions">
          <button className="accent-button" type="submit" disabled={working || preferences === null || needsLibraries || !hasFields || !validTiming}>
            {pending ? 'Working…' : cadence === 'ongoing' ? activity?.state === 'attention' ? 'Resume ongoing sync'
              : ongoing ? 'Update ongoing sync' : 'Start ongoing sync' : 'Sync once'}
          </button>
        </div>
      </form>
    </section>
  );
};
