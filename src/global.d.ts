import type { DjLibraryApi } from './shared/dj-library';
import type { AppUpdatesApi } from './shared/app-updates';
import type { AiModelsApi } from './shared/ai-models';
import type { PreferencesApi } from './shared/preferences';

declare global {
  interface Window {
    djLibrary: DjLibraryApi;
    appUpdates: AppUpdatesApi;
    aiModels: AiModelsApi;
    preferences: PreferencesApi;
  }
}

export {};
