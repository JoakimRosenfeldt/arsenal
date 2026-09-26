import type { DjLibraryApi } from './shared/dj-library';
import type { AppUpdatesApi } from './shared/app-updates';
import type { PreferencesApi } from './shared/preferences';
import type { LayaModelApi } from './shared/laya-model';

declare global {
  interface Window {
    djLibrary: DjLibraryApi;
    appUpdates: AppUpdatesApi;
    preferences: PreferencesApi;
    layaModel: LayaModelApi;
  }
}

export {};
