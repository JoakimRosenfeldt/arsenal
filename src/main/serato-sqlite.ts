import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, parse, posix, resolve, win32 } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { promisify } from 'node:util';

import type { SongRow } from '../shared/dj-library';
import type { SyncLibrary, SyncPlaylist, SyncTrack } from './library-sync-model';
import { seratoSmartRules } from './serato-smart-crates';
import { assertSeratoMediaFile, resolveSeratoLibraryPaths, seratoMediaPathKey } from './serato-paths';

// Serato 4.0.9 schema 202: root.sqlite is authoritative; master.sqlite is rebuilt by Serato.
// https://github.com/Venut-Technologies/serato-dj-mcp/blob/main/tests/fixtures/schema/root-202.sql
// https://github.com/LegendT/serato-crates-sync/blob/main/src/serato_crates_sync/serato_db.py
type Row = Record<string, SQLOutputValue>;

const text = (value: SQLOutputValue | undefined): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

const number = (value: SQLOutputValue | undefined): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const id = (value: SQLOutputValue | undefined): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Invalid Serato library identifier.');
  return value;
};

const anchors = (db: DatabaseSync) => {
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 202) {
    throw new Error('Unsupported Serato database version. Serato 4 libraries with schema 202 are supported.');
  }
  const required = {
    serato: ['revision'],
    master: ['revision'],
    space: ['id', 'name', 'revision'],
    asset: ['id', 'revision', 'portable_id', 'name', 'artist', 'third_party_type'],
    space_asset: ['id', 'asset_id', 'space_id'],
    container: ['id', 'revision', 'parent_id', 'name', 'type', 'list_order', 'space_id'],
    container_asset: ['id', 'revision', 'container_id', 'space_asset_id', 'list_order'],
    smart_crate_rules: ['container_id', 'revision', 'version', 'rules', 'needs_refresh'],
  };
  for (const [table, columns] of Object.entries(required)) {
    const present = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
    if (columns.some((column) => !present.has(column))) {
      throw new Error('Choose a Serato root.sqlite or location.sqlite library, not master.sqlite.');
    }
  }
  const space = db.prepare("SELECT id FROM space WHERE name = 'Serato Library' COLLATE NOCASE").get();
  const spaceId = id(space?.id);
  const roots = db.prepare('SELECT id FROM container WHERE space_id = ? AND type = 0 AND (parent_id IS NULL OR parent_id = 0)').all(spaceId);
  if (roots.length !== 1) throw new Error('The Serato library root could not be identified.');
  return { spaceId, rootId: id(roots[0]?.id) };
};

const volumeRoot = (rootPath: string): string => {
  const path = resolve(rootPath).replaceAll('\\', '/');
  const suffix = '/_Serato_/Library/location.sqlite';
  return path.endsWith(suffix) ? path.slice(0, -suffix.length) || '/' : parse(resolve(rootPath)).root.replaceAll('\\', '/');
};

const isServicePath = (path: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[/\\]/i.test(path);

const absolutePath = (rootPath: string, portableId: string): string => {
  if (isServicePath(portableId)) return portableId;
  if (/^[a-z]:[/\\]/i.test(portableId) || portableId.startsWith('/')) return portableId;
  return posix.join(volumeRoot(rootPath), portableId.replaceAll('\\', '/'));
};

const assetPath = (rootPath: string, row: Row): string => {
  const portableId = text(row.portable_id);
  if (portableId === null) throw new Error('A Serato track has no file location.');
  return number(row.third_party_type) && !isServicePath(portableId)
    ? `streaming://serato/${encodeURIComponent(portableId)}` : absolutePath(rootPath, portableId);
};

const portablePath = (rootPath: string, path: string): string => {
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  const root = volumeRoot(rootPath);
  const relative = (/^[a-z]:\//i.test(root) ? win32.relative(root, normalized) : posix.relative(root, normalized)).replaceAll('\\', '/');
  if (!path || path.includes('\0') || !posix.isAbsolute(normalized) && !/^[a-z]:\//i.test(normalized) ||
      relative === '..' || relative.startsWith('../') || /^[a-z]:\//i.test(relative) || !relative) {
    throw new Error(`The track is not on this Serato library's drive: ${path}`);
  }
  return relative;
};

const songFromRow = (row: Row, path: string): SongRow => {
  const added = number(row.time_added);
  const rating = number(row.rating);
  return {
    id: `serato-${id(row.id)}`,
    title: text(row.name) ?? basename(path),
    artist: text(row.artist),
    composer: text(row.composer),
    remixer: text(row.remixer),
    album: text(row.album),
    mixName: null,
    label: text(row.label),
    genre: text(row.genre),
    year: number(row.year),
    bpm: number(row.bpm),
    musicalKey: text(row.key),
    durationSeconds: number(row.length_ms) !== null ? Number(row.length_ms) / 1000 : number(row.length_sec),
    fileKind: text(row.format),
    fileSizeBytes: number(row.file_size),
    bitRateKbps: number(row.file_bit_rate),
    sampleRateHz: number(row.file_sample_rate),
    trackNumber: number(row.track_number),
    discNumber: number(row.part_of_set),
    playCount: number(row.dj_play_count),
    rating: rating === null ? null : rating * 255,
    dateAdded: added !== null && Math.abs(added) < 8_640_000_000_000 ? new Date(added * 1000).toISOString().slice(0, 10) : null,
    comments: text(row.comments),
    artworkUrl: null,
    audioUrl: null,
    source: isServicePath(path) || number(row.third_party_type) ? 'streaming' : 'local',
    cuePointCount: 0,
    hotCueCount: 0,
  };
};

const readLibrary = (db: DatabaseSync, rootPath: string): SyncLibrary => {
  const { spaceId, rootId } = anchors(db);
  const tracks = db.prepare('SELECT a.* FROM asset a JOIN space_asset sa ON sa.asset_id = a.id WHERE sa.space_id = ? ORDER BY a.id').all(spaceId).map((row) => {
    const path = assetPath(rootPath, row);
    return { path, song: songFromRow(row, path) };
  });
  const rows = db.prepare('SELECT id, parent_id, name, type FROM container WHERE space_id = ? ORDER BY list_order, id').all(spaceId);
  const containers = new Map(rows.map((row) => [id(row.id), row]));
  const paths = new Map<number, readonly string[]>([[rootId, []]]);
  const getPath = (containerId: number, visiting = new Set<number>()): readonly string[] => {
    const cached = paths.get(containerId);
    if (cached) return cached;
    const row = containers.get(containerId);
    if (!row || visiting.has(containerId)) throw new Error('Invalid Serato crate hierarchy.');
    visiting.add(containerId);
    const name = text(row.name);
    if (!name) throw new Error('A Serato crate has no name.');
    const path = [...getPath(id(row.parent_id), visiting), name];
    paths.set(containerId, path);
    return path;
  };
  const membership = new Map<number, string[]>();
  const smartRules = new Map(db.prepare('SELECT container_id, version, rules FROM smart_crate_rules').all().map((row) => [id(row.container_id), row]));
  for (const row of db.prepare(`SELECT ca.container_id, a.portable_id, a.third_party_type FROM container_asset ca
    JOIN space_asset sa ON sa.id = ca.space_asset_id JOIN asset a ON a.id = sa.asset_id
    WHERE sa.space_id = ? ORDER BY ca.list_order, ca.id`).all(spaceId)) {
    const containerId = id(row.container_id);
    const members = membership.get(containerId) ?? [];
    members.push(assetPath(rootPath, row));
    membership.set(containerId, members);
  }
  return {
    tracks,
    playlists: rows.filter((row) => id(row.id) !== rootId && (row.type === 1 || row.type === 2)).map((row): SyncPlaylist => {
      const rules = smartRules.get(id(row.id));
      return {
        path: getPath(id(row.id)),
        trackPaths: membership.get(id(row.id)) ?? [],
        kind: row.type === 2 ? 'smart' : 'playlist',
        ...(row.type === 2 && rules && typeof rules.rules === 'string'
          ? { smart: { kind: 'serato', version: id(rules.version), rules: rules.rules } } : {}),
      };
    }),
  };
};

export const readSeratoSqlite = async (rootPath: string): Promise<SyncLibrary> => {
  const db = new DatabaseSync(rootPath, { readOnly: true, timeout: 3000 });
  try {
    db.exec('BEGIN');
    return resolveSeratoLibraryPaths(readLibrary(db, rootPath));
  } finally {
    db.close();
  }
};

const assertSeratoClosed = async (): Promise<void> => {
  const execute = promisify(execFile);
  const result = process.platform === 'win32'
    ? await execute('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
    : await execute('ps', ['-A', '-o', 'comm='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  if (/serato\s*(dj|studio|itch|scratch)/i.test(result.stdout)) {
    throw new Error('Close Serato before syncing its library.');
  }
};

const metadata = ({ path, song }: SyncTrack): Record<string, SQLInputValue> => {
  const added = song.dateAdded === null ? NaN : Date.parse(song.dateAdded);
  const values = {
    file_name: basename(path.replaceAll('\\', '/')),
    file_size: song.fileSizeBytes,
    file_bit_rate: song.bitRateKbps,
    file_sample_rate: song.sampleRateHz,
    format: extname(path).slice(1) || song.fileKind,
    artist: song.artist,
    comments: song.comments,
    remixer: song.remixer,
    name: song.title,
    album: song.album,
    composer: song.composer,
    year: song.year === null ? null : String(song.year),
    genre: song.genre,
    key: song.musicalKey,
    label: song.label,
    rating: song.rating === null ? null : Math.max(0, Math.min(1, song.rating / (song.rating > 5 ? 255 : 5))),
    bpm: song.bpm,
    length_sec: song.durationSeconds === null ? null : Math.floor(song.durationSeconds),
    length_ms: song.durationSeconds === null ? null : Math.round(song.durationSeconds * 1000),
    time_added: Number.isFinite(added) ? Math.floor(added / 1000) : null,
    part_of_set: song.discNumber === null ? null : String(song.discNumber),
    track_number: song.trackNumber === null ? null : String(song.trackNumber),
    dj_play_count: song.playCount,
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== ''));
};

export const writeSeratoSqlite = async (
  rootPath: string,
  incoming: SyncLibrary,
  options: Readonly<{ metadata?: boolean; replaceTracks?: boolean; replacePlaylists?: boolean }> = {},
): Promise<{ trackCount: number; playlistCount: number; backupPaths: string[]; warnings: string[] }> => {
  await assertSeratoClosed();
  incoming = await resolveSeratoLibraryPaths(incoming);
  if (!(await stat(rootPath)).isFile()) throw new Error('Choose an existing Serato library.');
  const db = new DatabaseSync(rootPath, { timeout: 3000 });
  const backupPaths: string[] = [];
  try {
    const { spaceId, rootId } = anchors(db);
    const smartCrates = new Map(incoming.playlists.map((playlist) => [playlist, seratoSmartRules(playlist)]));
    const smartPaths = new Set(incoming.playlists.filter((playlist) => smartCrates.get(playlist)).map((playlist) => JSON.stringify(playlist.path)));
    for (const track of incoming.tracks) portablePath(rootPath, track.path);
    for (const playlist of incoming.playlists) {
      if (!playlist.path.length || playlist.path.some((part) => !part.trim() || /[\0\r\n]/.test(part))) {
        throw new Error('A playlist has an invalid crate name.');
      }
      if (playlist.path.slice(0, -1).some((_, index) => smartPaths.has(JSON.stringify(playlist.path.slice(0, index + 1))))) {
        throw new Error(`A smart crate cannot contain other crates: ${playlist.path.join(' / ')}`);
      }
    }
    db.exec('BEGIN IMMEDIATE');
    await assertSeratoClosed();
    const backupDirectory = join(dirname(rootPath), 'arsenal-backups', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    await mkdir(backupDirectory, { recursive: true });
    for (const path of [rootPath, join(dirname(rootPath), 'master.sqlite')]) {
      if (path !== rootPath) {
        try { await stat(path); } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
          throw error;
        }
      }
      const source = new DatabaseSync(path, { readOnly: true, timeout: 3000 });
      try {
        const destination = join(backupDirectory, basename(path));
        await backup(source, destination);
        backupPaths.push(destination);
      } finally {
        source.close();
      }
    }
    const foreignKeysBefore = db.prepare('PRAGMA foreign_key_check').all().length;
    const revision = id(db.prepare('SELECT revision FROM serato').get()?.revision) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('Invalid Serato revision.');
    db.prepare('UPDATE serato SET revision = ?').run(revision);
    const findSpaceAsset = db.prepare('SELECT id FROM space_asset WHERE asset_id = ? AND space_id = ?');
    const addSpaceAsset = db.prepare('INSERT INTO space_asset (asset_id, space_id) VALUES (?, ?)');
    const assetIdsByPath = new Map<string, number>();
    const assetsByPath = new Map<string, number>();
    const retainedSpaceAssets = new Set<number>();
    for (const row of db.prepare('SELECT id, portable_id, third_party_type FROM asset ORDER BY id').all()) {
      const key = await seratoMediaPathKey(assetPath(rootPath, row));
      if (!assetIdsByPath.has(key)) assetIdsByPath.set(key, id(row.id));
    }
    for (const row of db.prepare('SELECT a.portable_id, a.third_party_type, sa.id FROM asset a JOIN space_asset sa ON sa.asset_id = a.id WHERE sa.space_id = ?').all(spaceId)) {
      const portableId = text(row.portable_id);
      if (portableId) assetsByPath.set(await seratoMediaPathKey(assetPath(rootPath, row)), id(row.id));
    }
    for (const track of incoming.tracks) {
      const portableId = portablePath(rootPath, track.path);
      const key = await seratoMediaPathKey(track.path);
      const existing = assetIdsByPath.get(key);
      const values = metadata(track);
      const columns = Object.keys(values);
      let assetId: number;
      if (existing !== undefined) {
        assetId = existing;
        if (options.metadata !== false) {
          db.prepare(`UPDATE asset SET ${columns.map((column) => `"${column}" = ?`).join(', ')}, revision = ?, time_modified = ? WHERE id = ?`)
            .run(...Object.values(values), revision, Math.floor(Date.now() / 1000), assetId);
        }
      } else {
        await assertSeratoMediaFile(track.path);
        assetId = Number(db.prepare(`INSERT INTO asset (revision, portable_id, type, ${columns.map((column) => `"${column}"`).join(', ')})
          VALUES (?, ?, 'audio', ${columns.map(() => '?').join(', ')})`).run(revision, portableId, ...Object.values(values)).lastInsertRowid);
      }
      const spaceAsset = findSpaceAsset.get(assetId, spaceId);
      const spaceAssetId = spaceAsset ? id(spaceAsset.id) : Number(addSpaceAsset.run(assetId, spaceId).lastInsertRowid);
      assetIdsByPath.set(key, assetId);
      assetsByPath.set(key, spaceAssetId);
      retainedSpaceAssets.add(spaceAssetId);
    }
    const findCrate = db.prepare('SELECT id, type FROM container WHERE parent_id = ? AND name = ? COLLATE NOCASE');
    const addCrate = db.prepare(`INSERT INTO container (revision, parent_id, name, type, list_order, space_id)
      VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(list_order), 0) + 1 FROM container WHERE parent_id = ?), ?)`);
    const saveSmartRules = db.prepare(`INSERT INTO smart_crate_rules (container_id, revision, version, rules, needs_refresh)
      VALUES (?, ?, ?, ?, 1) ON CONFLICT(container_id) DO UPDATE SET
      revision = excluded.revision, version = excluded.version, rules = excluded.rules, needs_refresh = 1`);
    const findMembers = db.prepare('SELECT id, space_asset_id FROM container_asset WHERE container_id = ? ORDER BY list_order, id');
    const addMember = db.prepare('INSERT INTO container_asset (revision, container_id, space_asset_id, list_order) VALUES (?, ?, ?, ?)');
    const updateMember = db.prepare('UPDATE container_asset SET revision = ?, list_order = ? WHERE id = ?');
    const syncedCrates = new Set<number>();
    const retainedCrates = new Set<number>([rootId]);
    for (const playlist of incoming.playlists) {
      const smart = smartCrates.get(playlist);
      let containerId = rootId;
      for (const [index, name] of playlist.path.entries()) {
        const type = smart && index === playlist.path.length - 1 ? 2 : 1;
        const existing = findCrate.all(containerId, name);
        if (existing.length > 1 || existing.some((row) => row.type !== 1 && row.type !== type && !(options.replacePlaylists && row.type === 2))) {
          throw new Error(`A Serato crate conflicts with the playlist: ${playlist.path.join(' / ')}`);
        }
        containerId = existing[0] ? id(existing[0].id) : Number(addCrate.run(revision, containerId, name, type, containerId, spaceId).lastInsertRowid);
        if (existing[0] && existing[0].type !== type) {
          if (db.prepare('SELECT id FROM container WHERE parent_id = ? LIMIT 1').get(containerId)) {
            if (!options.replacePlaylists) throw new Error(`Cannot replace a crate that contains other crates with the smart playlist: ${playlist.path.join(' / ')}`);
            db.prepare('DELETE FROM container WHERE parent_id = ?').run(containerId);
          }
          db.prepare('UPDATE container SET type = ?, revision = ? WHERE id = ?').run(type, revision, containerId);
          if (type === 1) db.prepare('DELETE FROM smart_crate_rules WHERE container_id = ?').run(containerId);
        }
        retainedCrates.add(containerId);
      }
      if (smart) {
        saveSmartRules.run(containerId, revision, smart.version, smart.rules);
        db.prepare('DELETE FROM container_asset WHERE container_id = ?').run(containerId);
      }
      const members = findMembers.all(containerId);
      const existingMembers = new Map(members.map((row) => [id(row.space_asset_id), id(row.id)]));
      const desired = new Set<number>();
      for (const path of playlist.trackPaths) {
        const spaceAssetId = assetsByPath.get(await seratoMediaPathKey(path));
        if (spaceAssetId === undefined) throw new Error(`A playlist track is missing from the library: ${path}`);
        desired.add(spaceAssetId);
      }
      if (!smart && !options.replacePlaylists) for (const row of members) desired.add(id(row.space_asset_id));
      if (options.replacePlaylists) {
        const removeMember = db.prepare('DELETE FROM container_asset WHERE id = ?');
        for (const row of members) if (!desired.has(id(row.space_asset_id))) removeMember.run(id(row.id));
      }
      let order = 0;
      for (const spaceAssetId of desired) {
        order += 1;
        const memberId = existingMembers.get(spaceAssetId);
        if (memberId === undefined) addMember.run(revision, containerId, spaceAssetId, order);
        else updateMember.run(revision, order, memberId);
      }
      db.prepare('UPDATE container SET revision = ? WHERE id = ?').run(revision, containerId);
      syncedCrates.add(containerId);
    }
    if (options.replacePlaylists) {
      const removeCrate = db.prepare('DELETE FROM container WHERE id = ?');
      for (const row of db.prepare('SELECT id FROM container WHERE space_id = ?').all(spaceId)) {
        if (!retainedCrates.has(id(row.id))) removeCrate.run(id(row.id));
      }
    }
    if (options.replaceTracks) {
      const removeSpaceAsset = db.prepare('DELETE FROM space_asset WHERE id = ?');
      const removeUnusedAsset = db.prepare('DELETE FROM asset WHERE id = ? AND NOT EXISTS (SELECT 1 FROM space_asset WHERE asset_id = ?)');
      for (const row of db.prepare('SELECT id, asset_id FROM space_asset WHERE space_id = ?').all(spaceId)) {
        if (retainedSpaceAssets.has(id(row.id))) continue;
        removeSpaceAsset.run(id(row.id));
        removeUnusedAsset.run(id(row.asset_id), id(row.asset_id));
      }
    }
    db.prepare('UPDATE space SET revision = ? WHERE id = ?').run(revision, spaceId);
    if (db.prepare('PRAGMA foreign_key_check').all().length > foreignKeysBefore ||
        db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') {
      throw new Error('Serato library verification failed. No changes were saved.');
    }
    db.exec('COMMIT');
    return { trackCount: incoming.tracks.length, playlistCount: syncedCrates.size, backupPaths,
      warnings: [...smartCrates.values()].flatMap((smart) => smart?.warnings ?? []),
    };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
};
