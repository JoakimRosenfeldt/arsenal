import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';

import { normalizePath, type SyncLibrary, type SyncTrack } from './library-sync-model';

export const resolveSeratoMediaPath = async (path: string): Promise<string> => {
  if (!isAbsolute(path) && !win32.isAbsolute(path)) return path;
  try {
    const resolved = await realpath(path);
    const dataVolume = '/System/Volumes/Data';
    if (process.platform === 'darwin' && resolved.startsWith(`${dataVolume}/`)) {
      const logical = resolved.slice(dataVolume.length);
      if (await seratoMediaPathKey(logical) === await seratoMediaPathKey(resolved)) return logical;
    }
    return resolved;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return path;
    throw error;
  }
};

export const seratoMediaPathKey = async (path: string): Promise<string> => {
  if (isAbsolute(path) || win32.isAbsolute(path)) {
    try {
      const file = await stat(path, { bigint: true });
      if (file.isFile() && file.ino !== 0n) return `file:${file.dev}:${file.ino}`;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
    }
  }
  return `path:${normalizePath(path)}`;
};

export const assertSeratoMediaFile = async (path: string): Promise<void> => {
  try {
    if ((await stat(path)).isFile()) return;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
  }
  throw new Error(`Audio file not found. Relocate it in Rekordbox before syncing: ${path}`);
};

export const resolveSeratoLibraryPaths = async (library: SyncLibrary, reference?: SyncLibrary): Promise<SyncLibrary> => {
  const nativePaths = new Map<string, string>();
  const referenceTracks = reference?.tracks ?? [];
  for (let offset = 0; offset < referenceTracks.length; offset += 32) {
    const batch = referenceTracks.slice(offset, offset + 32);
    const keys = await Promise.all(batch.map((track) => seratoMediaPathKey(track.path)));
    for (const [index, key] of keys.entries()) {
      const track = batch[index];
      if (track !== undefined && !nativePaths.has(key)) nativePaths.set(key, track.path);
    }
  }
  const paths = new Map<string, Promise<{ path: string; key: string }>>();
  const resolve = (path: string): Promise<{ path: string; key: string }> => {
    let result = paths.get(path);
    if (!result) {
      result = (async () => {
        const resolved = await resolveSeratoMediaPath(path);
        return { path: resolved, key: await seratoMediaPathKey(resolved) };
      })();
      paths.set(path, result);
    }
    return result;
  };
  const resolvedTracks = await Promise.all(library.tracks.map(async (track) => ({ track, location: await resolve(track.path) })));
  const tracks = new Map<string, SyncTrack>();
  for (const { track, location } of resolvedTracks) {
    const path = nativePaths.get(location.key) ?? location.path;
    if (!nativePaths.has(location.key)) nativePaths.set(location.key, path);
    if (!tracks.has(location.key)) tracks.set(location.key, { ...track, path });
  }
  const playlists = await Promise.all(library.playlists.map(async (playlist) => ({
    ...playlist,
    trackPaths: [...new Set(await Promise.all(playlist.trackPaths.map(async (path) => {
      const location = await resolve(path);
      return nativePaths.get(location.key) ?? location.path;
    })))],
  })));
  return { tracks: [...tracks.values()], playlists };
};
