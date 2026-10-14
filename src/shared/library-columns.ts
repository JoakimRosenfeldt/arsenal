import { SONG_SOURCE_LABELS, type SongRow } from './dj-library';

export const LIBRARY_COLUMNS = [
  { key: 'title', label: 'Track', width: 220 },
  { key: 'bpm', label: 'BPM', width: 64 },
  { key: 'key', label: 'KEY', width: 60 },
  { key: 'time', label: 'Time', width: 66 },
  { key: 'genre', label: 'Genre', width: 130 },
  { key: 'album', label: 'Album', width: 146 },
  { key: 'artist', label: 'Artist', width: 150 },
  { key: 'label', label: 'Label', width: 130 },
  { key: 'year', label: 'Year', width: 56 },
  { key: 'rating', label: 'Rating', width: 84 },
  { key: 'plays', label: 'Plays', width: 52 },
  { key: 'dateAdded', label: 'Date added', width: 92 },
  { key: 'cues', label: 'Cues', width: 110 },
  { key: 'source', label: 'Source', width: 110 },
] as const;

export type LibraryColumnKey = (typeof LIBRARY_COLUMNS)[number]['key'];
export type LibraryColumn = (typeof LIBRARY_COLUMNS)[number];

export type LibraryColumnLayout = Readonly<{
  order: readonly LibraryColumnKey[];
  visible: readonly LibraryColumnKey[];
}>;

export type SongSortEntry = Readonly<{
  column: LibraryColumnKey;
  direction: 'asc' | 'desc';
}>;
export type SongSort = readonly SongSortEntry[];

export const MAX_SONG_SORT_COLUMNS = 2;

const columnKeys = LIBRARY_COLUMNS.map((column) => column.key);
const isColumnKey = (value: unknown): value is LibraryColumnKey =>
  typeof value === 'string' && (columnKeys as readonly string[]).includes(value);

export const DEFAULT_LIBRARY_COLUMN_LAYOUT: LibraryColumnLayout = Object.freeze({
  order: columnKeys,
  visible: ['title', 'bpm', 'key', 'time', 'genre', 'album'],
});

export const parseLibraryColumnLayout = (value: unknown): LibraryColumnLayout => {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const readKeys = (candidate: unknown): LibraryColumnKey[] => {
    const keys: LibraryColumnKey[] = [];
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (isColumnKey(entry) && !keys.includes(entry)) keys.push(entry);
      }
    }
    return keys;
  };
  const order = readKeys(record.order);
  for (const key of columnKeys) if (!order.includes(key)) order.push(key);
  const visible = readKeys(record.visible);
  if (!visible.includes('title')) visible.unshift('title');
  return { order, visible };
};

export const parseSongSort = (value: unknown): SongSort | null => {
  if (!Array.isArray(value) || value.length > MAX_SONG_SORT_COLUMNS) return null;
  const sort: SongSortEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { column, direction } = entry as Record<string, unknown>;
    if (!isColumnKey(column) || (direction !== 'asc' && direction !== 'desc')) return null;
    if (sort.some((existing) => existing.column === column)) return null;
    sort.push({ column, direction });
  }
  return sort;
};

export const toggleSongSort = (sort: SongSort, column: LibraryColumnKey, secondary: boolean): SongSort => {
  const existing = sort.find((entry) => entry.column === column);
  const cycle = (entry: SongSortEntry): SongSort =>
    entry.direction === 'asc'
      ? sort.map((candidate) => candidate.column === column ? { column, direction: 'desc' as const } : candidate)
      : sort.filter((candidate) => candidate.column !== column);
  if (!secondary) {
    if (existing && sort[0]?.column === column) return cycle(existing);
    return [{ column, direction: 'asc' }];
  }
  if (existing) return cycle(existing);
  if (sort.length === 0) return [{ column, direction: 'asc' }];
  return [sort[0] as SongSortEntry, { column, direction: 'asc' }];
};

export const ratingStars = (rating: number | null): number | null => {
  if (rating === null || !Number.isFinite(rating) || rating <= 0) return null;
  return Math.min(5, Math.max(1, Math.round(rating > 5 ? rating / 51 : rating)));
};

const songSortValue = (song: SongRow, column: LibraryColumnKey): string | number | null => {
  switch (column) {
    case 'title': return song.title;
    case 'artist': return song.artist;
    case 'bpm': return song.bpm;
    case 'key': return song.musicalKey;
    case 'time': return song.durationSeconds;
    case 'genre': return song.genre;
    case 'album': return song.album;
    case 'label': return song.label;
    case 'year': return song.year;
    case 'rating': return ratingStars(song.rating);
    case 'plays': return song.playCount;
    case 'dateAdded': return song.dateAdded;
    case 'cues': return song.cuePointCount;
    case 'source': return SONG_SOURCE_LABELS[song.source];
  }
};

const compareValues = (left: string | number, right: string | number): number =>
  typeof left === 'number' && typeof right === 'number'
    ? left - right
    : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });

export const sortSongs = (songs: readonly SongRow[], sort: SongSort): SongRow[] => {
  if (sort.length === 0) return [...songs];
  return songs
    .map((song, index) => ({ song, index }))
    .sort((left, right) => {
      for (const entry of sort) {
        const a = songSortValue(left.song, entry.column);
        const b = songSortValue(right.song, entry.column);
        if (a === null && b === null) continue;
        if (a === null) return 1;
        if (b === null) return -1;
        const compared = compareValues(a, b);
        if (compared !== 0) return entry.direction === 'asc' ? compared : -compared;
      }
      return left.index - right.index;
    })
    .map(({ song }) => song);
};

export const LIBRARY_COLUMN_SETTINGS_KEY = 'arsenal.libraryColumns';

export type LibraryColumnSettings = Readonly<{ layout: LibraryColumnLayout; sort: SongSort }>;

export const loadLibraryColumnSettings = (): LibraryColumnSettings => {
  const fallback: LibraryColumnSettings = { layout: DEFAULT_LIBRARY_COLUMN_LAYOUT, sort: [] };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(LIBRARY_COLUMN_SETTINGS_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const record = parsed as Record<string, unknown>;
    return {
      layout: parseLibraryColumnLayout(record.layout),
      sort: parseSongSort(record.sort) ?? [],
    };
  } catch {
    return fallback;
  }
};

export const saveLibraryColumnSettings = (settings: LibraryColumnSettings): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LIBRARY_COLUMN_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Column settings are a convenience; a full or blocked store keeps defaults in memory.
  }
};
