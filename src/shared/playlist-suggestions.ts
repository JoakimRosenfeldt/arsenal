import type { SongRow } from './dj-library';

export const MAX_MOOD_LENGTH = 1_000;
export const PLAYLIST_DEBUG_CHANNEL = 'playlist-suggestions:debug';
export const PLAYLIST_DEBUG_PREFIX = '[playlist-ai]';
export const PLAYLIST_PROGRESS_CHANNEL = 'playlist-suggestions:progress';
export const JEV_MODEL = '~typesafe/jev-latest';

export type PlaylistSuggestionRequest = Readonly<{
  revision: string;
  mood: string;
  seedSongIds: readonly string[];
  excludedSongIds: readonly string[];
}>;

export type PlaylistSuggestion = Readonly<{
  song: SongRow;
  score: number;
  reason: string;
}>;

export type PlaylistSuggestionProgress =
  | Readonly<{ phase: 'scoring'; completed: number; total: number }>
  | Readonly<{ phase: 'ranking' }>;

export type PlaylistSuggestionFailure =
  | 'api-key-missing'
  | 'unauthorized'
  | 'insufficient-credit'
  | 'rate-limited'
  | 'context-too-large'
  | 'invalid-response'
  | 'service-unavailable'
  | 'request-rejected'
  | 'model-unavailable'
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
