export const PREFERENCES_CHANNELS = Object.freeze({
  open: 'preferences:open',
  openRouter: 'preferences:openrouter',
  saveOpenRouterKey: 'preferences:save-openrouter-key',
  library: 'preferences:library',
  saveMinimumSongLength: 'preferences:save-minimum-song-length',
  libraryChanged: 'preferences:library-changed',
});

export const DEFAULT_MINIMUM_SONG_LENGTH_SECONDS = 30;
export type LibrarySettings = Readonly<{ minimumSongLengthSeconds: number }>;

export type OpenRouterSettings = Readonly<{ hasApiKey: boolean; keyStorage: 'encrypted' | 'session' }>;

export type PreferencesApi = Readonly<{
  open(): Promise<void>;
  openRouter(): Promise<OpenRouterSettings>;
  saveOpenRouterKey(apiKey: string): Promise<OpenRouterSettings>;
  library(): Promise<LibrarySettings>;
  saveMinimumSongLength(seconds: number): Promise<LibrarySettings>;
  onLibraryChanged(listener: (settings: LibrarySettings) => void): () => void;
}>;
