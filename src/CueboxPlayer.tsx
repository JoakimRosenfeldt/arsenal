import { useState, type JSX } from 'react';

import type { SongRow } from './shared/dj-library';
import { TrackWaveform } from './TrackWaveform';
import { UiIcon } from './UiIcon';

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
      {!showArtwork && <UiIcon name="music" size={size === 'large' ? 32 : 20} />}
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
  playback, queue, volume, muted, onVolume, onMute,
}: Readonly<{
  playback: PlaybackController;
  queue: readonly SongRow[];
  volume: number;
  muted: boolean;
  onVolume: (value: number) => void;
  onMute: () => void;
}>): JSX.Element => {
  const song = playback.song;
  const duration = playback.duration > 0 ? playback.duration : song?.durationSeconds ?? 0;
  const playable = queue.filter((track) => track.audioUrl !== null);
  const index = playable.findIndex((track) => track.id === song?.id);
  const previous = index > 0 ? playable[index - 1] : undefined;
  const next = playable[index + 1];

  return (
    <footer className={song === null ? 'global-player is-empty' : 'global-player'} aria-label="Audio player">
      <div className="global-player-track">
        {song === null ? <span className="player-empty-art" aria-hidden><UiIcon name="music" size={20} /></span>
          : <TrackArtwork loadEagerly song={song} size="medium" />}
        <span><strong>{song?.title ?? 'Nothing playing'}</strong>
          {song !== null && <small>{song.artist ?? 'Unknown artist'}</small>}</span>
      </div>
      <div className="global-player-controls">
        <div className="player-transport">
          <button className="player-skip" type="button" aria-label="Previous track" disabled={song === null}
            onClick={() => { if (playback.position > 3 || !previous) playback.seek(0); else playback.play(previous); }}>
            <UiIcon name="previous" />
          </button>
          <button className="global-play-button" type="button" disabled={song === null && playable.length === 0}
            aria-label={playback.playing ? 'Pause current track' : 'Play current track'}
            onClick={() => { const track = song ?? playable[0]; if (track) playback.play(track); }}>
            <UiIcon name={playback.playing ? 'pause' : 'play'} />
          </button>
          <button className="player-skip" type="button" aria-label="Next track" disabled={!next}
            onClick={() => { if (next) playback.play(next); }}><UiIcon name="next" /></button>
        </div>
        <span className="player-time">{formatPlayerTime(playback.position)}</span>
        <div className="player-waveform">
          {song === null ? <div className="empty-waveform" /> : <TrackWaveform disabled={duration <= 0 || song.audioUrl === null}
            duration={duration} onSeek={playback.seek} position={playback.position} song={song} />}
        </div>
        <span className="player-time">{formatPlayerTime(duration)}</span>
      </div>
      <div className="player-volume">
        {playback.failed && <span className="player-error" role="alert">Audio unavailable</span>}
        <button type="button" className="player-skip" onClick={onMute} aria-label={muted ? 'Unmute audio' : 'Mute audio'}>
          <UiIcon name={muted || volume === 0 ? 'muted' : 'volume'} />
        </button>
        <input type="range" min="0" max="1" step="0.01" value={muted ? 0 : volume}
          onChange={(event) => onVolume(event.currentTarget.valueAsNumber)} aria-label="Volume" />
      </div>
    </footer>
  );
};
