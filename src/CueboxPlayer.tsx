import { useState, type JSX } from 'react';

import type { SongRow } from './shared/dj-library';

export type PlaybackController = Readonly<{
  song: SongRow | null;
  playing: boolean;
  position: number;
  duration: number;
  failed: boolean;
  play: (song: SongRow) => void;
  seek: (seconds: number) => void;
}>;

const formatPlayerTime = (seconds: number): string => {
  if (!Number.isFinite(seconds)) {
    return '0:00';
  }

  const rounded = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, '0')}`;
};

export const TrackArtwork = ({
  loadEagerly = false,
  size = 'small',
  song,
}: Readonly<{
  loadEagerly?: boolean;
  size?: 'small' | 'medium' | 'large';
  song: SongRow;
}>): JSX.Element => {
  const artworkUrl =
    song.artworkUrl === null
      ? null
      : `${song.artworkUrl}?size=${size === 'large' ? 'overview' : 'thumbnail'}`;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showArtwork = artworkUrl !== null && artworkUrl !== failedUrl;

  return (
    <span className={`track-artwork is-${size}`} aria-hidden>
      {showArtwork && (
        <img
          src={artworkUrl}
          alt=""
          loading={loadEagerly ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setFailedUrl(artworkUrl)}
        />
      )}
    </span>
  );
};

export const CueboxPlayer = ({
  onStop,
  playback,
}: Readonly<{
  onStop: () => void;
  playback: PlaybackController;
}>): JSX.Element => {
  const song = playback.song;
  const duration = playback.duration > 0
    ? playback.duration
    : song?.durationSeconds ?? 0;

  return (
    <footer className={song === null ? 'global-player is-empty' : 'global-player'} aria-label="Audio player">
      <div className="global-player-track">
        {song === null ? (
          <span className="player-empty-art" aria-hidden />
        ) : (
          <TrackArtwork loadEagerly song={song} size="medium" />
        )}
        <span>
          <strong>{song?.title ?? 'Nothing playing'}</strong>
          {song !== null && <small>{song.artist ?? 'Unknown artist'}</small>}
        </span>
      </div>

      <div className="global-player-controls">
        <button
          className={playback.playing ? 'global-play-button is-playing' : 'global-play-button'}
          type="button"
          onClick={() => {
            if (song !== null) {
              playback.play(song);
            }
          }}
          disabled={song === null}
          aria-label={playback.playing ? 'Pause current track' : 'Play current track'}
        >
          <span aria-hidden>{playback.playing ? 'Ⅱ' : '▶'}</span>
        </button>
        <span className="player-time">{formatPlayerTime(playback.position)}</span>
        <input
          type="range"
          min="0"
          max={Math.max(duration, 1)}
          step="0.1"
          value={Math.min(playback.position, Math.max(duration, 1))}
          onChange={(event) => playback.seek(event.currentTarget.valueAsNumber)}
          disabled={song === null}
          aria-label={song === null ? 'Playback position' : `Seek in ${song.title}`}
        />
        <span className="player-time">{formatPlayerTime(duration)}</span>
      </div>

      <div className="global-player-meta">
        {song !== null && (
          <span>
            <b>{song.bpm === null ? '—' : Math.round(song.bpm)}</b>
            <small>BPM</small>
          </span>
        )}
        {song !== null && (
          <span>
            <b>{song.musicalKey ?? '—'}</b>
            <small>Key</small>
          </span>
        )}
        {playback.failed && <p className="is-error" role="alert">Audio unavailable</p>}
        <button type="button" onClick={onStop} disabled={song === null} aria-label="Clear player">×</button>
      </div>
    </footer>
  );
};
