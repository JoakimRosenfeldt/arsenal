export const PREFERENCES_CHANNELS = Object.freeze({
  open: 'preferences:open',
  library: 'preferences:library',
  saveMinimumSongLength: 'preferences:save-minimum-song-length',
  libraryChanged: 'preferences:library-changed',
});

export const DEFAULT_MINIMUM_SONG_LENGTH_SECONDS = 30;
export type LibrarySettings = Readonly<{ minimumSongLengthSeconds: number }>;

export type PreferencesApi = Readonly<{
  open(): Promise<void>;
  library(): Promise<LibrarySettings>;
  saveMinimumSongLength(seconds: number): Promise<LibrarySettings>;
  onLibraryChanged(listener: (settings: LibrarySettings) => void): () => void;
}>;
