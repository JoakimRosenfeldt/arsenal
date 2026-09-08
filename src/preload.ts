import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { APP_UPDATE_CHANNELS, type AppUpdatesApi, type UpdateStatus } from './shared/app-updates';
import { PREFERENCES_CHANNELS, type PreferencesApi } from './shared/preferences';
import { PLAYLIST_DEBUG_CHANNEL, PLAYLIST_DEBUG_PREFIX, PLAYLIST_PROGRESS_CHANNEL, type PlaylistSuggestionProgress } from './shared/playlist-suggestions';

ipcRenderer.on(PLAYLIST_DEBUG_CHANNEL, (_event: IpcRendererEvent, message: string, details: Record<string, unknown>) => {
  console.info(message, details);
});
console.info(`${PLAYLIST_DEBUG_PREFIX} Response debugging enabled`);

import {
  DJ_LIBRARY_CHANNELS,
  type DjLibraryApi,
} from './shared/dj-library';

const api: DjLibraryApi = Object.freeze({
  status: () => ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.status),
  importRekordboxExport: () =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.importExport),
  listSongs: (page) =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.listSongs, page),
  findDuplicates: (mode) =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.findDuplicates, mode),
  listPlaylists: () =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.listPlaylists),
  listFolders: () => ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.listFolders),
  playlistMenu: () => ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.playlistMenu),
  openPlaylistWindow: (request) => ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.openPlaylistWindow, request),
  playlistWindowContext: () => ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.playlistWindowContext),
  previewSmartPlaylist: (request) => ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.previewSmartPlaylist, request),
  searchSongs: (request) =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.searchSongs, request),
  trackMenu: (request) =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.trackMenu, request),
  suggestPlaylist: (request) =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.suggestPlaylist, request),
  onSuggestionProgress: (listener) => {
    const handleProgress = (_event: IpcRendererEvent, progress: PlaylistSuggestionProgress): void => listener(progress);
    ipcRenderer.on(PLAYLIST_PROGRESS_CHANNEL, handleProgress);
    return () => { ipcRenderer.removeListener(PLAYLIST_PROGRESS_CHANNEL, handleProgress); };
  },
  cancelSuggestions: () =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.cancelSuggestions),
  mutate: (change) =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.mutate, change),
});

contextBridge.exposeInMainWorld('djLibrary', api);

const preferences: PreferencesApi = Object.freeze({
  open: () => ipcRenderer.invoke(PREFERENCES_CHANNELS.open),
});
contextBridge.exposeInMainWorld('preferences', preferences);

const updates: AppUpdatesApi = Object.freeze({
  status: () => ipcRenderer.invoke(APP_UPDATE_CHANNELS.status),
  check: () => ipcRenderer.invoke(APP_UPDATE_CHANNELS.check),
  download: () => ipcRenderer.invoke(APP_UPDATE_CHANNELS.download),
  install: () => ipcRenderer.invoke(APP_UPDATE_CHANNELS.install),
  onChange: (listener) => {
    const handleChange = (_event: IpcRendererEvent, status: UpdateStatus): void => listener(status);
    ipcRenderer.on(APP_UPDATE_CHANNELS.changed, handleChange);
    return () => { ipcRenderer.removeListener(APP_UPDATE_CHANNELS.changed, handleChange); };
  },
});

contextBridge.exposeInMainWorld('appUpdates', updates);
