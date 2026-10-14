import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, readdir, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import type { LibraryOrganizationEntry, LibraryOrganizationPreview, LibraryOrganizationRequest } from '../shared/dj-library';
import { normalizePath, type SyncLibrary } from './library-sync-model';
import { fingerprint, safeName } from './portable-library';
import { resolveSeratoMediaPath, seratoMediaPathKey } from './serato-paths';
import { isCloudPath } from './cloud-tracks';
import { isSupportedAudioPath } from './track-artwork';

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
const portableKey = (path: string): string => resolve(path).normalize('NFC').toLowerCase();
export const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

export const defaultOrganizationRoot = (library: SyncLibrary): string => {
  const paths = library.tracks.filter((track) => track.song.source === 'local').map((track) => track.location ?? track.path).filter(isAbsolute);
  let root = paths[0] === undefined ? join(homedir(), 'Music') : dirname(paths[0]);
  for (const path of paths) while (!inside(root, path)) {
    const parent = dirname(root);
    if (parent === root) return join(homedir(), 'Music');
    root = parent;
  }
  return root === parse(root).root || root === homedir() ? join(homedir(), 'Music') : root;
};

const stamp = async (path: string): Promise<string> => {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink()) throw new Error('Audio file is a symbolic link');
  if (!info.isFile()) throw new Error('Audio path is not a regular file');
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
};

export type OrganizationPlan = Readonly<{
  preview: LibraryOrganizationPreview;
  stamps: ReadonlyMap<string, string>;
}>;

export const planLibraryOrganization = async (
  library: SyncLibrary, request: LibraryOrganizationRequest, reservedPaths: readonly string[], cloudPaths: readonly string[],
  portableRoots: readonly string[] = [], validateDestination: (from: string, to: string) => Promise<void> = async () => undefined,
  progress: (completed: number, total: number) => void = () => undefined,
): Promise<OrganizationPlan> => {
  const canonicalDirectory = async (path: string): Promise<string> => {
    try { return await realpath(path); } catch (error) {
      if (!missing(error) || dirname(path) === path) throw error;
      return join(await canonicalDirectory(dirname(path)), basename(path));
    }
  };
  const root = await canonicalDirectory(resolve(request.destinationRoot));
  const bundleRoots = await Promise.all(portableRoots.map(canonicalDirectory));
  const cloud = new Set(cloudPaths.map(normalizePath));
  const entries: LibraryOrganizationEntry[] = [];
  const stamps = new Map<string, string>();
  const sources = new Set<string>();
  const used = new Set(reservedPaths.filter(isAbsolute).map(portableKey));
  const namesByDirectory = new Map<string, ReadonlySet<string>>();
  const availableDirectories = new Map<string, boolean>();
  const directoryAvailable = async (directory: string): Promise<boolean> => {
    const cached = availableDirectories.get(directory);
    if (cached !== undefined) return cached;
    let available: boolean;
    try {
      const info = await stat(directory);
      available = info.isDirectory() && (inside(root, await realpath(directory)) || inside(await realpath(directory), root));
    } catch (error) {
      if (!missing(error)) throw error;
      available = directory !== dirname(directory) && await directoryAvailable(dirname(directory));
    }
    availableDirectories.set(directory, available);
    return available;
  };
  const occupied = async (path: string): Promise<boolean> => {
    if (used.has(portableKey(path))) return true;
    const directory = dirname(path);
    let names = namesByDirectory.get(directory);
    if (names === undefined) {
      try { names = new Set((await readdir(directory)).map((name) => name.normalize('NFC').toLowerCase())); }
      catch (error) { if (!missing(error)) throw error; names = new Set(); }
      namesByDirectory.set(directory, names);
    }
    return names.has(basename(path).normalize('NFC').toLowerCase());
  };
  for (const [index, track] of library.tracks.entries()) {
    if (index % 32 === 0) progress(index, library.tracks.length);
    let from = track.location ?? track.path;
    const skip = (reason: Extract<LibraryOrganizationEntry, { kind: 'skip' }>['reason']) => entries.push({ kind: 'skip', from, reason });
    if (track.song.source !== 'local' || !isAbsolute(from) || isCloudPath(from) || cloud.has(normalizePath(from))) { skip('Cloud or streaming track'); continue; }
    if (!isSupportedAudioPath(from)) { skip('Unsupported audio format'); continue; }
    try {
      await stamp(from);
      from = await resolveSeratoMediaPath(from);
      const key = await seratoMediaPathKey(from);
      if (sources.has(key)) continue;
      sources.add(key);
      if (bundleRoots.some((root) => inside(root, from))) { skip('Inside a portable library bundle'); continue; }
      stamps.set(from, await stamp(from));
    } catch (error) {
      skip(missing(error) ? 'Missing on disk' : error instanceof Error ? error.message : 'Could not read audio file'); continue;
    }
    const song = track.song;
    const artist = safeName(song.artist, 'Unknown Artist');
    const album = safeName(song.album, 'Unknown Album');
    const folders = (() => {
      switch (request.scheme) {
        case 'artist-album': return [artist, album];
        case 'genre-artist': return [safeName(song.genre, 'Unknown Genre'), artist];
        case 'year-album': return [song.year ? String(song.year) : 'Unknown Year', album];
        case 'date-added': {
          const date = song.dateAdded === null ? NaN : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(song.dateAdded) ? `${song.dateAdded}T00:00:00` : song.dateAdded);
          return Number.isFinite(date) ? [String(new Date(date).getFullYear()), String(new Date(date).getMonth() + 1).padStart(2, '0')]
            : ['Unknown Year', 'Unknown Month'];
        }
        case 'flat': return [];
        default: { const unexpected: never = request.scheme; throw new Error(`Unknown organization scheme: ${unexpected}`); }
      }
    })();
    const extension = extname(from);
    const originalName = basename(from, extension);
    const name = request.renameFiles ? `${artist} - ${safeName(song.title, 'Unknown Title')}` : originalName;
    // Leave room for the extension and collision suffix while preserving ordinary filenames.
    let stem = name.normalize('NFC').replace(/[<>:"/\\|?*]|\p{Cc}/gu, '_').trim().replace(/[. ]+$/g, '') || 'Unknown Title';
    while (Buffer.byteLength(stem) > 200) stem = [...stem].slice(0, -1).join('');
    if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
    const directory = await canonicalDirectory(join(root, ...folders));
    if (!inside(root, directory) || !await directoryAvailable(directory)) { skip('Destination is not a directory or leaves the chosen root'); continue; }
    let to = join(directory, `${stem}${extension}`);
    const canonicalSource = await realpath(from);
    const sourceKey = await seratoMediaPathKey(from);
    const ownDestination = async (path: string): Promise<boolean> => {
      const key = await seratoMediaPathKey(path);
      return key === sourceKey && !(await lstat(path)).isSymbolicLink() ||
        key.startsWith('path:') && portableKey(canonicalSource) === portableKey(path);
    };
    let suffix = 2;
    while (await occupied(to) && !await ownDestination(to)) to = join(directory, `${stem} (${suffix++})${extension}`);
    if (canonicalSource.normalize('NFC') === to.normalize('NFC') ||
        await ownDestination(to) && (portableKey(canonicalSource) !== portableKey(to) || (await readdir(directory)).includes(basename(to)))) {
      skip('Already in place'); continue;
    }
    try { await validateDestination(from, to); } catch (error) {
      skip(error instanceof Error ? error.message : 'Destination cannot be stored in a connected library'); continue;
    }
    used.add(portableKey(to));
    entries.push({ kind: 'move', from, to, collision: suffix > 2 });
  }
  progress(library.tracks.length, library.tracks.length);
  const moves = entries.filter((entry) => entry.kind === 'move');
  return { preview: { id: randomUUID(), destinationRoot: root, entries, moveCount: moves.length,
    skippedCount: entries.length - moves.length, collisionCount: moves.filter((entry) => entry.collision).length }, stamps };
};

export const validateOrganizationPlan = async (plan: OrganizationPlan, progress: (completed: number, total: number) => void = () => undefined): Promise<void> => {
  const moves = plan.preview.entries.filter((entry) => entry.kind === 'move');
  for (let offset = 0; offset < moves.length; offset += 32) {
    await Promise.all(moves.slice(offset, offset + 32).map(async (entry) => {
      if (await stamp(entry.from) !== plan.stamps.get(entry.from)) throw new Error(`The audio file changed. Preview again: ${entry.from}`);
      try { await lstat(entry.to); } catch (error) { if (missing(error)) return; throw error; }
      if (await seratoMediaPathKey(entry.from) !== await seratoMediaPathKey(entry.to)) {
        throw new Error(`The destination is now occupied. Preview again: ${entry.to}`);
      }
    }));
    progress(Math.min(offset + 32, moves.length), moves.length);
  }
};

export const createOrganizationDirectory = async (root: string, destination: string, created: string[] = [],
  onCreated: (directory: string) => Promise<void> = async () => undefined): Promise<void> => {
  const create = async (path: string): Promise<void> => {
    try { await mkdir(path); created.push(path); await onCreated(path); } catch (error) {
      if (missing(error)) { await create(dirname(path)); await create(path); }
      else if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  };
  await create(root);
  const canonicalRoot = await realpath(root);
  let directory = root;
  for (const part of relative(root, destination).split(sep).filter(Boolean)) {
    directory = join(directory, part);
    await create(directory);
    if (!inside(canonicalRoot, await realpath(directory))) throw new Error(`The destination leaves the chosen root: ${directory}`);
  }
};

export const removeOrganizationDirectories = async (created: readonly string[]): Promise<void> => {
  for (const path of [...created].reverse()) {
    try { await rmdir(path); } catch (error) {
      if (!missing(error) && !(error instanceof Error && 'code' in error && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST'))) throw error;
    }
  }
};

export const copyMusicFile = async (from: string, to: string): Promise<void> => {
  const info = await stat(from);
  const original = await fingerprint(from);
  await copyFile(from, to, constants.COPYFILE_EXCL);
  try {
    const copied = await fingerprint(to);
    if (copied.sha256 !== original.sha256 || copied.sizeBytes !== original.sizeBytes ||
        (await fingerprint(from)).stamp !== original.stamp) throw new Error(`Copy verification failed: ${from}`);
    await chmod(to, (info.mode & 0o777) | 0o200);
    const file = await open(to, 'r+');
    try { await file.chmod(info.mode & 0o777); await file.utimes(info.atime, info.mtime); await file.sync(); }
    finally { await file.close(); }
  } catch (error) { await unlink(to); throw error; }
};

export const moveMusicFile = async (from: string, to: string, temporary = join(dirname(from), `.arsenal-${randomUUID()}.tmp`)): Promise<void> => {
  const install = async (source: string, destination: string): Promise<void> => {
    try { await link(source, destination); } catch (error) {
      if (!(error instanceof Error && 'code' in error && ['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(String(error.code)))) throw error;
      await copyMusicFile(source, destination);
    }
  };
  try { await install(from, to); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST') ||
        (await lstat(to)).isSymbolicLink() || await seratoMediaPathKey(from) !== await seratoMediaPathKey(to)) throw error;
    // A case-only rename needs an intermediate name on case-insensitive filesystems.
    await install(from, temporary);
    await unlink(from);
    try { await install(temporary, to); } catch (error) { await install(temporary, from); throw error; }
    await unlink(temporary);
    return;
  }
  try { await unlink(from); } catch (error) { await unlink(to); throw error; }
};

export const relocatedLibrary = (library: SyncLibrary, replacements: ReadonlyMap<string, string>): SyncLibrary => {
  const paths = new Map<string, string>();
  const tracks = library.tracks.map((track) => {
    const replacement = replacements.get(normalizePath(track.location ?? track.path));
    const path = replacement !== undefined && track.location === undefined ? replacement : track.path;
    paths.set(track.path, path);
    return replacement === undefined ? track : { ...track, path, ...(track.location === undefined ? {} : { location: replacement }) };
  });
  return { tracks, playlists: library.playlists.map((playlist) => ({ ...playlist, trackPaths: playlist.trackPaths.map((path) => paths.get(path) ?? path) })) };
};
