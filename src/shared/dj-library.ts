export const DJ_LIBRARY_CHANNELS = Object.freeze({
  status: 'dj-library:status',
  importExport: 'dj-library:import-export',
  listSongs: 'dj-library:list-songs',
});

export const SONG_PAGE_SIZE = 100;

export type SongRow = Readonly<{
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  genre: string | null;
  bpm: number | null;
  musicalKey: string | null;
  durationSeconds: number | null;
}>;

export type LibrarySummary = Readonly<{
  sourceName: string;
  importedAt: string;
  songCount: number;
}>;

export type LibraryStatus =
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'ready'; library: LibrarySummary }>;

export type ImportFailure =
  | 'cannot-read'
  | 'not-rekordbox-xml'
  | 'malformed-xml';

export type ImportResult =
  | Readonly<{ kind: 'imported'; library: LibrarySummary }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'rejected'; reason: ImportFailure }>;

export type PageRequest = Readonly<{
  offset: number;
  limit: number;
}>;

export type SongPage = Readonly<{
  items: readonly SongRow[];
  offset: number;
  limit: number;
  total: number;
  hasNext: boolean;
}>;

export type DjLibraryApi = Readonly<{
  status(): Promise<LibraryStatus>;
  importRekordboxExport(): Promise<ImportResult>;
  listSongs(page: PageRequest): Promise<SongPage>;
}>;
