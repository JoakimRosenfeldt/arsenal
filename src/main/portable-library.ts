import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, opendir, readdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { SONG_SOURCE_LABELS, type SongRow } from '../shared/dj-library';
import { readSmartDefinition } from '../shared/smart-playlists';
import {
  normalizePath, type SyncBeatgrid, type SyncCue, type SyncLibrary,
  type SyncLoop, type SyncPerformance, type SyncSmartRules,
} from './library-sync-model';

type PortableMetadata = Omit<SongRow, 'id' | 'artworkUrl' | 'audioUrl'>;
type PortableMedia =
  | Readonly<{ kind: 'local'; originalPath: string; sizeBytes: number | null; sha256: string | null; relativePath: string | null }>
  | Readonly<{ kind: 'reference'; uri: string }>;
type PortableTrack = Readonly<{ id: string; metadata: PortableMetadata; media: PortableMedia; performance?: SyncPerformance }>;
type PortablePlaylist = Readonly<{
  id: string; path: readonly string[]; kind: 'folder' | 'playlist' | 'smart';
  trackIds: readonly string[]; smart?: SyncSmartRules;
}>;

export type PortableLibraryManifest = Readonly<{
  format: 'dj-library'; version: 1; name: string; savedAt: string; includeMusic: boolean;
  tracks: readonly PortableTrack[]; playlists: readonly PortablePlaylist[];
}>;

const invalid = (field: string): never => { throw new Error(`Invalid portable library: ${field}.`); };
const record = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(field);
  return value as Record<string, unknown>;
};
const text = (value: unknown, field: string, max = 1_000_000): string => {
  if (typeof value !== 'string' || value.length > max) return invalid(field);
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return invalid(field);
  }
  return value;
};
const nonempty = (value: unknown, field: string): string => {
  const result = text(value, field, 32768);
  if (!result.trim()) return invalid(field);
  return result;
};
const number = (value: unknown, field: string, minimum = 0, integer = false): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || integer && !Number.isSafeInteger(value)) return invalid(field);
  return value;
};
const boolean = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') return invalid(field);
  return value;
};
const array = (value: unknown, field: string, max = 1_000_000): unknown[] => {
  if (!Array.isArray(value) || value.length > max) return invalid(field);
  return value;
};
const nullableText = (value: unknown, field: string) => value === null ? null : text(value, field);
const nullableNumber = (value: unknown, field: string, integer = false) => value === null ? null : number(value, field, 0, integer);

const readMetadata = (value: unknown): PortableMetadata => {
  const raw = record(value, 'track metadata');
  const source = Object.keys(SONG_SOURCE_LABELS).find((key): key is SongRow['source'] => key === raw.source);
  if (source === undefined) return invalid('track source');
  return {
    title: text(raw.title, 'title'), artist: nullableText(raw.artist, 'artist'),
    composer: nullableText(raw.composer, 'composer'), remixer: nullableText(raw.remixer, 'remixer'),
    album: nullableText(raw.album, 'album'), mixName: nullableText(raw.mixName, 'mixName'),
    label: nullableText(raw.label, 'label'), genre: nullableText(raw.genre, 'genre'),
    year: nullableNumber(raw.year, 'year'), bpm: nullableNumber(raw.bpm, 'bpm'),
    musicalKey: nullableText(raw.musicalKey, 'musicalKey'), durationSeconds: nullableNumber(raw.durationSeconds, 'durationSeconds'),
    fileKind: nullableText(raw.fileKind, 'fileKind'), fileSizeBytes: nullableNumber(raw.fileSizeBytes, 'fileSizeBytes', true),
    bitRateKbps: nullableNumber(raw.bitRateKbps, 'bitRateKbps'), sampleRateHz: nullableNumber(raw.sampleRateHz, 'sampleRateHz'),
    trackNumber: nullableNumber(raw.trackNumber, 'trackNumber'), discNumber: nullableNumber(raw.discNumber, 'discNumber'),
    playCount: nullableNumber(raw.playCount, 'playCount'), rating: nullableNumber(raw.rating, 'rating'),
    dateAdded: nullableText(raw.dateAdded, 'dateAdded'), comments: nullableText(raw.comments, 'comments'),
    source, cuePointCount: number(raw.cuePointCount, 'cuePointCount', 0, true), hotCueCount: number(raw.hotCueCount, 'hotCueCount', 0, true),
  };
};

const readCue = (value: unknown, minimumIndex: number): SyncCue => {
  const raw = record(value, 'cue');
  const color = array(raw.color, 'cue color', 3);
  if (color.length !== 3) return invalid('cue color');
  const channel = (value: unknown): number => {
    const result = number(value, 'cue color channel', 0, true);
    return result <= 255 ? result : invalid('cue color channel');
  };
  return { index: number(raw.index, 'cue index', minimumIndex, true), name: text(raw.name, 'cue name'),
    start: number(raw.start, 'cue start'), color: [channel(color[0]), channel(color[1]), channel(color[2])] };
};

const readPerformance = (value: unknown): SyncPerformance => {
  const raw = record(value, 'performance');
  const hotCues = array(raw.hotCues, 'hot cues', 10000).map((value) => readCue(value, 0));
  const memoryCues = raw.memoryCues === undefined ? [] : array(raw.memoryCues, 'memory cues', 10000).map((value) => {
    const cue = readCue(value, -1);
    if (cue.index !== -1) return invalid('memory cue index');
    return cue;
  });
  const loops = array(raw.loops, 'loops', 10000).map((value): SyncLoop => {
    const raw = record(value, 'loop');
    const cue = readCue(raw, -1);
    const end = number(raw.end, 'loop end');
    if (end <= cue.start) return invalid('loop end');
    const hotCue = raw.hotCue === undefined ? undefined : boolean(raw.hotCue, 'hot loop');
    if (hotCue && cue.index < 0) return invalid('hot loop index');
    return { ...cue, end, locked: boolean(raw.locked, 'loop lock'), ...(hotCue === undefined ? {} : { hotCue }) };
  });
  const beatgrids = array(raw.beatgrids, 'beatgrids', 100000).map((value): SyncBeatgrid => {
    const grid = record(value, 'beatgrid');
    const bpm = number(grid.bpm, 'beatgrid BPM');
    if (bpm === 0) return invalid('beatgrid BPM');
    return { start: number(grid.start, 'beatgrid start', -Infinity), bpm, beat: number(grid.beat, 'beat number', 1, true),
      ...(grid.meter === undefined ? {} : { meter: nonempty(grid.meter, 'beatgrid meter') }) };
  });
  const cueSlots = new Set<number>();
  for (const cue of [...hotCues, ...loops.filter((loop) => loop.hotCue)]) {
    if (cueSlots.has(cue.index)) return invalid('duplicate hot cue slot');
    cueSlots.add(cue.index);
  }
  return { hotCues, loops, beatgrids, ...(raw.memoryCues === undefined ? {} : { memoryCues }) };
};

const readSmart = (value: unknown): SyncSmartRules => {
  const raw = record(value, 'smart playlist rules');
  if (raw.kind === 'arsenal') {
    const definition = readSmartDefinition(raw.definition);
    return definition === null ? invalid('smart playlist definition') : { kind: 'arsenal', definition };
  }
  if (raw.kind === 'serato') return { kind: 'serato', version: number(raw.version, 'Serato rules version', 0, true), rules: text(raw.rules, 'Serato rules') };
  if (raw.kind !== 'rekordbox') return invalid('smart playlist rule type');
  const rules = record(raw.rules, 'Rekordbox rules');
  return { kind: 'rekordbox', rules: {
    logicalOperator: nullableText(rules.logicalOperator, 'rule combination'),
    conditions: array(rules.conditions, 'rule conditions', 10000).map((value) =>
      Object.fromEntries(Object.entries(record(value, 'rule condition')).map(([key, value]) => [text(key, 'rule property'), text(value, 'rule value')]))),
  } };
};

const readManifest = (value: unknown): PortableLibraryManifest => {
  const raw = record(value, 'document');
  if (raw.format !== 'dj-library') throw new Error('This file is not a portable DJ library.');
  if (raw.version !== 1) throw new Error('This portable library version is not supported.');
  const ids = new Set<string>();
  const tracks = array(raw.tracks, 'tracks').map((value): PortableTrack => {
    const raw = record(value, 'track');
    const id = nonempty(raw.id, 'track ID');
    if (ids.has(id)) return invalid('duplicate track ID');
    ids.add(id);
    const metadata = readMetadata(raw.metadata);
    const file = record(raw.media, 'track media');
    let media: PortableMedia;
    if (file.kind === 'local') {
      if (metadata.source !== 'local') return invalid('local media source');
      const sha256 = nullableText(file.sha256, 'SHA-256');
      const sizeBytes = nullableNumber(file.sizeBytes, 'media size', true);
      const relativePath = nullableText(file.relativePath, 'media path');
      if (sha256 !== null && !/^[a-f0-9]{64}$/.test(sha256)) return invalid('SHA-256');
      if (sha256 !== null && sizeBytes === null) return invalid('hashed media size');
      if (relativePath !== null && (sha256 === null || !new RegExp(`^media/${sha256}(?:\\.[a-z0-9]{1,12})?$`).test(relativePath))) return invalid('relative media path');
      media = { kind: 'local', originalPath: nonempty(file.originalPath, 'original path'), sizeBytes, sha256, relativePath };
    } else if (file.kind === 'reference' && metadata.source !== 'local') {
      media = { kind: 'reference', uri: nonempty(file.uri, 'source reference') };
    } else return invalid('media type');
    return { id, metadata, media, ...(raw.performance === undefined ? {} : { performance: readPerformance(raw.performance) }) };
  });
  const playlistIds = new Set<string>();
  const playlistPaths = new Set<string>();
  const playlists = array(raw.playlists, 'playlists', 100000).map((value): PortablePlaylist => {
    const raw = record(value, 'playlist');
    const id = nonempty(raw.id, 'playlist ID');
    if (playlistIds.has(id)) return invalid('duplicate playlist ID');
    playlistIds.add(id);
    const path = array(raw.path, 'playlist path', 100).map((value) => nonempty(value, 'playlist name'));
    if (!path.length) return invalid('playlist path');
    const key = JSON.stringify(path);
    if (playlistPaths.has(key)) return invalid('duplicate playlist path');
    playlistPaths.add(key);
    const kind = raw.kind;
    if (kind !== 'folder' && kind !== 'playlist' && kind !== 'smart') return invalid('playlist kind');
    const trackIds = array(raw.trackIds, 'playlist tracks').map((value) => {
      const id = nonempty(value, 'playlist track ID');
      return ids.has(id) ? id : invalid('unknown playlist track ID');
    });
    const smart = raw.smart === undefined ? undefined : readSmart(raw.smart);
    if (kind === 'smart' && smart === undefined || kind !== 'smart' && smart !== undefined) return invalid('smart playlist kind');
    return { id, path, kind, trackIds, ...(smart === undefined ? {} : { smart }) };
  });
  const savedAt = text(raw.savedAt, 'save date', 100);
  if (!Number.isFinite(Date.parse(savedAt))) return invalid('save date');
  const includeMusic = boolean(raw.includeMusic, 'music option');
  if (!includeMusic && tracks.some((track) => track.media.kind === 'local' && track.media.relativePath !== null)) return invalid('music excluded but bundled files referenced');
  return { format: 'dj-library', version: 1, name: nonempty(raw.name, 'library name'), savedAt, includeMusic, tracks, playlists };
};

const fingerprints = new Map<string, Readonly<{ stamp: string; sha256: string; sizeBytes: number }>>();
const fingerprint = async (path: string) => {
  const file = await open(path, 'r');
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The music path is not a supported regular file.');
    const stampFor = (value: typeof before) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
    const stamp = stampFor(before);
    const cached = fingerprints.get(path);
    if (cached?.stamp === stamp) return cached;
    const hash = createHash('sha256');
    for await (const raw of file.createReadStream({ autoClose: false })) {
      const chunk: unknown = raw;
      if (!Buffer.isBuffer(chunk)) throw new Error('Could not read music file bytes.');
      hash.update(chunk);
    }
    if (stampFor(await file.stat({ bigint: true })) !== stamp) throw new Error('The music file changed while it was read. Retry the backup.');
    const result = { stamp, sha256: hash.digest('hex'), sizeBytes: Number(before.size) };
    fingerprints.set(path, result);
    return result;
  } finally { await file.close(); }
};

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
const within = (directory: string, path: string): boolean => {
  const child = relative(directory, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
const stableId = (kind: 'track' | 'playlist', value: string): string => `${kind}-${createHash('sha256').update(value).digest('hex')}`;

export const writePortableLibrary = async ({ library, directory, name, includeMusic }: Readonly<{
  library: SyncLibrary; directory: string; name: string; includeMusic: boolean;
}>) => {
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  const warnings: string[] = [];
  const paths = new Map<string, string>();
  for (const track of library.tracks) {
    const path = normalizePath(track.path);
    if (paths.has(path)) throw new Error(`The library contains multiple entries for ${track.path}. Resolve duplicate file references before backing up.`);
    paths.set(path, stableId('track', path));
  }
  const tracks: PortableTrack[] = [];
  for (const track of library.tracks) {
    const id = paths.get(normalizePath(track.path));
    if (id === undefined) throw new Error('A backup track has no ID.');
    const sourcePath = track.location ?? track.path;
    let media: PortableMedia;
    if (track.song.source !== 'local') media = { kind: 'reference', uri: sourcePath };
    else {
      let identity: Awaited<ReturnType<typeof fingerprint>> | null = null;
      try { identity = await fingerprint(sourcePath); } catch (error) {
        warnings.push(`${track.song.title}: music could not be read. ${error instanceof Error ? error.message : 'Check the original file.'}`);
      }
      let relativePath: string | null = null;
      if (identity !== null && includeMusic) {
        const extension = extname(sourcePath).toLowerCase();
        relativePath = `media/${identity.sha256}${/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''}`;
        const mediaDirectory = join(root, 'media');
        await mkdir(mediaDirectory, { recursive: true });
        if ((await lstat(mediaDirectory)).isSymbolicLink() || !within(root, await realpath(mediaDirectory))) throw new Error('The backup media folder must be inside the selected backup folder.');
        const target = join(root, relativePath);
        let exists = false;
        try {
          const info = await lstat(target);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('A backup music path is not a regular file.');
          const existing = await fingerprint(target);
          if (existing.sha256 !== identity.sha256 || existing.sizeBytes !== identity.sizeBytes) throw new Error(`An existing backup music file is damaged: ${target}.`);
          exists = true;
        } catch (error) { if (!missing(error)) throw error; }
        if (!exists) {
          const temporary = `${target}.${randomUUID()}.tmp`;
          try {
            await copyFile(sourcePath, temporary, constants.COPYFILE_EXCL);
            const copied = await fingerprint(temporary);
            if (copied.sha256 !== identity.sha256 || copied.sizeBytes !== identity.sizeBytes) throw new Error('A music file changed while it was copied. Retry the backup.');
            const file = await open(temporary, 'r');
            try { await file.sync(); } finally { await file.close(); }
            await rename(temporary, target);
            fingerprints.delete(temporary);
          } finally { await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; }); }
        }
      }
      media = { kind: 'local', originalPath: sourcePath, sizeBytes: identity?.sizeBytes ?? track.song.fileSizeBytes,
        sha256: identity?.sha256 ?? null, relativePath };
    }
    tracks.push({ id, metadata: readMetadata(track.song), media,
      ...(track.performance === undefined ? {} : { performance: track.performance }) });
  }
  const savedAt = new Date().toISOString();
  const manifest = readManifest({ format: 'dj-library', version: 1, name, savedAt, includeMusic, tracks,
    playlists: library.playlists.map((playlist): PortablePlaylist => ({
      id: stableId('playlist', JSON.stringify(playlist.path)), path: playlist.path,
      kind: playlist.kind ?? (playlist.smart === undefined ? 'playlist' : 'smart'),
      trackIds: playlist.trackPaths.map((path) => {
        const id = paths.get(normalizePath(path));
        if (id === undefined) throw new Error(`The playlist ${playlist.path.join(' / ')} references a track absent from the library: ${path}.`);
        return id;
      }), ...(playlist.smart === undefined ? {} : { smart: playlist.smart }),
    })),
  });
  const manifestPath = join(root, `${savedAt.replaceAll(':', '-')}-${randomUUID()}.json`);
  const temporary = `${manifestPath}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); await file.sync(); } finally { await file.close(); }
    await rename(temporary, manifestPath);
  } finally { await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; }); }
  return { manifestPath, savedAt, warnings };
};

export const readPortableLibrary = async (manifestPath: string): Promise<PortableLibraryManifest> => {
  const info = await stat(manifestPath);
  if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error('Choose a portable library JSON file smaller than 128 MiB.');
  const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  return readManifest(value);
};

export const portableSnapshotDate = (name: string): number | null => {
  const match = /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2}\.\d{3}Z)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/i.exec(name);
  if (match === null) return null;
  const date = Date.parse(`${match[1]}${match[2]}:${match[3]}:${match[4]}`);
  return Number.isFinite(date) ? date : null;
};

export const readPortableLibraryFolder = async (directory: string) => {
  let root = directory;
  let entries = await readdir(root, { withFileTypes: true });
  if (!entries.some((entry) => portableSnapshotDate(entry.name) !== null)) {
    const children = entries.filter((entry) => entry.isDirectory() && /^Arsenal-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(entry.name));
    if (children.length > 1) throw new Error('This folder contains several Arsenal libraries. Choose the backup folder for the library you want to open.');
    const child = children[0];
    if (child !== undefined) {
      root = join(root, child.name);
      entries = await readdir(root, { withFileTypes: true });
    }
  }
  const newest = entries.flatMap((entry) => {
    const date = portableSnapshotDate(entry.name);
    return date === null ? [] : [{ name: entry.name, date }];
  }).sort((left, right) => right.date - left.date || right.name.localeCompare(left.name))[0];
  if (newest === undefined) throw new Error('No library snapshot was found. Choose the Arsenal backup folder after it has finished syncing.');
  const manifestPath = join(root, newest.name);
  try {
    return { manifest: await readPortableLibrary(manifestPath), manifestPath };
  } catch (error) {
    throw new Error(`The latest library snapshot could not be read: ${newest.name}. Wait for the backup folder to finish syncing, then try again. ${error instanceof Error ? error.message : ''}`);
  }
};

export const resolvePortableLibrary = async (
  manifest: PortableLibraryManifest, manifestPath: string, searchRoots: readonly string[],
  managedMediaDirectory?: string,
) => {
  const root = await realpath(dirname(manifestPath));
  const resolved = new Map<string, string>();
  const bundled = new Map<string, Extract<PortableMedia, { kind: 'local' }>>();
  const warnings: string[] = [];
  const wanted = new Map<number, Map<string, PortableTrack[]>>();
  const matches = async (path: string, media: Extract<PortableMedia, { kind: 'local' }>): Promise<boolean> => {
    if (media.sha256 === null || media.sizeBytes === null) return false;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size !== media.sizeBytes) return false;
      const found = await fingerprint(path);
      return found.sha256 === media.sha256;
    } catch (error) {
      if (!missing(error)) warnings.push(`${basename(path)}: ${error instanceof Error ? error.message : 'Could not check this music file.'}`);
      return false;
    }
  };
  for (const track of manifest.tracks) {
    const media = track.media;
    if (media.kind === 'reference') { resolved.set(track.id, media.uri); continue; }
    if (media.relativePath !== null) {
      const candidate = join(root, media.relativePath);
      let contained = false;
      try { contained = within(root, await realpath(candidate)); } catch (error) { if (!missing(error)) throw error; }
      if (!contained) warnings.push(`${track.metadata.title}: bundled music is unavailable or points outside the backup folder.`);
      else {
        let valid: boolean;
        if (managedMediaDirectory === undefined) valid = await matches(candidate, media);
        else {
          const info = await stat(candidate);
          valid = info.isFile() && info.size === media.sizeBytes;
        }
        if (valid) { resolved.set(track.id, candidate); bundled.set(candidate, media); continue; }
        warnings.push(`${track.metadata.title}: bundled music did not match its saved fingerprint.`);
      }
    }
    if (isAbsolute(media.originalPath) && await matches(media.originalPath, media)) { resolved.set(track.id, media.originalPath); continue; }
    if (media.sha256 !== null && media.sizeBytes !== null) {
      let byHash = wanted.get(media.sizeBytes);
      if (byHash === undefined) { byHash = new Map(); wanted.set(media.sizeBytes, byHash); }
      const previous = byHash.get(media.sha256) ?? [];
      byHash.set(media.sha256, [...previous, track]);
    }
  }
  const visited = new Set<string>();
  const queue = [...new Set(searchRoots.map((path) => resolve(path)))];
  let inaccessible = 0;
  for (let index = 0; index < queue.length && wanted.size > 0; index += 1) {
    const directory = queue[index];
    if (directory === undefined) continue;
    try {
      const canonical = await realpath(directory);
      if (visited.has(canonical)) continue;
      visited.add(canonical);
      for await (const entry of await opendir(canonical)) {
        const path = join(canonical, entry.name);
        if (entry.isDirectory()) { queue.push(path); continue; }
        if (!entry.isFile()) continue;
        try {
          const info = await stat(path);
          const byHash = wanted.get(info.size);
          if (byHash === undefined) continue;
          const identity = await fingerprint(path);
          const matches = byHash.get(identity.sha256);
          if (matches === undefined) continue;
          for (const track of matches) resolved.set(track.id, path);
          byHash.delete(identity.sha256);
          if (byHash.size === 0) wanted.delete(info.size);
          if (wanted.size === 0) break;
        } catch { inaccessible += 1; }
      }
    } catch { inaccessible += 1; }
  }
  if (inaccessible) warnings.push(`Could not read ${inaccessible} files or folders while looking for music.`);
  if (managedMediaDirectory !== undefined && bundled.size > 0) {
    const copiedPaths = new Map<string, string>();
    const createdPaths: string[] = [];
    try {
      await mkdir(managedMediaDirectory, { recursive: true });
      const directoryInfo = await lstat(managedMediaDirectory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('The imported music folder must be a local directory, not a symbolic link.');
      const directory = await realpath(managedMediaDirectory);
      for (const [path, media] of bundled) {
        const copiedPath = join(directory, basename(path));
        let created = false;
        try {
          await copyFile(path, copiedPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
          created = true;
          createdPaths.push(copiedPath);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
        const info = await lstat(copiedPath);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('An imported music path is not a regular local file.');
        if (created) {
          const copied = await fingerprint(copiedPath);
          if (copied.sha256 !== media.sha256 || copied.sizeBytes !== media.sizeBytes) {
            throw new Error('Bundled music changed while it was imported. Wait for the backup folder to finish syncing and retry.');
          }
          const file = await open(copiedPath, 'r');
          try { await file.sync(); } finally { await file.close(); }
        }
        copiedPaths.set(path, copiedPath);
      }
      for (const [id, path] of resolved) {
        const copiedPath = copiedPaths.get(path);
        if (copiedPath !== undefined) resolved.set(id, copiedPath);
      }
    } catch (error) {
      await Promise.all(createdPaths.map((path) => unlink(path).catch((error: unknown) => { if (!missing(error)) throw error; })));
      throw error;
    }
  }
  const missingFiles = manifest.tracks.flatMap((track) => track.media.kind === 'local' && !resolved.has(track.id)
    ? [{ id: track.id, title: track.metadata.title, originalPath: track.media.originalPath }] : []);
  const byId = new Map(manifest.tracks.map((track) => [track.id, track]));
  const locationFor = (track: PortableTrack): string => resolved.get(track.id) ?? (track.media.kind === 'local'
    ? `missing:local/${encodeURIComponent(track.media.originalPath)}` : track.media.uri);
  const locationCounts = new Map<string, number>();
  for (const track of manifest.tracks) {
    const key = normalizePath(locationFor(track));
    locationCounts.set(key, (locationCounts.get(key) ?? 0) + 1);
  }
  const identities = new Map<string, string>();
  const used = new Set(locationCounts.keys());
  for (const track of manifest.tracks) {
    const location = locationFor(track);
    let path = location;
    if ((locationCounts.get(normalizePath(location)) ?? 0) > 1) {
      path = `library-track:${track.id}`;
      for (let suffix = 2; used.has(normalizePath(path)); suffix += 1) path = `library-track:${track.id}:${suffix}`;
      used.add(normalizePath(path));
    }
    identities.set(track.id, path);
  }
  const pathFor = (track: PortableTrack): string => identities.get(track.id) ?? locationFor(track);
  const library: SyncLibrary = {
    tracks: manifest.tracks.map((track) => {
      const path = pathFor(track);
      const location = locationFor(track);
      return { path, ...(path === location ? {} : { location }),
        song: { ...track.metadata, id: track.id, audioUrl: null, artworkUrl: null,
          source: track.media.kind === 'local' && !resolved.has(track.id) ? 'unknown' : track.metadata.source },
        ...(track.performance === undefined ? {} : { performance: track.performance }) };
    }),
    playlists: manifest.playlists.map((playlist) => ({ path: playlist.path, kind: playlist.kind,
      trackPaths: playlist.trackIds.map((id) => {
        const track = byId.get(id);
        if (track === undefined) throw new Error('A portable playlist references an unknown track.');
        return pathFor(track);
      }), ...(playlist.smart === undefined ? {} : { smart: playlist.smart }),
    })),
  };
  return { library, missingFiles, warnings };
};
