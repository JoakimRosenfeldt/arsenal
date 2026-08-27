import { dirname, resolve, sep } from 'node:path';
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
  DJ_LIBRARY_CHANNELS,
  SONG_PAGE_SIZE,
  type PageRequest,
} from './shared/dj-library';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const APP_SESSION_PARTITION = 'arsenal';
const APP_SCHEME = 'arsenal';
const PACKAGED_RENDERER_URL = `${APP_SCHEME}://app/main_window/index.html`;
const library = new RekordboxLibrary();

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { secure: true, standard: true },
  },
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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

const configurePackagedRenderer = (appSession: Session): void => {
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
    backgroundColor: '#f1eee7',
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

void app.whenReady().then(() => {
  const appSession = session.fromPartition(APP_SESSION_PARTITION);
  configureSession(appSession);
  configurePackagedRenderer(appSession);
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
