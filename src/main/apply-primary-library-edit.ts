import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LibrarySourceKind, SyncFields } from '../shared/dj-library';
import { editedRekordboxXml, RekordboxWriteError, removeRekordboxPlaylistReferences, type RekordboxXmlEdit } from './edit-rekordbox-xml';
import { parseRekordboxXml, type ParsedRekordboxLibrary, type ParsedPlaylist, type ParsedTrack } from './parse-rekordbox-xml';
import type { SyncLibrary, SyncPlaylist } from './library-sync-model';
import { assertSeratoClosed, findSeratoSource, readSeratoLibrary, writeSeratoLibrary } from './serato-library';
import { seratoMediaPathKey } from './serato-paths';
import { mergeRekordboxXml, rekordboxSyncLibrary } from './sync-rekordbox-xml';
import { saveLibraryXml } from './sync-libraries';

const structureFields = { tracks: true, playlists: true, metadata: false, hotCues: false, loops: false, beatgrids: false };
const pathKey = (path: readonly string[]): string => JSON.stringify(path.map((part) => part.toLocaleLowerCase()));
const playlistPath = (playlist: ParsedPlaylist): readonly string[] => playlist.seratoCrateTracks
  ? playlist.folderPath : [...playlist.folderPath, playlist.name];
const reference = (track: ParsedTrack) => ({ trackId: track.rekordboxId, rawLocation: track.rawLocation });
const trackKey = (track: ParsedTrack): Promise<string> => track.mediaPath === null
  ? Promise.resolve(`location:${track.rawLocation ?? track.rekordboxId ?? track.song.id}`) : seratoMediaPathKey(track.mediaPath);

export const preparePrimaryLibraryEdit = async ({ sourcePath, expectedFingerprint, edit, primary, fields = structureFields }: Readonly<{
  sourcePath: string;
  expectedFingerprint: string;
  edit: RekordboxXmlEdit;
  primary: Readonly<{ kind: LibrarySourceKind; path: string; workspacePath: string | null }> | null;
  fields?: Pick<SyncFields, 'tracks' | 'playlists'>;
}>): Promise<() => Promise<void>> => {
  const original = await readFile(sourcePath, 'utf8');
  if (createHash('sha256').update(original).digest('hex') !== expectedFingerprint) {
    throw new RekordboxWriteError('source-changed', 'The open library changed outside Arsenal. Reopen it before editing.');
  }
  editedRekordboxXml(original, edit);
  if (primary === null || primary.kind === 'rekordbox' && await seratoMediaPathKey(primary.path) === await seratoMediaPathKey(sourcePath)) return async () => undefined;
  if (edit.kind === 'remove-tracks' ? !fields.tracks && !fields.playlists : !fields.playlists) return async () => undefined;
  const source = await parseRekordboxXml(sourcePath);
  if (source.fingerprint !== expectedFingerprint) throw new RekordboxWriteError('source-changed', 'The open library changed before saving.');
  const native = primary.kind === 'serato' ? await findSeratoSource(primary.path) : null;
  if (native !== null) await assertSeratoClosed();
  const nativeBefore = native === null ? null : await readSeratoLibrary(native);
  const targetBefore = nativeBefore === null ? await readFile(primary.path, 'utf8') : mergeRekordboxXml(nativeBefore);
  const directory = await mkdtemp(join(tmpdir(), 'arsenal-primary-edit-'));
  const temporary = join(directory, 'library.xml');
  let targetXml = targetBefore;
  let target: ParsedRekordboxLibrary = source;
  const parseTarget = async () => {
    await writeFile(temporary, targetXml, { mode: 0o600 });
    target = await parseRekordboxXml(temporary);
    return target;
  };
  const changeTarget = async (next: RekordboxXmlEdit) => {
    targetXml = editedRekordboxXml(targetXml, next);
    await parseTarget();
  };
  try {
    await parseTarget();
    const sourceTrack = (selected: Readonly<{ trackId: string | null; rawLocation: string | null }>) => {
      const matches = source.tracks.filter((track) => selected.trackId !== null
        ? track.rekordboxId === selected.trackId : selected.rawLocation !== null && track.rawLocation === selected.rawLocation);
      if (matches.length !== 1 || !matches[0]) throw new Error('A selected track has more than one library match. Resolve its duplicates before editing.');
      return matches[0];
    };
    const keysByTrack = new Map<ParsedTrack, Promise<string>>();
    const keyForTrack = (track: ParsedTrack) => {
      let key = keysByTrack.get(track);
      if (!key) { key = trackKey(track); keysByTrack.set(track, key); }
      return key;
    };
    const mapReferences = async (selected: readonly Readonly<{ trackId: string | null; rawLocation: string | null }>[], add: boolean) => {
      const wanted = selected.map(sourceTrack);
      const wantedKeys = await Promise.all(wanted.map(keyForTrack));
      if (new Set(wantedKeys).size !== wantedKeys.length) throw new Error('Several selected entries refer to the same primary track. Resolve its duplicates before editing.');
      const byKey = new Map<string, ParsedTrack[]>();
      const keys = await Promise.all(target.tracks.map(keyForTrack));
      for (const [index, track] of target.tracks.entries()) {
        const key = keys[index];
        if (key !== undefined) byKey.set(key, [...byKey.get(key) ?? [], track]);
      }
      const additions: SyncLibrary['tracks'][number][] = [];
      for (const [index, track] of wanted.entries()) {
        const matches = byKey.get(wantedKeys[index] ?? '') ?? [];
        if (matches.length > 1) throw new Error(`The primary library has multiple entries for ${track.song.title}. Resolve its duplicates before editing.`);
        if (matches.length || !add) continue;
        const path = track.mediaPath ?? track.rawLocation;
        if (path === null || native !== null && track.mediaPath === null) throw new Error(`The selected library cannot store ${track.song.title}. Locate its local audio file first.`);
        additions.push({ path, song: track.song, performance: track.performance });
      }
      if (additions.length) {
        targetXml = mergeRekordboxXml({ tracks: additions, playlists: [] }, targetXml,
          { ...structureFields, playlists: false, hotCues: true, loops: true, beatgrids: true });
        await parseTarget();
        return mapReferences(selected, false);
      }
      return wantedKeys.flatMap((key) => byKey.get(key) ?? []);
    };
    const sourceFolderPath = (id: string | null): readonly string[] => {
      if (id === null) return [];
      const folder = source.folders.find((candidate) => candidate.id === id);
      if (!folder) throw new Error('The selected folder no longer exists.');
      return folder.folderPath;
    };
    const findPlaylist = (path: readonly string[]) => {
      const matches = target.playlists.filter((playlist) => pathKey(playlistPath(playlist)) === pathKey(path));
      if (matches.length > 1) throw new Error(`Multiple primary playlists share ${path.join(' / ')}.`);
      return matches[0];
    };
    const ensureFolder = async (path: readonly string[]): Promise<string | null> => {
      let parentFolderId: string | null = null;
      for (let depth = 1; depth <= path.length; depth++) {
        const currentPath = path.slice(0, depth);
        const folders = target.folders.filter((folder) => pathKey(folder.folderPath) === pathKey(currentPath));
        if (folders.length > 1) throw new Error(`Multiple primary folders share ${currentPath.join(' / ')}.`);
        if (folders[0]) { parentFolderId = folders[0].id; continue; }
        const existing = findPlaylist(currentPath);
        if (existing) {
          if (native === null) throw new Error(`A primary playlist blocks the folder ${currentPath.join(' / ')}.`);
          targetXml = mergeRekordboxXml({ tracks: [], playlists: [{ path: currentPath, kind: 'folder', trackPaths: [] }] },
            targetXml, { ...structureFields, tracks: false });
          await parseTarget();
        } else await changeTarget({ kind: 'create-folder', name: currentPath.at(-1) ?? '', parentFolderId });
        parentFolderId = target.folders.find((folder) => pathKey(folder.folderPath) === pathKey(currentPath))?.id ?? null;
        if (parentFolderId === null) throw new Error('Could not create the primary folder.');
      }
      return parentFolderId;
    };
    if (edit.kind === 'remove-tracks') {
      const tracks = await mapReferences(edit.tracks, false);
      if (tracks.length) {
        if (fields.tracks) await changeTarget({ kind: 'remove-tracks', tracks: tracks.map(reference) });
        else { targetXml = removeRekordboxPlaylistReferences(targetXml, tracks.map(reference)); await parseTarget(); }
      }
    } else if (edit.kind === 'create-folder') {
      await ensureFolder([...sourceFolderPath(edit.parentFolderId), edit.name]);
    } else if (edit.kind === 'create-playlist') {
      const folderPath = sourceFolderPath(edit.parentFolderId);
      const path = [...folderPath, edit.name];
      if (findPlaylist(path) || target.folders.some((folder) => pathKey(folder.folderPath) === pathKey(path))) {
        throw new Error(`The primary library already contains ${path.join(' / ')}. Open it before editing.`);
      }
      const tracks = await mapReferences(edit.trackIds.map((trackId) => ({ trackId, rawLocation: null })), fields.tracks);
      const parentFolderId = await ensureFolder(folderPath);
      await changeTarget({ ...edit, trackIds: tracks.map((track) => track.rekordboxId ?? ''), parentFolderId });
    } else if (edit.kind === 'set-playlist-tracks' || edit.kind === 'remove-playlist' || edit.kind === 'update-smart-playlist') {
      const from = source.playlists.find((playlist) => playlist.id === edit.playlistId);
      if (!from) throw new Error('The edited playlist no longer exists.');
      const path = playlistPath(from);
      const existing = findPlaylist(path);
      if (edit.kind === 'remove-playlist') {
        if (existing) await changeTarget({ kind: 'remove-playlist', playlistId: existing.id });
      } else {
        const tracks = await mapReferences(edit.kind === 'set-playlist-tracks' ? edit.tracks
          : edit.trackIds.map((trackId) => ({ trackId, rawLocation: null })), fields.tracks);
        const updated = findPlaylist(path);
        if (!updated) {
          const parentFolderId = await ensureFolder(path.slice(0, -1));
          await changeTarget({ kind: 'create-playlist', name: edit.kind === 'update-smart-playlist' ? edit.name : path.at(-1) ?? '',
            parentFolderId, trackIds: tracks.map((track) => track.rekordboxId ?? ''),
            smartDefinition: edit.kind === 'update-smart-playlist' ? edit.smartDefinition : null });
        } else if (edit.kind === 'set-playlist-tracks') {
          const removed = await mapReferences(edit.removedTracks, false);
          await changeTarget({ ...edit, playlistId: updated.id, tracks: tracks.map(reference), removedTracks: removed.map(reference) });
        } else {
          const nextPath = [...updated.folderPath, edit.name];
          if (target.playlists.some((playlist) => playlist.id !== updated.id && pathKey(playlistPath(playlist)) === pathKey(nextPath)) ||
            target.folders.some((folder) => pathKey(folder.folderPath) === pathKey(nextPath))) {
            throw new Error(`The primary library already contains ${nextPath.join(' / ')}.`);
          }
          await changeTarget({ ...edit, playlistId: updated.id, trackIds: tracks.map((track) => track.rekordboxId ?? '') });
        }
      }
    } else throw new Error('Playlist moves use the connected library move operation.');
    if (targetXml === targetBefore) return async () => undefined;
    if (native === null || nativeBefore === null) {
      return async () => { await saveLibraryXml(primary.path, targetXml, targetBefore); };
    }
    const edited = rekordboxSyncLibrary(target, { includeNonLocal: true });
    const after: SyncLibrary = { ...edited, playlists: edited.playlists.map((playlist) => playlist.smart?.kind === 'arsenal'
      ? { path: playlist.path, kind: 'playlist', trackPaths: playlist.trackPaths } : playlist) };
    const comparePlaylist = (playlist: SyncPlaylist) => JSON.stringify({ path: playlist.path, kind: playlist.kind ?? 'playlist',
      trackPaths: playlist.trackPaths, smart: playlist.smart });
    const beforePlaylists = new Map(nativeBefore.playlists.map((playlist) => [pathKey(playlist.path), playlist]));
    const afterPlaylists = new Set(after.playlists.map((playlist) => pathKey(playlist.path)));
    const changedPlaylists = after.playlists.filter((playlist) => {
      const before = beforePlaylists.get(pathKey(playlist.path));
      return before === undefined || comparePlaylist(before) !== comparePlaylist(playlist);
    });
    const removedTrackPaths = edit.kind === 'remove-tracks' ? await Promise.all(edit.tracks.map(async (item) => {
      const track = sourceTrack(item);
      const key = await trackKey(track);
      for (const existing of nativeBefore.tracks) if (await seratoMediaPathKey(existing.path) === key) return existing.path;
      return null;
    })) : [];
    const beforeTrackKeys = new Set(await Promise.all(nativeBefore.tracks.map((track) => seratoMediaPathKey(track.path))));
    const newTracks: SyncLibrary['tracks'][number][] = [];
    for (const track of after.tracks) if (!beforeTrackKeys.has(await seratoMediaPathKey(track.path))) newTracks.push(track);
    return async () => {
      if (JSON.stringify(await readSeratoLibrary(native)) !== JSON.stringify(nativeBefore)) {
        throw new RekordboxWriteError('source-changed', 'The primary Serato library changed before saving. Reopen it and retry.');
      }
      await writeSeratoLibrary(native, { tracks: newTracks, playlists: changedPlaylists }, {
      metadata: false, replacePlaylistPaths: changedPlaylists.map((playlist) => playlist.path),
      removePlaylistPaths: nativeBefore.playlists.filter((playlist) => !afterPlaylists.has(pathKey(playlist.path))).map((playlist) => playlist.path),
      ...(fields.tracks ? { removeTrackPaths: removedTrackPaths.filter((path) => path !== null) }
        : { removePlaylistTrackPaths: removedTrackPaths.filter((path) => path !== null) }),
      });
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
