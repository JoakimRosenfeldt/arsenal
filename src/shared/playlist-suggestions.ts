import type { SongRow } from './dj-library';

export const MAX_MOOD_LENGTH = 1_000;
export const PLAYLIST_DEBUG_CHANNEL = 'playlist-suggestions:debug';
export const PLAYLIST_DEBUG_PREFIX = '[playlist-ai]';
export const PLAYLIST_PROGRESS_CHANNEL = 'playlist-suggestions:progress';
export const LAYA_MODEL = 'convaiinnovations/laya';

export type PlaylistSuggestionRequest = Readonly<{
  revision: string;
  mood: string;
  seedSongIds: readonly string[];
  excludedSongIds: readonly string[];
}>;

export type PlaylistSuggestion = Readonly<{
  song: SongRow;
  score: number;
  confidence: number;
  reason: string;
}>;

export type PlaylistSuggestionProgress =
  | Readonly<{ phase: 'loading-model' }>
  | Readonly<{ phase: 'scoring'; completed: number; total: number }>
  | Readonly<{ phase: 'ranking' }>;

export type PlaylistSuggestionFailure =
  | 'context-too-large'
  | 'invalid-response'
  | 'model-unavailable'
  | 'model-failed'
  | 'invalid-tempo'
  | 'timed-out'
  | 'cancelled'
  | 'stale-library'
  | 'invalid-request'
  | 'failed';

export type PlaylistSuggestionResult =
  | Readonly<{
      kind: 'ready';
      suggestions: readonly PlaylistSuggestion[];
      candidateCount: number;
      librarySongCount: number;
      model: string;
    }>
  | Readonly<{ kind: 'rejected'; reason: PlaylistSuggestionFailure; detail?: string }>;
