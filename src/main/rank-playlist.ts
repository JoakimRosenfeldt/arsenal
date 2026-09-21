import type { SongRow } from '../shared/dj-library';
import type { PlaylistSuggestion } from '../shared/playlist-suggestions';

export type EmbeddedTrack = Readonly<{ song: SongRow; embedding: readonly number[] }>;
export type TempoRange = Readonly<{ min: number; max: number; minExclusive?: boolean; maxExclusive?: boolean }>;

export const normalizeEmbedding = (values: readonly number[]): number[] => {
  const length = Math.hypot(...values);
  if (!Number.isFinite(length) || length === 0) throw new Error('Invalid audio embedding');
  return values.map((value) => value / length);
};

const similarity = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((total, value, index) => total + value * (b[index] ?? 0), 0);

export const tempoFromMood = (mood: string): TempoRange | null => {
  const range = /\b(?:between\s+)?(\d{2,3}(?:\.\d+)?)\s*(?:-|–|to|and)\s*(\d{2,3}(?:\.\d+)?)\s*bpm\b/i.exec(mood);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const limit = /\b(under|below|over|above|at least|at most)\s+(\d{2,3}(?:\.\d+)?)\s*bpm\b/i.exec(mood);
  if (limit) {
    const bpm = Number(limit[2]);
    const operator = (limit[1] ?? '').toLowerCase();
    return /^(over|above|at least)$/.test(operator)
      ? { min: bpm, max: 300, minExclusive: operator !== 'at least' }
      : { min: 30, max: bpm, maxExclusive: operator !== 'at most' };
  }
  const target = /\b(\d{2,3}(?:\.\d+)?)\s*bpm\b/i.exec(mood);
  if (target) {
    const bpm = Number(target[1]);
    return bpm < 30 || bpm > 300 ? { min: bpm, max: bpm } : { min: Math.max(30, bpm - 3), max: Math.min(300, bpm + 3) };
  }
  return null;
};

export const matchesTempo = (song: SongRow, tempo: TempoRange | null): boolean =>
  tempo === null || (song.bpm !== null &&
    (tempo.minExclusive ? song.bpm > tempo.min : song.bpm >= tempo.min) &&
    (tempo.maxExclusive ? song.bpm < tempo.max : song.bpm <= tempo.max));

const normalize = (value: string): string => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();

const camelotKey = (value: string | null): string | null => {
  if (!value) return null;
  const key = value.trim().toLowerCase().replace(/♯/g, '#').replace(/♭/g, 'b').replace(/\s+/g, '');
  if (/^(?:[1-9]|1[0-2])[ab]$/.test(key)) return key;
  const keys: Readonly<Record<string, string>> = {
    abm: '1a', 'g#m': '1a', ebm: '2a', 'd#m': '2a', bbm: '3a', 'a#m': '3a', fm: '4a',
    cm: '5a', gm: '6a', dm: '7a', am: '8a', em: '9a', bm: '10a', 'f#m': '11a', gbm: '11a',
    'c#m': '12a', dbm: '12a', b: '1b', 'f#': '2b', gb: '2b', db: '3b', 'c#': '3b', ab: '4b',
    'g#': '4b', eb: '5b', 'd#': '5b', bb: '6b', 'a#': '6b', f: '7b', c: '8b', g: '9b', d: '10b', a: '11b', e: '12b',
  };
  return keys[key.replace(/minor$/, 'm').replace(/major$/, '').replace(/min$/, 'm').replace(/maj$/, '')] ?? null;
};

const harmonicMatch = (a: SongRow, b: SongRow): boolean => {
  const left = camelotKey(a.musicalKey);
  const right = camelotKey(b.musicalKey);
  if (!left || !right) return false;
  const distance = Math.abs(parseInt(left, 10) - parseInt(right, 10));
  return distance === 0 || (left.slice(-1) === right.slice(-1) && (distance === 1 || distance === 11));
};

const tempoDistance = (a: number | null, b: number | null): number =>
  a === null || b === null ? Infinity : Math.min(...[0.5, 1, 2].map((factor) => Math.abs(a * factor - b)));

export const rankPlaylist = ({
  tracks, seeds, textEmbedding, excludedIds, tempo,
}: Readonly<{
  tracks: readonly EmbeddedTrack[];
  seeds: readonly EmbeddedTrack[];
  textEmbedding: readonly number[] | null;
  excludedIds: ReadonlySet<string>;
  tempo: TempoRange | null;
}>): PlaylistSuggestion[] => {
  const seedEmbedding = seeds.length === 0 ? null : normalizeEmbedding(
    seeds[0]?.embedding.map((_, i) => seeds.reduce((sum, track) => sum + (track.embedding[i] ?? 0), 0) / seeds.length) ?? [],
  );
  const candidates = tracks.filter(({ song }) => !excludedIds.has(song.id) && matchesTempo(song, tempo)).map((track) => {
    const textScore = textEmbedding === null ? 0 : similarity(track.embedding, textEmbedding);
    const seedScore = seedEmbedding === null ? 0 : similarity(track.embedding, seedEmbedding);
    const score = textEmbedding !== null && seedEmbedding !== null ? 0.8 * textScore + 0.2 * seedScore
      : textEmbedding !== null ? textScore : seedScore;
    return { song: track.song, score };
  });
  return orderPlaylist(candidates, seeds.at(-1)?.song, tempo,
    textEmbedding === null ? 'Similar sound to your starting tracks' : 'Sound closest to your description');
};

export const orderPlaylist = (
  tracks: readonly Readonly<{ song: SongRow; score: number }>[],
  previous: SongRow | undefined,
  tempo: TempoRange | null,
  reason: string,
): PlaylistSuggestion[] => {
  const candidates = [...tracks];
  const selected: PlaylistSuggestion[] = [];
  const artistCounts = new Map<string, number>();
  while (selected.length < 12 && candidates.length > 0) {
    const ranked = candidates.map((track, index) => {
      const artist = normalize(track.song.artist ?? track.song.id);
      const artistCount = artistCounts.get(artist) ?? 0;
      const bpmDistance = previous ? tempoDistance(track.song.bpm, previous.bpm) : Infinity;
      const compatibleKey = previous ? harmonicMatch(track.song, previous) : false;
      return {
        track, index, artist, artistCount, bpmDistance, compatibleKey,
        score: track.score + Math.max(0, 1 - bpmDistance / 10) * 0.025 + (compatibleKey ? 0.015 : 0) - artistCount * 0.06,
      };
    }).filter((item) => item.artistCount < 2).sort((a, b) => b.score - a.score || a.track.song.id.localeCompare(b.track.song.id));
    const best = ranked[0];
    if (!best) break;
    const reasons = [reason];
    if (tempo !== null && best.track.song.bpm !== null) reasons.push(`${best.track.song.bpm} BPM`);
    else if (best.bpmDistance <= 3) reasons.push('close tempo');
    if (best.compatibleKey) reasons.push('compatible key');
    selected.push({ song: best.track.song, reason: `${reasons.join(' · ')}.` });
    artistCounts.set(best.artist, best.artistCount + 1);
    previous = best.track.song;
    candidates.splice(best.index, 1);
  }
  return selected;
};
