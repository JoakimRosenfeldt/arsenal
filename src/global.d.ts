import type { DjLibraryApi } from './shared/dj-library';

declare global {
  interface Window {
    djLibrary: DjLibraryApi;
  }
}

export {};
