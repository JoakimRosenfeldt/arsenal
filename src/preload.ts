import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { APP_UPDATE_CHANNELS, type AppUpdatesApi, type UpdateStatus } from './shared/app-updates';
import { AI_MODEL_CHANNELS, type AiModelsApi, type AiSettings } from './shared/ai-models';
import { PREFERENCES_CHANNELS, type PreferencesApi } from './shared/preferences';
import { PLAYLIST_DEBUG_CHANNEL, PLAYLIST_DEBUG_PREFIX } from './shared/playlist-suggestions';

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
  searchSongs: (request) =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.searchSongs, request),
  trackMenu: (request) =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.trackMenu, request),
  suggestPlaylist: (request) =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.suggestPlaylist, request),
  cancelSuggestions: () =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.cancelSuggestions),
  mutate: (change) =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.mutate, change),
});

contextBridge.exposeInMainWorld('djLibrary', api);

const aiModels: AiModelsApi = Object.freeze({
  onChange: (listener) => {
    const handleChange = (_event: IpcRendererEvent, settings: AiSettings): void => listener(settings);
    ipcRenderer.on(AI_MODEL_CHANNELS.changed, handleChange);
    return () => { ipcRenderer.removeListener(AI_MODEL_CHANNELS.changed, handleChange); };
  },
  settings: () => ipcRenderer.invoke(AI_MODEL_CHANNELS.settings),
  update: (change) => ipcRenderer.invoke(AI_MODEL_CHANNELS.update, change),
  list: (provider) => ipcRenderer.invoke(AI_MODEL_CHANNELS.list, provider),
  searchOllama: (query) => ipcRenderer.invoke(AI_MODEL_CHANNELS.searchOllama, query),
  variants: (family) => ipcRenderer.invoke(AI_MODEL_CHANNELS.variants, family),
  download: (model) => ipcRenderer.invoke(AI_MODEL_CHANNELS.download, model),
  downloadStatus: () => ipcRenderer.invoke(AI_MODEL_CHANNELS.downloadStatus),
  cancelDownload: () => ipcRenderer.invoke(AI_MODEL_CHANNELS.cancelDownload),
});
contextBridge.exposeInMainWorld('aiModels', aiModels);

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
