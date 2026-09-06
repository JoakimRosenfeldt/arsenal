import type { DjLibraryApi } from './shared/dj-library';
import type { AppUpdatesApi } from './shared/app-updates';

declare global {
  interface Window {
    djLibrary: DjLibraryApi;
    appUpdates: AppUpdatesApi;
  }
}

export {};
