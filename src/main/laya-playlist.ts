import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { app, utilityProcess } from 'electron';

import type { SongRow } from '../shared/dj-library';
import {
  LAYA_MODEL,
  type PlaylistSuggestion,
  type PlaylistSuggestionProgress,
  type PlaylistSuggestionRequest,
  type PlaylistSuggestionResult,
} from '../shared/playlist-suggestions';
import { logPlaylistDebug } from './playlist-debug';
import { getLayaModelDirectory } from './laya-model';
import { matchesTempo, orderPlaylist, tempoFromMood } from './rank-playlist';

const MIN_MATCH_SCORE = 67;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const compactText = (value: string | null, bytes: number): string | null => {
  if (value === null) return null;
  let text = value.trim().replace(/\s+/gu, ' ').slice(0, bytes);
  while (Buffer.byteLength(text, 'utf8') > bytes) text = text.slice(0, -1);
  return text || null;
};

const metadata = (song: SongRow, startingTrack = false) => {
  const title = compactText(song.title, 96);
  const row = [title, compactText(song.artist, 96), compactText(song.genre, 64), song.bpm, compactText(song.musicalKey, 24)];
  if (!startingTrack) {
    const mix = compactText(song.mixName, 64);
    const repeatedMix = mix !== null && title !== null &&
      new RegExp(`(^|[^\\p{L}\\p{N}])${mix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(title);
    row.push(compactText(song.album, 64), repeatedMix ? null : mix, compactText(song.remixer, 64), song.year);
  }
  while (row.at(-1) === null) row.pop();
  return row;
};

export const suggestLayaPlaylist = async (
  songs: readonly SongRow[],
  request: PlaylistSuggestionRequest,
  signal: AbortSignal,
  onProgress: (progress: PlaylistSuggestionProgress) => void,
): Promise<PlaylistSuggestionResult> => {
  if (signal.aborted) return { kind: 'rejected', reason: 'cancelled' };
  const tempo = tempoFromMood(request.mood);
  if (tempo && (tempo.min < 30 || tempo.max > 300 || tempo.min > tempo.max)) return { kind: 'rejected', reason: 'invalid-tempo' };
  const byId = new Map(songs.map((song) => [song.id, song]));
  if ([...request.seedSongIds, ...request.excludedSongIds].some((id) => !byId.has(id))) {
    return { kind: 'rejected', reason: 'stale-library' };
  }
  const seeds = request.seedSongIds.flatMap((id) => { const song = byId.get(id); return song ? [song] : []; });
  const excludedIds = new Set([...request.seedSongIds, ...request.excludedSongIds]);
  const candidates = songs.filter((song) => !excludedIds.has(song.id) && matchesTempo(song, tempo));
  const scored: Omit<PlaylistSuggestion, 'reason'>[] = [];
  const ready = (): PlaylistSuggestionResult => ({
    kind: 'ready', model: LAYA_MODEL,
    suggestions: orderPlaylist(scored, seeds.at(-1), tempo,
      request.mood ? 'Metadata fits your description' : 'Metadata fits your starting tracks'),
    candidateCount: candidates.length, librarySongCount: songs.length,
  });
  if (candidates.length === 0) return ready();
  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'assets');
  const modelDirectory = await getLayaModelDirectory();
  const worker = join(resources, 'laya-runtime', 'worker.mjs');
  if (modelDirectory === null || !existsSync(worker)) {
    return { kind: 'rejected', reason: 'model-unavailable' };
  }
  if (signal.aborted) return { kind: 'rejected', reason: 'cancelled' };
  onProgress({ phase: 'loading-model' });
  try {
    const child = utilityProcess.fork(worker, [], { stdio: 'pipe', serviceName: 'Laya music recommendations' });
    return await new Promise<PlaylistSuggestionResult>((resolve) => {
      let finished = false;
      let completed = 0;
      let diagnostic = '';
      const finish = (result: PlaylistSuggestionResult): void => {
        if (finished) return;
        finished = true;
        clearTimeout(idleTimeout);
        clearTimeout(deadline);
        signal.removeEventListener('abort', cancel);
        child.kill();
        if (result.kind === 'rejected') logPlaylistDebug('Laya failed', { reason: result.reason, detail: result.detail });
        resolve(result);
      };
      const cancel = (): void => finish({ kind: 'rejected', reason: 'cancelled' });
      const timedOut = (): void => finish({ kind: 'rejected', reason: 'timed-out' });
      let idleTimeout = setTimeout(timedOut, 120_000);
      const deadline = setTimeout(timedOut, 1_800_000);
      child.once('spawn', () => { if (finished) child.kill(); });
      child.stderr?.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-500); });
      child.stdout?.resume();
      child.on('error', () => finish({ kind: 'rejected', reason: 'model-failed', detail: diagnostic || 'Laya could not run.' }));
      child.on('exit', (code) => finish({
        kind: 'rejected', reason: 'model-failed', detail: diagnostic || `Laya stopped with exit code ${code}.`,
      }));
      child.on('message', (message: unknown) => {
        if (finished) return;
        if (!isRecord(message)) return finish({ kind: 'rejected', reason: 'invalid-response' });
        if (message.kind === 'loaded') {
          logPlaylistDebug('Laya loaded', { model: LAYA_MODEL, tracks: candidates.length });
        } else if (message.kind === 'score') {
          const song = candidates[completed];
          if (!song || message.index !== completed || typeof message.score !== 'number' ||
            !Number.isFinite(message.score) || message.score < 0 || message.score > 4 ||
            typeof message.confidence !== 'number' || !Number.isFinite(message.confidence) ||
            message.confidence < 0 || message.confidence > 1) {
            return finish({ kind: 'rejected', reason: 'invalid-response' });
          }
          const matchScore = 1 + 99 * message.score / 4;
          if (matchScore >= MIN_MATCH_SCORE) {
            scored.push({ song, score: 1 + (matchScore - 1) * message.confidence, confidence: message.confidence });
          }
          completed += 1;
        } else if (message.kind === 'done' && completed === candidates.length) {
          onProgress({ phase: 'ranking' });
          logPlaylistDebug('Laya finished', { tracks: completed });
          return finish(ready());
        } else if (message.kind === 'rejected' &&
          (message.reason === 'context-too-large' || message.reason === 'model-unavailable' || message.reason === 'model-failed')) {
          return finish({ kind: 'rejected', reason: message.reason,
            ...(typeof message.detail === 'string' ? { detail: message.detail.slice(0, 500) } : {}) });
        } else {
          return finish({ kind: 'rejected', reason: 'invalid-response' });
        }
        clearTimeout(idleTimeout);
        idleTimeout = setTimeout(timedOut, 120_000);
        onProgress({ phase: 'scoring', completed, total: candidates.length });
      });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) return cancel();
      try {
        child.postMessage({ modelDirectory, mood: request.mood,
          seeds: seeds.map((song) => metadata(song, true)), candidates: candidates.map((song) => metadata(song)) });
      } catch {
        finish({ kind: 'rejected', reason: 'model-failed', detail: 'Could not send tracks to Laya.' });
      }
    });
  } catch (error: unknown) {
    const detail = (error instanceof Error ? error.message : 'Could not start Laya.').slice(0, 500);
    logPlaylistDebug('Laya failed', { detail });
    return { kind: 'rejected', reason: 'model-failed', detail };
  }
};
