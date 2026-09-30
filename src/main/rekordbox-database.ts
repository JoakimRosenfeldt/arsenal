import { randomInt, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { SaxesParser } from 'saxes';
import type { SongRow, SyncFields } from '../shared/dj-library';
import { normalizePath, type SyncBeatgrid, type SyncCue, type SyncLibrary, type SyncLoop, type SyncPerformance, type SyncPlaylist } from './library-sync-model';
import { assertRekordboxClosed, assertRekordboxClosedSync, backupRekordboxDatabase, openRekordboxDatabase, type RekordboxDatabase } from './rekordbox-database-connection';

type Row = Record<string, unknown>;
type Value = string | number | null;
type Values = Record<string, Value>;

// Rekordbox 7 stores some fields (streaming and cloud tracks) as "$A7:v1:<iv>:<data>" ciphertext with a private key.
const encrypted = (value: unknown): boolean => typeof value === 'string' && value.startsWith('$A7:');
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() && !encrypted(value) ? value : null;
const number = (value: unknown): number | null => {
  const result = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(result) ? result : null;
};
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid Rekordbox database identifier.');
  return value;
};
const rows = (db: RekordboxDatabase, sql: string, ...values: Value[]): Row[] => db.prepare<Value[], Row>(sql).all(...values);
const pathKey = (path: readonly string[]): string => JSON.stringify(path);
const active = (row: Row): boolean => number(row.rb_local_deleted) !== 1;
const standardPlaylist = (row: Row): boolean => [0, 1, 4].includes(number(row.Attribute) ?? -1) && active(row);
const dateTime = (): string => new Date().toISOString().replace('T', ' ').replace('Z', ' +00:00');

// Native row identities, revisions and playlist sidecar follow pyrekordbox/masterdb.
const schema = (db: RekordboxDatabase): void => {
  const required = {
    agentRegistry: ['registry_id', 'int_1', 'updated_at'],
    djmdContent: ['ID', 'FolderPath', 'Title', 'ArtistID', 'ComposerID', 'RemixerID', 'AlbumID', 'GenreID', 'LabelID', 'KeyID',
      'BPM', 'Length', 'TrackNo', 'BitRate', 'Commnt', 'FileType', 'Rating', 'ReleaseYear', 'StockDate', 'DJPlayCount',
      'FileSize', 'DiscNo', 'Subtitle', 'SampleRate', 'rb_local_usn', 'updated_at', 'rb_local_deleted'],
    djmdPlaylist: ['ID', 'Seq', 'Name', 'Attribute', 'ParentID', 'SmartList', 'UUID', 'rb_local_usn', 'created_at', 'updated_at', 'rb_local_deleted'],
    djmdSongPlaylist: ['ID', 'PlaylistID', 'ContentID', 'TrackNo', 'UUID', 'rb_local_usn', 'created_at', 'updated_at', 'rb_local_deleted'],
    djmdArtist: ['ID', 'Name', 'UUID', 'rb_local_usn', 'created_at', 'updated_at'],
    djmdAlbum: ['ID', 'Name', 'UUID', 'rb_local_usn', 'created_at', 'updated_at'],
    djmdGenre: ['ID', 'Name', 'UUID', 'rb_local_usn', 'created_at', 'updated_at'],
    djmdLabel: ['ID', 'Name', 'UUID', 'rb_local_usn', 'created_at', 'updated_at'],
    djmdKey: ['ID', 'ScaleName', 'Seq', 'UUID', 'rb_local_usn', 'created_at', 'updated_at'],
    djmdCue: ['ContentID', 'Kind', 'InMsec', 'OutMsec', 'Comment', 'rb_local_deleted'],
  };
  for (const [table, columns] of Object.entries(required)) {
    const info = rows(db, `PRAGMA table_info("${table}")`);
    const present = new Set(info.map((row) => row.name));
    const primaryKey = table === 'agentRegistry' ? 'registry_id' : columns.includes('ID') ? 'ID' : null;
    if (columns.some((column) => !present.has(column)) || primaryKey !== null &&
      (info.filter((row) => number(row.pk)).length !== 1 || !info.some((row) => row.name === primaryKey && row.pk === 1))) {
      throw new Error('Unsupported Rekordbox database structure. No changes were saved.');
    }
  }
  const revision = number(rows(db, "SELECT int_1 FROM agentRegistry WHERE registry_id = 'localUpdateCount'")[0]?.int_1);
  if (revision === null || !Number.isSafeInteger(revision) || revision < 0) throw new Error('The Rekordbox database has an invalid update counter.');
};

const nativePlaylists = (db: RekordboxDatabase) => {
  const all = rows(db, 'SELECT * FROM djmdPlaylist ORDER BY Seq, ID').filter(active);
  const children = new Map<string, Row[]>();
  for (const row of all) {
    const parent = id(row.ParentID);
    const siblings = children.get(parent) ?? [];
    siblings.push(row);
    children.set(parent, siblings);
  }
  const ordered: { row: Row; path: readonly string[] }[] = [];
  const visit = (parent: string, path: readonly string[], visiting: Set<string>): void => {
    for (const row of children.get(parent) ?? []) {
      if (!standardPlaylist(row)) continue;
      const playlistId = id(row.ID);
      if (visiting.has(playlistId)) throw new Error('The Rekordbox playlist hierarchy contains a cycle.');
      const name = text(row.Name);
      if (!name) throw new Error('A Rekordbox playlist has no name.');
      const childPath = [...path, name];
      ordered.push({ row, path: childPath });
      visiting.add(playlistId);
      visit(playlistId, childPath, visiting);
      visiting.delete(playlistId);
    }
  };
  visit('root', [], new Set());
  const visited = new Set(ordered.map(({ row }) => id(row.ID)));
  if (all.some((row) => standardPlaylist(row) && !visited.has(id(row.ID)))) throw new Error('The Rekordbox playlist hierarchy is unsupported.');
  return { all, ordered };
};

const fileTypes: Record<number, string> = { 1: 'MP3', 3: 'MP4', 4: 'AAC', 5: 'FLAC', 6: 'ALAC', 11: 'WAV', 12: 'AIFF', 16: 'VIDEO' };
const extensionFileTypes: Record<string, number> = { mp3: 1, mp4: 3, m4a: 4, aac: 4, flac: 5, wav: 11, aiff: 12, aif: 12 };
const links = {
  artist: ['djmdArtist', 'ArtistID', 'Name'], composer: ['djmdArtist', 'ComposerID', 'Name'], remixer: ['djmdArtist', 'RemixerID', 'Name'],
  album: ['djmdAlbum', 'AlbumID', 'Name'], genre: ['djmdGenre', 'GenreID', 'Name'], label: ['djmdLabel', 'LabelID', 'Name'],
  musicalKey: ['djmdKey', 'KeyID', 'ScaleName'],
} as const;

// ANLZ layout follows Deep Symmetry's crate-digger notes: a big-endian "PMAI" file of tagged sections, where PQTZ holds the beat grid.
const readBeatgrids = async (path: string): Promise<SyncBeatgrid[]> => {
  let data: Buffer;
  try { data = await readFile(path); } catch { return []; }
  if (data.length < 12 || data.toString('latin1', 0, 4) !== 'PMAI') return [];
  for (let offset = data.readUInt32BE(4); offset + 24 <= data.length;) {
    const tagLength = data.readUInt32BE(offset + 8);
    if (tagLength < 12) return [];
    if (data.toString('latin1', offset, offset + 4) === 'PQTZ') {
      const grids: SyncBeatgrid[] = [];
      for (let index = 0, entry = offset + data.readUInt32BE(offset + 4); index < data.readUInt32BE(offset + 20) && entry + 8 <= data.length; index++, entry += 8) {
        const bpm = data.readUInt16BE(entry + 2) / 100;
        if (bpm > 0 && grids.at(-1)?.bpm !== bpm) grids.push({ start: data.readUInt32BE(entry + 4) / 1000, bpm, beat: data.readUInt16BE(entry) || 1 });
      }
      return grids;
    }
    offset += tagLength;
  }
  return [];
};

const cueColor = [255, 0, 0] as const;
const loopColor = [39, 170, 225] as const;

export const readRekordboxDatabase = async (path: string): Promise<{ library: SyncLibrary; warnings: string[] }> => {
  const db = await openRekordboxDatabase(path);
  try {
    schema(db);
    const names = new Map<string, Map<string, string | null>>();
    for (const [table, , column] of Object.values(links)) {
      if (!names.has(table)) names.set(table, new Map(rows(db, `SELECT ID, "${column}" FROM "${table}"`).map((row) => [id(row.ID), text(row[column])])));
    }
    const performances = new Map<string, { hotCues: SyncCue[]; memoryCues: SyncCue[]; loops: SyncLoop[]; beatgrids: SyncBeatgrid[] }>();
    for (const cue of rows(db, 'SELECT * FROM djmdCue WHERE COALESCE(rb_local_deleted, 0) = 0 ORDER BY InMsec, ID')) {
      const contentId = id(cue.ContentID);
      const performance = performances.get(contentId) ?? { hotCues: [], memoryCues: [], loops: [], beatgrids: [] };
      performances.set(contentId, performance);
      const kind = number(cue.Kind) ?? 0;
      const start = (number(cue.InMsec) ?? 0) / 1000;
      const end = (number(cue.OutMsec) ?? -1) / 1000;
      // Kind is 0 for memory cues, otherwise the hot cue number (1 = A).
      const index = kind - 1;
      const name = text(cue.Comment) ?? '';
      if (end > start) performance.loops.push({ index, name, start, end, locked: false, hotCue: kind > 0, color: loopColor });
      else (kind > 0 ? performance.hotCues : performance.memoryCues).push({ index, name, start, color: cueColor });
    }
    const share = join(dirname(path), 'share');
    const contents = rows(db, 'SELECT * FROM djmdContent WHERE COALESCE(rb_local_deleted, 0) = 0 ORDER BY ID');
    for (let offset = 0; offset < contents.length; offset += 32) {
      await Promise.all(contents.slice(offset, offset + 32).map(async (row) => {
        const analysis = text(row.AnalysisDataPath);
        if (!analysis) return;
        const beatgrids = await readBeatgrids(join(share, analysis.replace(/^[\\/]+/, '')));
        if (!beatgrids.length) return;
        const performance = performances.get(id(row.ID)) ?? { hotCues: [], memoryCues: [], loops: [], beatgrids: [] };
        performance.beatgrids = beatgrids;
        performances.set(id(row.ID), performance);
      }));
    }
    let encryptedTracks = 0;
    const tracks = contents.flatMap((row) => {
      const trackId = id(row.ID);
      if (encrypted(row.FolderPath) || !text(row.FolderPath) && Object.values(row).some(encrypted)) { encryptedTracks++; return []; }
      const path = text(row.FolderPath) ?? `streaming://rekordbox/${encodeURIComponent(trackId)}`;
      const title = text(row.Title) ?? basename(path);
      const linked = (field: keyof typeof links): string | null => {
        const [table, column] = links[field];
        const key = text(row[column]);
        return key ? names.get(table)?.get(key) ?? null : null;
      };
      const bpm = number(row.BPM);
      const rating = number(row.Rating);
      const performance = performances.get(trackId);
      const song: SongRow = {
        id: `rekordbox-${trackId}`, title: title.startsWith('spotify:track:') ? `Spotify track ${title.slice('spotify:track:'.length)}` : title, artist: linked('artist'), composer: linked('composer'),
        remixer: linked('remixer'), album: linked('album'), mixName: text(row.Subtitle), label: linked('label'), genre: linked('genre'),
        year: number(row.ReleaseYear), bpm: bpm === null ? null : bpm / 100, musicalKey: linked('musicalKey'),
        durationSeconds: number(row.Length), fileKind: fileTypes[number(row.FileType) ?? 0] ?? null, fileSizeBytes: number(row.FileSize),
        bitRateKbps: number(row.BitRate), sampleRateHz: number(row.SampleRate), trackNumber: number(row.TrackNo), discNumber: number(row.DiscNo),
        playCount: number(row.DJPlayCount), rating: rating === null ? null : rating * 51, dateAdded: text(row.StockDate), comments: text(row.Commnt),
        artworkUrl: null, audioUrl: null, source: /^(?:\/|[a-z]:[\\/])/i.test(path) && !number(row.ServiceID) ? 'local' : 'streaming',
        cuePointCount: performance ? performance.hotCues.length + performance.memoryCues.length + performance.loops.length : 0,
        hotCueCount: performance ? performance.hotCues.length + performance.loops.filter((loop) => loop.hotCue).length : 0,
      };
      return [{ path, song, ...(performance ? { performance } : {}) }];
    });
    const contentPaths = new Map(tracks.map((track) => [track.song.id.slice('rekordbox-'.length), track.path]));
    const members = new Map<string, string[]>();
    for (const row of rows(db, 'SELECT * FROM djmdSongPlaylist WHERE COALESCE(rb_local_deleted, 0) = 0 ORDER BY TrackNo, ID')) {
      const path = contentPaths.get(id(row.ContentID));
      if (!path) continue;
      const playlistId = id(row.PlaylistID);
      const paths = members.get(playlistId) ?? [];
      paths.push(path);
      members.set(playlistId, paths);
    }
    // Intelligent playlists calculate their members from rules, so a static import would lose their contents.
    const playlists = nativePlaylists(db).ordered.filter(({ row }) => number(row.Attribute) !== 4).map(({ row, path }): SyncPlaylist => ({
      path, kind: number(row.Attribute) === 1 ? 'folder' : 'playlist',
      trackPaths: members.get(id(row.ID)) ?? [],
    }));
    return { library: { tracks, playlists }, warnings: encryptedTracks ? [`${encryptedTracks} Rekordbox ${encryptedTracks === 1 ? 'track was' : 'tracks were'} skipped because Rekordbox encrypts ${encryptedTracks === 1 ? 'its' : 'their'} details. These are usually streaming tracks.`] : [] };
  } finally { db.close(); }
};

type SidecarNode = { start: number; end: number; attributes: Record<string, string> };
const playlistSidecar = (source: string): { nodes: Map<string, SidecarNode>; insertion: number; emptyContainer: { start: number; end: number } | null } => {
  const parser = new SaxesParser({ xmlns: false });
  const stack: string[] = [];
  const nodes = new Map<string, SidecarNode>();
  let start = 0;
  let node: SidecarNode | null = null;
  let insertion = -1;
  let emptyContainer: { start: number; end: number } | null = null;
  parser.on('error', (error) => { throw error; });
  parser.on('doctype', () => { throw new Error('Unsupported Rekordbox playlist sidecar.'); });
  parser.on('opentagstart', (tag) => { start = parser.position - tag.name.length - 2; });
  parser.on('opentag', (tag) => {
    if (stack.length === 0 && tag.name !== 'MASTER_PLAYLIST') throw new Error('Invalid Rekordbox playlist sidecar.');
    if (node) throw new Error('Unsupported nested Rekordbox playlist sidecar entry.');
    if (tag.name === 'NODE' && stack.at(-1) === 'PLAYLISTS') node = { start, end: 0, attributes: { ...tag.attributes } };
    stack.push(tag.name);
  });
  parser.on('closetag', (tag) => {
    stack.pop();
    if (tag.name === 'NODE' && node) {
      const hexId = node.attributes.Id;
      if (!hexId || !/^[\da-f]+$/i.test(hexId)) throw new Error('Invalid Rekordbox playlist sidecar identifier.');
      const key = BigInt(`0x${hexId}`).toString();
      if (nodes.has(key)) throw new Error('Duplicate Rekordbox playlist sidecar identifier.');
      node.end = parser.position;
      nodes.set(key, node);
      node = null;
    }
    if (tag.name === 'PLAYLISTS') {
      if (insertion !== -1 || stack.length !== 1) throw new Error('Unsupported Rekordbox playlist sidecar structure.');
      insertion = tag.isSelfClosing ? start : source.lastIndexOf('</', parser.position - 1);
      if (tag.isSelfClosing) emptyContainer = { start, end: parser.position };
    }
  });
  parser.write(source).close();
  if (insertion < 0) throw new Error('The Rekordbox playlist sidecar has no playlist list.');
  return { nodes, insertion, emptyContainer };
};

const renderSidecar = (source: string, changed: ReadonlyMap<string, Row>, removed: ReadonlySet<string>): string => {
  const { nodes, insertion, emptyContainer } = playlistSidecar(source);
  const edits: { start: number; end: number; value: string }[] = [];
  const additions: string[] = [];
  const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  for (const playlistId of removed) {
    const node = nodes.get(playlistId);
    if (node) edits.push({ ...node, value: '' });
  }
  for (const [playlistId, row] of changed) {
    if (removed.has(playlistId)) continue;
    if (!/^\d+$/.test(playlistId) || row.ParentID !== 'root' && !/^\d+$/.test(id(row.ParentID))) throw new Error('Unsupported native Rekordbox playlist identifier.');
    const existing = nodes.get(playlistId);
    const attributes = { ...existing?.attributes, Id: BigInt(playlistId).toString(16).toUpperCase(),
      ParentId: row.ParentID === 'root' ? '0' : BigInt(id(row.ParentID)).toString(16).toUpperCase(),
      Attribute: String(row.Attribute), Timestamp: String(Date.parse(id(row.updated_at).replace(' +00:00', 'Z').replace(' ', 'T'))),
      Lib_Type: existing?.attributes.Lib_Type ?? '0', CheckType: existing?.attributes.CheckType ?? '0' };
    const value = `<NODE${Object.entries(attributes).map(([key, value]) => ` ${key}="${escape(value)}"`).join('')}/>`;
    if (existing) edits.push({ ...existing, value });
    else additions.push(`    ${value}\n`);
  }
  if (additions.length) edits.push(emptyContainer
    ? { ...emptyContainer, value: `${source.slice(emptyContainer.start, emptyContainer.end).replace(/\s*\/>$/, '>')}\n${additions.join('')}</PLAYLISTS>` }
    : { start: insertion, end: insertion, value: additions.join('') });
  for (const edit of edits.sort((left, right) => right.start - left.start)) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
};

export const writeRekordboxDatabase = async (
  path: string,
  incoming: SyncLibrary,
  options: Readonly<{ fields: SyncFields; mode: 'merge' | 'replace'; removePlaylistPaths?: readonly (readonly string[])[] }>,
): Promise<{ trackCount: number; playlistCount: number; skippedTrackCount: number; backupPaths: string[]; warnings: string[] }> => {
  if (!options.fields.tracks && !options.fields.metadata && !options.fields.playlists && !options.fields.hotCues && !options.fields.loops) {
    throw new Error('Native Rekordbox sync supports tracks, track metadata, playlists, hot cues and loops. Select at least one of those categories.');
  }
  await assertRekordboxClosed();
  const db = await openRekordboxDatabase(path, { readonly: false });
  const sidecarPath = join(dirname(path), 'masterPlaylists6.xml');
  const temporaryPath = `${sidecarPath}.${randomUUID()}.tmp`;
  let originalSidecar: Buffer | null = null;
  let sidecarWritten = false;
  try {
    schema(db);
    originalSidecar = await readFile(sidecarPath);
    const sidecarSource = new TextDecoder('utf-8', { fatal: true }).decode(originalSidecar);
    playlistSidecar(sidecarSource);
    const dataVersion = rows(db, 'PRAGMA data_version')[0]?.data_version;
    const now = dateTime();
    let revision = number(rows(db, "SELECT int_1 FROM agentRegistry WHERE registry_id = 'localUpdateCount'")[0]?.int_1) ?? 0;
    const statements: { sql: string; values: Value[] }[] = [];
    const changedPlaylists = new Map<string, Row>();
    const removedPlaylists = new Set<string>();
    const warnings: string[] = [];
    const nextRevision = (): number => {
      revision++;
      if (!Number.isSafeInteger(revision)) throw new Error('The Rekordbox update counter is too large.');
      return revision;
    };
    const update = (table: string, row: Row, values: Values): boolean => {
      const changed = Object.entries(values).filter(([key, value]) => !(row[key] === value ||
        (row[key] === null || row[key] === '') && (value === null || value === '')));
      if (!changed.length) return false;
      const patch = { ...Object.fromEntries(changed), rb_local_usn: nextRevision(), updated_at: now };
      statements.push({ sql: `UPDATE "${table}" SET ${Object.keys(patch).map((column) => `"${column}" = ?`).join(', ')} WHERE ID = ?`, values: [...Object.values(patch), id(row.ID)] });
      Object.assign(row, patch);
      if (table === 'djmdPlaylist') changedPlaylists.set(id(row.ID), row);
      return true;
    };
    const insert = (table: string, values: Values): Row => {
      const row = { ...values, UUID: randomUUID(), rb_local_usn: nextRevision(), created_at: now, updated_at: now };
      statements.push({ sql: `INSERT INTO "${table}" (${Object.keys(row).map((column) => `"${column}"`).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, values: Object.values(row) });
      return row;
    };
    const remove = (table: string, row: Row): void => {
      nextRevision();
      statements.push({ sql: `DELETE FROM "${table}" WHERE ID = ?`, values: [id(row.ID)] });
    };
    const usedIds = new Map<string, Set<string>>();
    const unusedId = (table: string, column = 'ID'): string => {
      let used = usedIds.get(`${table}.${column}`);
      if (!used) {
        used = new Set(rows(db, `SELECT "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL`).map((row) => String(row.value)));
        usedIds.set(`${table}.${column}`, used);
      }
      let candidate: string;
      do { candidate = String(randomInt(100, 2 ** 28)); } while (used.has(candidate));
      used.add(candidate);
      return candidate;
    };
    const relatedRows = new Map<string, { byId: Map<string, Row>; byName: Map<string, Row>; nextSequence: number }>();
    const related = (table: string, column: string) => {
      let entries = relatedRows.get(table);
      if (!entries) {
        const all = rows(db, `SELECT * FROM "${table}"`).filter(active);
        entries = { byId: new Map(all.map((row) => [id(row.ID), row])),
          byName: new Map(all.map((row) => [text(row[column]) ?? '', row])), nextSequence: all.reduce((max, row) => Math.max(max, number(row.Seq) ?? 0), 0) + 1 };
        relatedRows.set(table, entries);
      }
      return entries;
    };
    const linkedId = (table: string, column: string, value: string | null, existingId: unknown): string | null => {
      if (!value?.trim()) return existingId === '0' ? '0' : null;
      const entries = related(table, column);
      const current = typeof existingId === 'string' ? entries.byId.get(existingId) : undefined;
      const existing = current?.[column] === value ? current : entries.byName.get(value);
      if (existing) return id(existing.ID);
      const created = insert(table, { ID: unusedId(table), [column]: value,
        ...(table === 'djmdKey' ? { Seq: entries.nextSequence++ } : {}) });
      entries.byId.set(id(created.ID), created);
      entries.byName.set(value, created);
      return id(created.ID);
    };
    const contents = rows(db, 'SELECT * FROM djmdContent WHERE COALESCE(rb_local_deleted, 0) = 0');
    const byPath = new Map<string, Row>();
    const ambiguousPaths = new Set<string>();
    for (const row of contents) {
      const path = text(row.FolderPath);
      if (!path) continue;
      const key = normalizePath(path);
      if (byPath.has(key)) ambiguousPaths.add(key);
      else byPath.set(key, row);
    }
    const contentColumns = new Set(rows(db, 'PRAGMA table_info("djmdContent")').map((row) => row.name));
    let contentDefaults: Values | null = null;
    // New Collection rows follow pyrekordbox's MasterDatabase.add_content.
    const addContent = (location: string): Row | null => {
      const fileType = extensionFileTypes[location.split('.').pop()?.toLowerCase() ?? ''];
      if (fileType === undefined) return null;
      if (contentDefaults === null) {
        const device = rows(db, 'SELECT ID, MasterDBID FROM djmdDevice WHERE COALESCE(rb_local_deleted, 0) = 0 ORDER BY ID LIMIT 1')[0];
        const menu = rows(db, "SELECT rb_local_usn FROM djmdMenuItems WHERE Name = 'TRACK' LIMIT 1")[0];
        if (!device || !menu) throw new Error('This Rekordbox database cannot receive new tracks. No changes were saved.');
        contentDefaults = { DeviceID: id(device.ID), MasterDBID: text(device.MasterDBID), ContentLink: number(menu.rb_local_usn), HotCueAutoLoad: 'on' };
      }
      const contentId = unusedId('djmdContent');
      const today = now.slice(0, 10);
      const values: Values = { ...contentDefaults, ID: contentId, MasterSongID: contentId, rb_file_id: unusedId('djmdContent', 'rb_file_id'),
        FolderPath: location, FileNameL: basename(location), FileType: fileType, DateCreated: today, StockDate: today };
      return insert('djmdContent', Object.fromEntries(Object.entries(values).filter(([column]) => contentColumns.has(column))));
    };
    const cueColumns = new Set(rows(db, 'PRAGMA table_info("djmdCue")').map((row) => row.name));
    const cuesByContent = new Map<string, Row[]>();
    for (const cue of rows(db, 'SELECT * FROM djmdCue WHERE COALESCE(rb_local_deleted, 0) = 0')) {
      const group = cuesByContent.get(id(cue.ContentID)) ?? [];
      group.push(cue);
      cuesByContent.set(id(cue.ContentID), group);
    }
    // Replaces the selected cue kinds of one track. Frames are 1/150 s; MPEG seek fields stay 0 as for non-VBR files.
    const syncCues = (content: Row, performance: SyncPerformance): void => {
      const loop = (cue: Row): boolean => (number(cue.OutMsec) ?? -1) > (number(cue.InMsec) ?? 0);
      const managed = (cue: Row): boolean => loop(cue) ? options.fields.loops
        : options.fields.hotCues && ((number(cue.Kind) ?? 0) > 0 || performance.memoryCues !== undefined);
      const current = cuesByContent.get(id(content.ID)) ?? [];
      const existing = current.filter(managed);
      const occupied = new Set(current.filter((cue) => !managed(cue)).map((cue) => number(cue.Kind) ?? 0));
      const kind = (index: number, hotCue: boolean): number | null => {
        const slot = hotCue && index >= 0 && index < 8 ? index + 1 : 0;
        if (slot === 0) return 0;
        if (occupied.has(slot)) return null;
        occupied.add(slot);
        return slot;
      };
      const ms = (seconds: number): number => Math.max(0, Math.round(seconds * 1000));
      const desired: Values[] = [];
      if (options.fields.hotCues) for (const cue of [...performance.hotCues, ...performance.memoryCues ?? []]) {
        const Kind = kind(cue.index, cue.index >= 0);
        if (Kind !== null && (Kind > 0 || cue.index < 0)) desired.push({ Kind, InMsec: ms(cue.start), OutMsec: -1, Comment: cue.name || null });
      }
      if (options.fields.loops) for (const cue of performance.loops) {
        desired.push({ Kind: kind(cue.index, cue.hotCue === true) ?? 0, InMsec: ms(cue.start), OutMsec: ms(cue.end), Comment: cue.name || null });
      }
      const signature = (cues: readonly Row[]): string => JSON.stringify(cues.map((cue) =>
        [number(cue.Kind) ?? 0, number(cue.InMsec) ?? 0, number(cue.OutMsec) ?? -1, text(cue.Comment) ?? ''].join('\0')).sort());
      if (signature(existing) === signature(desired)) return;
      for (const cue of existing) remove('djmdCue', cue);
      for (const cue of desired) {
        const inMsec = number(cue.InMsec) ?? 0;
        const outMsec = number(cue.OutMsec) ?? -1;
        const values: Values = { ...cue, ID: unusedId('djmdCue'), ContentID: id(content.ID), ContentUUID: text(content.UUID),
          InFrame: Math.round(inMsec * 0.15), InMpegFrame: 0, InMpegAbs: 0, OutFrame: outMsec < 0 ? 0 : Math.round(outMsec * 0.15),
          OutMpegFrame: 0, OutMpegAbs: 0, Color: -1, ActiveLoop: 0, BeatLoopSize: 0 };
        insert('djmdCue', Object.fromEntries(Object.entries(values).filter(([column]) => cueColumns.has(column))));
      }
      changedCueTracks++;
    };
    let changedCueTracks = 0;
    // Conflicts skip one track or playlist so the rest of the library still syncs.
    const conflicts: string[] = [];
    const syncedTracks = new Set<string>();
    const skippedTracks = new Set<string>();
    let addedTracks = 0;
    let encryptedTracks = 0;
    let changedAnalysedBpm = false;
    for (const track of incoming.tracks) {
      const location = track.location ?? track.path;
      const key = normalizePath(location);
      if (ambiguousPaths.has(key)) { conflicts.push(`${track.song.title}: Rekordbox has this file more than once`); continue; }
      let row = byPath.get(key);
      const added = !row && options.fields.tracks;
      if (!row && added) {
        row = addContent(process.platform === 'win32' ? location.replaceAll('\\', '/') : location) ?? undefined;
        if (row) { byPath.set(key, row); addedTracks++; }
      }
      if (!row) { skippedTracks.add(key); continue; }
      if (syncedTracks.has(id(row.ID))) { conflicts.push(`${track.song.title}: Arsenal has this file more than once`); continue; }
      byPath.set(normalizePath(track.path), row);
      syncedTracks.add(id(row.ID));
      const cues = options.fields.hotCues || options.fields.loops ? track.performance : undefined;
      if (!options.fields.metadata && !added && !cues) continue;
      // Arsenal cannot read encrypted fields, so writing its blanks back would erase them.
      const current = row;
      if (Object.values(current).some(encrypted) || Object.values(links).some(([table, column, name]) =>
        typeof current[column] === 'string' && encrypted(related(table, name).byId.get(current[column])?.[name]))) { encryptedTracks++; continue; }
      if (cues) syncCues(row, cues);
      if (!options.fields.metadata && !added) continue;
      const song = track.song;
      const integer = (value: number | null): number | null => {
        if (value === null) return null;
        if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value))) throw new Error(`Invalid metadata for ${song.title}.`);
        return Math.round(value);
      };
      const values: Values = { Title: song.title, Subtitle: song.mixName, Commnt: song.comments, ReleaseYear: integer(song.year),
        BPM: integer(song.bpm === null ? null : song.bpm * 100), Length: integer(song.durationSeconds), TrackNo: integer(song.trackNumber),
        DiscNo: integer(song.discNumber), BitRate: integer(song.bitRateKbps), SampleRate: integer(song.sampleRateHz), FileSize: integer(song.fileSizeBytes),
        DJPlayCount: integer(song.playCount), Rating: song.rating === null ? null : Math.min(5, integer(song.rating > 5 ? song.rating / 51 : song.rating) ?? 0),
        StockDate: song.dateAdded ?? (added ? now.slice(0, 10) : null) };
      for (const [field, [table, column, name]] of Object.entries(links)) {
        if (!(field in song)) continue;
        const value = song[field as keyof typeof links];
        values[column] = linkedId(table, name, value, row[column]);
      }
      changedAnalysedBpm ||= values.BPM !== number(row.BPM) && text(row.AnalysisDataPath) !== null;
      update('djmdContent', row, values);
    }
    const native = nativePlaylists(db);
    const playlistsByPath = new Map<string, Row>();
    const duplicateNative = new Set<string>();
    for (const entry of native.ordered) {
      const key = pathKey(entry.path);
      if (playlistsByPath.has(key)) duplicateNative.add(key);
      else playlistsByPath.set(key, entry.row);
    }
    const desired = new Map<string, { path: readonly string[]; folder: boolean; playlist?: SyncPlaylist }>();
    const incomingPlaylistPaths = new Set<string>();
    const protectedIntelligent = new Set<string>();
    let playlistCount = 0;
    if (options.fields.playlists) for (const playlist of incoming.playlists) {
      const name = playlist.path.join(' / ');
      if (!playlist.path.length || playlist.path.some((part) => !part.trim() || /[\0\r\n]/.test(part))) { conflicts.push(`${name || 'Untitled playlist'}: invalid playlist name`); continue; }
      if (playlist.path.some((_, index) => duplicateNative.has(pathKey(playlist.path.slice(0, index + 1))))) {
        conflicts.push(`${name}: Rekordbox has more than one playlist with this name`);
        continue;
      }
      const protectedPath = playlist.path.findIndex((_, index) => number(playlistsByPath.get(pathKey(playlist.path.slice(0, index + 1)))?.Attribute) === 4);
      if (protectedPath !== -1) {
        protectedIntelligent.add(pathKey(playlist.path.slice(0, protectedPath + 1)));
        continue;
      }
      const key = pathKey(playlist.path);
      if (incomingPlaylistPaths.has(key)) { conflicts.push(`${name}: Arsenal has more than one playlist with this name`); continue; }
      incomingPlaylistPaths.add(key);
      playlistCount++;
      for (let length = 1; length <= playlist.path.length; length++) {
        const path = playlist.path.slice(0, length);
        const key = pathKey(path);
        const previous = desired.get(key);
        const last = length === playlist.path.length;
        desired.set(key, { path, folder: previous?.folder || !last || playlist.kind === 'folder',
          ...(last ? { playlist } : previous?.playlist ? { playlist: previous.playlist } : {}) });
      }
    }
    for (const entry of desired.values()) {
      if (entry.folder && entry.playlist?.trackPaths.length) conflicts.push(`${entry.path.join(' / ')}: Rekordbox folders cannot hold tracks, so its tracks were not synced`);
    }
    if (protectedIntelligent.size) warnings.push(`${protectedIntelligent.size} native Rekordbox intelligent playlist${protectedIntelligent.size === 1 ? ' was' : 's were'} kept unchanged. Arsenal playlists with the same names were skipped.`);
    const members = rows(db, 'SELECT * FROM djmdSongPlaylist WHERE COALESCE(rb_local_deleted, 0) = 0 ORDER BY TrackNo, ID');
    const membersByPlaylist = new Map<string, Row[]>();
    for (const member of members) {
      const playlistId = id(member.PlaylistID);
      const group = membersByPlaylist.get(playlistId) ?? [];
      group.push(member);
      membersByPlaylist.set(playlistId, group);
    }
    const explicitRemovals = new Set((options.fields.playlists ? options.removePlaylistPaths ?? [] : []).map(pathKey));
    for (const { row, path } of native.ordered) {
      if (number(row.Attribute) === 4) continue;
      if (duplicateNative.has(pathKey(path))) continue;
      const removePath = explicitRemovals.has(pathKey(path));
      if (options.fields.playlists && !desired.has(pathKey(path)) && (options.mode === 'replace' || removePath)) removedPlaylists.add(id(row.ID));
    }
    const nativeById = new Map(native.all.map((row) => [id(row.ID), row]));
    let retainedFolders = false;
    for (const row of native.all) {
      if (removedPlaylists.has(id(row.ID))) continue;
      let parent = id(row.ParentID);
      while (removedPlaylists.delete(parent)) {
        retainedFolders = true;
        const ancestor = nativeById.get(parent);
        if (!ancestor) break;
        parent = id(ancestor.ParentID);
      }
    }
    if (retainedFolders) warnings.push('Folders containing Rekordbox-only playlists were kept with those playlists.');
    for (const { row, path } of [...native.ordered].reverse()) {
      if (!removedPlaylists.has(id(row.ID))) continue;
      for (const member of membersByPlaylist.get(id(row.ID)) ?? []) remove('djmdSongPlaylist', member);
      remove('djmdPlaylist', row);
      playlistsByPath.delete(pathKey(path));
    }
    const desiredOrder = new Map<string, number>();
    const parentsWithChildren = new Set(native.all.filter((row) => !removedPlaylists.has(id(row.ID))).map((row) => id(row.ParentID)));
    let materializedSmart = false;
    for (const entry of desired.values()) {
      const key = pathKey(entry.path);
      const parent = entry.path.length === 1 ? 'root' : id(playlistsByPath.get(pathKey(entry.path.slice(0, -1)))?.ID);
      let row = playlistsByPath.get(key);
      if (!row) {
        row = insert('djmdPlaylist', { ID: unusedId('djmdPlaylist'), Name: entry.path.at(-1) ?? '', ParentID: parent, Attribute: entry.folder ? 1 : 0, Seq: 1 });
        playlistsByPath.set(key, row);
        native.all.push(row);
        changedPlaylists.set(id(row.ID), row);
      } else {
        // An empty Arsenal playlist over a Rekordbox folder usually is that folder, kept after its intelligent playlists were left out.
        if (!entry.folder && parentsWithChildren.has(id(row.ID))) {
          if (entry.playlist?.trackPaths.length) conflicts.push(`${entry.path.join(' / ')}: a Rekordbox folder with this name holds other playlists`);
          desiredOrder.set(id(row.ID), desiredOrder.size);
          continue;
        }
        update('djmdPlaylist', row, { Attribute: entry.folder ? 1 : 0, SmartList: null });
      }
      desiredOrder.set(id(row.ID), desiredOrder.size);
      materializedSmart ||= entry.playlist?.kind === 'smart';
      if (!entry.playlist && !entry.folder) continue;
      const desiredMembers = entry.folder ? [] : (entry.playlist?.trackPaths ?? []).flatMap((path) => {
        const key = normalizePath(path);
        if (ambiguousPaths.has(key)) return [];
        const content = byPath.get(key);
        if (!content) { skippedTracks.add(key); return []; }
        return [id(content.ID)];
      });
      const existingMembers = membersByPlaylist.get(id(row.ID)) ?? [];
      const available = new Map<string, Row[]>();
      for (const member of existingMembers) {
        const contentId = id(member.ContentID);
        const group = available.get(contentId) ?? [];
        group.push(member);
        available.set(contentId, group);
      }
      const retained = new Set<string>();
      let membershipChanged = false;
      for (const [index, contentId] of desiredMembers.entries()) {
        const member = available.get(contentId)?.shift();
        if (member) {
          retained.add(id(member.ID));
          membershipChanged = update('djmdSongPlaylist', member, { TrackNo: index + 1 }) || membershipChanged;
        } else {
          insert('djmdSongPlaylist', { ID: randomUUID(), PlaylistID: id(row.ID), ContentID: contentId, TrackNo: index + 1 });
          membershipChanged = true;
        }
      }
      for (const member of existingMembers) if (!retained.has(id(member.ID))) { remove('djmdSongPlaylist', member); membershipChanged = true; }
      if (membershipChanged) update('djmdPlaylist', row, { updated_at: now });
    }
    if (options.fields.playlists) {
      const siblings = new Map<string, Row[]>();
      for (const row of native.all) {
        if (removedPlaylists.has(id(row.ID))) continue;
        const parent = id(row.ParentID);
        const group = siblings.get(parent) ?? [];
        group.push(row);
        siblings.set(parent, group);
      }
      for (const group of siblings.values()) {
        const selected = group.filter((row) => desiredOrder.has(id(row.ID)))
          .sort((left, right) => (desiredOrder.get(id(left.ID)) ?? 0) - (desiredOrder.get(id(right.ID)) ?? 0));
        let selectedIndex = 0;
        for (const [index, original] of group.entries()) {
          const row = desiredOrder.has(id(original.ID)) ? selected[selectedIndex++] : original;
          if (row) update('djmdPlaylist', row, { Seq: index + 1 });
        }
      }
    }
    if (changedAnalysedBpm) warnings.push('Track BPM metadata was updated. Existing Rekordbox beat grids were left unchanged.');
    if (materializedSmart) warnings.push('Arsenal smart playlists were saved as regular Rekordbox playlists with their current tracks.');
    if (skippedTracks.size) warnings.push(`${skippedTracks.size} track${skippedTracks.size === 1 ? ' is' : 's are'} not in the Rekordbox Collection and could not be synced. ${options.fields.tracks ? `Rekordbox does not support ${skippedTracks.size === 1 ? 'its' : 'their'} file type.` : `Turn on Tracks to add ${skippedTracks.size === 1 ? 'it' : 'them'}.`}`);
    if (conflicts.length) warnings.push(`Skipped ${conflicts.length} item${conflicts.length === 1 ? '' : 's'} that could not sync: ${conflicts.join('; ')}.`);
    if (changedCueTracks) warnings.push(`Cues and loops were updated on ${changedCueTracks} track${changedCueTracks === 1 ? '' : 's'}. Rekordbox shows them in its default colors.`);
    if (addedTracks) warnings.push(`${addedTracks} track${addedTracks === 1 ? ' was' : 's were'} added to the Rekordbox Collection. Rekordbox analyses ${addedTracks === 1 ? 'it' : 'them'} when opened.`);
    if (encryptedTracks) warnings.push(`${encryptedTracks} track${encryptedTracks === 1 ? ' has' : 's have'} encrypted details in Rekordbox and ${encryptedTracks === 1 ? 'was' : 'were'} left unchanged.`);
    const backupPaths: string[] = [];
    const result = { trackCount: syncedTracks.size, playlistCount,
      skippedTrackCount: skippedTracks.size, backupPaths, warnings };
    if (!statements.length) return result;
    const afterSidecar = renderSidecar(sidecarSource, changedPlaylists, removedPlaylists);
    result.backupPaths = await backupRekordboxDatabase(db, path);
    await assertRekordboxClosed();
    db.exec('BEGIN IMMEDIATE');
    if (rows(db, 'PRAGMA data_version')[0]?.data_version !== dataVersion || !(await readFile(sidecarPath)).equals(originalSidecar)) {
      throw new Error('Rekordbox changed during sync. No changes were saved. Try again.');
    }
    for (const statement of statements) db.prepare(statement.sql).run(...statement.values);
    db.prepare("UPDATE agentRegistry SET int_1 = ?, updated_at = ? WHERE registry_id = 'localUpdateCount'").run(revision, now);
    if (rows(db, 'PRAGMA quick_check')[0]?.quick_check !== 'ok') throw new Error('Rekordbox database verification failed.');
    await assertRekordboxClosed();
    if (afterSidecar !== sidecarSource) {
      await writeFile(temporaryPath, afterSidecar, { flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, sidecarPath);
      sidecarWritten = true;
    }
    assertRekordboxClosedSync();
    db.exec('COMMIT');
    sidecarWritten = false;
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    if (sidecarWritten && originalSidecar) {
      await writeFile(temporaryPath, originalSidecar);
      await rename(temporaryPath, sidecarPath);
    }
    throw error;
  } finally {
    try { await rm(temporaryPath, { force: true }); } finally { db.close(); }
  }
};
