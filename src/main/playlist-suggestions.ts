import type { SongRow } from '../shared/dj-library';
import {
  MAX_MOOD_LENGTH,
  MAX_SEED_SONGS,
  type PlaylistSuggestion,
  type PlaylistSuggestionFailure,
  type PlaylistSuggestionRequest,
  type PlaylistSuggestionResult,
} from '../shared/playlist-suggestions';
import { askModel, ModelError, MODEL_OUTPUT_TOKENS, type ModelConnection } from './ai-client';
import { logPlaylistDebug } from './playlist-debug';

const MAX_CANDIDATES = 80;
const SUGGESTION_COUNT = 12;

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
  ) {
    return null;
  }
  return {
    revision: value.revision,
    mood: value.mood.trim(),
    seedSongIds: value.seedSongIds,
    excludedSongIds: value.excludedSongIds,
  };
};

class SuggestionError extends Error {
  constructor(readonly reason: PlaylistSuggestionFailure) {
    super(reason);
  }
}

const metadataFor = (song: SongRow): Record<string, string | number> =>
  Object.fromEntries(Object.entries(song).filter((entry): entry is [string, string | number] =>
    entry[0] !== 'id' && entry[0] !== 'audioUrl' && entry[0] !== 'artworkUrl' && entry[1] !== null,
  ));

const normalize = (value: string): string => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();

const shortlistSongs = async (
  songs: readonly SongRow[],
  seeds: readonly SongRow[],
  mood: string,
  signal: AbortSignal,
  connection: ModelConnection,
): Promise<readonly SongRow[]> => {
  if (songs.length <= MAX_CANDIDATES) {
    return songs;
  }

  const genreCounts = new Map<string, number>();
  for (const song of songs) {
    if (song.genre) {
      const genre = song.genre.slice(0, 40);
      genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
    }
  }
  const profile = await askModel(
    connection,
    'Translate the mood and seed tracks into a library search. Choose up to 8 matching genres from availableGenres, up to 8 useful artist names or musical keywords, and a target BPM. Use null for BPM when tempo is irrelevant. Respect explicit mood instructions over seed similarity. Do not use vague mood words as genres.',
    {
      mood,
      seeds: seeds.map(metadataFor),
      availableGenres: [...genreCounts].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([genre]) => genre),
    },
    {
      type: 'object',
      properties: {
        genres: { type: 'array', maxItems: 8, items: { type: 'string' } },
        terms: { type: 'array', maxItems: 8, items: { type: 'string' } },
        bpm: { type: ['number', 'null'], minimum: 40, maximum: 240 },
      },
      required: ['genres', 'terms', 'bpm'],
      additionalProperties: false,
    },
    signal,
  );
  if (
    !isRecord(profile) ||
    !Array.isArray(profile.genres) || !profile.genres.every((genre: unknown) => typeof genre === 'string') ||
    !Array.isArray(profile.terms) || !profile.terms.every((term: unknown) => typeof term === 'string') ||
    !(profile.bpm === null || (typeof profile.bpm === 'number' && Number.isFinite(profile.bpm) && profile.bpm >= 40 && profile.bpm <= 240))
  ) {
    logPlaylistDebug('validation failed', {
      stage: 'mood interpretation', provider: connection.provider, model: connection.model,
      expected: 'genres and terms must be string arrays; bpm must be null or a number between 40 and 240',
    });
    throw new SuggestionError('invalid-response');
  }

  const genres = profile.genres.slice(0, 8).map(normalize).filter(Boolean);
  const terms = profile.terms.slice(0, 8).map(normalize).filter(Boolean);
  const seedArtists = new Set(seeds.flatMap((song) => song.artist ? [normalize(song.artist)] : []));
  const seedGenres = new Set(seeds.flatMap((song) => song.genre ? [normalize(song.genre)] : []));
  const targetBpm = profile.bpm;
  const ranked = songs.map((song) => {
    const genre = normalize(song.genre ?? '');
    const searchable = normalize([song.title, song.artist, song.genre, song.album, song.comments, song.remixer, song.composer, song.mixName, song.label].join(' '));
    const score =
      (genres.some((match) => genre.includes(match)) ? 10 : 0) +
      terms.reduce((total, term) => total + (searchable.includes(term) ? 4 : 0), 0) +
      (seedArtists.has(normalize(song.artist ?? '')) ? 3 : 0) +
      (seedGenres.has(genre) ? 2 : 0) +
      (targetBpm !== null && song.bpm !== null ? Math.max(0, 3 - Math.abs(song.bpm - targetBpm) / 5) : 0);
    return { song, score };
  }).sort((a, b) => b.score - a.score);

  // Keep a prolific artist from filling the model's entire context.
  const artistCounts = new Map<string, number>();
  const shortlist: SongRow[] = [];
  const overflow: SongRow[] = [];
  for (const { song } of ranked) {
    const artist = normalize(song.artist ?? song.id);
    const count = artistCounts.get(artist) ?? 0;
    if (count < 5) {
      shortlist.push(song);
      artistCounts.set(artist, count + 1);
    } else {
      overflow.push(song);
    }
    if (shortlist.length === MAX_CANDIDATES) {
      break;
    }
  }
  return [...shortlist, ...overflow].slice(0, MAX_CANDIDATES);
};

export const suggestPlaylist = async (
  songs: readonly SongRow[],
  request: PlaylistSuggestionRequest,
  cancellation: AbortSignal,
  connection: ModelConnection,
): Promise<PlaylistSuggestionResult> => {
  const timeout = AbortSignal.timeout(180_000);
  const signal = AbortSignal.any([cancellation, timeout]);
  logPlaylistDebug('playlist started', { provider: connection.provider, model: connection.model, mood: request.mood, seedCount: request.seedSongIds.length, librarySongCount: songs.length });
  try {
    const byId = new Map(songs.map((song) => [song.id, song]));
    const seeds: SongRow[] = [];
    for (const id of request.seedSongIds) {
      const song = byId.get(id);
      if (song === undefined) {
        return { kind: 'rejected', reason: 'stale-library' };
      }
      seeds.push(song);
    }
    if (request.excludedSongIds.some((id) => !byId.has(id))) {
      return { kind: 'rejected', reason: 'stale-library' };
    }
    const excluded = new Set([...request.excludedSongIds, ...request.seedSongIds]);
    const shortlist = await shortlistSongs(songs.filter((song) => !excluded.has(song.id)), seeds, request.mood, signal, connection);
    let bytes = Buffer.byteLength(JSON.stringify({ mood: request.mood, seeds: seeds.map(metadataFor) }), 'utf8');
    const candidates: SongRow[] = [];
    for (const song of shortlist) {
      const size = Buffer.byteLength(JSON.stringify({ id: candidates.length, ...metadataFor(song) }), 'utf8') + 1;
      if (bytes + size <= connection.contextTokens - MODEL_OUTPUT_TOKENS[connection.provider] - 3_072) {
        candidates.push(song);
        bytes += size;
      }
    }
    if (shortlist.length > 0 && candidates.length === 0) {
      throw new SuggestionError('context-too-large');
    }
    if (candidates.length === 0) {
      return { kind: 'ready', suggestions: [], candidateCount: 0, librarySongCount: songs.length, provider: connection.provider, model: connection.model };
    }
    const answer = await askModel(
      connection,
      `You help a DJ build a playlist. Recommend up to ${SUGGESTION_COUNT} tracks from candidates that fit the mood and seed tracks. Use both when provided, with the mood taking priority. Consider BPM and half/double tempo, harmonic compatibility of musicalKey, genre, durationSeconds, year, artist, composer, remixer, mixName, album, label, comments, rating, playCount, dateAdded, cuePointCount, hotCueCount, and file quality where supplied. Prioritize musical fit. Do not treat a missing value as zero or invent audio characteristics. Return candidate numbers in playlist order, without duplicates. Give one short reason grounded in the supplied metadata for each choice. Do not claim to have listened to audio. Return fewer tracks or an empty list if none fit.`,
      { mood: request.mood, seeds: seeds.map(metadataFor), candidates: candidates.map((song, index) => ({ id: index, ...metadataFor(song) })) },
      {
        type: 'object',
        properties: {
          suggestions: {
            type: 'array', maxItems: SUGGESTION_COUNT,
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer', enum: candidates.map((_song, index) => index) },
                reason: { type: 'string' },
              },
              required: ['id', 'reason'], additionalProperties: false,
            },
          },
        },
        required: ['suggestions'], additionalProperties: false,
      },
      signal,
    );
    if (!isRecord(answer) || !Array.isArray(answer.suggestions)) {
      logPlaylistDebug('validation failed', { stage: 'track selection', expected: 'an object containing a suggestions array' });
      throw new SuggestionError('invalid-response');
    }
    const suggestions: PlaylistSuggestion[] = [];
    const seen = new Set<string>();
    for (const item of answer.suggestions) {
      if (!isRecord(item) || typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || typeof item.reason !== 'string') {
        logPlaylistDebug('validation failed', { stage: 'track selection', expected: 'each suggestion must have an integer id and a string reason' });
        throw new SuggestionError('invalid-response');
      }
      const song = candidates[item.id];
      if (song === undefined) {
        logPlaylistDebug('validation failed', { stage: 'track selection', candidateId: item.id, candidateCount: candidates.length, expected: 'an id from the supplied candidates' });
        throw new SuggestionError('invalid-response');
      }
      if (!seen.has(song.id) && suggestions.length < SUGGESTION_COUNT) {
        seen.add(song.id);
        suggestions.push({ song, reason: item.reason.trim().slice(0, 160) });
      }
    }
    logPlaylistDebug('playlist complete', { provider: connection.provider, model: connection.model, suggestionCount: suggestions.length, candidateCount: candidates.length });
    return { kind: 'ready', suggestions, candidateCount: candidates.length, librarySongCount: songs.length, provider: connection.provider, model: connection.model };
  } catch (error: unknown) {
    logPlaylistDebug('playlist failed', {
      provider: connection.provider, model: connection.model,
      reason: cancellation.aborted ? 'cancelled' : timeout.aborted ? 'timed-out' : error instanceof SuggestionError || error instanceof ModelError ? error.reason : 'failed',
    });
    return {
      kind: 'rejected',
      reason: cancellation.aborted ? 'cancelled'
        : timeout.aborted ? 'timed-out'
          : error instanceof SuggestionError || error instanceof ModelError ? error.reason : 'failed',
    };
  }
};
