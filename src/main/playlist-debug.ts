import { BrowserWindow } from 'electron';

import { PLAYLIST_DEBUG_CHANNEL, PLAYLIST_DEBUG_PREFIX } from '../shared/playlist-suggestions';

export const logPlaylistDebug = (event: string, details: Record<string, unknown>): void => {
  const message = `${PLAYLIST_DEBUG_PREFIX} ${event}`;
  console.info(message, details);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(PLAYLIST_DEBUG_CHANNEL, message, details);
    }
  }
};
