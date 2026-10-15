import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rmdir, stat, statfs, unlink, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import type { LibraryOrganizationEntry, LibraryOrganizationPreview, LibraryOrganizationRequest } from '../shared/dj-library';
import { LIBRARY_ORGANIZATION_SCHEMES, readOrganizationOperation } from '../shared/dj-library';
import { organizationFieldValue, readOrganizationLayout, type LibraryOrganizationLayout } from '../shared/library-organization';
import { normalizePath, type SyncLibrary } from './library-sync-model';
import { fingerprint, safeName } from './portable-library';
import { resolveSeratoMediaPath, seratoMediaPathKey } from './serato-paths';
import { isCloudPath } from './cloud-tracks';
import { isSupportedAudioPath } from './track-artwork';

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const portableKey = (path: string): string => resolve(path).normalize('NFC').toLowerCase();
export const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

export const canonicalOrganizationPath = async (path: string, allowUnreadable = false): Promise<string> => {
  try { return await resolveSeratoMediaPath(await realpath(path)); } catch (error) {
    if (allowUnreadable && error instanceof Error && 'code' in error && ['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM'].includes(String(error.code))) return resolve(path);
    if (!missing(error) || dirname(path) === path) throw error;
    return join(await canonicalOrganizationPath(dirname(path), allowUnreadable), basename(path));
  }
};

export const sameOrganizationFile = async (left: string, right: string): Promise<boolean> => {
  try {
    const [a, b] = await Promise.all([stat(left, { bigint: true }), stat(right, { bigint: true })]);
    return a.dev !== 0n && a.ino !== 0n && b.dev !== 0n && b.ino !== 0n ? a.dev === b.dev && a.ino === b.ino
      : (await canonicalOrganizationPath(left)).normalize('NFC') === (await canonicalOrganizationPath(right)).normalize('NFC');
  } catch (error) { if (missing(error)) return false; throw error; }
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

export const organizationFileStamp = async (path: string): Promise<string> => {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink()) throw new Error('Audio file is a symbolic link');
  if (!info.isFile()) throw new Error('Audio path is not a regular file');
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
};

export type ExistingOrganizationCopy = Readonly<{ from: string; to: string; stamp: string; sha256: string }>;

export type OrganizationPlan = Readonly<{
  preview: LibraryOrganizationPreview;
  stamps: ReadonlyMap<string, string>;
  existingCopies: ReadonlyMap<string, ExistingOrganizationCopy>;
}>;

export const validateExistingOrganizationCopies = async (copies: Iterable<ExistingOrganizationCopy>): Promise<void> => {
  for (const copy of copies) if (await organizationFileStamp(copy.to) !== copy.stamp || (await fingerprint(copy.to)).sha256 !== copy.sha256 ||
    await organizationFileStamp(copy.to) !== copy.stamp) throw new Error(`The existing copy changed. Preview again: ${copy.to}`);
};

export const readOrganizationRequest = (value: unknown): LibraryOrganizationRequest => {
  if (typeof value !== 'object' || value === null || !('destinationRoot' in value) || typeof value.destinationRoot !== 'string' ||
    !isAbsolute(value.destinationRoot) || value.destinationRoot.includes('\0') || value.destinationRoot.length > 32768 ||
    !('renameFiles' in value) || typeof value.renameFiles !== 'boolean' || !('scheme' in value)) throw new Error('Choose an absolute destination folder and filename option.');
  const scheme = LIBRARY_ORGANIZATION_SCHEMES.find((option) => option.value === value.scheme)?.value;
  if (scheme === undefined) throw new Error('Choose an organization scheme.');
  return { destinationRoot: value.destinationRoot, scheme, renameFiles: value.renameFiles,
    operation: readOrganizationOperation('operation' in value ? value.operation : undefined),
    ...('layout' in value && value.layout !== undefined ? { layout: readOrganizationLayout(value.layout) } : {}) };
};

export const organizationCopySpace = async (plan: OrganizationPlan): Promise<NonNullable<LibraryOrganizationPreview['copySpace']>> => {
  const sizes = plan.preview.entries.flatMap((entry) => {
    if (entry.kind !== 'move') return [];
    const size = plan.stamps.get(entry.from)?.split(':')[2];
    if (size === undefined) throw new Error(`The preview has no file size: ${entry.from}`);
    return [BigInt(size)];
  });
  let blockSize = 1n;
  let availableBytes: number | null = null;
  let path = plan.preview.destinationRoot;
  for (;;) {
    try {
      const info = await statfs(path, { bigint: true });
      if (info.bsize > 0n && info.bavail >= 0n) {
        blockSize = info.bsize;
        availableBytes = Number(info.bavail * blockSize);
      }
      break;
    } catch (error) {
      if (!missing(error) || dirname(path) === path) break;
      path = dirname(path);
    }
  }
  const requiredBytes = Number(sizes.reduce((total, size) => total + (size + blockSize - 1n) / blockSize * blockSize, 0n));
  return { requiredBytes, availableBytes };
};

export const planLibraryOrganization = async (
  library: SyncLibrary, request: LibraryOrganizationRequest, reservedPaths: readonly string[],
  portableRoots: readonly string[] = [], validateDestination: (from: string, to: string) => Promise<void> = async () => undefined,
  progress: (completed: number, total: number) => void = () => undefined,
): Promise<OrganizationPlan> => {
  const root = resolve(request.destinationRoot);
  const preset = LIBRARY_ORGANIZATION_SCHEMES.find((preset) => preset.value === request.scheme);
  if (preset === undefined) throw new Error('Choose an organization scheme.');
  const layout: LibraryOrganizationLayout = request.layout ?? { folders: preset.folders, artists: { kind: 'all' },
    filename: request.renameFiles ? { kind: 'fields', fields: ['artist', 'title'], separator: ' - ' } : { kind: 'original' } };
  const canonicalRoot = await canonicalOrganizationPath(root);
  const bundleRoots = await Promise.all(portableRoots.map((path) => canonicalOrganizationPath(path)));
  const entries: LibraryOrganizationEntry[] = [];
  const stamps = new Map<string, string>();
  const existingCopies = new Map<string, ExistingOrganizationCopy>();
  const sources = new Set<string>();
  const used = new Set(await Promise.all(reservedPaths.filter(isAbsolute).map(async (path) => portableKey(await canonicalOrganizationPath(path, true)))));
  const namesByDirectory = new Map<string, ReadonlySet<string>>();
  const availableDirectories = new Map<string, boolean>();
  const directoryAvailable = async (directory: string): Promise<boolean> => {
    const cached = availableDirectories.get(directory);
    if (cached !== undefined) return cached;
    let available: boolean;
    try {
      const info = await stat(directory);
      available = info.isDirectory() && (inside(canonicalRoot, await canonicalOrganizationPath(directory)) || inside(await canonicalOrganizationPath(directory), canonicalRoot));
    } catch (error) {
      if (!missing(error)) throw error;
      available = directory !== dirname(directory) && await directoryAvailable(dirname(directory));
    }
    availableDirectories.set(directory, available);
    return available;
  };
  const occupied = async (path: string): Promise<boolean> => {
    if (used.has(portableKey(await canonicalOrganizationPath(path)))) return true;
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
    if (!isAbsolute(from) || isCloudPath(from)) { skip('Cloud or streaming track'); continue; }
    if (!isSupportedAudioPath(from)) { skip('Unsupported audio format'); continue; }
    try {
      await organizationFileStamp(from);
      from = resolve(from);
      const canonicalSource = await canonicalOrganizationPath(from);
      const key = await seratoMediaPathKey(from);
      if (sources.has(key)) { skip('Shares audio with another library entry; relocated together if that entry moves'); continue; }
      sources.add(key);
      if (bundleRoots.some((root) => inside(root, canonicalSource))) { skip('Inside a portable library bundle'); continue; }
      stamps.set(from, await organizationFileStamp(from));
    } catch (error) {
      skip(missing(error) ? 'Missing on disk' : error instanceof Error ? error.message : 'Could not read audio file'); continue;
    }
    const song = track.song;
    const value = (field: Parameters<typeof organizationFieldValue>[1]) => safeName(organizationFieldValue(song, field, layout.artists), 'Unknown');
    const folders = layout.folders.map(value);
    const extension = extname(from);
    const originalName = basename(from, extension);
    const name = layout.filename.kind === 'fields' ? layout.filename.fields.map(value).join(layout.filename.separator) : originalName;
    // Leave room for the extension and collision suffix while preserving ordinary filenames.
    let stem = name.normalize('NFC').replace(/[<>:"/\\|?*]|\p{Cc}/gu, '_').trim().replace(/[. ]+$/g, '') || 'Unknown Title';
    while (Buffer.byteLength(stem) > 200) stem = [...stem].slice(0, -1).join('');
    if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
    const directory = join(root, ...folders);
    const canonicalDirectory = await canonicalOrganizationPath(directory);
    if (!inside(canonicalRoot, canonicalDirectory) || !await directoryAvailable(directory)) { skip('Destination is not a directory or leaves the chosen root'); continue; }
    let to = join(directory, `${stem}${extension}`);
    const canonicalSource = await canonicalOrganizationPath(from);
    const sourceKey = await seratoMediaPathKey(from);
    const ownDestination = async (path: string): Promise<boolean> => {
      const key = await seratoMediaPathKey(path);
      return key === sourceKey && !(await lstat(path)).isSymbolicLink() &&
        (request.operation?.kind !== 'copy' || portableKey(canonicalSource) === portableKey(join(canonicalDirectory, basename(path)))) ||
        key.startsWith('path:') && portableKey(canonicalSource) === portableKey(join(canonicalDirectory, basename(path)));
    };
    let suffix = 2;
    let existingCopy: ExistingOrganizationCopy | null = null;
    while (await occupied(to) && !await ownDestination(to)) {
      if (request.operation?.kind === 'copy') {
        try {
          const info = await lstat(to, { bigint: true });
          if (info.isFile() && info.size.toString() === stamps.get(from)?.split(':')[2]) {
            const stamp = await organizationFileStamp(to);
            const original = await fingerprint(from);
            const candidate = await fingerprint(to);
            if (await organizationFileStamp(from) !== stamps.get(from) || await organizationFileStamp(to) !== stamp) throw new Error('An audio file changed during preview. Preview again.');
            if (original.sha256 === candidate.sha256) { existingCopy = { from, to, stamp, sha256: original.sha256 }; break; }
          }
        } catch (error) { if (!missing(error)) throw error; }
      }
      to = join(directory, `${stem} (${suffix++})${extension}`);
    }
    if (existingCopy !== null) {
      try { await validateDestination(from, to); } catch (error) {
        skip(error instanceof Error ? error.message : 'Destination cannot be stored in a connected library'); continue;
      }
      existingCopies.set(from, existingCopy);
      entries.push({ kind: 'skip', from, reason: 'Identical copy already exists', existingCopy: to });
      continue;
    }
    const temporaryName = `.arsenal-${randomUUID()}.tmp`;
    if (process.platform === 'win32' && Math.max(to.length, join(directory, `${temporaryName}.copy`).length) > 259) { skip('Destination path exceeds the Windows 259-character limit'); continue; }
    const canonicalDestination = join(canonicalDirectory, basename(to));
    if (canonicalSource.normalize('NFC') === canonicalDestination.normalize('NFC') ||
        await ownDestination(to) && (request.operation?.kind === 'copy' || portableKey(canonicalSource) !== portableKey(canonicalDestination) || (await readdir(directory)).includes(basename(to)))) {
      skip('Already in place'); continue;
    }
    try { await validateDestination(from, to); } catch (error) {
      skip(error instanceof Error ? error.message : 'Destination cannot be stored in a connected library'); continue;
    }
    used.add(portableKey(canonicalDestination));
    entries.push({ kind: 'move', from, to, collision: suffix > 2 });
  }
  progress(library.tracks.length, library.tracks.length);
  const moves = entries.filter((entry) => entry.kind === 'move');
  const plan: OrganizationPlan = { preview: { id: randomUUID(), destinationRoot: root, operation: request.operation ?? { kind: 'move' }, entries, moveCount: moves.length,
    skippedCount: entries.length - moves.length, collisionCount: moves.filter((entry) => entry.collision).length, copySpace: null }, stamps, existingCopies };
  return request.operation?.kind === 'copy' ? { ...plan, preview: { ...plan.preview, copySpace: await organizationCopySpace(plan) } } : plan;
};

export const validateOrganizationPlan = async (plan: OrganizationPlan, progress: (completed: number, total: number) => void = () => undefined): Promise<void> => {
  const moves = plan.preview.entries.filter((entry) => entry.kind === 'move' || entry.existingCopy !== undefined);
  for (let offset = 0; offset < moves.length; offset += 32) {
    await Promise.all(moves.slice(offset, offset + 32).map(async (entry) => {
      if (await organizationFileStamp(entry.from) !== plan.stamps.get(entry.from)) throw new Error(`The audio file changed. Preview again: ${entry.from}`);
      if (entry.kind === 'skip') {
        const copy = plan.existingCopies.get(entry.from);
        if (copy === undefined || copy.to !== entry.existingCopy) throw new Error('The preview is missing an existing copy. Preview again.');
        await validateExistingOrganizationCopies([copy]);
        return;
      }
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
    try { await mkdir(path); created.push(path); await onCreated(path); await syncOrganizationDirectory(dirname(path)); } catch (error) {
      if (missing(error) && dirname(path) !== path) { await create(dirname(path)); await create(path); }
      else if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST') || !(await stat(path)).isDirectory()) throw error;
    }
  };
  await create(root);
  const canonicalRoot = await canonicalOrganizationPath(root);
  let directory = root;
  for (const part of relative(root, destination).split(sep).filter(Boolean)) {
    directory = join(directory, part);
    await create(directory);
    if (!inside(canonicalRoot, await canonicalOrganizationPath(directory))) throw new Error(`The destination leaves the chosen root: ${directory}`);
  }
};

export const removeOrganizationDirectories = async (created: readonly string[]): Promise<void> => {
  for (const path of [...created].reverse()) {
    try { await rmdir(path); } catch (error) {
      if (!missing(error) && !(error instanceof Error && 'code' in error && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST'))) throw error;
    }
  }
};

export const removeEmptyOrganizationSourceDirectories = async (
  moves: readonly Readonly<{ from: string; to: string }>[], destinationRoot?: string,
): Promise<string[]> => {
  const protectedDirectories = new Set([normalizePath(await canonicalOrganizationPath(homedir()))]);
  for (const path of new Set([...moves.map((move) => dirname(move.to)), ...(destinationRoot === undefined ? [] : [destinationRoot])])) {
    let directory = await canonicalOrganizationPath(path, true);
    for (;;) {
      protectedDirectories.add(normalizePath(directory));
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const directories = new Set<string>();
  const warnings: string[] = [];
  for (const path of new Set(moves.map((move) => dirname(move.from)))) {
    try {
      let directory = await canonicalOrganizationPath(path);
      while (!protectedDirectories.has(normalizePath(directory)) && dirname(directory) !== directory &&
        (process.platform === 'win32' || dirname(directory) !== parse(directory).root)) {
        directories.add(directory);
        directory = dirname(directory);
      }
    } catch (error) { warnings.push(`Could not check the old folder ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`); }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try {
      const info = await lstat(directory);
      if (info.isDirectory() && !info.isSymbolicLink()) await rmdir(directory);
    } catch (error) {
      if (!missing(error) && !(error instanceof Error && 'code' in error && ['ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(String(error.code)))) {
        warnings.push(`Could not remove the empty old folder ${directory}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }
  return warnings;
};

export const syncOrganizationDirectory = async (path: string): Promise<void> => {
  if (process.platform === 'win32') return;
  try {
    const directory = await open(path, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EISDIR'].includes(String(error.code)))) throw error;
  }
};

const syncOrganizationFile = async (path: string): Promise<void> => {
  if (process.platform === 'win32') await chmod(path, (await stat(path)).mode | 0o200).catch(() => undefined);
  const file = await open(path, process.platform === 'win32' ? 'r+' : 'r');
  try { await file.sync(); } catch (error) {
    if (!(error instanceof Error && 'code' in error && ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EISDIR'].includes(String(error.code)))) throw error;
  } finally { await file.close(); }
};

type MusicInstallOptions = Readonly<{
  copyOnly?: boolean;
  signal?: AbortSignal;
  onCopy?: (sha256: string) => Promise<void>;
  onDestination?: (stamp: string, installed: boolean) => Promise<void>;
}>;

export const copyMusicFile = async (from: string, to: string, options: MusicInstallOptions = {}): Promise<void> => {
  options.signal?.throwIfAborted();
  const info = await stat(from);
  const originalStamp = await organizationFileStamp(from);
  const hash = createHash('sha256');
  const file = await open(to, 'wx');
  try {
    await options.onDestination?.(await organizationFileStamp(to), false);
    const source = await open(from, 'r');
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        options.signal?.throwIfAborted();
        if (bytesRead === 0) break;
        const bytes = buffer.subarray(0, bytesRead);
        hash.update(bytes);
        await file.writeFile(bytes);
      }
    } finally { await source.close(); }
  } finally { await file.close(); }
  const sha256 = hash.digest('hex');
  const copied = await fingerprint(to, options.signal);
  if (copied.sha256 !== sha256 || copied.sizeBytes !== info.size ||
      await organizationFileStamp(from) !== originalStamp) throw new Error(`Copy verification failed: ${from}`);
  await chmod(to, info.mode & 0o777).catch(() => undefined);
  await utimes(to, info.atime, info.mtime).catch(() => undefined);
  options.signal?.throwIfAborted();
  await options.onCopy?.(sha256);
};

export const installMusicFile = async (from: string, to: string, options: MusicInstallOptions = {}): Promise<void> => {
  if (options.copyOnly) await copyMusicFile(from, to, options);
  else try { await link(from, to); } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOENT')) throw error;
    await copyMusicFile(from, to, options);
  }
  await syncOrganizationFile(to);
  await syncOrganizationDirectory(dirname(to));
  await options.onDestination?.(await organizationFileStamp(to), true);
};

export const unlinkMusicFile = async (path: string): Promise<void> => {
  try { await unlink(path); } catch (error) {
    if (process.platform !== 'win32' || !(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
    await chmod(path, (await stat(path)).mode | 0o200);
    await unlink(path);
  }
  await syncOrganizationDirectory(dirname(path));
};

export const moveMusicFile = async (from: string, to: string, temporary = join(dirname(to), `.arsenal-${randomUUID()}.tmp`),
  options: MusicInstallOptions = {}): Promise<void> => {
  const originalStamp = await organizationFileStamp(from);
  try { await installMusicFile(from, to, options); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST') ||
        (await lstat(to)).isSymbolicLink() || !await sameOrganizationFile(from, to)) throw error;
    await rename(from, temporary);
    await syncOrganizationDirectory(dirname(from));
    await syncOrganizationDirectory(dirname(temporary));
    try { await installMusicFile(temporary, to, options); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST') || !await sameOrganizationFile(temporary, to)) throw error;
      await options.onDestination?.(await organizationFileStamp(to), true);
    }
    await unlinkMusicFile(temporary);
    return;
  }
  if (await organizationFileStamp(from) !== originalStamp) throw new Error(`The source changed while moving: ${from}`);
  if (await sameOrganizationFile(from, to)) {
    await rename(from, temporary);
    await syncOrganizationDirectory(dirname(from));
    await syncOrganizationDirectory(dirname(temporary));
    await unlinkMusicFile(temporary);
  } else await unlinkMusicFile(from);
};

export const relocatedLibrary = (library: SyncLibrary, replacements: ReadonlyMap<string, string>): SyncLibrary => {
  const destinations = library.tracks.map((track) => replacements.get(normalizePath(track.location ?? track.path)) ?? track.location ?? track.path);
  const counts = new Map<string, number>();
  for (const destination of destinations) counts.set(normalizePath(destination), (counts.get(normalizePath(destination)) ?? 0) + 1);
  const paths = new Map<string, string>();
  const tracks = library.tracks.map((track) => {
    const replacement = replacements.get(normalizePath(track.location ?? track.path));
    const path = replacement !== undefined && track.location === undefined && counts.get(normalizePath(replacement)) === 1 ? replacement : track.path;
    paths.set(track.path, path);
    return replacement === undefined ? track : { ...track, path, song: { ...track.song, source: 'local' as const },
      ...(path === replacement && track.location === undefined ? {} : { location: replacement }) };
  });
  return { tracks, playlists: library.playlists.map((playlist) => ({ ...playlist, trackPaths: playlist.trackPaths.map((path) => paths.get(path) ?? path) })) };
};
