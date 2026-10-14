import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import type { LibraryOrganizationEntry, LibraryOrganizationPreview, LibraryOrganizationRequest } from '../shared/dj-library';
import { normalizePath, type SyncLibrary } from './library-sync-model';
import { fingerprint as fingerprintMusicFile, safeName as safeMusicName } from './portable-library';
import { isCloudPath } from './cloud-tracks';
import { isSupportedAudioPath } from './track-artwork';

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
const portableKey = (path: string): string => resolve(path).normalize('NFC').toLowerCase();
const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

export const defaultOrganizationRoot = (library: SyncLibrary): string => {
  const paths = library.tracks.filter((track) => track.song.source === 'local').map((track) => track.location ?? track.path).filter(isAbsolute);
  let root = paths[0] === undefined ? join(homedir(), 'Music') : dirname(paths[0]);
  for (const path of paths) while (!inside(root, path)) root = dirname(root);
  return root === parse(root).root || root === homedir() ? join(homedir(), 'Music') : root;
};

const stamp = async (path: string): Promise<string> => {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || normalizePath(await realpath(path)) !== normalizePath(resolve(path))) {
    throw new Error(`Choose a regular audio file without symbolic links: ${path}`);
  }
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
};

export type OrganizationPlan = Readonly<{
  preview: LibraryOrganizationPreview;
  stamps: ReadonlyMap<string, string>;
}>;

export const planLibraryOrganization = async (
  library: SyncLibrary, request: LibraryOrganizationRequest, reservedPaths: readonly string[], cloudPaths: readonly string[],
): Promise<OrganizationPlan> => {
  const root = resolve(request.destinationRoot);
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
      const info = await lstat(directory);
      available = info.isDirectory() && !info.isSymbolicLink();
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
  for (const track of library.tracks) {
    const from = track.location ?? track.path;
    if (sources.has(normalizePath(from))) continue;
    sources.add(normalizePath(from));
    const skip = (reason: Extract<LibraryOrganizationEntry, { kind: 'skip' }>['reason']) => entries.push({ kind: 'skip', from, reason });
    if (track.song.source !== 'local' || !isAbsolute(from) || isCloudPath(from) || cloud.has(normalizePath(from))) { skip('Cloud or streaming track'); continue; }
    if (!isSupportedAudioPath(from)) { skip('Conflict or unsupported file'); continue; }
    try { stamps.set(from, await stamp(from)); } catch (error) {
      skip(missing(error) ? 'Missing on disk' : 'Conflict or unsupported file'); continue;
    }
    const song = track.song;
    const artist = safeMusicName(song.artist, 'Unknown Artist');
    const album = safeMusicName(song.album, 'Unknown Album');
    const folders = (() => {
      switch (request.scheme) {
        case 'artist-album': return [artist, album];
        case 'genre-artist': return [safeMusicName(song.genre, 'Unknown Genre'), artist];
        case 'year-album': return [song.year ? String(song.year) : 'Unknown Year', album];
        case 'date-added': {
          const date = song.dateAdded === null ? NaN : Date.parse(song.dateAdded);
          return Number.isFinite(date) ? [String(new Date(date).getUTCFullYear()), String(new Date(date).getUTCMonth() + 1).padStart(2, '0')]
            : ['Unknown Year', 'Unknown Month'];
        }
        case 'flat': return [];
        default: { const unexpected: never = request.scheme; throw new Error(`Unknown organization scheme: ${unexpected}`); }
      }
    })();
    const extension = extname(from);
    const originalName = basename(from, extension);
    const name = request.renameFiles ? `${artist} - ${safeMusicName(song.title, 'Unknown Title')}` : originalName;
    // Leave room for the extension and collision suffix while preserving ordinary filenames.
    let stem = name.normalize('NFC').replace(/[<>:"/\\|?*]|\p{Cc}/gu, '_').trim().replace(/[. ]+$/g, '') || 'Unknown Title';
    while (Buffer.byteLength(stem) > 200) stem = [...stem].slice(0, -1).join('');
    if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
    const directory = join(root, ...folders);
    if (!await directoryAvailable(directory)) { skip('Conflict or unsupported file'); continue; }
    let to = join(directory, `${stem}${extension}`);
    if (resolve(from) === to) { skip('Already in place'); continue; }
    let suffix = 2;
    while (await occupied(to)) to = join(directory, `${stem} (${suffix++})${extension}`);
    used.add(portableKey(to));
    entries.push({ kind: 'move', from, to, collision: suffix > 2 });
  }
  const moves = entries.filter((entry) => entry.kind === 'move');
  return { preview: { id: randomUUID(), destinationRoot: root, entries, moveCount: moves.length,
    skippedCount: entries.length - moves.length, collisionCount: moves.filter((entry) => entry.collision).length }, stamps };
};

export const validateOrganizationPlan = async (plan: OrganizationPlan): Promise<void> => {
  for (const entry of plan.preview.entries) {
    if (entry.kind !== 'move') continue;
    if (await stamp(entry.from) !== plan.stamps.get(entry.from)) throw new Error(`The audio file changed. Preview again: ${entry.from}`);
    try { await lstat(entry.to); } catch (error) { if (missing(error)) continue; throw error; }
    throw new Error(`The destination is now occupied. Preview again: ${entry.to}`);
  }
};

export const createOrganizationDirectory = async (root: string, destination: string): Promise<void> => {
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  let directory = root;
  for (const part of relative(root, destination).split(sep).filter(Boolean)) {
    directory = join(directory, part);
    await mkdir(directory, { recursive: true });
    if ((await lstat(directory)).isSymbolicLink() || !inside(canonicalRoot, await realpath(directory))) {
      throw new Error(`The destination contains a symbolic link: ${directory}`);
    }
  }
};

export const moveMusicFile = async (from: string, to: string): Promise<void> => {
  const reservation = await open(to, 'wx', (await stat(from)).mode & 0o777);
  const reserved = await reservation.stat();
  const temporary = join(dirname(to), `.arsenal-${randomUUID()}.tmp`);
  let installed = false;
  try {
    await reservation.close();
    const assertReserved = async () => {
      const current = await lstat(to);
      if (current.dev !== reserved.dev || current.ino !== reserved.ino || current.size !== 0) throw new Error(`The destination changed during the move: ${to}`);
    };
    await assertReserved();
    try { await rename(from, to); installed = true; } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) throw error;
      const original = await fingerprintMusicFile(from);
      await copyFile(from, temporary, constants.COPYFILE_EXCL);
      const copied = await fingerprintMusicFile(temporary);
      if (copied.sha256 !== original.sha256 || copied.sizeBytes !== original.sizeBytes ||
        (await fingerprintMusicFile(from)).stamp !== original.stamp) throw new Error(`Copy verification failed: ${from}`);
      const file = await open(temporary, 'r+');
      try { await file.sync(); } finally { await file.close(); }
      await assertReserved();
      await rename(temporary, to);
      installed = true;
      try { await unlink(from); } catch (error) { await unlink(to); installed = false; throw error; }
    }
  } finally {
    await reservation.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; });
    if (!installed) {
      const current = await lstat(to).catch((error: unknown) => { if (!missing(error)) throw error; return null; });
      if (current?.dev === reserved.dev && current.ino === reserved.ino) await unlink(to);
    }
  }
};

export const copyMusicFile = async (from: string, to: string): Promise<void> => {
  const temporary = join(dirname(to), `.arsenal-${randomUUID()}.tmp`);
  try {
    const original = await fingerprintMusicFile(from);
    await copyFile(from, temporary, constants.COPYFILE_EXCL);
    const copied = await fingerprintMusicFile(temporary);
    if (copied.sha256 !== original.sha256 || copied.sizeBytes !== original.sizeBytes ||
      (await fingerprintMusicFile(from)).stamp !== original.stamp) throw new Error(`Copy verification failed: ${from}`);
    await moveMusicFile(temporary, to);
  } finally { await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; }); }
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
