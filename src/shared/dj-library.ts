export const DJ_LIBRARY_CHANNELS = Object.freeze({
  status: 'dj-library:status',
  importExport: 'dj-library:import-export',
  listSongs: 'dj-library:list-songs',
  findDuplicates: 'dj-library:find-duplicates',
  listPlaylists: 'dj-library:list-playlists',
  searchSongs: 'dj-library:search-songs',
  mutate: 'dj-library:mutate',
});

export const SONG_PAGE_SIZE = 100;

export const DUPLICATE_MATCH_MODES = [
  'exact',
  'versions',
  'dj-edits',
  'remixes',
] as const;

export type DuplicateMatchMode = (typeof DUPLICATE_MATCH_MODES)[number];

export type DuplicateVariantKind =
  | 'original'
  | 'alternate'
  | 'dj-edit'
  | 'remix';

export type SongRow = Readonly<{
  id: string;
  title: string;
  artist: string | null;
  composer: string | null;
  remixer: string | null;
  album: string | null;
  mixName: string | null;
  label: string | null;
  genre: string | null;
  year: number | null;
  bpm: number | null;
  musicalKey: string | null;
  durationSeconds: number | null;
  fileKind: string | null;
  fileSizeBytes: number | null;
  bitRateKbps: number | null;
  sampleRateHz: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  playCount: number | null;
  rating: number | null;
  dateAdded: string | null;
  comments: string | null;
  artworkUrl: string | null;
  audioUrl: string | null;
}>;

export type DuplicateCandidate = Readonly<{
  song: SongRow;
  variantLabel: string;
  variantKinds: readonly DuplicateVariantKind[];
}>;

export type DuplicateGroup = Readonly<{
  key: string;
  title: string;
  artist: string;
  matchReason: string;
  candidates: readonly DuplicateCandidate[];
}>;

export type DuplicateScan = Readonly<{
  mode: DuplicateMatchMode;
  groups: readonly DuplicateGroup[];
  trackCount: number;
}>;

export type LibrarySummary = Readonly<{
  revision: string;
  sourceName: string;
  importedAt: string;
  songCount: number;
  playlistCount: number;
}>;

export type RekordboxPlaylist = Readonly<{
  id: string;
  name: string;
  kind: 'regular' | 'smart';
  folderPath: readonly string[];
  tracks: readonly SongRow[];
  missingTrackCount: number;
  smartRules: SmartPlaylistStatus | null;
}>;

export type SmartPlaylistStatus = Readonly<{
  kind: 'evaluated' | 'unavailable';
  message: string;
  conditions: readonly string[];
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

export type SongSearchRequest = PageRequest & Readonly<{
  query: string;
}>;

export type LibraryMutation =
  | Readonly<{
      kind: 'remove-song';
      revision: string;
      songId: string;
      removeLocalFile: boolean;
    }>
  | Readonly<{
      kind: 'create-playlist';
      revision: string;
      name: string;
      songIds: readonly string[];
    }>;

export type LocalFileAction =
  | 'kept'
  | 'trashed'
  | 'missing'
  | 'shared'
  | 'unsupported'
  | 'failed';

export type MutationFailure =
  | 'stale-library'
  | 'source-changed'
  | 'song-not-found'
  | 'invalid-playlist'
  | 'cannot-write';

export type LibraryMutationResult =
  | Readonly<{
      kind: 'song-removed';
      library: LibrarySummary;
      fileAction: LocalFileAction;
    }>
  | Readonly<{
      kind: 'playlist-created';
      library: LibrarySummary;
    }>
  | Readonly<{
      kind: 'rejected';
      reason: MutationFailure;
    }>;

export type DjLibraryApi = Readonly<{
  status(): Promise<LibraryStatus>;
  importRekordboxExport(): Promise<ImportResult>;
  listSongs(page: PageRequest): Promise<SongPage>;
  findDuplicates(mode: DuplicateMatchMode): Promise<DuplicateScan>;
  listPlaylists(): Promise<readonly RekordboxPlaylist[]>;
  searchSongs(request: SongSearchRequest): Promise<SongPage>;
  mutate(change: LibraryMutation): Promise<LibraryMutationResult>;
}>;
