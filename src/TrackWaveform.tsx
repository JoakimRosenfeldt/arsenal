import { useEffect, useState, type JSX } from 'react';

import type { SongRow } from './shared/dj-library';

const cache = new Map<string, readonly number[]>();
let decoding = Promise.resolve();

const readWaveform = (url: string, signal: AbortSignal): Promise<readonly number[]> => {
  const task = decoding.then(async () => {
    signal.throwIfAborted();
    const cached = cache.get(url);
    if (cached !== undefined) {
      return cached;
    }

    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error('Audio unavailable');
    }
    const bytes = await response.arrayBuffer();
    signal.throwIfAborted();
    const context = new OfflineAudioContext(1, 1, 11025);
    const audio = await context.decodeAudioData(bytes);
    signal.throwIfAborted();

    const bars = Array.from({ length: 72 }, (_, index) => {
      const start = Math.floor(index * audio.length / 72);
      const end = Math.floor((index + 1) * audio.length / 72);
      let energy = 0;
      for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
        const samples = audio.getChannelData(channel);
        for (let sample = start; sample < end; sample += 1) {
          const amplitude = samples[sample] ?? 0;
          energy += amplitude * amplitude;
        }
      }
      return Math.sqrt(energy / Math.max(1, (end - start) * audio.numberOfChannels));
    });
    const maximum = Math.max(...bars);
    const heights = bars.map((bar) => maximum === 0 ? 0 : bar / maximum * 100);
    cache.set(url, heights);
    if (cache.size > 32) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    return heights;
  });
  // Audio decoding cannot be aborted. Keep only one decoder active at a time.
  decoding = task.then(() => undefined, () => undefined);
  return task;
};

type WaveformState =
  | Readonly<{ kind: 'ready'; url: string; bars: readonly number[] }>
  | Readonly<{ kind: 'failed'; url: string }>;

export const TrackWaveform = ({
  disabled,
  duration,
  onSeek,
  position,
  song,
}: Readonly<{
  disabled: boolean;
  duration: number;
  onSeek: (seconds: number) => void;
  position: number;
  song: SongRow;
}>): JSX.Element => {
  const [state, setState] = useState<WaveformState | null>(null);
  const url = song.audioUrl;

  useEffect(() => {
    if (url === null) {
      return;
    }
    const controller = new AbortController();
    void readWaveform(url, controller.signal).then(
      (bars) => {
        if (!controller.signal.aborted) {
          setState({ kind: 'ready', url, bars });
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setState({ kind: 'failed', url });
        }
      },
    );
    return () => controller.abort();
  }, [url]);

  const bars = state?.url === url && state.kind === 'ready' ? state.bars : null;
  const failed = url === null || (state?.url === url && state.kind === 'failed');
  const progress = duration <= 0 ? 0 : position / duration;

  return (
    <div className="interactive-waveform">
      {bars === null ? (
        <p className="waveform-status" role="status">
          {failed ? 'Waveform unavailable' : 'Loading waveform…'}
        </p>
      ) : (
        <div className="track-profile-bars" role="img" aria-label={`Audio waveform of ${song.title}`}>
          {bars.map((height, index) => (
            <span
              className={index / bars.length < progress ? 'is-accent' : ''}
              style={{ height: `${height}%` }}
              key={index}
            />
          ))}
        </div>
      )}
      {bars !== null && <span className="waveform-playhead" style={{ left: `${Math.max(0, Math.min(1, progress)) * 100}%` }} aria-hidden />}
      <input
        type="range"
        min="0"
        max={Math.max(duration, 1)}
        step="0.1"
        value={Math.min(position, Math.max(duration, 1))}
        onChange={(event) => onSeek(event.currentTarget.valueAsNumber)}
        disabled={disabled}
        aria-label={`Seek in ${song.title}`}
      />
    </div>
  );
};
