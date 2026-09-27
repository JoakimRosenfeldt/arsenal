import { posix } from 'node:path';
import type { SongRow } from '../shared/dj-library';

export type SyncCue = Readonly<{ index: number; name: string; start: number; color: readonly [number, number, number] }>;
export type SyncLoop = SyncCue & Readonly<{ end: number; locked: boolean; hotCue?: boolean }>;
export type SyncBeatgrid = Readonly<{ start: number; bpm: number; beat: number; meter?: string }>;
export type SyncPerformance = Readonly<{
  hotCues: readonly SyncCue[];
  loops: readonly SyncLoop[];
  beatgrids: readonly SyncBeatgrid[];
}>;
export type SyncTrack = Readonly<{ path: string; song: SongRow; performance?: SyncPerformance }>;
export type SyncPlaylist = Readonly<{ path: readonly string[]; trackPaths: readonly string[]; kind?: 'folder' | 'playlist' }>;
export type SyncLibrary = Readonly<{
  tracks: readonly SyncTrack[];
  playlists: readonly SyncPlaylist[];
}>;

export const normalizePath = (path: string): string => {
  const slashes = path.replaceAll('\\', '/');
  const normalized = posix.normalize(slashes);
  if (slashes.startsWith('//')) return `/${normalized}`.toLowerCase();
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
};

export const mergeLibraries = (preferred: SyncLibrary, other: SyncLibrary): SyncLibrary => {
  const tracks = new Map(other.tracks.map((track) => [normalizePath(track.path), track]));
  for (const track of preferred.tracks) {
    const existing = tracks.get(normalizePath(track.path));
    const song = existing ? { ...existing.song, ...Object.fromEntries(Object.entries(track.song).filter(([, value]) => value !== null && value !== '')) } : track.song;
    tracks.set(normalizePath(track.path), { ...track, song });
  }
  const playlists = new Map(other.playlists.map((playlist) => [JSON.stringify(playlist.path), playlist]));
  for (const playlist of preferred.playlists) {
    const existing = playlists.get(JSON.stringify(playlist.path));
    const paths = new Map<string, string>();
    for (const path of [...playlist.trackPaths, ...existing?.trackPaths ?? []]) {
      if (!paths.has(normalizePath(path))) paths.set(normalizePath(path), path);
    }
    playlists.set(JSON.stringify(playlist.path), { ...playlist, trackPaths: [...paths.values()] });
  }
  return { tracks: [...tracks.values()], playlists: [...playlists.values()] };
};
