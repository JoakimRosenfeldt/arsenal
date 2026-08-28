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
});

contextBridge.exposeInMainWorld('djLibrary', api);
