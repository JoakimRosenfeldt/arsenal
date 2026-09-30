import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import type { LibrarySourceKind } from '../shared/dj-library';
import type { SyncLibrary } from './library-sync-model';
import { parseRekordboxXml } from './parse-rekordbox-xml';
import { PORTABLE_LIBRARY_FILENAME, portableSnapshotDate, readPortableLibrary } from './portable-library';
import { findSeratoSource } from './serato-library';
import { readSeratoWithPerformance } from './sync-libraries';
import { rekordboxSyncLibrary } from './sync-rekordbox-xml';
import { readRekordboxDatabase } from './rekordbox-database';
import { isRekordboxDatabasePath } from './rekordbox-database-connection';

export type PortableLibrarySource = Readonly<{
  manifestPath: string;
  searchRoots: readonly string[];
  resolvedPaths?: readonly string[];
}>;

const newestPortableLibrary = async (source: PortableLibrarySource, followLatest: boolean) => {
  let manifestPath = source.manifestPath;
  if (basename(manifestPath) === PORTABLE_LIBRARY_FILENAME || !followLatest) {
    return { manifest: await readPortableLibrary(manifestPath), manifestPath };
  }
  const fixedPath = join(dirname(manifestPath), PORTABLE_LIBRARY_FILENAME);
  try {
    return { manifest: await readPortableLibrary(fixedPath), manifestPath: fixedPath };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  let manifest = await readPortableLibrary(manifestPath);
  const directory = dirname(manifestPath);
  const candidates = (await readdir(directory)).flatMap((name) => {
    const date = portableSnapshotDate(name);
    return date !== null && date >= Date.parse(manifest.savedAt) && name !== basename(manifestPath)
      ? [{ path: join(directory, name), date }] : [];
  }).sort((left, right) => right.date - left.date || right.path.localeCompare(left.path));
  for (const candidate of candidates) {
    if (candidate.date < Date.parse(manifest.savedAt)) continue;
    let next: Awaited<ReturnType<typeof readPortableLibrary>>;
    try {
      next = await readPortableLibrary(candidate.path);
    } catch (error) {
      throw new Error(`A newer library snapshot could not be read: ${basename(candidate.path)}. Wait for the cloud folder to finish syncing, then try again. ${error instanceof Error ? error.message : ''}`);
    }
    if (next.name !== manifest.name && next.name !== 'Arsenal library') continue;
    const date = Date.parse(next.savedAt);
    const previousDate = Date.parse(manifest.savedAt);
    if (date > previousDate || date === previousDate && candidate.path.localeCompare(manifestPath) > 0) {
      manifest = next;
      manifestPath = candidate.path;
    }
  }
  return { manifest, manifestPath };
};

const mediaFileState = async (path: string): Promise<readonly [string, ...string[]]> => {
  try {
    const info = await stat(path, { bigint: true });
    return info.isFile()
      ? [path, String(info.dev), String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]
      : [path, 'not-file'];
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
    return [path, 'missing'];
  }
};

const mediaFilesState = async (paths: ReadonlySet<string>) => {
  const ordered = [...paths];
  const files: Awaited<ReturnType<typeof mediaFileState>>[] = [];
  for (let offset = 0; offset < ordered.length; offset += 32) {
    files.push(...await Promise.all(ordered.slice(offset, offset + 32).map(mediaFileState)));
  }
  return files;
};

const nativeMediaState = async (library: SyncLibrary) => {
  const paths = new Set(library.tracks.filter((track) => track.song.source === 'local').map((track) => track.location ?? track.path));
  const files = await mediaFilesState(paths);
  return { files, warnings: files.flatMap((file) => file[1] === 'missing' || file[1] === 'not-file'
    ? [`${basename(file[0])}: the music file is missing or unavailable.`] : []) };
};

const syncFingerprint = (library: SyncLibrary, files: readonly (readonly string[])[]): string => createHash('sha256')
  .update(JSON.stringify({ ...library, tracks: library.tracks.map((track) => ({ ...track,
    song: { ...track.song, id: undefined, artworkUrl: undefined, audioUrl: undefined },
  })) })).update(JSON.stringify(files.map(([path, state]) => [path, state === 'missing' || state === 'not-file' ? state : 'file']))).digest('hex');

export const readLibrarySource = async ({ kind, path, portableSource, followLatest = true }: Readonly<{
  kind: LibrarySourceKind;
  path: string;
  portableSource?: PortableLibrarySource;
  followLatest?: boolean;
}>): Promise<Readonly<{
  fingerprint: string;
  syncFingerprint: string;
  library: SyncLibrary | null;
  warnings: readonly string[];
  portableManifestPath: string | null;
}>> => {
  if (portableSource !== undefined) {
    const { manifest, manifestPath } = await newestPortableLibrary(portableSource, followLatest);
    const sourcePaths = new Set(manifest.tracks.flatMap((track) => track.media.kind !== 'local' ? [] : [
      ...(track.media.relativePath === null ? [] : [join(dirname(manifestPath), track.media.relativePath)]),
      ...(isAbsolute(track.media.originalPath) ? [track.media.originalPath] : []),
    ]));
    const paths = new Set([...sourcePaths, ...portableSource.resolvedPaths ?? []]);
    const files = (await mediaFilesState(paths)).map((state) => sourcePaths.has(state[0]) ? state
      : [state[0], state[1] === 'missing' || state[1] === 'not-file' ? state[1] : 'file']);
    const fingerprint = createHash('sha256').update(JSON.stringify({
      ...manifest, savedAt: undefined, files,
    })).digest('hex');
    return { fingerprint, syncFingerprint: createHash('sha256').update(JSON.stringify({ ...manifest, savedAt: undefined,
      files: files.map(([path, state]) => [path, state === 'missing' || state === 'not-file' ? state : 'file']),
    })).digest('hex'), library: null, portableManifestPath: manifestPath, warnings: [] };
  }
  if (kind === 'rekordbox') {
    if (isRekordboxDatabasePath(path)) {
      const library = await readRekordboxDatabase(path);
      const media = await nativeMediaState(library);
      return { fingerprint: createHash('sha256').update(JSON.stringify(library)).update(JSON.stringify(media.files)).digest('hex'),
        syncFingerprint: syncFingerprint(library, media.files), library, warnings: media.warnings, portableManifestPath: null };
    }
    const parsed = await parseRekordboxXml(path);
    const library = rekordboxSyncLibrary(parsed, { includeNonLocal: true });
    const media = await nativeMediaState(library);
    return { fingerprint: createHash('sha256').update(parsed.fingerprint).update(JSON.stringify(media.files)).digest('hex'),
      syncFingerprint: syncFingerprint(library, media.files), library, warnings: media.warnings, portableManifestPath: null };
  }
  const read = await readSeratoWithPerformance(await findSeratoSource(path));
  const media = await nativeMediaState(read.library);
  return { fingerprint: createHash('sha256').update(JSON.stringify(read.library)).update(JSON.stringify(media.files)).digest('hex'),
    syncFingerprint: syncFingerprint(read.library, media.files),
    library: read.library, warnings: [...new Set([...read.warnings, ...media.warnings])], portableManifestPath: null };
};
