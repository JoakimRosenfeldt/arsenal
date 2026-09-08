import type { PlaylistSuggestionProgress, PlaylistSuggestionRequest, PlaylistSuggestionResult } from './playlist-suggestions';
import type { SmartPlaylistDefinition } from './smart-playlists';

export const DJ_LIBRARY_CHANNELS = Object.freeze({
  status: 'dj-library:status',
  importExport: 'dj-library:import-export',
  listSongs: 'dj-library:list-songs',
  findDuplicates: 'dj-library:find-duplicates',
  listPlaylists: 'dj-library:list-playlists',
  listFolders: 'dj-library:list-folders',
  playlistMenu: 'dj-library:playlist-menu',
  openPlaylistWindow: 'dj-library:open-playlist-window',
  playlistWindowContext: 'dj-library:playlist-window-context',
  previewSmartPlaylist: 'dj-library:preview-smart-playlist',
  searchSongs: 'dj-library:search-songs',
  trackMenu: 'dj-library:track-menu',
  suggestPlaylist: 'dj-library:suggest-playlist',
  cancelSuggestions: 'dj-library:cancel-suggestions',
  mutate: 'dj-library:mutate',
});

export const SONG_PAGE_SIZE = 100;

export const DUPLICATE_MATCH_MODES = [
  'smart',
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

export const SONG_SOURCE_LABELS = Object.freeze({
  local: 'Local file',
  tidal: 'TIDAL',
  beatport: 'Beatport',
  beatsource: 'Beatsource',
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
  'apple-music': 'Apple Music',
  streaming: 'Streaming',
  unknown: 'Unknown source',
});

export type SongSource = keyof typeof SONG_SOURCE_LABELS;

export const SONG_METADATA_FILTERS = Object.freeze({
  all: 'All metadata',
  incomplete: 'Missing metadata',
  complete: 'Complete metadata',
  'no-cues': 'No cue points',
});

export type SongFilters = Readonly<{
  source: SongSource | 'all';
  metadata: keyof typeof SONG_METADATA_FILTERS;
}>;

export const DEFAULT_SONG_FILTERS: SongFilters = Object.freeze({ source: 'all', metadata: 'all' });

export const songMetadataGapCount = (song: SongRow): number =>
  [song.artist, song.album, song.genre, song.bpm, song.musicalKey, song.durationSeconds]
    .filter((value) => value === null || value === '').length;

export type TrackMenuRequest = Readonly<{
  count: number;
  playable: boolean;
  playing: boolean;
}>;

export type TrackMenuAction = 'play' | 'inspect' | 'create-playlist' | 'remove-songs' | 'clear-selection';

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
  source: SongSource;
  cuePointCount: number;
  hotCueCount: number;
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
  recommendedKeepSongId: string | null;
}>;

export type DuplicateScan = Readonly<{
  mode: DuplicateMatchMode;
  groups: readonly DuplicateGroup[];
  ignoredGroupCount: number;
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
  order: number;
  name: string;
  kind: 'regular' | 'smart';
  folderPath: readonly string[];
  parentFolderId: string | null;
  tracks: readonly SongRow[];
  missingTrackCount: number;
  smartRules: SmartPlaylistStatus | null;
  smartDefinition: SmartPlaylistDefinition | null;
}>;

export type PlaylistFolder = Readonly<{
  id: string;
  order: number;
  name: string;
  parentFolderId: string | null;
  folderPath: readonly string[];
}>;

export type PlaylistCreationKind = 'playlist' | 'folder' | 'smart-playlist';
export type PlaylistWindowRequest = Readonly<{ revision: string; parentFolderId: string | null }> & (
  | Readonly<{ kind: 'playlist'; songIds: readonly string[] }>
  | Readonly<{ kind: 'folder' | 'smart-playlist' }>
  | Readonly<{ kind: 'edit-smart-playlist'; playlistId: string }>
);
export type PlaylistWindowContext = Readonly<{
  request: PlaylistWindowRequest;
  initialSongs: readonly SongRow[];
}>;
export type SmartPlaylistPreview = Readonly<{ tracks: readonly SongRow[]; matchingCount: number; total: number }>;

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
  filters?: SongFilters;
}>;

export type LibraryMutation =
  | Readonly<{
      kind: 'ignore-duplicate-group';
      revision: string;
      mode: DuplicateMatchMode;
      groupKey: string;
    }>
  | Readonly<{
      kind: 'remove-songs';
      revision: string;
      songIds: readonly string[];
      removeLocalFile: boolean;
    }>
  | Readonly<{
      kind: 'create-playlist';
      revision: string;
      name: string;
      songIds: readonly string[];
      parentFolderId: string | null;
    }>
  | Readonly<{
      kind: 'create-folder';
      revision: string;
      name: string;
      parentFolderId: string | null;
    }>
  | Readonly<{
      kind: 'save-smart-playlist';
      revision: string;
      name: string;
      parentFolderId: string | null;
      playlistId: string | null;
      definition: SmartPlaylistDefinition;
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
  | 'duplicate-not-found'
  | 'cannot-save-preferences'
  | 'invalid-playlist'
  | 'name-conflict'
  | 'folder-not-found'
  | 'cannot-write';

export type LibraryMutationResult =
  | Readonly<{
      kind: 'duplicate-ignored';
      library: LibrarySummary;
      scan: DuplicateScan;
    }>
  | Readonly<{
      kind: 'songs-removed';
      library: LibrarySummary;
      removedCount: number;
      fileActions: readonly LocalFileAction[];
    }>
  | Readonly<{
      kind: 'playlist-created';
      library: LibrarySummary;
      playlistId: string;
    }>
  | Readonly<{
      kind: 'folder-created';
      library: LibrarySummary;
    }>
  | Readonly<{
      kind: 'smart-playlist-saved';
      library: LibrarySummary;
      playlistId: string;
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
  listFolders(): Promise<readonly PlaylistFolder[]>;
  playlistMenu(): Promise<PlaylistCreationKind | null>;
  openPlaylistWindow(request: PlaylistWindowRequest): Promise<LibraryMutationResult | null>;
  playlistWindowContext(): Promise<PlaylistWindowContext>;
  previewSmartPlaylist(request: Readonly<{ revision: string; definition: SmartPlaylistDefinition }>): Promise<SmartPlaylistPreview>;
  searchSongs(request: SongSearchRequest): Promise<SongPage>;
  trackMenu(request: TrackMenuRequest): Promise<TrackMenuAction | null>;
  suggestPlaylist(request: PlaylistSuggestionRequest): Promise<PlaylistSuggestionResult>;
  onSuggestionProgress(listener: (progress: PlaylistSuggestionProgress) => void): () => void;
  cancelSuggestions(): Promise<void>;
  mutate(change: LibraryMutation): Promise<LibraryMutationResult>;
}>;
