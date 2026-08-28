import { contextBridge, ipcRenderer } from 'electron';

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
