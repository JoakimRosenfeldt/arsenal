import type { SongRow } from './dj-library';
import type { AiProvider } from './ai-models';

export const MAX_SEED_SONGS = 20;
export const MAX_MOOD_LENGTH = 1_000;

export type PlaylistSuggestionRequest = Readonly<{
  revision: string;
  mood: string;
  seedSongIds: readonly string[];
  excludedSongIds: readonly string[];
}>;

export type PlaylistSuggestion = Readonly<{
  song: SongRow;
  reason: string;
}>;

export type PlaylistSuggestionFailure =
  | 'unavailable'
  | 'model-missing'
  | 'timed-out'
  | 'cancelled'
  | 'invalid-response'
  | 'stale-library'
  | 'invalid-request'
  | 'unauthorized'
  | 'rate-limited'
  | 'insufficient-credit'
  | 'context-too-large'
  | 'failed';

export type PlaylistSuggestionResult =
  | Readonly<{
      kind: 'ready';
      suggestions: readonly PlaylistSuggestion[];
      candidateCount: number;
      librarySongCount: number;
      provider: AiProvider;
      model: string;
    }>
  | Readonly<{ kind: 'rejected'; reason: PlaylistSuggestionFailure }>;
