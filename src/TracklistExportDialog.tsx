import { useEffect, useRef, useState, type JSX } from 'react';

import type { RekordboxPlaylist } from './shared/dj-library';

type TracklistOptions = Readonly<{
  name: boolean;
  numbers: boolean;
  bpm: boolean;
  key: boolean;
  duration: boolean;
}>;

const optionLabels: readonly (readonly [keyof TracklistOptions, string])[] = [
  ['name', 'Playlist name'],
  ['numbers', 'Track numbers'],
  ['bpm', 'BPM'],
  ['key', 'Key'],
  ['duration', 'Duration'],
];

const formatDuration = (seconds: number): string => {
  const rounded = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(rounded / 60);
  const hours = Math.floor(minutes / 60);
  const secondsPart = String(rounded % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes % 60).padStart(2, '0')}:${secondsPart}`
    : `${minutes}:${secondsPart}`;
};

const tracklistText = (playlist: RekordboxPlaylist, options: TracklistOptions): string => {
  if (playlist.tracks.length === 0) return '';
  const tracks = playlist.tracks.map((song, index) => {
    const details = [
      options.bpm && song.bpm !== null && Number.isFinite(song.bpm)
        ? `${song.bpm.toLocaleString(undefined, { maximumFractionDigits: 2 })} BPM` : null,
      options.key ? song.musicalKey : null,
      options.duration && song.durationSeconds !== null && Number.isFinite(song.durationSeconds)
        ? formatDuration(song.durationSeconds) : null,
    ].filter((detail): detail is string => detail !== null && detail !== '');
    const number = options.numbers ? `${index + 1}. ` : '';
    const title = `${song.artist ?? 'Unknown artist'} - ${song.title}`;
    return `${number}${title}${details.length > 0 ? ` (${details.join(' · ')})` : ''}`;
  });
  return [...(options.name ? [playlist.name, ''] : []), ...tracks].join('\n');
};

export const TracklistExportDialog = ({ playlist, onClose }: Readonly<{
  playlist: RekordboxPlaylist;
  onClose: () => void;
}>): JSX.Element => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<TracklistOptions>({
    name: true, numbers: true, bpm: false, key: false, duration: false,
  });
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = tracklistText(playlist, options);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const copy = async (): Promise<void> => {
    try {
      await window.djLibrary.copyTracklist(text);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  return (
    <dialog className="tracklist-export-dialog" ref={dialogRef} onClose={onClose} aria-labelledby="tracklist-export-title">
      <div className="tracklist-export-heading">
        <div>
          <h2 id="tracklist-export-title">Export tracklist</h2>
          <p>{playlist.name}</p>
        </div>
        <button className="inspector-close" type="button" onClick={() => dialogRef.current?.close()} aria-label="Close export">×</button>
      </div>

      <fieldset className="tracklist-export-options">
        <legend>Include</legend>
        <div>
          {optionLabels.map(([key, label]) => (
            <label key={key}>
              <input type="checkbox" checked={options[key]} onChange={(event) => {
                setOptions({ ...options, [key]: event.currentTarget.checked });
                setCopyStatus('idle');
              }} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="tracklist-export-preview" htmlFor="tracklist-export-text">Tracklist</label>
      <textarea id="tracklist-export-text" value={text} readOnly spellCheck={false}
        placeholder="This playlist has no tracks." onFocus={(event) => event.currentTarget.select()} />
      {playlist.missingTrackCount > 0 && (
        <p className="tracklist-export-note">{playlist.missingTrackCount} missing {playlist.missingTrackCount === 1 ? 'track' : 'tracks'} could not be included.</p>
      )}

      <div className="tracklist-export-actions">
        <span>{playlist.tracks.length} {playlist.tracks.length === 1 ? 'track' : 'tracks'}</span>
        <span role="status">{copyStatus === 'copied' ? 'Copied to clipboard.' : copyStatus === 'failed' ? 'Could not copy tracklist.' : ''}</span>
        <button className="accent-button" type="button" disabled={playlist.tracks.length === 0} onClick={() => void copy()}>Copy to clipboard</button>
      </div>
    </dialog>
  );
};
