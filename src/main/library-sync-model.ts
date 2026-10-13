import { posix } from 'node:path';
import type { SongRow } from '../shared/dj-library';
import type { SmartPlaylistDefinition } from '../shared/smart-playlists';
import type { SmartPlaylistRules } from './smart-playlists';

export type SyncCue = Readonly<{ index: number; name: string; start: number; color: readonly [number, number, number] }>;
export type SyncLoop = SyncCue & Readonly<{ end: number; locked: boolean; hotCue?: boolean }>;
export type SyncBeatgrid = Readonly<{ start: number; bpm: number; beat: number; meter?: string }>;
export type SyncPerformance = Readonly<{
  hotCues: readonly SyncCue[];
  memoryCues?: readonly SyncCue[];
  loops: readonly SyncLoop[];
  beatgrids: readonly SyncBeatgrid[];
}>;
export type SyncTrack = Readonly<{ path: string; location?: string; song: SongRow; performance?: SyncPerformance }>;
export type SyncSmartRules =
  | Readonly<{ kind: 'arsenal'; definition: SmartPlaylistDefinition }>
  | Readonly<{ kind: 'rekordbox'; rules: SmartPlaylistRules }>
  | Readonly<{ kind: 'serato'; version: number; rules: string }>;
export type SyncPlaylist = Readonly<{
  path: readonly string[];
  trackPaths: readonly string[];
  kind?: 'folder' | 'playlist' | 'smart';
  smart?: SyncSmartRules;
}>;
export type SyncLibrary = Readonly<{
  tracks: readonly SyncTrack[];
  playlists: readonly SyncPlaylist[];
}>;

export type PlaylistNodeMove = Readonly<{
  sourcePath: readonly string[];
  parentPath: readonly string[];
  beforePath: readonly string[] | null;
}>;

export const normalizePath = (path: string): string => {
  const slashes = path.replaceAll('\\', '/');
  const normalized = posix.normalize(slashes);
  if (slashes.startsWith('//')) return `/${normalized}`.toLowerCase();
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
};

const sameLoop = (left: SyncLoop, right: SyncLoop): boolean =>
  Math.round(left.start * 1000) === Math.round(right.start * 1000) &&
  Math.round(left.end * 1000) === Math.round(right.end * 1000);

// Serato tags cannot store that a loop sits in a hot cue slot, so loops read from them carry no
// hotCue flag. Such a loop keeps the hot slot of the matching loop that is already known, instead
// of being demoted to a memory loop on the next Rekordbox sync.
export const preserveHotLoops = (incoming: SyncPerformance, existing: SyncPerformance | undefined): SyncPerformance => {
  if (existing === undefined) return incoming;
  const occupied = new Set([...incoming.hotCues.map((cue) => cue.index),
    ...incoming.loops.filter((loop) => loop.hotCue).map((loop) => loop.index)]);
  let changed = false;
  const loops = incoming.loops.map((loop) => {
    if (loop.hotCue !== undefined) return loop;
    const matches = existing.loops.filter((candidate) => candidate.hotCue && sameLoop(candidate, loop) && !occupied.has(candidate.index));
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match === undefined) return loop;
    changed = true;
    occupied.add(match.index);
    return { ...loop, index: match.index, hotCue: true };
  });
  return changed ? { ...incoming, loops } : incoming;
};

// Promotes every memory loop to a hot loop, for libraries where sync already turned hot loops into
// memory loops. A loop goes back into its own slot when that slot is known and free, otherwise into
// the first free slot. Loops are skipped only when every hot cue slot on the track is taken.
export const promoteHotLoops = (library: SyncLibrary): Readonly<{ library: SyncLibrary; restored: number; skipped: number; tracks: number }> => {
  let restored = 0;
  let skipped = 0;
  let tracks = 0;
  const updated = library.tracks.map((track) => {
    const performance = track.performance;
    if (performance === undefined) return track;
    const occupied = new Set([...performance.hotCues.map((cue) => cue.index),
      ...performance.loops.filter((loop) => loop.hotCue).map((loop) => loop.index)]);
    const loops: SyncLoop[] = [...performance.loops];
    let promoted = 0;
    const place = (position: number, slot: number): void => {
      const loop = loops[position];
      if (loop === undefined) return;
      loops[position] = { ...loop, index: slot, hotCue: true };
      occupied.add(slot);
      promoted += 1;
    };
    // Own slots first, so a fallback placement never steals another loop's original slot.
    loops.forEach((loop, position) => {
      if (!loop.hotCue && Number.isInteger(loop.index) && loop.index >= 0 && loop.index <= 7 && !occupied.has(loop.index)) place(position, loop.index);
    });
    loops.forEach((loop, position) => {
      if (loop.hotCue) return;
      const slot = [0, 1, 2, 3, 4, 5, 6, 7].find((candidate) => !occupied.has(candidate));
      if (slot === undefined) skipped += 1;
      else place(position, slot);
    });
    if (promoted === 0) return track;
    restored += promoted;
    tracks += 1;
    return { ...track, performance: { ...performance, loops }, song: { ...track.song,
      cuePointCount: performance.hotCues.length + (performance.memoryCues?.length ?? 0) + performance.loops.length,
      hotCueCount: performance.hotCues.length + loops.filter((loop) => loop.hotCue).length } };
  });
  return { library: restored ? { ...library, tracks: updated } : library, restored, skipped, tracks };
};

export const mergeLibraries = (preferred: SyncLibrary, other: SyncLibrary): SyncLibrary => {
  const tracks = new Map(other.tracks.map((track) => [normalizePath(track.path), track]));
  for (const track of preferred.tracks) {
    const existing = tracks.get(normalizePath(track.path));
    const song = existing ? { ...existing.song, ...Object.fromEntries(Object.entries(track.song).filter(([, value]) => value !== null && value !== '')) } : track.song;
    tracks.set(normalizePath(track.path), { ...track, song });
  }
  const playlists = new Map(preferred.playlists.map((playlist) => [JSON.stringify(playlist.path), playlist]));
  for (const playlist of other.playlists) {
    const existing = playlists.get(JSON.stringify(playlist.path));
    const paths = new Map<string, string>();
    for (const path of [...existing?.trackPaths ?? [], ...playlist.trackPaths]) {
      if (!paths.has(normalizePath(path))) paths.set(normalizePath(path), path);
    }
    playlists.set(JSON.stringify(playlist.path), { ...playlist, ...existing, trackPaths: [...paths.values()] });
  }
  return { tracks: [...tracks.values()], playlists: [...playlists.values()] };
};
