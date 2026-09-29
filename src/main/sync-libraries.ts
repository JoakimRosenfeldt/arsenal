import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LibrarySourceKind, SyncFields, SyncRequest, SyncResult } from '../shared/dj-library';
import { evaluateArsenalSmartPlaylist } from '../shared/smart-playlists';
import { normalizePath, type SyncLibrary, type SyncTrack } from './library-sync-model';
import { parseRekordboxXml } from './parse-rekordbox-xml';
import { mergeRekordboxXml, rekordboxSyncLibrary } from './sync-rekordbox-xml';
import { assertSeratoClosed, findSeratoSource, readSeratoLibrary, writeSeratoLibrary, type SeratoSource } from './serato-library';
import { readSeratoPerformance, writeSeratoPerformance } from './serato-performance';
import { resolveSeratoLibraryPaths, resolveSeratoMediaPath } from './serato-paths';
import { automaticSyncSearchRoots, findMissingSyncFiles, searchSyncMissingFiles } from './sync-missing-files';

export const readSeratoWithPerformance = async (source: SeratoSource, includePerformance = true) => {
  const library = await readSeratoLibrary(source);
  const warnings: string[] = [];
  const tracks: SyncTrack[] = [];
  let missingFiles = false;
  for (const track of library.tracks) {
    if (!includePerformance || track.song.source !== 'local') {
      tracks.push(track);
      continue;
    }
    try {
      tracks.push({ ...track, performance: await readSeratoPerformance(track.path) });
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) missingFiles = true;
      tracks.push(track);
      warnings.push(`${basename(track.path)}: ${error instanceof Error ? error.message : 'Could not read performance data.'}`);
    }
  }
  return { library: { ...library, tracks }, warnings, missingFiles };
};

export const saveLibraryXml = async (path: string, xml: string, expected: string | null, backup = true): Promise<string | null> => {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let backupPath: string | null = null;
  try {
    const mode = expected === null ? 0o600 : (await stat(path)).mode & 0o777;
    const file = await open(temporary, 'wx', mode);
    try { await file.writeFile(xml, 'utf8'); await file.sync(); } finally { await file.close(); }
    await parseRekordboxXml(temporary);
    let current: string | null = null;
    try { current = await readFile(path, 'utf8'); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (current !== expected) throw new Error('The Rekordbox XML changed during sync. Open its connection on the Connections page and retry.');
    if (backup && expected !== null) {
      const directory = join(dirname(path), 'arsenal-backups', `${Date.now()}-${randomUUID()}`);
      await mkdir(directory, { recursive: true });
      backupPath = join(directory, basename(path));
      await copyFile(path, backupPath);
    }
    await rename(temporary, path);
    return backupPath;
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    });
  }
};

const selectedSource = (source: SyncLibrary, target: SyncLibrary, fields: SyncFields): SyncLibrary => {
  const existing = new Map(target.tracks.map((track) => [normalizePath(track.path), track]));
  const tracks = source.tracks.flatMap((track): SyncTrack[] => {
    const previous = existing.get(normalizePath(track.path));
    if (!fields.tracks && !previous) return [];
    const performance = track.performance;
    return [{ ...track,
      song: fields.metadata || !previous ? track.song : previous.song,
      ...(performance ? { performance: {
        ...performance,
        hotCues: fields.hotCues ? performance.hotCues : previous?.performance?.hotCues ?? [],
        memoryCues: fields.hotCues ? performance.memoryCues ?? previous?.performance?.memoryCues ?? [] : previous?.performance?.memoryCues ?? [],
        loops: fields.loops ? performance.loops : previous?.performance?.loops ?? [],
        beatgrids: fields.beatgrids ? performance.beatgrids : previous?.performance?.beatgrids ?? [],
      } } : {}),
    }];
  });
  const available = new Set([...tracks, ...target.tracks].map((track) => normalizePath(track.path)));
  return { tracks, playlists: fields.playlists ? source.playlists.map((playlist) => ({ ...playlist,
    trackPaths: playlist.trackPaths.filter((path) => available.has(normalizePath(path))),
  })) : [] };
};

const shiftPerformance = (library: SyncLibrary, seconds: number, fields: SyncFields): SyncLibrary => {
  if (seconds === 0) return library;
  const shift = (time: number, allowNegative = false): number => {
    const value = Math.round((time + seconds) * 1_000_000) / 1_000_000;
    if ((!allowNegative && value < 0) || !Number.isFinite(value)) throw new Error('The timing correction moves a cue or loop before the track starts. Choose a smaller correction.');
    return value;
  };
  return { ...library, tracks: library.tracks.map((track) => track.performance ? { ...track, performance: {
    ...track.performance,
    hotCues: fields.hotCues ? track.performance.hotCues.map((cue) => ({ ...cue, start: shift(cue.start) })) : track.performance.hotCues,
    ...(track.performance.memoryCues === undefined ? {} : { memoryCues: fields.hotCues
      ? track.performance.memoryCues.map((cue) => ({ ...cue, start: shift(cue.start) })) : track.performance.memoryCues }),
    loops: fields.loops ? track.performance.loops.map((loop) => ({ ...loop, start: shift(loop.start), end: shift(loop.end) })) : track.performance.loops,
    beatgrids: fields.beatgrids ? track.performance.beatgrids.map((grid) => ({ ...grid, start: shift(grid.start, true) })) : track.performance.beatgrids,
  } } : track) };
};

export const libraryForDjApp = (library: SyncLibrary, kind: LibrarySourceKind): SyncLibrary => {
  const paths = new Map(library.tracks.map((track) => [track.song.id, track.path]));
  const songs = library.tracks.map((track) => track.song);
  return { ...library, playlists: library.playlists.map((playlist) => {
    if (playlist.smart?.kind !== 'arsenal') return playlist;
    const trackPaths = evaluateArsenalSmartPlaylist(playlist.smart.definition, songs)
      .tracks.flatMap((song) => { const path = paths.get(song.id); return path === undefined ? [] : [path]; });
    return kind === 'rekordbox' ? { ...playlist, trackPaths } : { path: playlist.path, kind: 'playlist', trackPaths };
  }) };
};

export const syncArsenalLibraryToConnection = async ({ library, target, request, protectedMediaRoots = [] }: Readonly<{
  library: SyncLibrary;
  target: Readonly<{ kind: LibrarySourceKind; path: string }>;
  request: Pick<SyncRequest, 'fields' | 'mode' | 'timingOffsetMs'>;
  protectedMediaRoots?: readonly string[];
}>): Promise<SyncResult> => {
  const backupPaths: string[] = [];
  const warnings: string[] = [];
  let wroteLibrary = false;
  try {
    const serato = target.kind === 'serato' ? await findSeratoSource(target.path) : null;
    if (serato !== null) await assertSeratoClosed();
    let xml: string | null = null;
    if (serato === null) {
      try { xml = await readFile(target.path, 'utf8'); } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    const hasPerformance = request.fields.hotCues || request.fields.loops || request.fields.beatgrids;
    const native = serato === null ? null : await readSeratoWithPerformance(serato, hasPerformance);
    const destination = native?.library ?? (xml === null ? { tracks: [], playlists: [] } : rekordboxSyncLibrary(await parseRekordboxXml(target.path)));
    warnings.push(...native?.warnings ?? []);
    const projected = libraryForDjApp(library, target.kind);
    const locations = new Map(projected.tracks.map((track) => [track.path, track.location ?? track.path]));
    const local = { tracks: projected.tracks.filter((track) => track.song.source === 'local')
      .map((track) => ({ ...track, path: track.location ?? track.path })),
    playlists: projected.playlists.map((playlist) => ({ ...playlist,
      trackPaths: playlist.trackPaths.map((path) => locations.get(path) ?? path) })) };
    const source = await resolveSeratoLibraryPaths(local, destination);
    const selected = selectedSource(source, destination, request.fields);
    const missing = await findMissingSyncFiles([{ kind: target.kind, library: selected }, { kind: target.kind, library: destination }]);
    if (missing.length) {
      const found = await searchSyncMissingFiles(missing, automaticSyncSearchRoots([selected, destination], [target.path]));
      return { kind: 'missing-files', files: found.files, warnings: [...warnings, ...found.warnings], backupPaths,
        message: `Locate or remove ${missing.length} missing audio ${missing.length === 1 ? 'file' : 'files'}, then retry sync. No library changes were made.` };
    }
    if (serato === null) {
      const next = mergeRekordboxXml(selected, xml ?? undefined, request.fields, undefined, request.mode === 'replace');
      const backup = await saveLibraryXml(target.path, next, xml);
      if (backup !== null) backupPaths.push(backup);
      wroteLibrary = true;
    } else {
      const outgoing = shiftPerformance(selected, request.timingOffsetMs / 1000, request.fields);
      if (hasPerformance || request.fields.metadata) {
        const roots = await Promise.all(protectedMediaRoots.map(async (root) => normalizePath(await resolveSeratoMediaPath(root))));
        for (const track of outgoing.tracks) {
          const path = normalizePath(await resolveSeratoMediaPath(track.path));
          if (roots.some((root) => path === root || path.startsWith(`${root}/`))) {
            throw new Error('This library still uses music inside a backup folder. Import the backup again to create local working copies before syncing audio tags.');
          }
        }
      }
      if (request.fields.tracks || request.fields.metadata || request.fields.playlists) {
        const smartPaths = request.fields.playlists ? library.playlists.filter((playlist) => playlist.smart?.kind === 'arsenal').map((playlist) => playlist.path) : [];
        const saved = await writeSeratoLibrary(serato, outgoing, {
          metadata: request.fields.metadata,
          replaceTracks: request.mode === 'replace' && request.fields.tracks,
          replacePlaylists: request.mode === 'replace' && request.fields.playlists,
          ...(smartPaths.length ? { replacePlaylistPaths: smartPaths } : {}),
        });
        backupPaths.push(...saved.backupPaths);
        warnings.push(...saved.warnings);
        if (smartPaths.length) warnings.push('Arsenal smart playlists were saved as regular Serato crates. Their rules stay in Arsenal.');
        wroteLibrary = true;
      }
      if (hasPerformance || request.fields.metadata) {
        for (const track of outgoing.tracks) {
          if (!track.performance && !request.fields.metadata) continue;
          const backup = await writeSeratoPerformance(track.path, track.performance ?? { hotCues: [], loops: [], beatgrids: [] }, {
            hotCues: track.performance !== undefined && request.fields.hotCues,
            loops: track.performance !== undefined && request.fields.loops,
            beatgrids: track.performance !== undefined && request.fields.beatgrids,
          }, request.fields.metadata ? track.song : undefined);
          if (backup !== null) { backupPaths.push(backup); wroteLibrary = true; }
        }
      }
    }
    return { kind: 'synced', trackCount: selected.tracks.length, playlistCount: selected.playlists.length,
      skippedTrackCount: Math.max(0, library.tracks.length - selected.tracks.length), backupPaths, warnings,
      message: target.kind === 'serato' ? 'Arsenal library synced to Serato. Reopen Serato to load the changes.'
        : `Arsenal library saved to ${target.path}. Import its tracks and playlists into Rekordbox.` };
  } catch (error) {
    return { kind: 'rejected', warnings, backupPaths,
      message: `${error instanceof Error ? error.message : 'Could not sync the Arsenal library.'}${wroteLibrary ? ' Some destination files were already updated. Arsenal edits were kept.' : ''}` };
  }
};
