import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, parse, posix, resolve, sep, win32 } from 'node:path';

import type { SongRow } from '../shared/dj-library';
import { mergeLibraries, normalizePath, type PlaylistNodeMove, type SyncLibrary, type SyncPlaylist, type SyncTrack } from './library-sync-model';
import { assertSeratoMediaFile, resolveSeratoLibraryPaths, resolveSeratoMediaPath, seratoMediaPathKey } from './serato-paths';
import { assertMissingFileRepair, saveRepairedLibraryFiles, type LibraryFileRepairResult } from './repair-library-files';
import type { SeratoLibraryWriteOptions } from './serato-library';

type RecordField = Readonly<{ tag: string; data: Buffer }>;
type NativeFile = Readonly<{ path: string; bytes: Buffer | null; records: readonly RecordField[] }>;
type NativeCrate = NativeFile & Readonly<{ playlist: SyncPlaylist; members: ReadonlyMap<string, RecordField> }>;

const DATABASE_VERSION = '2.0/Serato Scratch LIVE Database';
const CRATE_VERSION = '1.0/Serato ScratchLive Crate';

const decodeText = (data: Buffer): string => {
  if (data.length % 2 !== 0) throw new Error('Serato text has an invalid UTF-16 length.');
  return new TextDecoder('utf-16be', { fatal: true }).decode(data).replace(/\0+$/, '');
};

const textField = (tag: string, value: string): RecordField => ({ tag, data: Buffer.from(value, 'utf16le').swap16() });
const uintField = (tag: string, value: number): RecordField => {
  const data = Buffer.alloc(4);
  data.writeUInt32BE(Math.min(0xffffffff, Math.max(0, Math.round(value))));
  return { tag, data };
};

const parseRecords = (bytes: Buffer, context: string): RecordField[] => {
  const records: RecordField[] = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error(`Truncated Serato record in ${context}.`);
    const tag = bytes.toString('latin1', offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    if (!/^[a-zA-Z0-9 ]{4}$/.test(tag) || length > bytes.length - offset - 8) {
      throw new Error(`Invalid Serato record in ${context}.`);
    }
    records.push({ tag, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += length + 8;
  }
  return records;
};

const encodeRecords = (records: readonly RecordField[]): Buffer => Buffer.concat(records.map(({ tag, data }) => {
  const header = Buffer.alloc(8);
  header.write(tag, 'ascii');
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}));

const getText = (fields: readonly RecordField[], tag: string): string | null => {
  const record = fields.find((field) => field.tag === tag);
  return record ? decodeText(record.data).trim() || null : null;
};

const getUint = (fields: readonly RecordField[], tag: string): number | null => {
  const record = fields.find((field) => field.tag === tag);
  if (!record) return null;
  if (record.data.length !== 4) throw new Error(`Invalid Serato ${tag} integer.`);
  return record.data.readUInt32BE();
};

const numberText = (value: string | null): number | null => {
  const match = value?.match(/^\s*(\d+(?:[.,]\d+)?)/);
  const number = match?.[1] === undefined ? NaN : Number(match[1].replace(',', '.'));
  return Number.isFinite(number) ? number : null;
};

const duration = (value: string | null): number | null => {
  if (value === null) return null;
  if (!value.includes(':')) return numberText(value);
  const parts = value.split(':').map(Number);
  return parts.length <= 3 && parts.every((part) => Number.isFinite(part) && part >= 0)
    ? parts.reduce((total, part) => total * 60 + part, 0) : null;
};

const volumeRoot = (directory: string): string => {
  const parent = dirname(resolve(directory));
  if (process.platform === 'win32') return parse(parent).root;
  if (parent === homedir() || parent.startsWith(`${homedir()}${sep}`) || basename(parent).toLowerCase() === 'music') return '/';
  return parent;
};

const absoluteMediaPath = (value: string, root: string): string => {
  const path = value.replaceAll('\\', '/');
  if (!path || path.includes('\0')) throw new Error('A Serato track has an invalid file path.');
  if (/^[a-z]:\//i.test(path) || path.startsWith('/')) return posix.normalize(path);
  return posix.join(root.replaceAll('\\', '/'), path);
};

const relativeMediaPath = (path: string, root: string): string => {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.includes('\0') || (!posix.isAbsolute(normalized) && !win32.isAbsolute(normalized))) {
    throw new Error(`Serato needs an absolute audio file path: ${path}`);
  }
  const relative = /^[a-z]:\//i.test(root) ? win32.relative(root, normalized).replaceAll('\\', '/') : posix.relative(root, normalized);
  if (relative === '..' || relative.startsWith('../') || win32.isAbsolute(relative)) {
    throw new Error(`The audio file is outside the selected Serato library volume: ${path}`);
  }
  return relative;
};

const readOptional = async (path: string): Promise<Buffer | null> => {
  try { return await readFile(path); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
};

const readNativeFile = async (path: string, version: string, allowMissing: boolean): Promise<NativeFile> => {
  const bytes = await readOptional(path);
  if (bytes === null) {
    if (!allowMissing) throw new Error(`Serato file not found: ${path}`);
    return { path, bytes, records: [textField('vrsn', version)] };
  }
  const records = parseRecords(bytes, path);
  if (records[0]?.tag !== 'vrsn' || getText(records, 'vrsn') !== version) throw new Error(`Unsupported Serato file: ${path}`);
  return { path, bytes, records };
};

const songFromFields = (fields: readonly RecordField[], path: string): SongRow => {
  const added = getUint(fields, 'uadd') ?? numberText(getText(fields, 'tadd'));
  const rate = getText(fields, 'tsmp');
  const sampleRate = numberText(rate);
  const size = getText(fields, 'tsiz');
  const fileSize = numberText(size);
  return {
    id: path, title: getText(fields, 'tsng') ?? basename(path), artist: getText(fields, 'tart'),
    composer: getText(fields, 'tcmp'), remixer: null, album: getText(fields, 'talb'), mixName: null,
    label: getText(fields, 'tlbl'), genre: getText(fields, 'tgen'), year: numberText(getText(fields, 'ttyr')),
    bpm: numberText(getText(fields, 'tbpm')) || null, musicalKey: getText(fields, 'tkey'),
    durationSeconds: duration(getText(fields, 'tlen')), fileKind: getText(fields, 'ttyp'),
    fileSizeBytes: getUint(fields, 'ufsb') ?? (fileSize === null ? null : Math.round(fileSize * (/gb$/i.test(size ?? '') ? 1e9 : /mb$/i.test(size ?? '') ? 1e6 : /kb$/i.test(size ?? '') ? 1e3 : 1))),
    bitRateKbps: numberText(getText(fields, 'tbit')),
    sampleRateHz: sampleRate === null ? null : Math.round(sampleRate * (/k(?:hz)?$/i.test(rate ?? '') ? 1000 : 1)),
    trackNumber: null, discNumber: null, playCount: getUint(fields, 'utpc'), rating: null,
    dateAdded: added !== null && added <= 0xffffffff ? new Date(added * 1000).toISOString() : null,
    comments: getText(fields, 'tcom'), artworkUrl: null, audioUrl: null, source: 'local', cuePointCount: 0, hotCueCount: 0,
  };
};

const crateNames = async (directory: string, extension = '.crate'): Promise<string[]> => {
  try { return (await readdir(directory)).filter((name) => name.toLowerCase().endsWith(extension)).sort(); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
};

const readNativeLibrary = async (directory: string, allowMissing: boolean) => {
  const root = volumeRoot(directory);
  const database = await readNativeFile(join(directory, 'database V2'), DATABASE_VERSION, allowMissing);
  const tracks = new Map<string, SyncTrack>();
  const trackRecords = new Map<string, readonly RecordField[]>();
  for (const record of database.records) {
    if (record.tag !== 'otrk') continue;
    const fields = parseRecords(record.data, database.path);
    const location = getText(fields, 'pfil');
    if (!location) throw new Error('A Serato database track is missing its file path.');
    const path = await resolveSeratoMediaPath(absoluteMediaPath(location, root));
    const key = normalizePath(path);
    tracks.set(key, { path, song: songFromFields(fields, path) });
    trackRecords.set(key, fields);
  }
  const subcrates = join(directory, 'Subcrates');
  const names = await crateNames(subcrates);
  const orderFile = await readOptional(join(directory, 'neworder.pref')) ?? await readOptional(join(directory, 'Neworder.pref'));
  if (orderFile !== null) {
    const order = new Map(new TextDecoder('utf-16be').decode(orderFile).split(/\r?\n/)
      .filter((line) => line.startsWith('[crate]'))
      .map((line, index) => [line.slice('[crate]'.length), index]));
    names.sort((left, right) => {
      const leftOrder = order.get(left.slice(0, -'.crate'.length)) ?? Infinity;
      const rightOrder = order.get(right.slice(0, -'.crate'.length)) ?? Infinity;
      return leftOrder === rightOrder ? 0 : leftOrder - rightOrder;
    });
  }
  const crates: NativeCrate[] = [];
  for (const name of names) {
    const file = await readNativeFile(join(subcrates, name), CRATE_VERSION, false);
    const members = new Map<string, RecordField>();
    const paths: string[] = [];
    for (const record of file.records) {
      if (record.tag !== 'otrk') continue;
      const fields = parseRecords(record.data, file.path);
      const location = getText(fields, 'ptrk');
      if (!location) throw new Error(`A Serato crate track is missing its file path: ${name}`);
      const path = await resolveSeratoMediaPath(absoluteMediaPath(location, root));
      paths.push(path);
      members.set(normalizePath(path), record);
      if (!tracks.has(normalizePath(path))) tracks.set(normalizePath(path), { path, song: songFromFields([], path) });
    }
    crates.push({ ...file, playlist: { path: name.slice(0, -6).split('%%'), trackPaths: paths }, members });
  }
  const library: SyncLibrary = { tracks: [...tracks.values()], playlists: crates.map((crate) => crate.playlist) };
  return { root, database, trackRecords, crates, library, subcrates, names };
};

export const readSeratoLegacy = async (directory: string): Promise<SyncLibrary> => resolveSeratoLibraryPaths((await readNativeLibrary(directory, false)).library);

export const repairSeratoLegacyMissingFile = async (
  directory: string,
  missingPath: string,
  replacementPath: string | null,
  assertClosed: () => Promise<void>,
): Promise<LibraryFileRepairResult> => {
  await assertClosed();
  await assertMissingFileRepair(missingPath, replacementPath);
  const native = await readNativeLibrary(directory, false);
  const replacement = replacementPath === null ? null : await resolveSeratoMediaPath(replacementPath);
  const location = replacement === null ? null : relativeMediaPath(replacement, native.root);
  const missingKey = await seratoMediaPathKey(missingPath);
  const replacementKey = replacement === null ? null : await seratoMediaPathKey(replacement);
  for (const track of native.library.tracks) {
    if (await seratoMediaPathKey(track.path) === replacementKey) throw new Error('The selected audio file already has an entry in this Serato library. Remove the missing entry or choose another audio file.');
  }
  const files = [native.database, ...native.crates];
  const updates: { path: string; before: Buffer; after: Buffer }[] = [];
  for (const file of files) {
    const tag = file === native.database ? 'pfil' : 'ptrk';
    const records: RecordField[] = [];
    let changed = false;
    for (const record of file.records) {
      if (record.tag !== 'otrk') { records.push(record); continue; }
      const fields = parseRecords(record.data, file.path);
      const value = getText(fields, tag);
      if (value === null || await seratoMediaPathKey(absoluteMediaPath(value, native.root)) !== missingKey) {
        records.push(record);
        continue;
      }
      changed = true;
      if (location !== null) records.push({ ...record, data: encodeRecords(fields.map((field) => field.tag === tag ? textField(tag, location) : field)) });
    }
    if (changed && file.bytes !== null) updates.push({ path: file.path, before: file.bytes, after: encodeRecords(records) });
  }
  if (updates.length === 0) throw new Error('The missing track is no longer in this Serato library. Scan the library again.');
  return saveRepairedLibraryFiles(updates, async () => {
    await assertClosed();
    await assertMissingFileRepair(missingPath, replacement);
    if (JSON.stringify(await crateNames(native.subcrates)) !== JSON.stringify(native.names)) throw new Error('Serato crates changed during repair. Close Serato and retry.');
    for (const file of files) {
      if (!(await readOptional(file.path))?.equals(file.bytes ?? Buffer.alloc(0))) throw new Error('The Serato library changed during repair. Close Serato and retry.');
    }
  });
};

const fieldsForTrack = (track: SyncTrack, root: string, existing: readonly RecordField[] = []): RecordField[] => {
  const song = track.song;
  const changes: RecordField[] = [textField('pfil', getText(existing, 'pfil') ?? relativeMediaPath(track.path, root))];
  const texts: [string, string | number | null][] = [
    ['tsng', song.title], ['tart', song.artist], ['talb', song.album], ['tgen', song.genre],
    ['tcmp', song.composer], ['tlbl', song.label], ['ttyr', song.year], ['tkey', song.musicalKey],
    ['tcom', song.comments], ['ttyp', extname(track.path).slice(1).toLowerCase() || song.fileKind],
    ['tbpm', song.bpm === null ? null : song.bpm.toFixed(2)],
    ['tbit', song.bitRateKbps === null ? null : `${song.bitRateKbps}kbps`],
    ['tsmp', song.sampleRateHz === null ? null : `${song.sampleRateHz / 1000}k`],
    ['tsiz', song.fileSizeBytes === null ? null : `${(song.fileSizeBytes / 1e6).toFixed(1)}MB`],
  ];
  if (song.durationSeconds !== null) {
    const hundredths = Math.round(song.durationSeconds * 100);
    texts.push(['tlen', `${String(Math.floor(hundredths / 6000)).padStart(2, '0')}:${((hundredths % 6000) / 100).toFixed(2).padStart(5, '0')}`]);
  }
  for (const [tag, value] of texts) if (value !== null && value !== '') changes.push(textField(tag, String(value)));
  if (song.fileSizeBytes !== null && song.fileSizeBytes <= 0xffffffff) changes.push(uintField('ufsb', song.fileSizeBytes));
  if (song.playCount !== null) changes.push(uintField('utpc', song.playCount));
  const added = song.dateAdded === null ? NaN : Date.parse(song.dateAdded) / 1000;
  if (Number.isFinite(added) && added >= 0 && added <= 0xffffffff) changes.push(uintField('uadd', added), textField('tadd', String(Math.floor(added))));
  const byTag = new Map(changes.map((record) => [record.tag, record]));
  const fields = existing.map((record) => byTag.get(record.tag) ?? record);
  const existingTags = new Set(existing.map((record) => record.tag));
  fields.push(...changes.filter((record) => !existingTags.has(record.tag)));
  return fields;
};

const crateFilename = (path: readonly string[]): string => {
  if (path.length === 0 || path.some((name) => !name.trim() || name === '.' || name === '..' || name.includes('%%') || [...name].some((character) => character.charCodeAt(0) < 32) || /[<>:"/\\|?*]/.test(name) || /[. ]$/.test(name))) {
    throw new Error(`This playlist name cannot be stored as a Serato crate: ${path.join(' / ')}`);
  }
  return `${path.join('%%')}.crate`;
};

const defaultCrateRecords = (): RecordField[] => [
  textField('vrsn', CRATE_VERSION),
  ...['song', 'artist', 'album', 'bpm', 'key', 'length', 'comment'].map((column) => ({
    tag: 'ovct', data: encodeRecords([textField('tvcn', column), textField('tvcw', '0')]),
  })),
];

export const moveSeratoLegacyNode = async (directory: string, move: PlaylistNodeMove): Promise<void> => {
  const native = await readNativeLibrary(directory, false);
  const key = (path: readonly string[]): string => JSON.stringify(path);
  const under = (path: readonly string[], prefix: readonly string[]): boolean =>
    path.length >= prefix.length && key(path.slice(0, prefix.length)) === key(prefix);
  const paths = native.crates.map((crate) => crate.playlist.path);
  const exists = (path: readonly string[]): boolean => path.length === 0 || paths.some((candidate) => under(candidate, path));
  if (!exists(move.sourcePath) || !exists(move.parentPath) ||
    (move.beforePath !== null && !exists(move.beforePath)) ||
    under(move.parentPath, move.sourcePath) ||
    (move.beforePath !== null && (under(move.beforePath, move.sourcePath) ||
      key(move.beforePath.slice(0, -1)) !== key(move.parentPath)))) {
    throw new Error('The Serato crate move is invalid. Sync playlists first.');
  }
  const destinationPath = [...move.parentPath, move.sourcePath.at(-1)!];
  const moved = native.crates.filter((crate) => under(crate.playlist.path, move.sourcePath));
  const retained = native.crates.filter((crate) => !under(crate.playlist.path, move.sourcePath));
  if (retained.some((crate) => under(crate.playlist.path, destinationPath))) {
    throw new Error('A crate with this name already exists in the destination folder.');
  }
  const position = move.beforePath === null
    ? retained.reduce((last, crate, index) => under(crate.playlist.path, move.parentPath) ? index : last, -1) + 1
    : retained.findIndex((crate) => under(crate.playlist.path, move.beforePath!));
  if (position < 0) throw new Error('The Serato drop position is missing.');
  const ordered = [...retained];
  ordered.splice(position, 0, ...moved);
  const changedPath = (path: readonly string[]): readonly string[] => under(path, move.sourcePath)
    ? [...destinationPath, ...path.slice(move.sourcePath.length)] : path;
  const filenames = ordered.map((crate) => crateFilename(changedPath(crate.playlist.path)));
  if (new Set(filenames.map((name) => name.toLocaleLowerCase())).size !== filenames.length) {
    throw new Error('The destination has conflicting Serato crate names.');
  }
  const preferencePath = await readOptional(join(directory, 'neworder.pref')) !== null
    ? join(directory, 'neworder.pref') : await readOptional(join(directory, 'Neworder.pref')) !== null
      ? join(directory, 'Neworder.pref') : join(directory, 'neworder.pref');
  const previousPreference = await readOptional(preferencePath);
  const oldLines = previousPreference === null ? [] : new TextDecoder('utf-16be').decode(previousPreference).split(/\r?\n/);
  const otherLines = oldLines.filter((line) => line && !line.startsWith('[crate]'));
  const preference = Buffer.from([...otherLines, ...filenames.map((name) => `[crate]${name.slice(0, -6)}`)].join('\r\n') + '\r\n', 'utf16le').swap16();
  const updates = new Map<string, { before: Buffer | null; after: Buffer | null }>();
  for (const crate of moved) {
    const destination = join(native.subcrates, crateFilename(changedPath(crate.playlist.path)));
    if (destination === crate.path) continue;
    updates.set(crate.path, { before: crate.bytes, after: null });
    updates.set(destination, { before: null, after: crate.bytes });
  }
  if (previousPreference?.equals(preference) && updates.size === 0) return;
  updates.set(preferencePath, { before: previousPreference, after: preference });
  const suffix = `.arsenal-${Date.now()}-${randomUUID()}`;
  const staged: string[] = [];
  const committed: string[] = [];
  try {
    if (JSON.stringify(await crateNames(native.subcrates)) !== JSON.stringify([...native.names].sort())) throw new Error('Serato crates changed. Close Serato and retry.');
    for (const crate of native.crates) {
      if (!(await readOptional(crate.path))?.equals(crate.bytes ?? Buffer.alloc(0))) throw new Error('Serato crates changed. Close Serato and retry.');
    }
    for (const [path, { before, after }] of updates) {
      const current = await readOptional(path);
      if (before === null ? current !== null : !current?.equals(before)) throw new Error('Serato order changed. Close Serato and retry.');
      if (after !== null) {
        const temporary = `${path}${suffix}.tmp`;
        await writeFile(temporary, after, { flag: 'wx' });
        staged.push(temporary);
      }
      if (before !== null) await writeFile(`${path}${suffix}.bak`, before, { flag: 'wx' });
    }
    for (const [path, { after }] of updates) {
      if (after === null) await rm(path);
      else await rename(`${path}${suffix}.tmp`, path);
      committed.push(path);
    }
  } catch (error) {
    for (const path of committed.reverse()) {
      const before = updates.get(path)?.before;
      if (before === null) await rm(path, { force: true });
      else if (before !== undefined) await writeFile(path, before);
    }
    throw error;
  } finally {
    await Promise.all(staged.map((path) => rm(path, { force: true })));
  }
};

export const writeSeratoLegacy = async (
  directory: string,
  incoming: SyncLibrary,
  options: Partial<SeratoLibraryWriteOptions> = {},
): Promise<{ trackCount: number; playlistCount: number; backupPaths: string[] }> => {
  const smart = incoming.playlists.find((playlist) => playlist.kind === 'smart' || playlist.smart !== undefined);
  if (smart) throw new Error(`Smart playlist "${smart.path.join(' / ')}" needs a Serato 4 library. Choose Serato 4's Library folder to sync it as a smart crate.`);
  const native = await readNativeLibrary(directory, true);
  incoming = await resolveSeratoLibraryPaths(incoming, native.library);
  for (const track of incoming.tracks) {
    if (!native.trackRecords.has(normalizePath(track.path))) await assertSeratoMediaFile(track.path);
  }
  const combined = mergeLibraries(incoming, native.library);
  const removedTracks = new Set(await Promise.all((options.removeTrackPaths ?? []).map(seratoMediaPathKey)));
  const removedMembers = new Set(await Promise.all((options.removePlaylistTrackPaths ?? []).map(seratoMediaPathKey)));
  const removedMemberPaths = new Set((await Promise.all(combined.tracks.map(async (track) =>
    removedMembers.has(await seratoMediaPathKey(track.path)) ? normalizePath(track.path) : null))).filter((path) => path !== null));
  const removedTrackPaths = new Set((await Promise.all(combined.tracks.map(async (track) =>
    removedTracks.has(await seratoMediaPathKey(track.path)) ? normalizePath(track.path) : null))).filter((path) => path !== null));
  const tracks = (options.replaceTracks ? incoming.tracks : combined.tracks).filter((track) => !removedTrackPaths.has(normalizePath(track.path)));
  const availablePaths = new Set(tracks.map((track) => normalizePath(track.path)));
  const replacedPlaylists = new Set((options.replacePlaylistPaths ?? []).map((path) => JSON.stringify(path)));
  const removedPlaylists = new Set((options.removePlaylistPaths ?? []).map((path) => JSON.stringify(path)));
  const incomingByPath = new Map(incoming.playlists.map((playlist) => [JSON.stringify(playlist.path), playlist]));
  const playlistOrder = new Map(native.library.playlists.map((playlist, index) => [JSON.stringify(playlist.path), index]));
  const combinedPlaylists = options.replacePlaylistPaths === undefined ? combined.playlists : [...combined.playlists].sort((left, right) =>
    (playlistOrder.get(JSON.stringify(left.path)) ?? Infinity) - (playlistOrder.get(JSON.stringify(right.path)) ?? Infinity));
  const merged: SyncLibrary = {
    tracks,
    playlists: (options.replacePlaylists ? incoming.playlists : combinedPlaylists)
      .filter((playlist) => !removedPlaylists.has(JSON.stringify(playlist.path)))
      .map((playlist) => replacedPlaylists.has(JSON.stringify(playlist.path)) ? incomingByPath.get(JSON.stringify(playlist.path)) ?? playlist : playlist)
      .map((playlist) => ({
      ...playlist, trackPaths: playlist.trackPaths.filter((path) => availablePaths.has(normalizePath(path)) && !removedMemberPaths.has(normalizePath(path))),
    })),
  };
  const updates = new Map<string, { before: Buffer | null; after: Buffer | null }>();
  const incomingPaths = new Set(incoming.tracks.map((track) => normalizePath(track.path)));
  const trackRecords = new Map(merged.tracks.map((track) => {
    const key = normalizePath(track.path);
    const existing = native.trackRecords.get(key);
    const fields = existing && (options.metadata === false || !incomingPaths.has(key))
      ? existing : fieldsForTrack(track, native.root, existing);
    return [key, { tag: 'otrk', data: encodeRecords(fields) }];
  }));
  const records: RecordField[] = [];
  for (const record of native.database.records) {
    if (record.tag !== 'otrk') { records.push(record); continue; }
    const location = getText(parseRecords(record.data, native.database.path), 'pfil');
    if (!location) throw new Error('A Serato database track is missing its file path.');
    const key = normalizePath(await resolveSeratoMediaPath(absoluteMediaPath(location, native.root)));
    const replacement = trackRecords.get(key);
    if (replacement) { records.push(replacement); trackRecords.delete(key); }
  }
  records.push(...trackRecords.values());
  updates.set(native.database.path, { before: native.database.bytes, after: encodeRecords(records) });
  const crates = new Map(native.crates.map((crate) => [JSON.stringify(crate.playlist.path), crate]));
  const incomingCrates = new Set(incoming.playlists.map((playlist) => JSON.stringify(playlist.path)));
  const filenames = new Set<string>();
  for (const playlist of merged.playlists) {
    const crate = crates.get(JSON.stringify(playlist.path));
    const path = crate?.path ?? join(native.subcrates, crateFilename(playlist.path));
    const filenameKey = basename(path).toLowerCase();
    if (filenames.has(filenameKey)) throw new Error(`Serato crate names differ only by letter case: ${playlist.path.join(' / ')}`);
    filenames.add(filenameKey);
    if (crate && !incomingCrates.has(JSON.stringify(playlist.path)) && !options.replaceTracks && !removedTracks.size && !removedMembers.size) continue;
    const contents = (crate?.records ?? defaultCrateRecords()).filter((record) => record.tag !== 'otrk');
    for (const path of playlist.trackPaths) {
      contents.push(crate?.members.get(normalizePath(path)) ?? { tag: 'otrk', data: encodeRecords([textField('ptrk', relativeMediaPath(path, native.root))]) });
    }
    updates.set(path, { before: crate?.bytes ?? null, after: encodeRecords(contents) });
  }
  const smartDirectory = join(directory, 'SmartCrates');
  for (const crate of native.crates) {
    if (removedPlaylists.has(JSON.stringify(crate.playlist.path))) updates.set(crate.path, { before: crate.bytes, after: null });
  }
  const smartNames = options.replacePlaylists ? await crateNames(smartDirectory, '.scrate') : [];
  if (options.replacePlaylists) {
    for (const crate of native.crates) {
      if (!incomingCrates.has(JSON.stringify(crate.playlist.path))) updates.set(crate.path, { before: crate.bytes, after: null });
    }
    for (const name of smartNames) {
      const path = join(smartDirectory, name);
      updates.set(path, { before: await readFile(path), after: null });
    }
  }
  if (merged.playlists.length > 0 || removedPlaylists.size > 0) {
    const preferencePath = await readOptional(join(directory, 'neworder.pref')) !== null
      ? join(directory, 'neworder.pref') : await readOptional(join(directory, 'Neworder.pref')) !== null
        ? join(directory, 'Neworder.pref') : join(directory, 'neworder.pref');
    const before = await readOptional(preferencePath);
    const lines = before === null ? [] : new TextDecoder('utf-16be').decode(before).split(/\r?\n/).filter(Boolean);
    const desired = merged.playlists.map((playlist) => `[crate]${crateFilename(playlist.path).slice(0, -6)}`);
    const previous = new Set(native.library.playlists.map((playlist) => `[crate]${crateFilename(playlist.path).slice(0, -6)}`));
    const retained = options.replacePlaylistPaths === undefined ? lines.filter((line) => !line.startsWith('[crate]'))
      : lines.filter((line) => !previous.has(line) || desired.includes(line));
    const after = Buffer.from([...retained, ...desired.filter((line) => !retained.includes(line))].join('\r\n') + '\r\n', 'utf16le').swap16();
    updates.set(preferencePath, { before, after });
  }
  for (const [path, { before, after }] of updates) if (after !== null && before?.equals(after)) updates.delete(path);
  if (updates.size === 0) return { trackCount: merged.tracks.length, playlistCount: merged.playlists.length, backupPaths: [] };

  const suffix = `.arsenal-${Date.now()}-${randomUUID()}`;
  const staged: string[] = [];
  const committed: string[] = [];
  const backupPaths: string[] = [];
  try {
    for (const [path, { after }] of updates) {
      if (after === null) continue;
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}${suffix}.tmp`;
      const mode = (await stat(path).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }))?.mode;
      await writeFile(temporary, after, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
      staged.push(temporary);
    }
    if (JSON.stringify(await crateNames(native.subcrates)) !== JSON.stringify([...native.names].sort())) throw new Error('Serato crates changed during sync. Close Serato and retry.');
    if (options.replacePlaylists && JSON.stringify(await crateNames(smartDirectory, '.scrate')) !== JSON.stringify(smartNames)) throw new Error('Serato smart crates changed during sync. Close Serato and retry.');
    for (const file of [native.database, ...native.crates]) {
      const current = await readOptional(file.path);
      if (file.bytes === null ? current !== null : !current?.equals(file.bytes)) throw new Error('The Serato library changed during sync. Close Serato and retry.');
    }
    for (const [path, { before }] of updates) {
      const current = await readOptional(path);
      if (before === null ? current !== null : !current?.equals(before)) throw new Error('The Serato library changed during sync. Close Serato and retry.');
      if (before !== null) {
        const backup = `${path}${suffix}.bak`;
        await writeFile(backup, before, { flag: 'wx' });
        backupPaths.push(backup);
      }
    }
    for (const [path, { after }] of updates) {
      if (after === null) await rm(path);
      else await rename(`${path}${suffix}.tmp`, path);
      committed.push(path);
    }
  } catch (error) {
    for (const path of committed.reverse()) {
      const before = updates.get(path)?.before;
      if (before === null) await rm(path, { force: true });
      else if (before !== undefined) {
        await writeFile(`${path}${suffix}.restore`, before, { flag: 'wx' });
        await rename(`${path}${suffix}.restore`, path);
      }
    }
    throw error;
  } finally {
    await Promise.all(staged.map((path) => rm(path, { force: true })));
  }
  return { trackCount: merged.tracks.length, playlistCount: merged.playlists.length, backupPaths };
};
