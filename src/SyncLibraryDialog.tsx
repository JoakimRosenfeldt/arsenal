import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';

import type { LibrarySummary, SyncDirection, SyncFields, SyncRequest } from './shared/dj-library';

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

export const SyncLibraryDialog = ({ busy, library, onClose, onSync }: Readonly<{
  busy: boolean;
  library: LibrarySummary | null;
  onClose: () => void;
  onSync: (request: SyncRequest) => Promise<string | null>;
}>): JSX.Element => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [direction, setDirection] = useState<SyncDirection>('both');
  const [mode, setMode] = useState<NonNullable<SyncRequest['mode']>>('merge');
  const [conflictSource, setConflictSource] = useState<SyncRequest['conflictSource']>(library?.sourceKind ?? 'rekordbox');
  const [fields, setFields] = useState<SyncFields>({
    tracks: true, metadata: true, playlists: true, hotCues: true, loops: true, beatgrids: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [timingOffset, setTimingOffset] = useState('0');
  const sourceKind = direction === 'both' ? null : direction === 'rekordbox-to-serato' ? 'rekordbox' : 'serato';
  const destinationName = direction === 'rekordbox-to-serato' ? 'Serato' : 'Rekordbox XML';
  const usesOpenLibrary = library !== null && (sourceKind === null || library.sourceKind === sourceKind);
  const hasFields = Object.values(fields).some(Boolean);
  const hasPerformance = fields.hotCues || fields.loops || fields.beatgrids;
  const timingOffsetMs = hasPerformance ? Number(timingOffset) : 0;
  const validTiming = !hasPerformance || (timingOffset.trim() !== '' && Number.isSafeInteger(timingOffsetMs) && Math.abs(timingOffsetMs) <= 1000);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !hasFields || !validTiming) return;
    setError(null);
    setError(await onSync({ direction, mode, conflictSource: sourceKind ?? conflictSource, fields, timingOffsetMs }));
  };

  return (
    <dialog className="tracklist-export-dialog library-sync-dialog" ref={dialogRef} onClose={onClose}
      aria-labelledby="library-sync-title" aria-describedby="library-sync-description"
      onCancel={(event) => { if (busy) event.preventDefault(); }}
      onClick={(event) => {
        if (busy || event.target !== event.currentTarget) return;
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
          <button className="inspector-close" type="button" disabled={busy}
            onClick={() => dialogRef.current?.close()} aria-label="Close library sync">×</button>
        </div>

        <fieldset className="tracklist-export-options library-sync-directions" disabled={busy}>
          <legend>Direction</legend>
          <div>
            {directions.map((option) => (
              <label key={option.value}>
                <input type="radio" name="sync-direction" checked={direction === option.value}
                  onChange={() => { setDirection(option.value); if (option.value === 'both') setMode('merge'); setError(null); }} />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {direction !== 'both' && (
          <fieldset className="tracklist-export-options" disabled={busy}>
            <legend>Update {destinationName}</legend>
            <div>
              <label><input type="radio" name="sync-mode" checked={mode === 'merge'}
                onChange={() => { setMode('merge'); setError(null); }} /> Merge</label>
              <label><input type="radio" name="sync-mode" checked={mode === 'replace'}
                onChange={() => { setMode('replace'); setError(null); }} /> Overwrite</label>
            </div>
          </fieldset>
        )}

        <fieldset className="tracklist-export-options library-sync-fields" disabled={busy}>
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
          <fieldset className="tracklist-export-options" disabled={busy}>
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
                value={timingOffset} disabled={busy} onChange={(event) => setTimingOffset(event.currentTarget.value)} />
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
          <p>{usesOpenLibrary
            ? `Uses your open ${library.sourceKind === 'serato' ? 'Serato library' : 'Rekordbox XML'}: ${library.sourceName}. Choose the other library in the next dialog.`
            : 'Choose a Rekordbox XML file and a Serato library folder in the next dialogs.'}</p>
          <p>Supports Serato 4 Library folders and older _Serato_ libraries. Hot cues, loops and beatgrids use audio tags in MP3, AIFF, WAV, FLAC and M4A/MP4 files. Unsupported files are listed in the sync report.</p>
          <p>Close Serato before syncing. Backups are saved beside changed files. Import the updated XML into Rekordbox to apply its changes.</p>
        </div>

        {error !== null && <p className="tracklist-export-note" role="alert">{error}</p>}
        {!hasFields && <p className="tracklist-export-note">Choose at least one category to sync.</p>}
        {!validTiming && <p className="tracklist-export-note">Enter a whole number between -1000 and 1000 milliseconds.</p>}
        <div className="library-sync-actions">
          <button className="quiet-button" type="button" disabled={busy} onClick={() => dialogRef.current?.close()}>Cancel</button>
          <button className="accent-button" type="submit" disabled={busy || !hasFields || !validTiming}>
            {busy ? 'Syncing…' : mode === 'replace' ? 'Choose libraries and overwrite' : 'Choose libraries and sync'}
          </button>
        </div>
      </form>
    </dialog>
  );
};
