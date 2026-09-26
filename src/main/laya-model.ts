import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { app, BrowserWindow } from 'electron';

import manifest from '../shared/laya-model-manifest.json';
import { LAYA_MODEL_CHANNELS, type LayaModelStatus } from '../shared/laya-model';

const files = Object.entries(manifest.files);
const downloads = [
  { name: 'model.safetensors', source: 'model.safetensors', bytes: 842609210, sha256: manifest.checkpointSha256 },
  { name: 'tokenizer.json', source: 'tokenizer/tokenizer.json', ...manifest.files['tokenizer.json'] },
  { name: 'rl_agent_config.json', source: 'rl_agent_config.json', ...manifest.files['rl_agent_config.json'] },
  { name: 'MODEL_CARD.md', source: 'README.md', ...manifest.files['MODEL_CARD.md'] },
];
const totalBytes = downloads.reduce((sum, file) => sum + file.bytes, 0);
const convertedBytes = manifest.files['encoder.onnx.data'].bytes + manifest.files['head.onnx.data'].bytes;
const requiredBytes = totalBytes + files.reduce((sum, [, file]) => sum + file.bytes, 0) + 64 * 1024 * 1024;
const cacheKey = `laya-${manifest.modelRevision.slice(0, 12)}-${createHash('sha256')
  .update(JSON.stringify(manifest.files)).digest('hex').slice(0, 12)}`;
let status: LayaModelStatus = { kind: 'checking' };
let directory: string | null = null;
let generation = 0;
let download: Promise<LayaModelStatus> | null = null;
let controller: AbortController | null = null;

const downloadDirectory = (): string => join(app.getPath('userData'), 'models', 'laya', cacheKey);

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

const convert = async (directory: string, signal: AbortSignal, onProgress: (bytes: number) => void): Promise<void> => {
  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'assets');
  const worker = new Worker(join(resources, 'laya-runtime', 'converter.mjs'), {
    workerData: {
      checkpoint: join(directory, 'model.safetensors'), directory,
      templates: join(resources, 'laya-runtime', 'conversion'),
    },
  });
  let cancel = (): void => undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      cancel = () => reject(signal.reason);
      worker.on('message', (bytes: unknown) => {
        if (typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= convertedBytes) {
          onProgress(bytes);
        } else {
          reject(new Error('Could not prepare Laya. The converter returned invalid progress.'));
        }
      });
      worker.once('error', reject);
      worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Could not prepare Laya. Try again.')));
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    await worker.terminate();
  }
};

const install = async (abort: AbortController): Promise<LayaModelStatus> => {
  const destination = downloadDirectory();
  const parent = join(destination, '..');
  let staging: string | undefined;
  let receivedBytes = 0;
  let lastProgress = 0;
  const idleTimeout = setTimeout(() => abort.abort(new Error('Laya setup stalled. Try again.')), 120_000);
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
    if (space.bavail * space.bsize < requiredBytes) {
      throw new Error('Not enough disk space. Free at least 2.5 GiB and try again.');
    }
    staging = await mkdtemp(join(parent, `.download-${process.pid}-`));
    const baseUrl = `https://huggingface.co/convaiinnovations/laya/resolve/${manifest.modelRevision}`;
    for (const { name, source, ...expected } of downloads) {
      abort.signal.throwIfAborted();
      const response = await fetch(`${baseUrl}/${source}?download=true`, { signal: abort.signal });
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        throw new Error(response.status === 404
          ? 'The Laya model could not be found on Hugging Face. Try again later.'
          : `Could not download Laya. Hugging Face returned HTTP ${response.status}. Try again.`);
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
    publish({ kind: 'converting', completedBytes: 0, totalBytes: convertedBytes });
    idleTimeout.refresh();
    await convert(staging, abort.signal, (completedBytes) => {
      idleTimeout.refresh();
      publish({ kind: 'converting', completedBytes, totalBytes: convertedBytes });
    });
    abort.signal.throwIfAborted();
    if (!await complete(staging)) throw new Error('The prepared model is incomplete. Try again.');
    await rm(join(staging, 'model.safetensors'));
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
      const message = abort.signal.aborted ? 'Laya setup stalled. Try again.'
        : error instanceof Error && 'code' in error && error.code === 'ENOSPC'
          ? 'Not enough disk space. Free at least 2.5 GiB and try again.'
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
