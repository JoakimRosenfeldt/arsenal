import type { DjLibraryApi } from './shared/dj-library';
import type { AppUpdatesApi } from './shared/app-updates';
import type { PreferencesApi } from './shared/preferences';

declare global {
  interface Window {
    djLibrary: DjLibraryApi;
    appUpdates: AppUpdatesApi;
    preferences: PreferencesApi;
  }
}

export {};
