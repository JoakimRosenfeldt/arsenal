import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { app, BrowserWindow } from 'electron';

import manifest from '../shared/laya-model-manifest.json';
import { LAYA_MODEL_CHANNELS, type LayaModelStatus } from '../shared/laya-model';

const files = Object.entries(manifest.files);
const totalBytes = files.reduce((sum, [, file]) => sum + file.bytes, 0);
const modelRelease = `laya-${manifest.modelRevision.slice(0, 12)}-${createHash('sha256')
  .update(JSON.stringify(manifest.files)).digest('hex').slice(0, 12)}`;
let status: LayaModelStatus = { kind: 'checking' };
let directory: string | null = null;
let generation = 0;
let download: Promise<LayaModelStatus> | null = null;
let controller: AbortController | null = null;

const downloadDirectory = (): string => join(app.getPath('userData'), 'models', 'laya', modelRelease);

const publish = (next: LayaModelStatus): void => {
  status = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(LAYA_MODEL_CHANNELS.changed, status);
  }
};

const complete = async (path: string): Promise<boolean> => {
  try {
    const sizes = await Promise.all(files.map(async ([name, expected]) => {
      const file = await stat(join(path, name));
      return file.isFile() && file.size === expected.bytes;
    }));
    return sizes.every(Boolean);
  } catch {
    return false;
  }
};

export const getLayaModelDirectory = async (): Promise<string | null> => {
  if (download !== null) return null;
  const current = generation;
  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'assets');
  for (const path of [downloadDirectory(), join(resources, 'laya')]) {
    if (await complete(path)) {
      if (current !== generation) return directory;
      directory = path;
      publish({ kind: 'ready' });
      return path;
    }
  }
  if (current !== generation) return directory;
  directory = null;
  publish({ kind: 'missing' });
  return null;
};

export const getLayaModelStatus = async (): Promise<LayaModelStatus> => {
  if (status.kind === 'checking' || status.kind === 'ready') await getLayaModelDirectory();
  return status;
};

const install = async (abort: AbortController): Promise<LayaModelStatus> => {
  const destination = downloadDirectory();
  const parent = join(destination, '..');
  let staging: string | undefined;
  let receivedBytes = 0;
  let lastProgress = 0;
  const idleTimeout = setTimeout(() => abort.abort(new Error('Download stalled. Try again.')), 120_000);
  publish({ kind: 'downloading', receivedBytes, totalBytes });
  try {
    await mkdir(parent, { recursive: true });
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const match = /^\.download-(\d+)-/u.exec(entry.name);
      if (!entry.isDirectory() || !match?.[1]) continue;
      const pid = Number(match[1]);
      if (pid !== process.pid) {
        try { process.kill(pid, 0); continue; } catch (error: unknown) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') continue;
        }
      }
      await rm(join(parent, entry.name), { recursive: true, force: true });
    }
    const space = await statfs(parent);
    if (space.bavail * space.bsize < totalBytes + 64 * 1024 * 1024) {
      throw new Error('Not enough disk space. Free at least 1.7 GiB and try again.');
    }
    staging = await mkdtemp(join(parent, `.download-${process.pid}-`));
    const baseUrl = `https://github.com/JoakimRosenfeldt/arsenal/releases/download/${modelRelease}`;
    for (const [name, expected] of files) {
      abort.signal.throwIfAborted();
      const response = await fetch(`${baseUrl}/laya-${name}`, { signal: abort.signal });
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        throw new Error(response.status === 404
          ? 'The Laya model download is unavailable. Try again later.'
          : `Could not download Laya. The server returned HTTP ${response.status}. Try again.`);
      }
      idleTimeout.refresh();
      const reader = response.body.getReader();
      const hash = createHash('sha256');
      let bytes = 0;
      try {
        const file = await open(join(staging, name), 'wx');
        try {
          let chunk = await reader.read();
          while (!chunk.done) {
            abort.signal.throwIfAborted();
            idleTimeout.refresh();
            bytes += chunk.value.byteLength;
            if (bytes > expected.bytes) throw new Error('The model download failed verification. Try again.');
            hash.update(chunk.value);
            await file.writeFile(chunk.value);
            receivedBytes += chunk.value.byteLength;
            if (Date.now() - lastProgress > 150) {
              lastProgress = Date.now();
              publish({ kind: 'downloading', receivedBytes, totalBytes });
            }
            chunk = await reader.read();
          }
        } finally {
          await file.close();
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) {
        throw new Error('The model download failed verification. Try again.');
      }
    }
    abort.signal.throwIfAborted();
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest));
    abort.signal.throwIfAborted();
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    directory = destination;
    return { kind: 'ready' };
  } catch (error: unknown) {
    if (abort.signal.aborted && abort.signal.reason?.name === 'AbortError') {
      return { kind: 'missing' };
    } else {
      const message = abort.signal.aborted ? 'Download stalled. Try again.'
        : error instanceof Error && 'code' in error && error.code === 'ENOSPC'
          ? 'Not enough disk space. Free at least 1.7 GiB and try again.'
          : error instanceof Error ? error.message : 'Could not download Laya. Check your connection and try again.';
      return { kind: 'failed', message: message === 'fetch failed'
        ? 'Could not download Laya. Check your connection and try again.' : message.slice(0, 300) };
    }
  } finally {
    clearTimeout(idleTimeout);
    if (staging !== undefined) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
};

export const downloadLayaModel = async (): Promise<LayaModelStatus> => {
  if (download !== null) return download;
  if (await getLayaModelDirectory()) return status;
  if (download !== null) return download;
  generation += 1;
  controller = new AbortController();
  download = install(controller).then((next) => {
    download = null;
    controller = null;
    publish(next);
    return next;
  });
  return download;
};

export const cancelLayaModelDownload = async (): Promise<void> => {
  controller?.abort();
  await download;
};
