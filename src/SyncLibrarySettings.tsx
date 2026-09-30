import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import { ONGOING_SYNC_REQUEST, type LibraryConnectionResult, type LibraryConnections, type SyncActivity, type SyncMissingFileAction, type SyncRequest, type SyncResult } from './shared/dj-library';

export const SyncLibrarySettings = ({ busy, connections, onSync, onResolveMissing, onImportChanges, onError, initialResult = null }: Readonly<{
  busy: boolean;
  connections: LibraryConnections | null;
  onSync: (request: SyncRequest) => Promise<SyncResult>;
  onResolveMissing: (action: SyncMissingFileAction) => Promise<SyncResult>;
  onImportChanges: (id: string) => Promise<LibraryConnectionResult>;
  onError?: (message: string) => void;
  initialResult?: Exclude<SyncResult, { kind: 'cancelled' }> | null;
}>): JSX.Element => {
  const resultRef = useRef<HTMLElement>(null);
  const removalRef = useRef<HTMLDivElement>(null);
  const activityResultKey = useRef<string | null>(null);
  const backgroundResult = useRef<SyncActivity['result']>(null);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  const [activity, setActivity] = useState<SyncActivity | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [result, setResult] = useState<Exclude<SyncResult, { kind: 'cancelled' }> | null>(initialResult);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<readonly string[]>([]);
  const [removePaths, setRemovePaths] = useState<readonly string[]>([]);
  const working = busy || pending || activity?.state === 'syncing';
  const hasConnections = connections?.connections.some((entry) => entry.origin === undefined) ?? false;
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
  const reportError = useCallback((message: string): void => {
    if (onError) onError(message);
    else {
      setRepairError(message);
      setResult((current) => current?.kind === 'missing-files' ? current
        : { kind: 'rejected', warnings: current?.warnings ?? [], backupPaths: current?.backupPaths ?? [], message });
    }
  }, [onError]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

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
      const message = error instanceof Error ? error.message : 'Could not load ongoing sync status. Reopen Connections to try again.';
      if (onError) onError(message);
      else setActivityError(message);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [onError]);

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

  const retry = async (): Promise<void> => {
    if (working || !hasConnections) return;
    setPending(true);
    setResult(null);
    setRepairError(null);
    setSelectedPaths([]);
    setRemovePaths([]);
    try {
      const saved = await window.djLibrary.syncPreferences();
      const next = await onSync({ ...ONGOING_SYNC_REQUEST, timingOffsetMs: saved.request?.timingOffsetMs ?? 0 });
      if (next.kind === 'rejected' && onError && result?.kind === 'missing-files') {
        onError([next.message, ...next.warnings].join(' '));
        setResult(result);
        return;
      }
      if (!mounted.current && next.kind !== 'cancelled' && (next.kind === 'missing-files' || next.warnings.length > 0 ||
        next.kind === 'synced' && next.skippedTrackCount > 0)) onError?.([next.message, ...next.warnings].join(' '));
      setResult(next.kind === 'cancelled' ? result : result?.kind === 'missing-files'
        ? { ...next, backupPaths: [...new Set([...result.backupPaths, ...next.backupPaths])] } : next);
    } catch (error: unknown) {
      reportError(error instanceof Error ? error.message : 'Could not sync the libraries. Try again.');
    } finally {
      setPending(false);
    }
  };

  const importAndRetry = async (ids: readonly string[]): Promise<void> => {
    if (working) return;
    setPending(true);
    try {
      for (const id of ids) {
        const imported = await onImportChanges(id);
        if (imported.kind === 'cancelled') return;
        if (imported.kind === 'rejected') { reportError(imported.message); return; }
      }
    } catch (error: unknown) {
      reportError(error instanceof Error ? error.message : 'Could not import the changes. Try again.');
      return;
    } finally {
      setPending(false);
    }
    await retry();
  };

  const resolveMissing = async (action: SyncMissingFileAction): Promise<void> => {
    if (working) return;
    setPending(true);
    setRepairError(null);
    const repairedPaths = new Set(action.kind === 'remove-many' ? action.paths
      : action.kind === 'relink-many' ? action.replacements.map((replacement) => replacement.path)
        : action.kind === 'remove' || action.kind === 'relink' ? [action.path] : []);
    if (result?.kind === 'missing-files' && repairedPaths.size > 0) {
      setResult({ ...result, files: result.files.filter((file) => !repairedPaths.has(file.path)) });
      setRemovePaths([]);
    }
    try {
      const next = await onResolveMissing(action);
      if (next.kind === 'cancelled') {
        if (repairedPaths.size > 0) setResult(result);
        return;
      }
      if (next.kind === 'rejected') {
        if (onError) {
          onError([next.message, ...next.warnings].join(' '));
          setResult(result?.kind === 'missing-files' ? result : null);
          return;
        }
        setRepairError(next.message);
        setResult((current) => {
          const previous = repairedPaths.size > 0 ? result : current;
          return previous?.kind === 'missing-files'
            ? { ...previous, warnings: [...new Set([...previous.warnings, ...next.warnings])],
              backupPaths: [...new Set([...previous.backupPaths, ...next.backupPaths])] }
            : next;
        });
      } else {
        if (!mounted.current && (next.kind === 'missing-files' && next.files.length > 0 || next.warnings.length > 0 ||
          next.kind === 'synced' && next.skippedTrackCount > 0)) onError?.([next.message, ...next.warnings].join(' '));
        setResult((current) => ({ ...next,
          warnings: [...new Set([...(current?.warnings ?? []), ...next.warnings])],
          backupPaths: [...new Set([...(current?.backupPaths ?? []), ...next.backupPaths])],
        }));
        const remainingPaths = new Set(next.kind === 'missing-files' ? next.files.map((file) => file.path) : []);
        setSelectedPaths((current) => current.filter((path) => remainingPaths.has(path)));
        setRemovePaths([]);
      }
    } catch (error: unknown) {
      if (repairedPaths.size > 0) setResult(result);
      reportError(error instanceof Error ? error.message : 'Could not update the missing files. Try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="library-sync-settings" aria-labelledby="library-sync-title">
      <form onSubmit={(event) => { event.preventDefault(); void retry(); }}>
        <h2 id="library-sync-title">Sync</h2>

        {activity !== null && (
          <div className="library-sync-activity">
            <p>{activity.state === 'watching' ? 'Ongoing sync is on.'
              : activity.state === 'syncing' ? 'Syncing…'
              : activity.state === 'waiting' ? 'Waiting for Rekordbox to close.'
              : activity.state === 'attention' ? 'Sync needs attention.'
              : 'Connect a library to sync it with Arsenal.'}
              {activity.lastSyncedAt !== null && <> Last synced <time dateTime={activity.lastSyncedAt}>{new Date(activity.lastSyncedAt).toLocaleString()}</time>.</>}
            </p>
            {activity.state === 'attention' && hasConnections && <button className="quiet-button" type="submit" disabled={working}>Retry sync</button>}
          </div>
        )}
        {activityError !== null && <p className="library-sync-recovery-error" role="alert">{activityError}</p>}

        {result !== null && (
          <section className={`library-sync-result${hasIssues ? ' library-sync-result-warning' : ''}`} ref={resultRef}
            tabIndex={-1} role={hasIssues ? 'alert' : 'status'} aria-labelledby="library-sync-result-title">
            <h3 id="library-sync-result-title">{result.kind === 'missing-files'
              ? hasMissingFiles ? 'Missing audio files' : 'Resume sync'
              : result.kind === 'rejected' ? 'Sync stopped'
              : result.kind === 'queued' ? 'Changes queued'
              : hasIssues ? 'Sync needs attention' : 'Sync complete'}</h3>
            {!(result.kind === 'missing-files' && !hasIssues) && <p>{result.message}</p>}
            {result.kind === 'rejected' && result.importConnectionIds !== undefined && result.importConnectionIds.length > 0 && (
              <div className="library-sync-file-actions">
                <button className="accent-button" type="button" disabled={working}
                  onClick={() => void importAndRetry(result.importConnectionIds ?? [])}>
                  Import {connections?.connections.filter((entry) => result.importConnectionIds?.includes(entry.id)).map((entry) => entry.name).join(' and ') || 'library'} changes and retry
                </button>
              </div>
            )}
            {missingFiles !== null && (
              <div className="library-sync-recovery" aria-busy={working}>
                {repairError !== null && <p className="library-sync-recovery-error" role="alert">{repairError}</p>}
                {hasMissingFiles ? (
                  <>
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
                    {removalFiles.length > 0 && (
                      <div className="library-sync-remove-confirmation" ref={removalRef} tabIndex={-1}
                        role="group" aria-labelledby="library-sync-remove-title">
                        <strong id="library-sync-remove-title">Remove {removalFiles.length === 1 ? 'this track' : `${removalFiles.length} tracks`} from Arsenal and connected libraries?</strong>
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
                        <p>Audio files stay on disk.</p>
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
                                {file.candidates.length > 3 && <p>+{file.candidates.length - 3} more</p>}
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
                    <button className="accent-button" type="submit" disabled={working || !hasConnections}>Retry sync</button>
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

      </form>
    </section>
  );
};
