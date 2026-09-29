import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { normalizePath, type SyncLibrary, type SyncTrack } from './library-sync-model';
import { readLibraryModel } from './portable-library';

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const loadArsenalLibrary = async (path: string): Promise<SyncLibrary | null> => {
  let serialized: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error('The Arsenal library must be a JSON file smaller than 128 MiB.');
    serialized = await readFile(path, 'utf8');
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  const document: unknown = JSON.parse(serialized);
  if (typeof document !== 'object' || document === null || !('format' in document) || document.format !== 'arsenal-library') {
    throw new Error('This file is not an Arsenal library.');
  }
  if (!('version' in document) || document.version !== 1) throw new Error('This Arsenal library version is not supported.');
  if (!('library' in document)) throw new Error('The Arsenal library is missing its collection.');
  return readLibraryModel(document.library);
};

export const saveArsenalLibrary = async (path: string, library: SyncLibrary): Promise<void> => {
  const document = { format: 'arsenal-library', version: 1, library: readLibraryModel(library) };
  const serialized = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(serialized) > 128 * 1024 * 1024) throw new Error('The Arsenal library exceeds the supported size of 128 MiB.');
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(serialized, 'utf8'); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; });
  }
};

export const mergeArsenalLibrary = (existing: SyncLibrary, incoming: SyncLibrary): SyncLibrary => {
  const mediaKey = (track: SyncTrack): string => normalizePath(track.location ?? track.path);
  const tracks = new Map(existing.tracks.map((track) => [normalizePath(track.path), track]));
  const byMedia = new Map<string, SyncTrack[]>();
  for (const track of existing.tracks) {
    const key = mediaKey(track);
    const group = byMedia.get(key) ?? [];
    group.push(track);
    byMedia.set(key, group);
  }
  const exactPaths = new Set(incoming.tracks.flatMap((track) => {
    const key = normalizePath(track.path);
    const current = tracks.get(key);
    return current !== undefined && mediaKey(current) === mediaKey(track) ? [key] : [];
  }));
  const matched = new Set<string>();
  const songIds = new Set(existing.tracks.map((track) => track.song.id));
  const importedPaths = new Map<string, string>();
  for (const track of incoming.tracks) {
    const key = normalizePath(track.path);
    const media = mediaKey(track);
    const atPath = tracks.get(key);
    const current = atPath !== undefined && !matched.has(key) && mediaKey(atPath) === media ? atPath
      : byMedia.get(media)?.find((candidate) => !matched.has(normalizePath(candidate.path)) && !exactPaths.has(normalizePath(candidate.path)));
    let saved: SyncTrack;
    if (current !== undefined) {
      saved = { ...current,
        song: { ...current.song, ...Object.fromEntries(Object.entries(track.song).filter(([, value]) => value !== null && value !== '')),
          id: current.song.id },
        ...(track.performance === undefined ? {} : { performance: track.performance }) };
    } else {
      let path = track.path;
      while (tracks.has(normalizePath(path))) path = `library-track:${randomUUID()}`;
      let id = track.song.id;
      while (songIds.has(id)) id = randomUUID();
      songIds.add(id);
      saved = { ...track, path, song: { ...track.song, id },
        ...(path === track.path ? {} : { location: track.location ?? track.path }) };
    }
    tracks.set(normalizePath(saved.path), saved);
    matched.add(normalizePath(saved.path));
    importedPaths.set(key, saved.path);
  }
  const playlists = new Map(existing.playlists.map((playlist) => [JSON.stringify(playlist.path), playlist]));
  for (const playlist of incoming.playlists) {
    const key = JSON.stringify(playlist.path);
    const current = playlists.get(key);
    const imported = playlist.trackPaths.map((path) => {
      const resolved = importedPaths.get(normalizePath(path));
      if (resolved === undefined) throw new Error(`The imported playlist references an unknown track: ${path}.`);
      return resolved;
    });
    const trackPaths = current === undefined ? imported : [...current.trackPaths];
    if (current !== undefined) {
      const present = new Set(trackPaths.map(normalizePath));
      for (const path of imported) {
        const key = normalizePath(path);
        if (!present.has(key)) { trackPaths.push(path); present.add(key); }
      }
    }
    playlists.set(key, { ...(current?.smart?.kind === 'arsenal' ? current : playlist), trackPaths });
  }
  return { tracks: [...tracks.values()], playlists: [...playlists.values()] };
};
