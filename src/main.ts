import { stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  type IpcMainInvokeEvent,
  net,
  protocol,
  type Session,
  session,
} from 'electron';

import { RekordboxLibrary } from './main/rekordbox-library';
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
const library = new RekordboxLibrary();

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
  if (value.kind === 'remove-song') {
    if (
      typeof value.revision !== 'string' ||
      value.revision.length === 0 ||
      typeof value.songId !== 'string' ||
      value.songId.length === 0 ||
      typeof value.removeLocalFile !== 'boolean'
    ) {
      throw new Error('Invalid song removal');
    }
    return {
      kind: 'remove-song',
      revision: value.revision,
      songId: value.songId,
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

const installIpc = (owner: BrowserWindow): void => {
  const ipc = owner.webContents.ipc;

  ipc.handle(DJ_LIBRARY_CHANNELS.status, (event) => {
    assertTrustedSender(event, owner);
    return library.status();
  });

  ipc.handle(DJ_LIBRARY_CHANNELS.importExport, async (event) => {
    assertTrustedSender(event, owner);
    return library.importExport(owner);
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

  ipc.handle(DJ_LIBRARY_CHANNELS.mutate, (event, change: unknown) => {
    assertTrustedSender(event, owner);
    return library.mutate(readLibraryMutation(change));
  });
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

const createWindow = (): void => {
  const rendererUrl = app.isPackaged
    ? PACKAGED_RENDERER_URL
    : MAIN_WINDOW_WEBPACK_ENTRY;
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    show: false,
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

  installIpc(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.on('will-frame-navigate', (details) => {
    if (
      details.url !== rendererUrl ||
      details.frame !== mainWindow.webContents.mainFrame
    ) {
      details.preventDefault();
    }
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (url !== rendererUrl) {
      event.preventDefault();
    }
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  void mainWindow.loadURL(rendererUrl);
};

void app.whenReady().then(async () => {
  await library.initialize(
    join(app.getPath('userData'), 'last-library.json'),
  );
  const appSession = session.fromPartition(APP_SESSION_PARTITION);
  configureSession(appSession);
  configureProtocols(appSession);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
