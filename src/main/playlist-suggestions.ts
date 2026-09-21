import { MAX_MOOD_LENGTH, MAX_SEED_SONGS, type PlaylistSuggestionRequest } from '../shared/playlist-suggestions';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isSongIds = (value: unknown, limit: number): value is string[] =>
  Array.isArray(value) && value.length <= limit &&
  value.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 200) &&
  new Set(value).size === value.length;

export const readPlaylistSuggestionRequest = (value: unknown): PlaylistSuggestionRequest | null => {
  if (
    !isRecord(value) ||
    typeof value.revision !== 'string' || value.revision.length === 0 ||
    typeof value.mood !== 'string' || value.mood.length > MAX_MOOD_LENGTH ||
    !isSongIds(value.seedSongIds, MAX_SEED_SONGS) ||
    !isSongIds(value.excludedSongIds, 10_000) ||
    (value.mood.trim().length === 0 && value.seedSongIds.length === 0)
  ) return null;
  return {
    revision: value.revision,
    mood: value.mood.trim(),
    seedSongIds: value.seedSongIds,
    excludedSongIds: value.excludedSongIds,
  };
};
