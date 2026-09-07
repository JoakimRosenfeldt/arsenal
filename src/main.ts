import { stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  Menu,
  type IpcMainInvokeEvent,
  net,
  protocol,
  type Session,
  session,
} from 'electron';

import { RekordboxLibrary } from './main/rekordbox-library';
import { readPlaylistSuggestionRequest } from './main/playlist-suggestions';
import { AppUpdates } from './main/app-updates';
import { AiModels } from './main/ai-models';
import { ModelError } from './main/ai-client';
import { AI_MODEL_CHANNELS, type AiResult } from './shared/ai-models';
import { APP_UPDATE_CHANNELS } from './shared/app-updates';
import { PREFERENCES_CHANNELS } from './shared/preferences';
import {
  TRACK_ARTWORK_SCHEME,
  TRACK_MEDIA_SCHEME,
} from './main/track-artwork';
import {
  DJ_LIBRARY_CHANNELS,
  DUPLICATE_MATCH_MODES,
  SONG_PAGE_SIZE,
  type DuplicateMatchMode,
  type LibraryMutation,
  type PageRequest,
  type SongSearchRequest,
} from './shared/dj-library';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const APP_SESSION_PARTITION = 'arsenal';
const APP_SCHEME = 'arsenal';
const PACKAGED_RENDERER_URL = `${APP_SCHEME}://app/main_window/index.html`;
const APP_ICON_PATH = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(app.getAppPath(), 'assets', 'icon.png');
const library = new RekordboxLibrary();
const aiModels = new AiModels();
let mainWindow: BrowserWindow | null = null;
let preferencesWindow: BrowserWindow | null = null;
let libraryActions = 0;

app.setName('Arsenal');

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { secure: true, standard: true },
  },
  {
    scheme: TRACK_ARTWORK_SCHEME,
    privileges: { secure: true, standard: true },
  },
  {
    scheme: TRACK_MEDIA_SCHEME,
    privileges: {
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

type ByteRange = Readonly<{ start: number; end: number }>;

const byteRangeFor = (value: string, size: number): ByteRange | null => {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  const rawStart = match?.[1];
  const rawEnd = match?.[2];
  if (rawStart === undefined || rawEnd === undefined || size <= 0) {
    return null;
  }

  if (rawStart.length === 0) {
    const suffixLength = Number(rawEnd);
    return Number.isSafeInteger(suffixLength) && suffixLength > 0
      ? { start: Math.max(0, size - suffixLength), end: size - 1 }
      : null;
  }

  const start = Number(rawStart);
  const requestedEnd = rawEnd.length === 0 ? size - 1 : Number(rawEnd);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
};

const readPageRequest = (value: unknown): PageRequest => {
  if (!isRecord(value)) {
    throw new Error('Invalid page request');
  }

  const { offset, limit } = value;
  if (
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit !== SONG_PAGE_SIZE
  ) {
    throw new Error('Invalid page request');
  }

  return { offset, limit };
};

const readDuplicateMatchMode = (value: unknown): DuplicateMatchMode => {
  const mode = DUPLICATE_MATCH_MODES.find((candidate) => candidate === value);
  if (mode === undefined) {
    throw new Error('Invalid duplicate match mode');
  }
  return mode;
};

const readSongSearchRequest = (value: unknown): SongSearchRequest => {
  if (
    !isRecord(value) ||
    typeof value.query !== 'string' ||
    value.query.length > 200
  ) {
    throw new Error('Invalid song search');
  }
  return { ...readPageRequest(value), query: value.query };
};

const readLibraryMutation = (value: unknown): LibraryMutation => {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('Invalid library mutation');
  }
  if (value.kind === 'ignore-duplicate-group') {
    if (
      typeof value.revision !== 'string' ||
      value.revision.length === 0 ||
      typeof value.groupKey !== 'string' ||
      value.groupKey.length === 0
    ) {
      throw new Error('Invalid duplicate group');
    }
    return {
      kind: 'ignore-duplicate-group',
      revision: value.revision,
      mode: readDuplicateMatchMode(value.mode),
      groupKey: value.groupKey,
    };
  }
  if (value.kind === 'remove-songs') {
    if (
      typeof value.revision !== 'string' ||
      value.revision.length === 0 ||
      !Array.isArray(value.songIds) ||
      value.songIds.length === 0 ||
      value.songIds.length > 10_000 ||
      !value.songIds.every((songId) => typeof songId === 'string' && songId.length > 0) ||
      new Set(value.songIds).size !== value.songIds.length ||
      typeof value.removeLocalFile !== 'boolean'
    ) {
      throw new Error('Invalid song removal');
    }
    return {
      kind: 'remove-songs',
      revision: value.revision,
      songIds: value.songIds,
      removeLocalFile: value.removeLocalFile,
    };
  }
  if (value.kind === 'create-playlist') {
    if (
      typeof value.revision !== 'string' ||
      value.revision.length === 0 ||
      typeof value.name !== 'string' ||
      !Array.isArray(value.songIds) ||
      !value.songIds.every((songId) => typeof songId === 'string')
    ) {
      throw new Error('Invalid playlist creation');
    }
    return {
      kind: 'create-playlist',
      revision: value.revision,
      name: value.name,
      songIds: value.songIds,
    };
  }
  throw new Error('Invalid library mutation');
};

const assertTrustedSender = (
  event: IpcMainInvokeEvent,
  owner: BrowserWindow,
): void => {
  const contents = owner.webContents;
  if (
    event.sender !== contents ||
    event.senderFrame === null ||
    event.senderFrame !== contents.mainFrame
  ) {
    throw new Error('Rejected IPC from an untrusted frame');
  }
};

const installIpc = (owner: BrowserWindow, updates: AppUpdates, preferences: boolean): void => {
  const ipc = owner.webContents.ipc;

  ipc.handle(PREFERENCES_CHANNELS.open, (event) => {
    assertTrustedSender(event, owner);
    openPreferences(updates);
  });

  const modelAction = async <T,>(action: () => T | Promise<T>): Promise<AiResult<T>> => {
    try {
      return { kind: 'ready', value: await action() };
    } catch (error: unknown) {
      return { kind: 'error', message: error instanceof ModelError ? error.message : 'Could not complete the model request. Try again.' };
    }
  };
  ipc.handle(AI_MODEL_CHANNELS.settings, (event) => {
    assertTrustedSender(event, owner);
    return aiModels.settings();
  });
  ipc.handle(AI_MODEL_CHANNELS.update, (event, change: unknown) => {
    assertTrustedSender(event, owner);
    return modelAction(async () => {
      const settings = await aiModels.update(change);
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(AI_MODEL_CHANNELS.changed, settings);
      }
      return settings;
    });
  });
  ipc.handle(AI_MODEL_CHANNELS.list, (event, provider: unknown) => {
    assertTrustedSender(event, owner);
    return modelAction(() => aiModels.list(provider));
  });
  ipc.handle(AI_MODEL_CHANNELS.searchOllama, (event, query: unknown) => {
    assertTrustedSender(event, owner);
    return modelAction(() => aiModels.searchOllama(query));
  });
  ipc.handle(AI_MODEL_CHANNELS.variants, (event, family: unknown) => {
    assertTrustedSender(event, owner);
    return modelAction(() => aiModels.variants(family));
  });
  ipc.handle(AI_MODEL_CHANNELS.download, (event, model: unknown) => {
    assertTrustedSender(event, owner);
    return modelAction(() => aiModels.startDownload(model));
  });
  ipc.handle(AI_MODEL_CHANNELS.downloadStatus, (event) => {
    assertTrustedSender(event, owner);
    return aiModels.downloadStatus();
  });
  ipc.handle(AI_MODEL_CHANNELS.cancelDownload, (event) => {
    assertTrustedSender(event, owner);
    return aiModels.cancelDownload();
  });

  ipc.handle(APP_UPDATE_CHANNELS.status, (event) => {
    assertTrustedSender(event, owner);
    return updates.status();
  });
  ipc.handle(APP_UPDATE_CHANNELS.check, (event) => {
    assertTrustedSender(event, owner);
    return updates.check();
  });
  ipc.handle(APP_UPDATE_CHANNELS.download, (event) => {
    assertTrustedSender(event, owner);
    return updates.download();
  });
  ipc.handle(APP_UPDATE_CHANNELS.install, (event) => {
    assertTrustedSender(event, owner);
    if (libraryActions > 0) {
      throw new Error('Wait for library actions to finish before restarting.');
    }
    updates.install();
  });

  if (preferences) return;

  ipc.handle(DJ_LIBRARY_CHANNELS.status, (event) => {
    assertTrustedSender(event, owner);
    return library.status();
  });

  ipc.handle(DJ_LIBRARY_CHANNELS.importExport, async (event) => {
    assertTrustedSender(event, owner);
    libraryActions += 1;
    try {
      return await library.importExport(owner);
    } finally {
      libraryActions -= 1;
    }
  });

  ipc.handle(
    DJ_LIBRARY_CHANNELS.listSongs,
    (event, request: unknown) => {
      assertTrustedSender(event, owner);
      return library.listSongs(readPageRequest(request));
    },
  );

  ipc.handle(
    DJ_LIBRARY_CHANNELS.findDuplicates,
    (event, mode: unknown) => {
      assertTrustedSender(event, owner);
      return library.findDuplicates(readDuplicateMatchMode(mode));
    },
  );

  ipc.handle(DJ_LIBRARY_CHANNELS.listPlaylists, (event) => {
    assertTrustedSender(event, owner);
    return library.listPlaylists();
  });

  ipc.handle(
    DJ_LIBRARY_CHANNELS.searchSongs,
    (event, request: unknown) => {
      assertTrustedSender(event, owner);
      const search = readSongSearchRequest(request);
      return library.searchSongs(search);
    },
  );

  ipc.handle(DJ_LIBRARY_CHANNELS.mutate, async (event, change: unknown) => {
    assertTrustedSender(event, owner);
    libraryActions += 1;
    try {
      return await library.mutate(readLibraryMutation(change));
    } finally {
      libraryActions -= 1;
    }
  });

  ipc.handle(DJ_LIBRARY_CHANNELS.suggestPlaylist, (event, value: unknown) => {
    assertTrustedSender(event, owner);
    const request = readPlaylistSuggestionRequest(value);
    return request === null
      ? { kind: 'rejected', reason: 'invalid-request' }
      : library.suggestPlaylist(request, aiModels);
  });

  ipc.handle(DJ_LIBRARY_CHANNELS.cancelSuggestions, (event) => {
    assertTrustedSender(event, owner);
    library.cancelSuggestions();
  });
  owner.on('closed', () => library.cancelSuggestions());
};

const configureSession = (appSession: Session): void => {
  appSession.setPermissionCheckHandler(() => false);
  appSession.setPermissionRequestHandler((_webContents, _permission, reply) => {
    reply(false);
  });
  appSession.on('will-download', (event) => {
    event.preventDefault();
  });

  if (app.isPackaged) {
    appSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, reply) => {
        reply({ cancel: true });
      },
    );
  }
};

const configureProtocols = (appSession: Session): void => {
  appSession.protocol.handle(TRACK_ARTWORK_SCHEME, async (request) => {
    if (request.method !== 'GET') {
      return new Response('Not found', { status: 404 });
    }

    const artwork = await library.openArtwork(request.url);
    if (artwork === null) {
      return new Response(null, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    return new Response(artwork.bytes, {
      status: 200,
      headers: {
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Type': artwork.contentType,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  appSession.protocol.handle(TRACK_MEDIA_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Not found', { status: 404 });
    }
    const mediaPath = library.mediaPathFor(request.url);
    if (mediaPath === null) {
      return new Response('Not found', { status: 404 });
    }

    let fileSize: number;
    try {
      const file = await stat(mediaPath);
      if (!file.isFile() || !Number.isSafeInteger(file.size)) {
        return new Response('Not found', { status: 404 });
      }
      fileSize = file.size;
    } catch {
      return new Response('Not found', { status: 404 });
    }

    const range = request.headers.get('range');
    const parsedRange =
      request.method === 'GET' && range !== null
        ? byteRangeFor(range, fileSize)
        : null;
    if (request.method === 'GET' && range !== null && parsedRange === null) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileSize}` },
      });
    }

    const fetched = await net.fetch(pathToFileURL(mediaPath).toString(), {
      method: request.method,
      ...(parsedRange === null
        ? {}
        : { headers: { Range: `bytes=${parsedRange.start}-${parsedRange.end}` } }),
      bypassCustomProtocolHandlers: true,
    });
    const headers = new Headers(fetched.headers);
    headers.set(
      'Access-Control-Allow-Origin',
      app.isPackaged ? 'arsenal://app' : new URL(MAIN_WINDOW_WEBPACK_ENTRY).origin,
    );
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    if (parsedRange !== null) {
      headers.set(
        'Content-Range',
        `bytes ${parsedRange.start}-${parsedRange.end}/${fileSize}`,
      );
      headers.set(
        'Content-Length',
        String(parsedRange.end - parsedRange.start + 1),
      );
    }
    return new Response(fetched.body, {
      status: parsedRange === null ? fetched.status : 206,
      statusText: fetched.statusText,
      headers,
    });
  });

  if (!app.isPackaged) {
    return;
  }

  const rendererRoot = dirname(
    dirname(fileURLToPath(MAIN_WINDOW_WEBPACK_ENTRY)),
  );
  const rendererRootPrefix = `${rendererRoot}${sep}`;

  appSession.protocol.handle(APP_SCHEME, (request) => {
    const requestUrl = new URL(request.url);
    if (request.method !== 'GET' || requestUrl.hostname !== 'app') {
      return new Response('Not found', { status: 404 });
    }

    let relativePath: string;
    try {
      relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
    } catch {
      return new Response('Invalid path', { status: 400 });
    }

    const assetPath = resolve(rendererRoot, relativePath);
    if (!assetPath.startsWith(rendererRootPrefix)) {
      return new Response('Not found', { status: 404 });
    }

    return net.fetch(pathToFileURL(assetPath).toString(), {
      bypassCustomProtocolHandlers: true,
    });
  });
};

const createWindow = (updates: AppUpdates, preferences = false): BrowserWindow => {
  const entry = app.isPackaged
    ? PACKAGED_RENDERER_URL
    : MAIN_WINDOW_WEBPACK_ENTRY;
  const renderer = new URL(entry);
  if (preferences) renderer.searchParams.set('window', 'preferences');
  const rendererUrl = renderer.href;
  const window = new BrowserWindow({
    title: preferences ? 'Arsenal Preferences' : 'Arsenal',
    width: preferences ? 760 : 1280,
    height: preferences ? 740 : 800,
    minWidth: preferences ? 560 : 760,
    minHeight: 560,
    autoHideMenuBar: preferences,
    show: false,
    icon: APP_ICON_PATH,
    backgroundColor: '#0b0b0d',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      partition: APP_SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
      safeDialogs: true,
      navigateOnDragDrop: false,
    },
  });

  installIpc(window, updates, preferences);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('page-title-updated', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  window.webContents.on('will-frame-navigate', (details) => {
    if (
      details.url !== rendererUrl ||
      details.frame !== window.webContents.mainFrame
    ) {
      details.preventDefault();
    }
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) {
      event.preventDefault();
    }
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (url !== rendererUrl) {
      event.preventDefault();
    }
  });
  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    if (preferences) preferencesWindow = null;
    else mainWindow = null;
  });
  void window.loadURL(rendererUrl);
  return window;
};

const openPreferences = (updates: AppUpdates): void => {
  if (preferencesWindow === null) {
    preferencesWindow = createWindow(updates, true);
  } else {
    if (preferencesWindow.isMinimized()) preferencesWindow.restore();
    preferencesWindow.show();
    preferencesWindow.focus();
  }
};

void app.whenReady().then(async () => {
  app.dock?.setIcon(APP_ICON_PATH);
  await aiModels.initialize(join(app.getPath('userData'), 'ai-settings.json'));
  await library.initialize(
    join(app.getPath('userData'), 'last-library.json'),
  );
  const appSession = session.fromPartition(APP_SESSION_PARTITION);
  configureSession(appSession);
  configureProtocols(appSession);
  const updates = new AppUpdates();
  mainWindow = createWindow(updates);
  const preferencesItem = {
    label: 'Preferences...',
    accelerator: 'CmdOrCtrl+,',
    click: () => openPreferences(updates),
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{
      label: 'Arsenal', submenu: [
        { role: 'about' as const }, { type: 'separator' as const }, preferencesItem,
        { type: 'separator' as const }, { role: 'services' as const },
        { type: 'separator' as const }, { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const },
        { type: 'separator' as const }, { role: 'quit' as const },
      ],
    }] : []),
    { label: 'File', submenu: [
      ...(process.platform === 'darwin' ? [] : [preferencesItem, { type: 'separator' as const }]),
      { role: 'close' },
      ...(process.platform === 'darwin' ? [] : [{ role: 'quit' as const }]),
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));

  app.on('activate', () => {
    if (mainWindow === null) {
      mainWindow = createWindow(updates);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => aiModels.cancelDownload());
