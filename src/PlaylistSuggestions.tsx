import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';

import { TrackArtwork, type PlaybackController } from './CueboxPlayer';
import type { SongRow } from './shared/dj-library';
import { PreferencesButton } from './Preferences';
import { AI_PROVIDER_LABELS, type AiSettings } from './shared/ai-models';
import {
  MAX_MOOD_LENGTH,
  MAX_SEED_SONGS,
  PLAYLIST_DEBUG_PREFIX,
  type PlaylistSuggestionFailure,
  type PlaylistSuggestionResult,
} from './shared/playlist-suggestions';

const failureMessages: Readonly<Record<PlaylistSuggestionFailure, string>> = {
  unavailable: 'The model service is not reachable. Check your connection, or start Ollama for local models.',
  'model-missing': 'Model not found. Choose an available model or download it in Preferences.',
  'timed-out': 'The model took too long. Try again with fewer starting tracks or another model.',
  cancelled: 'Suggestions cancelled.',
  'invalid-response': 'The model did not return the required song-list format. Try again or choose another model in Preferences.',
  'incomplete-response': 'The model reached its output limit before finishing the list. Try fewer starting tracks or choose another model in Preferences.',
  'empty-response': 'The model returned no final answer. Try again or choose another model in Preferences.',
  refused: 'The model declined this request. Try a different mood description or another model.',
  'stale-library': 'The library changed. Reopen the playlist creator to use the current tracks.',
  'invalid-request': 'Describe a mood or select some tracks before requesting suggestions.',
  unauthorized: 'Add a valid API key in Preferences and check that it has access to the selected model.',
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
  const [settingsFailed, setSettingsFailed] = useState(false);
  const [activeModel, setActiveModel] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<Extract<PlaylistSuggestionResult, { kind: 'ready' }> | null>(null);
  const [failure, setFailure] = useState<PlaylistSuggestionFailure | null>(null);
  const sequence = useRef(0);
  const pending = useRef(false);
  const configured = aiSettings !== null && (aiSettings.provider === 'ollama' || aiSettings.hasApiKey[aiSettings.provider]);

  useEffect(() => {
    let active = true;
    let receivedChange = false;
    const unsubscribe = window.aiModels.onChange((settings) => {
      receivedChange = true;
      setAiSettings(settings);
      setSettingsFailed(false);
    });
    void window.aiModels.settings().then((settings) => {
      if (active && !receivedChange) setAiSettings(settings);
    }).catch(() => { if (active && !receivedChange) setSettingsFailed(true); });
    return () => { active = false; unsubscribe(); };
  }, []);

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
    setActiveModel(aiSettings === null ? '' : aiSettings.models[aiSettings.provider]);
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
        ? { kind: response.kind, provider: response.provider, model: response.model, suggestionCount: response.suggestions.length }
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
      <div className="playlist-ai-summary">
        <span>{aiSettings === null ? 'Loading AI preferences...' : `${AI_PROVIDER_LABELS[aiSettings.provider]} · ${aiSettings.models[aiSettings.provider]}`}</span>
        <PreferencesButton />
      </div>
      {settingsFailed && <p role="alert">Could not load AI preferences. Reopen the playlist creator to try again.</p>}
      {aiSettings !== null && !configured && <p role="status">Add your {AI_PROVIDER_LABELS[aiSettings.provider]} API key in Preferences to get suggestions.</p>}
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
      {generating && <p className="playlist-helper-status" role="status">Finding tracks with {activeModel}. This may take a few minutes.</p>}
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
