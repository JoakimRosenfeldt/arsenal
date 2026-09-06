import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { APP_UPDATE_CHANNELS, type AppUpdatesApi, type UpdateStatus } from './shared/app-updates';

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
  mutate: (change) =>
    ipcRenderer.invoke(DJ_LIBRARY_CHANNELS.mutate, change),
});

contextBridge.exposeInMainWorld('djLibrary', api);

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
