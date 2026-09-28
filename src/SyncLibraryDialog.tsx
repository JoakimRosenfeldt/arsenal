import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';

import type { LibrarySourceKind, LibrarySummary, SyncDirection, SyncFields, SyncMissingFileAction, SyncPreferences, SyncRequest, SyncResult } from './shared/dj-library';

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

export const SyncLibraryDialog = ({ busy, library, onClose, onSync, onResolveMissing }: Readonly<{
  busy: boolean;
  library: LibrarySummary | null;
  onClose: () => void;
  onSync: (request: SyncRequest) => Promise<SyncResult>;
  onResolveMissing: (action: SyncMissingFileAction) => Promise<SyncResult>;
}>): JSX.Element => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resultRef = useRef<HTMLElement>(null);
  const [preferences, setPreferences] = useState<SyncPreferences | null>(null);
  const [pending, setPending] = useState(true);
  const [direction, setDirection] = useState<SyncDirection>('both');
  const [mode, setMode] = useState<NonNullable<SyncRequest['mode']>>('merge');
  const [conflictSource, setConflictSource] = useState<SyncRequest['conflictSource']>(library?.sourceKind ?? 'rekordbox');
  const [fields, setFields] = useState<SyncFields>({
    tracks: true, metadata: true, playlists: true, hotCues: true, loops: true, beatgrids: true,
  });
  const [result, setResult] = useState<Exclude<SyncResult, { kind: 'cancelled' }> | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [removePath, setRemovePath] = useState<string | null>(null);
  const [timingOffset, setTimingOffset] = useState('0');
  const sourceKind = direction === 'both' ? null : direction === 'rekordbox-to-serato' ? 'rekordbox' : 'serato';
  const destinationName = direction === 'rekordbox-to-serato' ? 'Serato' : 'Rekordbox XML';
  const working = busy || pending;
  const needsLibraries = preferences?.rekordboxPath === null || preferences?.seratoPath === null;
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
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    let active = true;
    void window.djLibrary.syncPreferences().then((saved) => {
      if (!active) return;
      setPreferences(saved);
      if (saved.request !== null) {
        setDirection(saved.request.direction);
        setMode(saved.request.mode ?? 'merge');
        setConflictSource(saved.request.conflictSource);
        setFields(saved.request.fields);
        setTimingOffset(String(saved.request.timingOffsetMs));
      }
    }).catch((error: unknown) => {
      if (active) setResult({ kind: 'rejected', warnings: [], backupPaths: [],
        message: `Could not load saved sync settings. ${error instanceof Error ? error.message : 'Close and reopen this dialog to try again.'}`,
      });
    }).finally(() => { if (active) setPending(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (result !== null) {
      resultRef.current?.focus({ preventScroll: true });
      resultRef.current?.scrollIntoView({ block: 'start' });
    }
  }, [result]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (working || preferences === null || !hasFields || !validTiming) return;
    setPending(true);
    setResult(null);
    setRepairError(null);
    setRemovePath(null);
    try {
      let next = await onSync({ direction, mode, conflictSource: sourceKind ?? conflictSource, fields, timingOffsetMs });
      try {
        setPreferences(await window.djLibrary.syncPreferences());
      } catch {
        const message = 'Could not refresh the saved library locations. Close and reopen this dialog before syncing again.';
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

  const chooseLibrary = async (kind: LibrarySourceKind): Promise<void> => {
    setPending(true);
    try {
      const selected = await window.djLibrary.chooseSyncLibrary(kind, direction);
      if (selected !== null) {
        setPreferences(selected);
        setResult(null);
        setRepairError(null);
        setRemovePath(null);
      }
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
    <dialog className="tracklist-export-dialog library-sync-dialog" ref={dialogRef} onClose={onClose}
      aria-labelledby="library-sync-title" aria-describedby="library-sync-description"
      onCancel={(event) => { if (working) event.preventDefault(); }}
      onClick={(event) => {
        if (working || event.target !== event.currentTarget) return;
        const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
        if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) {
          event.currentTarget.close();
        }
      }}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="tracklist-export-heading">
          <div>
            <h2 id="library-sync-title">Sync libraries</h2>
            <p>Rekordbox XML and Serato</p>
          </div>
          <button className="inspector-close" type="button" disabled={working}
            onClick={() => dialogRef.current?.close()} aria-label="Close library sync">×</button>
        </div>

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
                    <p>Relink each file or remove its library entry. Possible matches require your choice. After reconnecting a drive, use Check files again.</p>
                    <ul className="library-sync-missing-list" aria-label="Missing audio files">
                      {missingFiles.map((file) => {
                        const collections = file.libraries.map((kind) => kind === 'rekordbox' ? 'Rekordbox XML' : 'Serato').join(' and ');
                        return (
                          <li key={file.path} className="library-sync-missing-file">
                            <strong>{file.title || 'Untitled track'}{file.artist ? ` · ${file.artist}` : ''}</strong>
                            <p className="library-sync-file-path">{file.path}</p>
                            <p>In {collections}</p>
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
                            ) : <p>No matching file found. Search a folder or choose its new location.</p>}
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
                                <p>Remove this entry from the {collections} collections?</p>
                                <p className="library-sync-file-path">{file.path}</p>
                                <p>This removes the track and its playlist memberships from those collections. It never deletes audio files.</p>
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
                    <button className="accent-button" type="submit" disabled={working || preferences === null || !hasFields || !validTiming}>Retry sync</button>
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

        {preferences === null && pending && <p className="library-sync-description" role="status">Loading saved sync settings…</p>}

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

        <fieldset className="tracklist-export-options library-sync-locations" disabled={working || preferences === null}>
          <legend>Libraries</legend>
          <div>
            {(['rekordbox', 'serato'] as const).map((kind) => {
              const label = kind === 'rekordbox' ? 'Rekordbox XML' : 'Serato library';
              const path = preferences?.[kind === 'rekordbox' ? 'rekordboxPath' : 'seratoPath'];
              return (
                <div className="library-sync-location" key={kind}>
                  <div><strong>{label}</strong><span>{path ?? 'No library selected'}</span></div>
                  <button className="quiet-button" type="button" onClick={() => void chooseLibrary(kind)}
                    aria-label={`${path ? 'Change' : 'Choose'} ${label}`}>{path ? 'Change' : 'Choose…'}</button>
                </div>
              );
            })}
          </div>
        </fieldset>

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

        {hasPerformance && (
          <details className="library-sync-timing">
            <summary>Timing correction</summary>
            <label htmlFor="sync-timing-offset">Correction in milliseconds
              <input id="sync-timing-offset" type="number" min={-1000} max={1000} step={1} required
                value={timingOffset} disabled={working || preferences === null} onChange={(event) => setTimingOffset(event.currentTarget.value)} />
            </label>
            <p>Added when sending to Serato, subtracted when sending to Rekordbox. Leave 0 to preserve stored positions.</p>
          </details>
        )}

        <div className="library-sync-description" id="library-sync-description">
          <p>Only checked categories are synced. {mode === 'replace'
            ? `Overwrite replaces those categories in ${destinationName}. Tracks and playlists absent from the source are removed only when their categories are checked. Audio files stay on disk.`
            : 'Tracks and playlist memberships are merged without deletions.'} {direction === 'both'
            ? `${conflictSource === 'rekordbox' ? 'Rekordbox' : 'Serato'} values win for matching tracks.`
            : 'Source values win for matching tracks.'}</p>
          <p>Your last used settings and library locations are saved for the next sync. Choose or change the libraries above.</p>
          <p>Supports Serato 4 Library folders and older _Serato_ libraries. Hot cues, loops and beatgrids use audio tags in MP3, AIFF, WAV, FLAC and M4A/MP4 files. Unsupported files are listed in the sync report.</p>
          <p>Close Serato before syncing. Backups are saved beside changed files. Import the updated XML into Rekordbox to apply its changes.</p>
        </div>

        {!hasFields && <p className="tracklist-export-note">Choose at least one category to sync.</p>}
        {!validTiming && <p className="tracklist-export-note">Enter a whole number between -1000 and 1000 milliseconds.</p>}
        <div className="library-sync-actions">
          <button className="quiet-button" type="button" disabled={working} onClick={() => dialogRef.current?.close()}>{result === null ? 'Cancel' : 'Close'}</button>
          <button className="accent-button" type="submit" disabled={working || preferences === null || !hasFields || !validTiming}>
            {busy ? 'Syncing…' : hasMissingFiles ? 'Check files again' : missingFiles !== null ? 'Retry sync' : mode === 'replace'
              ? needsLibraries ? 'Choose libraries and overwrite' : 'Overwrite library'
              : needsLibraries ? 'Choose libraries and sync' : 'Sync libraries'}
          </button>
        </div>
      </form>
    </dialog>
  );
};
