import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';

import { TrackArtwork, type PlaybackController } from './CueboxPlayer';
import type { SongRow } from './shared/dj-library';
import {
  MAX_MOOD_LENGTH,
  PLAYLIST_DEBUG_PREFIX,
  type PlaylistSuggestionFailure,
  type PlaylistSuggestionProgress,
  type PlaylistSuggestionResult,
} from './shared/playlist-suggestions';

const failureMessages: Readonly<Record<PlaylistSuggestionFailure, string>> = {
  'api-key-missing': 'Add your OpenRouter API key in Preferences to use Jev.',
  unauthorized: 'OpenRouter rejected the API key or model access. Check your key in Preferences.',
  'insufficient-credit': 'Your OpenRouter account needs more credits.',
  'rate-limited': 'OpenRouter reached its rate limit. Try again shortly.',
  'context-too-large': 'The request exceeds Jev\'s input limit. Shorten the description or use fewer starting tracks.',
  'invalid-response': 'Jev returned incomplete or invalid scores or confidence. Try again.',
  'service-unavailable': 'Could not reach Jev through OpenRouter. Check your connection and try again.',
  'request-rejected': 'OpenRouter rejected the Jev request.',
  'model-unavailable': 'Jev is unavailable through OpenRouter for this account.',
  'invalid-tempo': 'Use a tempo from 30 to 300 BPM, with the lower number first in a range.',
  'timed-out': 'Jev took too long to respond. Try again.',
  cancelled: 'Suggestions stopped.',
  'stale-library': 'The library changed. Reopen the playlist creator to use the current tracks.',
  'invalid-request': 'Describe a mood or select some tracks before requesting suggestions.',
  failed: 'Could not finish playlist suggestions. Try again.',
};

const progressMessage = (progress: PlaylistSuggestionProgress | null): string => {
  if (progress === null) return 'Preparing Jev suggestions...';
  switch (progress.phase) {
    case 'scoring': return `Jev has scored ${progress.completed} of ${progress.total} tracks...`;
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
  const [failure, setFailure] = useState<Extract<PlaylistSuggestionResult, { kind: 'rejected' }> | null>(null);
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

  useEffect(() => window.preferences.onLibraryChanged(() => {
    sequence.current += 1;
    pending.current = false;
    setGenerating(false);
    setProgress(null);
    setResult(null);
    setFailure(null);
  }), []);

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
        seedSongIds: [...chosenSongs.keys()],
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
        setFailure(response);
      }
    } catch (error: unknown) {
      console.error(`${PLAYLIST_DEBUG_PREFIX} renderer request failed`, error);
      if (requestSequence === sequence.current) {
        setFailure({ kind: 'rejected', reason: 'failed' });
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
    setFailure({ kind: 'rejected', reason: 'cancelled' });
    void window.djLibrary.cancelSuggestions().catch(() => undefined);
  };

  return (
    <section className="playlist-helper" aria-labelledby="playlist-helper-title">
      <div className="playlist-helper-heading">
        <h3 id="playlist-helper-title">Find the next tracks</h3>
        <span className="mono-label">Playlist helper</span>
      </div>
      <p>Select tracks below, describe a mood, or do both.</p>
      <p className="playlist-ai-summary">Jev · Your description and track metadata are sent through OpenRouter. Audio stays on this computer. Set up your API key in Preferences.</p>
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
      {failure !== null && <p className="playlist-search-error" role={failure.reason === 'cancelled' ? 'status' : 'alert'}>{failureMessages[failure.reason]}{failure.detail ? ` ${failure.detail}` : ''}</p>}
      {result !== null && (
        <div className="playlist-suggestions" aria-busy={generating}>
          <div className="playlist-helper-heading">
            <h4>Suggested tracks</h4>
            <span role="status">{result.suggestions.length} suggestions</span>
          </div>
          <p>Scored {result.candidateCount.toLocaleString()} library tracks with Jev. Add the ones you want.</p>
          {result.suggestions.length === 0 ? (
            <p>No matching tracks found. Try a different mood or starting tracks.</p>
          ) : (
            <ul className="playlist-suggestion-list">
              {result.suggestions.map(({ song, confidence, reason }) => {
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
                      <p className="playlist-suggestion-reason">{(confidence * 100).toFixed(0)}% confidence · {reason}</p>
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
