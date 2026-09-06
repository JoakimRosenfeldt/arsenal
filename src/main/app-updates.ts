import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

import {
  APP_UPDATE_CHANNELS,
  type UpdatePhase,
  type UpdateStatus,
} from '../shared/app-updates';

export class AppUpdates {
  private phase: UpdatePhase = { kind: 'idle' };

  constructor() {
    if (!app.isPackaged) {
      this.phase = { kind: 'disabled', message: 'Updates are available in installed builds.' };
      return;
    }
    if (process.platform === 'linux' && !process.env.APPIMAGE) {
      this.phase = { kind: 'disabled', message: 'Run the AppImage to enable updates.' };
      return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = null;
    autoUpdater.on('error', (error) => {
      if (error.message === 'No published versions on GitHub') {
        return;
      }
      console.error('App update failed', error);
      this.setPhase({ kind: 'error', message: 'Could not update Arsenal. Try again.' });
    });
    autoUpdater.on('update-available', ({ version }) => {
      this.setPhase({ kind: 'available', version });
    });
    autoUpdater.on('update-not-available', () => {
      this.setPhase({ kind: 'current' });
    });
    autoUpdater.on('download-progress', ({ percent }) => {
      if (this.phase.kind === 'downloading') {
        this.setPhase({ ...this.phase, percent: Math.max(0, Math.min(100, Math.round(percent))) });
      }
    });
    autoUpdater.on('update-downloaded', ({ version }) => {
      this.setPhase({ kind: 'downloaded', version });
    });

    const startupCheck = setTimeout(() => void this.check(), 10_000);
    const periodicCheck = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
    startupCheck.unref();
    periodicCheck.unref();
    app.once('before-quit', () => {
      clearTimeout(startupCheck);
      clearInterval(periodicCheck);
    });
  }

  status(): UpdateStatus {
    return { ...this.phase, currentVersion: app.getVersion() };
  }

  private setPhase(phase: UpdatePhase): void {
    this.phase = phase;
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(APP_UPDATE_CHANNELS.changed, this.status());
      window.setProgressBar(phase.kind === 'downloading' ? phase.percent / 100 : -1);
    }
  }

  async check(): Promise<void> {
    if (this.phase.kind !== 'idle' && this.phase.kind !== 'current' && this.phase.kind !== 'error' && this.phase.kind !== 'unpublished') {
      return;
    }
    this.setPhase({ kind: 'checking' });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.setPhase(error instanceof Error && error.message === 'No published versions on GitHub'
        ? { kind: 'unpublished' }
        : { kind: 'error', message: 'Could not check for updates. Try again.' });
    }
  }

  async download(): Promise<void> {
    if (this.phase.kind !== 'available') {
      return;
    }
    this.setPhase({ kind: 'downloading', version: this.phase.version, percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch {
      this.setPhase({ kind: 'error', message: 'Could not download the update. Check your connection and try again.' });
    }
  }

  install(): void {
    if (this.phase.kind === 'downloaded') {
      autoUpdater.quitAndInstall(false, true);
    }
  }
}
