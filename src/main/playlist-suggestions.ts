import { join } from 'node:path';
import { app, utilityProcess } from 'electron';

import {
  MAX_MOOD_LENGTH,
  MAX_SEED_SONGS,
  type PlaylistSuggestionProgress,
  type PlaylistSuggestionRequest,
  type PlaylistSuggestionResult,
} from '../shared/playlist-suggestions';
import type { SongRow } from '../shared/dj-library';
import { logPlaylistDebug } from './playlist-debug';

export type AnalysisTrack = Readonly<{ song: SongRow; mediaPath: string | null }>;
export type ClapWorkerRequest = Readonly<{
  tracks: readonly AnalysisTrack[];
  request: PlaylistSuggestionRequest;
  cacheDirectory: string;
}>;
export type ClapWorkerMessage =
  | Readonly<{ kind: 'progress'; progress: PlaylistSuggestionProgress }>
  | Readonly<{ kind: 'result'; result: PlaylistSuggestionResult }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isSongIds = (value: unknown, limit: number): value is string[] =>
  Array.isArray(value) && value.length <= limit &&
  value.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 200) &&
  new Set(value).size === value.length;

export const readPlaylistSuggestionRequest = (value: unknown): PlaylistSuggestionRequest | null => {
  if (
    !isRecord(value) ||
    typeof value.revision !== 'string' || value.revision.length === 0 ||
    typeof value.mood !== 'string' || value.mood.length > MAX_MOOD_LENGTH ||
    !isSongIds(value.seedSongIds, MAX_SEED_SONGS) ||
    !isSongIds(value.excludedSongIds, 10_000) ||
    (value.mood.trim().length === 0 && value.seedSongIds.length === 0)
  ) return null;
  return {
    revision: value.revision,
    mood: value.mood.trim(),
    seedSongIds: value.seedSongIds,
    excludedSongIds: value.excludedSongIds,
  };
};

export const suggestPlaylist = (
  tracks: readonly AnalysisTrack[],
  request: PlaylistSuggestionRequest,
  signal: AbortSignal,
  onProgress: (progress: PlaylistSuggestionProgress) => void,
): Promise<PlaylistSuggestionResult> => {
  if (signal.aborted) return Promise.resolve({ kind: 'rejected', reason: 'cancelled' });
  const ids = new Set(tracks.map(({ song }) => song.id));
  if ([...request.seedSongIds, ...request.excludedSongIds].some((id) => !ids.has(id))) {
    return Promise.resolve({ kind: 'rejected', reason: 'stale-library' });
  }
  return new Promise((resolve) => {
    const worker = utilityProcess.fork(join(__dirname, 'clap-worker.js'), [], {
      serviceName: 'Arsenal music analysis',
      stdio: 'pipe',
    });
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout>;
    const finish = (result: PlaylistSuggestionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      signal.removeEventListener('abort', cancel);
      worker.removeAllListeners('message');
      worker.kill();
      logPlaylistDebug('CLAP complete', result.kind === 'ready'
        ? { candidates: result.candidateCount, skipped: result.skippedCount, cached: result.cachedCount }
        : { reason: result.reason });
      resolve(result);
    };
    const cancel = (): void => finish({ kind: 'rejected', reason: 'cancelled' });
    const resetWatchdog = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => finish({ kind: 'rejected', reason: 'timed-out' }), 300_000);
    };
    worker.on('message', (message: ClapWorkerMessage) => {
      resetWatchdog();
      if (message.kind === 'progress') onProgress(message.progress);
      else finish(message.result);
    });
    worker.on('exit', () => finish({ kind: 'rejected', reason: 'failed' }));
    worker.on('error', () => finish({ kind: 'rejected', reason: 'failed' }));
    worker.stderr?.on('data', (data: Buffer) => {
      logPlaylistDebug('CLAP worker', { message: data.toString('utf8').slice(0, 2_000) });
    });
    signal.addEventListener('abort', cancel, { once: true });
    resetWatchdog();
    worker.once('spawn', () => {
      if (settled) worker.kill();
      else worker.postMessage({ tracks, request, cacheDirectory: join(app.getPath('userData'), 'clap') } satisfies ClapWorkerRequest);
    });
    if (signal.aborted) cancel();
  });
};
