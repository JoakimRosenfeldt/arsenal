import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

import { normalizePath, type SyncLibrary } from './library-sync-model';
import type { PortableLibraryManifest } from './portable-library';

export const portableLibraryPreview = (current: SyncLibrary, manifest: PortableLibraryManifest): SyncLibrary => {
  const existing = new Map(current.tracks.map((track) => [track.song.id, track]));
  for (const track of current.tracks) {
    existing.set(`track-${createHash('sha256').update(normalizePath(track.path)).digest('hex')}`, track);
  }
  const tracks = manifest.tracks.map((track) => {
    const previous = existing.get(track.id);
    const location = track.media.kind === 'local' ? track.media.originalPath : track.media.uri;
    return { path: previous?.path ?? location, location: previous?.location ?? previous?.path ?? location, song: { ...track.metadata,
      id: previous?.song.id ?? track.id, audioUrl: null, artworkUrl: null },
      ...(track.performance === undefined ? {} : { performance: track.performance }) };
  });
  const paths = new Map(manifest.tracks.map((track, index) => [track.id, tracks[index]?.path ?? '']));
  return { tracks, playlists: manifest.playlists.map((playlist) => ({ path: playlist.path, kind: playlist.kind,
    trackPaths: playlist.trackIds.map((id) => paths.get(id) ?? ''),
    ...(playlist.smart === undefined ? {} : { smart: playlist.smart }) })) };
};

export const describeLibraryChanges = (current: SyncLibrary, updated: SyncLibrary): readonly string[] => {
  const previousTracks = new Map(current.tracks.map((track) => [normalizePath(track.path), track]));
  let added = 0;
  let metadata = 0;
  let cues = 0;
  let grids = 0;
  for (const track of updated.tracks) {
    const previous = previousTracks.get(normalizePath(track.path));
    if (!previous) { added += 1; continue; }
    const songDetails = (song: typeof track.song) => ({ ...song, id: undefined, audioUrl: undefined,
      artworkUrl: undefined, cuePointCount: undefined, hotCueCount: undefined });
    if (!isDeepStrictEqual(songDetails(previous.song), songDetails(track.song))) metadata += 1;
    if (!isDeepStrictEqual(previous.performance?.hotCues ?? [], track.performance?.hotCues ?? []) ||
      !isDeepStrictEqual(previous.performance?.memoryCues ?? [], track.performance?.memoryCues ?? []) ||
      !isDeepStrictEqual(previous.performance?.loops ?? [], track.performance?.loops ?? [])) cues += 1;
    if (!isDeepStrictEqual(previous.performance?.beatgrids ?? [], track.performance?.beatgrids ?? [])) grids += 1;
  }
  const count = (value: number, singular: string, plural = `${singular}s`) => `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
  const changes = [
    ...(added ? [`${count(added, 'track')} added`] : []),
    ...(metadata ? [`Metadata updated on ${count(metadata, 'track')}`] : []),
    ...(cues ? [`Cue points or loops updated on ${count(cues, 'track')}`] : []),
    ...(grids ? [`Beatgrids updated on ${count(grids, 'track')}`] : []),
  ];
  const previousPlaylists = new Map(current.playlists.map((playlist) => [JSON.stringify(playlist.path), playlist]));
  for (const playlist of updated.playlists) {
    const previous = previousPlaylists.get(JSON.stringify(playlist.path));
    if (previous && isDeepStrictEqual({ ...previous, kind: previous.kind ?? 'playlist' }, { ...playlist, kind: playlist.kind ?? 'playlist' })) continue;
    const kind = playlist.kind === 'folder' ? 'Folder' : playlist.kind === 'smart' ? 'Smart playlist' : 'Playlist';
    const name = playlist.path.join(' / ');
    changes.push(`${kind} ${previous ? 'updated' : 'added'}: ${name}${playlist.kind === 'folder' ? '' : ` (${count(playlist.trackPaths.length, 'track')})`}`);
  }
  return changes.length ? changes : ['No new track or playlist changes to import.'];
};
