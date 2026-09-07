import type { DjLibraryApi } from './shared/dj-library';
import type { AppUpdatesApi } from './shared/app-updates';
import type { AiModelsApi } from './shared/ai-models';

declare global {
  interface Window {
    djLibrary: DjLibraryApi;
    appUpdates: AppUpdatesApi;
    aiModels: AiModelsApi;
  }
}

export {};
