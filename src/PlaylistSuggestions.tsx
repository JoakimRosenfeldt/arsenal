import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';

import { TrackArtwork, type PlaybackController } from './CueboxPlayer';
import type { SongRow } from './shared/dj-library';
import {
  MAX_MOOD_LENGTH,
  MAX_SEED_SONGS,
  PLAYLIST_DEBUG_PREFIX,
  type PlaylistSuggestionFailure,
  type PlaylistSuggestionProgress,
  type PlaylistSuggestionResult,
} from './shared/playlist-suggestions';

const failureMessages: Readonly<Record<PlaylistSuggestionFailure, string>> = {
  'model-unavailable': 'CLAP could not load. Connect to the internet for the first download, check free disk space, then try again.',
  'description-too-long': 'Keep the description under about 50 words. Focus on the sound, instruments and mood.',
  'no-local-audio': 'No readable local audio was found. Make sure the files are available on this computer.',
  'seed-audio-unavailable': 'A starting track could not be analyzed. Use starting tracks with readable local audio.',
  'invalid-tempo': 'Use a tempo from 30 to 300 BPM, with the lower number first in a range.',
  'timed-out': 'Audio analysis stopped responding. Try again. Completed analysis has been saved.',
  cancelled: 'Suggestions stopped. Completed analysis has been saved.',
  'stale-library': 'The library changed. Reopen the playlist creator to use the current tracks.',
  'invalid-request': 'Describe a mood or select some tracks before requesting suggestions.',
  failed: 'Audio analysis could not finish. Try again. Completed analysis has been saved.',
};

const progressMessage = (progress: PlaylistSuggestionProgress | null): string => {
  if (progress === null) return 'Preparing music analysis...';
  switch (progress.phase) {
    case 'model': return progress.percent === null ? 'Loading CLAP. The first download is about 210 MB.' : `Downloading CLAP model: ${progress.percent}%.`;
    case 'analyzing': return `Analyzing ${progress.completed + 1} of ${progress.total}: ${progress.title}`;
    case 'ranking': return 'Choosing tracks and checking tempo and key...';
  }
};

export const PlaylistSuggestions = ({
  busy,
  chosenSongs,
  onAdd,
  playback,
  revision,
}: Readonly<{
  busy: boolean;
  chosenSongs: ReadonlyMap<string, SongRow>;
  onAdd: (song: SongRow) => void;
  playback: PlaybackController;
  revision: string;
}>): JSX.Element => {
  const [mood, setMood] = useState('');
  const [progress, setProgress] = useState<PlaylistSuggestionProgress | null>(null);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<Extract<PlaylistSuggestionResult, { kind: 'ready' }> | null>(null);
  const [failure, setFailure] = useState<PlaylistSuggestionFailure | null>(null);
  const sequence = useRef(0);
  const pending = useRef(false);
  useEffect(() => window.djLibrary.onSuggestionProgress((next) => {
    if (pending.current) setProgress(next);
  }), []);

  useEffect(() => () => {
    sequence.current += 1;
    if (pending.current) {
      void window.djLibrary.cancelSuggestions().catch(() => undefined);
    }
  }, []);

  const generate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending.current || busy || (mood.trim().length === 0 && chosenSongs.size === 0)) {
      return;
    }
    const requestSequence = ++sequence.current;
    pending.current = true;
    setProgress(null);
    setResult(null);
    setGenerating(true);
    setFailure(null);
    try {
      const response = await window.djLibrary.suggestPlaylist({
        revision,
        mood,
        seedSongIds: [...chosenSongs.keys()].slice(0, MAX_SEED_SONGS),
        excludedSongIds: [...chosenSongs.keys()],
      });
      console.info(`${PLAYLIST_DEBUG_PREFIX} suggestion result`, response.kind === 'ready'
        ? { kind: response.kind, model: response.model, suggestionCount: response.suggestions.length }
        : response);
      if (requestSequence !== sequence.current) {
        return;
      }
      if (response.kind === 'ready') {
        setResult(response);
      } else {
        setFailure(response.reason);
      }
    } catch (error: unknown) {
      console.error(`${PLAYLIST_DEBUG_PREFIX} renderer request failed`, error);
      if (requestSequence === sequence.current) {
        setFailure('failed');
      }
    } finally {
      if (requestSequence === sequence.current) {
        pending.current = false;
        setGenerating(false);
      }
    }
  };

  const cancel = (): void => {
    sequence.current += 1;
    pending.current = false;
    setGenerating(false);
    setFailure('cancelled');
    void window.djLibrary.cancelSuggestions().catch(() => undefined);
  };

  return (
    <section className="playlist-helper" aria-labelledby="playlist-helper-title">
      <div className="playlist-helper-heading">
        <h3 id="playlist-helper-title">Find the next tracks</h3>
        <span className="mono-label">Playlist helper</span>
      </div>
      <p>Select tracks below, describe a mood, or do both.</p>
      <p className="playlist-ai-summary">CLAP · Local audio matching. First use downloads about 210 MB and analyzes your tracks.</p>
      <form onSubmit={(event) => void generate(event)}>
        <label className="playlist-mood-field" htmlFor="playlist-mood">Describe the mood</label>
        <textarea
          id="playlist-mood"
          value={mood}
          onChange={(event) => setMood(event.currentTarget.value)}
          maxLength={MAX_MOOD_LENGTH}
          rows={3}
          disabled={busy || generating}
          placeholder="Warm, laid-back house for a sunset set. Keep it around 115 BPM."
        />
        <div className="playlist-helper-actions">
          <span>
            {chosenSongs.size === 0 ? 'Mood only, or select starting tracks below'
              : chosenSongs.size > MAX_SEED_SONGS ? `Using your first ${MAX_SEED_SONGS} selected tracks as a starting point`
                : `Using ${chosenSongs.size} selected ${chosenSongs.size === 1 ? 'track' : 'tracks'} as a starting point`}
          </span>
          {generating ? (
            <button className="quiet-button" type="button" onClick={cancel}>Stop</button>
          ) : (
            <button className="accent-button compact" type="submit" disabled={busy || (mood.trim().length === 0 && chosenSongs.size === 0)}>
              {result === null ? 'Suggest tracks' : 'Suggest again'}
            </button>
          )}
        </div>
      </form>
      {generating && <p className="playlist-helper-status" role="status">{progressMessage(progress)}</p>}
      {failure !== null && <p className="playlist-search-error" role={failure === 'cancelled' ? 'status' : 'alert'}>{failureMessages[failure]}</p>}
      {result !== null && (
        <div className="playlist-suggestions" aria-busy={generating}>
          <div className="playlist-helper-heading">
            <h4>Suggested tracks</h4>
            <span role="status">{result.suggestions.length} suggestions</span>
          </div>
          <p>Matched {result.candidateCount.toLocaleString()} local tracks. Reused analysis for {result.cachedCount.toLocaleString()} tracks. Add the ones you want.</p>
          {result.skippedCount > 0 && <p>{result.skippedCount.toLocaleString()} tracks skipped because local audio was unavailable or could not be analyzed.</p>}
          {result.suggestions.length === 0 ? (
            <p>No matching tracks found. Try a different mood or starting tracks.</p>
          ) : (
            <ul className="playlist-suggestion-list">
              {result.suggestions.map(({ song, reason }) => {
                const added = chosenSongs.has(song.id);
                const isPlaying = playback.song?.id === song.id && playback.playing;
                return (
                  <li className="playlist-suggestion" key={song.id}>
                    <button
                      className={isPlaying ? 'track-play is-playing' : 'track-play'}
                      type="button"
                      onClick={() => playback.play(song)}
                      disabled={song.audioUrl === null}
                      aria-label={isPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
                    >
                      <TrackArtwork song={song} />
                      <span aria-hidden>{isPlaying ? 'Ⅱ' : '▶'}</span>
                    </button>
                    <div className="track-identity">
                      <strong>{song.title}</strong>
                      <small>{song.artist ?? 'Unknown artist'}{song.bpm === null ? '' : ` · ${song.bpm} BPM`}{song.musicalKey === null ? '' : ` · ${song.musicalKey}`}</small>
                      <p className="playlist-suggestion-reason">{reason}</p>
                    </div>
                    <button className="quiet-button" type="button" onClick={() => onAdd(song)} disabled={busy || added} aria-label={added ? `${song.title} added to playlist` : `Add ${song.title} to playlist`}>
                      {added ? 'Added' : 'Add to playlist'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};
