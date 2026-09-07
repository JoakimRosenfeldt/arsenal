import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';

import { TrackArtwork, type PlaybackController } from './CueboxPlayer';
import type { SongRow } from './shared/dj-library';
import { AiModelPicker } from './AiModelPicker';
import { AI_PROVIDER_LABELS, type AiSettings } from './shared/ai-models';
import {
  MAX_MOOD_LENGTH,
  MAX_SEED_SONGS,
  type PlaylistSuggestionFailure,
  type PlaylistSuggestionResult,
} from './shared/playlist-suggestions';

const failureMessages: Readonly<Record<PlaylistSuggestionFailure, string>> = {
  unavailable: 'The model service is not reachable. Check your connection, or start Ollama for local models.',
  'model-missing': 'Model not found. Choose an available model or download it in model settings.',
  'timed-out': 'The model took too long. Try again with fewer starting tracks or another model.',
  cancelled: 'Suggestions cancelled.',
  'invalid-response': 'The model returned an unreadable suggestion list. Try again.',
  'stale-library': 'The library changed. Reopen the playlist creator to use the current tracks.',
  'invalid-request': 'Describe a mood or select some tracks before requesting suggestions.',
  unauthorized: 'Add a valid API key in model settings and check that it has access to the selected model.',
  'rate-limited': 'The provider quota or rate limit was reached. Check your account or try again later.',
  'insufficient-credit': 'The provider account needs more credits.',
  'context-too-large': 'The song metadata exceeds this model\'s context. Use fewer starting tracks or a model with a larger context.',
  failed: 'The model could not generate suggestions. Check the model service or try another model.',
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
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<Extract<PlaylistSuggestionResult, { kind: 'ready' }> | null>(null);
  const [failure, setFailure] = useState<PlaylistSuggestionFailure | null>(null);
  const sequence = useRef(0);
  const pending = useRef(false);
  const configured = aiSettings !== null && (aiSettings.provider === 'ollama' || aiSettings.hasApiKey[aiSettings.provider]);

  useEffect(() => () => {
    sequence.current += 1;
    if (pending.current) {
      void window.djLibrary.cancelSuggestions().catch(() => undefined);
    }
  }, []);

  const generate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending.current || busy || !configured || (mood.trim().length === 0 && chosenSongs.size === 0)) {
      return;
    }
    const requestSequence = ++sequence.current;
    pending.current = true;
    setGenerating(true);
    setFailure(null);
    try {
      const response = await window.djLibrary.suggestPlaylist({
        revision,
        mood,
        seedSongIds: [...chosenSongs.keys()].slice(0, MAX_SEED_SONGS),
        excludedSongIds: [...chosenSongs.keys()],
      });
      if (requestSequence !== sequence.current) {
        return;
      }
      if (response.kind === 'ready') {
        setResult(response);
      } else {
        setFailure(response.reason);
      }
    } catch {
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
      <p>Select tracks below, describe a mood, or do both. Suggestions use your library's metadata.</p>
      <AiModelPicker disabled={busy || generating} onChange={setAiSettings} />
      <details className="ai-context-details">
        <summary>Song information sent to the model</summary>
        <p>Every available metadata field is included for each starting track and candidate: title, artist, BPM, musical key, duration, genre, album, mix, remixer, composer, label, year, comments, rating, play count, date added, track and disc numbers, cue counts, source, and file quality.</p>
        <p>Complete song records are fitted into the model's context. Missing values stay unknown. Audio, artwork, and local file paths are excluded.</p>
      </details>
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
            <button className="accent-button compact" type="submit" disabled={busy || !configured || (mood.trim().length === 0 && chosenSongs.size === 0)}>
              {result === null ? 'Suggest tracks' : 'Suggest again'}
            </button>
          )}
        </div>
      </form>
      {generating && <p className="playlist-helper-status" role="status">Finding tracks with {aiSettings === null ? 'the selected model' : aiSettings.models[aiSettings.provider]}. This may take a few minutes.</p>}
      {failure !== null && <p className="playlist-search-error" role={failure === 'cancelled' ? 'status' : 'alert'}>{failureMessages[failure]}</p>}
      {result !== null && (
        <div className="playlist-suggestions" aria-busy={generating}>
          <div className="playlist-helper-heading">
            <h4>Suggested tracks</h4>
            <span role="status">{result.suggestions.length} suggestions</span>
          </div>
          <p>{AI_PROVIDER_LABELS[result.provider]} · {result.model}. Reviewed {result.candidateCount} candidates from {result.librarySongCount.toLocaleString()} library tracks. Add the ones you want.</p>
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
