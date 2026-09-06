import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

import { dialog, shell, type BrowserWindow } from 'electron';

import type {
  DuplicateGroup,
  DuplicateMatchMode,
  DuplicateScan,
  ImportResult,
  LibraryMutation,
  LibraryMutationResult,
  LibraryStatus,
  LibrarySummary,
  LocalFileAction,
  MutationFailure,
  PageRequest,
  RekordboxPlaylist,
  SongPage,
  SongRow,
  SongSearchRequest,
} from '../shared/dj-library';
import {
  editRekordboxXml,
  RekordboxWriteError,
  type RekordboxXmlEdit,
} from './edit-rekordbox-xml';
import { findDuplicateScan } from './find-duplicates';
import { evaluateSmartPlaylist } from './smart-playlists';
import {
  parseRekordboxXml,
  type ParsedPlaylist,
  type ParsedTrack,
  RekordboxXmlError,
} from './parse-rekordbox-xml';
import {
  TrackArtworkStore,
  type ArtworkAsset,
  isSupportedAudioPath,
} from './track-artwork';

type CatalogTrack = Readonly<{
  song: SongRow;
  mediaPath: string | null;
  rekordboxId: string | null;
  rawLocation: string | null;
}>;

type CurrentCatalog = Readonly<{
  revision: string;
  sourcePath: string;
  sourceName: string;
  importedAt: string;
  fingerprint: string;
  tracks: readonly CatalogTrack[];
  songs: readonly SongRow[];
  playlists: readonly RekordboxPlaylist[];
  duplicateScans: Map<DuplicateMatchMode, DuplicateScan>;
  trackKeysBySongId: ReadonlyMap<string, string>;
  artwork: TrackArtworkStore;
}>;

type RememberedLibrary = Readonly<{
  rekordboxXmlPath: string;
  ignoredDuplicateGroups: Readonly<Record<string, readonly string[]>>;
}>;

type ReloadResult =
  | Readonly<{ kind: 'ready'; catalog: CurrentCatalog }>
  | Readonly<{ kind: 'rejected'; reason: MutationFailure }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readRememberedLibrary = async (
  stateFilePath: string,
): Promise<RememberedLibrary | null> => {
  try {
    const serialized = await readFile(stateFilePath, 'utf8');
    const stored: unknown = JSON.parse(serialized);
    if (!isRecord(stored)) {
      return null;
    }

    const rememberedPath = stored.rekordboxXmlPath;
    if (
      typeof rememberedPath !== 'string' ||
      rememberedPath.length === 0 ||
      !isAbsolute(rememberedPath)
    ) {
      return null;
    }
    const ignoredDuplicateGroups: Record<string, readonly string[]> = {};
    if (isRecord(stored.ignoredDuplicateGroups)) {
      for (const [key, trackKeys] of Object.entries(stored.ignoredDuplicateGroups)) {
        if (Array.isArray(trackKeys) && trackKeys.every((key) => typeof key === 'string')) {
          ignoredDuplicateGroups[key] = trackKeys;
        }
      }
    }
    return { rekordboxXmlPath: rememberedPath, ignoredDuplicateGroups };
  } catch {
    return null;
  }
};

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

const compareCatalogTracks = (
  left: CatalogTrack,
  right: CatalogTrack,
): number => {
  if (left.song.artist === null && right.song.artist !== null) {
    return 1;
  }
  if (left.song.artist !== null && right.song.artist === null) {
    return -1;
  }

  return (
    collator.compare(left.song.artist ?? '', right.song.artist ?? '') ||
    collator.compare(left.song.title, right.song.title)
  );
};

const searchTextFor = (song: SongRow): string =>
  [song.title, song.artist, song.album, song.genre, song.musicalKey]
    .filter((value): value is string => value !== null)
    .join(' ')
    .toLocaleLowerCase();

const summaryFor = (catalog: CurrentCatalog): LibrarySummary => ({
  revision: catalog.revision,
  sourceName: catalog.sourceName,
  importedAt: catalog.importedAt,
  songCount: catalog.songs.length,
  playlistCount: catalog.playlists.length,
});

const trackKeysFor = (catalog: CurrentCatalog, group: DuplicateGroup): string[] =>
  group.candidates.map(({ song }) => {
    const key = catalog.trackKeysBySongId.get(song.id);
    if (key === undefined) {
      throw new Error('Duplicate candidate is missing from the catalog');
    }
    return key;
  });

const hasNewTrack = (trackKeys: readonly string[], ignoredKeys: readonly string[]): boolean => {
  const remaining = [...ignoredKeys];
  return trackKeys.some((key) => {
    const index = remaining.indexOf(key);
    if (index === -1) {
      return true;
    }
    remaining.splice(index, 1);
    return false;
  });
};

const firstSongBy = (
  tracks: readonly CatalogTrack[],
  keyFor: (track: CatalogTrack) => string | null,
): ReadonlyMap<string, SongRow> => {
  const songs = new Map<string, SongRow>();
  for (const track of tracks) {
    const key = keyFor(track);
    if (key !== null && !songs.has(key)) {
      songs.set(key, track.song);
    }
  }
  return songs;
};

const projectPlaylists = (
  parsedPlaylists: readonly ParsedPlaylist[],
  tracks: readonly CatalogTrack[],
): readonly RekordboxPlaylist[] => {
  const byTrackId = firstSongBy(tracks, (track) => track.rekordboxId);
  const byLocation = firstSongBy(tracks, (track) => track.rawLocation);

  return parsedPlaylists.map((playlist) => {
    const lookup =
      playlist.referenceKind === 'track-id'
        ? byTrackId
        : playlist.referenceKind === 'location'
          ? byLocation
          : null;
    const resolved = playlist.keys.map((key) => lookup?.get(key) ?? null);
    const exportedTracks = resolved.filter((song): song is SongRow => song !== null);
    const smart = playlist.kind === 'smart'
      ? evaluateSmartPlaylist(playlist.rules, tracks, exportedTracks)
      : null;
    return {
      id: playlist.id,
      name: playlist.name,
      kind: playlist.kind,
      folderPath: playlist.folderPath,
      tracks: smart?.tracks ?? exportedTracks,
      missingTrackCount: resolved.filter((song) => song === null).length,
      smartRules: smart?.status ?? null,
    };
  });
};

const fileActionFor = async ({
  mediaPath,
  removeLocalFile,
  sharedLocation,
}: Readonly<{
  mediaPath: string | null;
  removeLocalFile: boolean;
  sharedLocation: boolean;
}>): Promise<LocalFileAction> => {
  if (!removeLocalFile) {
    return 'kept';
  }
  if (sharedLocation) {
    return 'shared';
  }
  if (mediaPath === null) {
    return 'missing';
  }
  if (!isSupportedAudioPath(mediaPath)) {
    return 'unsupported';
  }

  try {
    const file = await stat(mediaPath);
    if (!file.isFile()) {
      return 'missing';
    }
  } catch (error: unknown) {
    return isRecord(error) && error.code === 'ENOENT' ? 'missing' : 'failed';
  }

  try {
    await shell.trashItem(mediaPath);
    return 'trashed';
  } catch {
    return 'failed';
  }
};

export class RekordboxLibrary {
  private catalog: CurrentCatalog | null = null;

  private activeImport: Promise<ImportResult> | null = null;

  private stateFilePath: string | null = null;

  private rememberedPath: string | null = null;

  private ignoredDuplicateGroups: RememberedLibrary['ignoredDuplicateGroups'] = {};

  private operationTail: Promise<void> = Promise.resolve();

  async initialize(stateFilePath: string): Promise<void> {
    this.stateFilePath = stateFilePath;
    const remembered = await readRememberedLibrary(stateFilePath);
    this.rememberedPath = remembered?.rekordboxXmlPath ?? null;
    this.ignoredDuplicateGroups = remembered?.ignoredDuplicateGroups ?? {};
    if (this.rememberedPath === null) {
      return;
    }

    try {
      this.catalog = await this.catalogFor(this.rememberedPath);
    } catch {
      this.catalog = null;
    }
  }

  status(): LibraryStatus {
    return this.catalog === null
      ? { kind: 'empty' }
      : { kind: 'ready', library: summaryFor(this.catalog) };
  }

  listSongs(page: PageRequest): SongPage {
    return this.searchSongs({ ...page, query: '' });
  }

  searchSongs(request: SongSearchRequest): SongPage {
    const songs = this.requireCatalog().songs;
    const normalized = request.query.trim().toLocaleLowerCase();
    const matches = normalized.length === 0
      ? songs
      : songs.filter((song) => searchTextFor(song).includes(normalized));
    const total = matches.length;
    const limit = request.limit;
    const lastOffset = Math.floor(Math.max(0, total - 1) / limit) * limit;
    const offset = Math.min(request.offset, lastOffset);
    const items = matches.slice(offset, offset + limit);
    return {
      items,
      offset,
      limit,
      total,
      hasNext: offset + items.length < total,
    };
  }

  listPlaylists(): readonly RekordboxPlaylist[] {
    return this.requireCatalog().playlists;
  }

  findDuplicates(mode: DuplicateMatchMode): DuplicateScan {
    const catalog = this.requireCatalog();
    const cached = catalog.duplicateScans.get(mode);
    if (cached !== undefined) {
      return cached;
    }

    const unfiltered = findDuplicateScan(catalog.songs, mode);
    const groups = unfiltered.groups.filter((group) => {
      const ignored = this.ignoredDuplicateGroups[JSON.stringify([catalog.sourcePath, group.key])];
      return ignored === undefined || hasNewTrack(trackKeysFor(catalog, group), ignored);
    });
    const scan = {
      mode,
      groups,
      ignoredGroupCount: unfiltered.groups.length - groups.length,
      trackCount: groups.reduce((total, group) => total + group.candidates.length, 0),
    };
    catalog.duplicateScans.set(mode, scan);
    return scan;
  }

  async openArtwork(requestUrl: string): Promise<ArtworkAsset | null> {
    return this.catalog?.artwork.open(requestUrl) ?? null;
  }

  mediaPathFor(requestUrl: string): string | null {
    return this.catalog?.artwork.mediaPathFor(requestUrl) ?? null;
  }

  async importExport(owner: BrowserWindow): Promise<ImportResult> {
    if (this.activeImport !== null) {
      return this.activeImport;
    }

    const importTask = this.enqueue(() => this.chooseAndImport(owner));
    this.activeImport = importTask;
    try {
      return await importTask;
    } finally {
      if (this.activeImport === importTask) {
        this.activeImport = null;
      }
    }
  }

  mutate(change: LibraryMutation): Promise<LibraryMutationResult> {
    return this.enqueue(() => this.applyMutation(change));
  }

  private requireCatalog(): CurrentCatalog {
    if (this.catalog === null) {
      throw new Error('No Rekordbox export is open');
    }
    return this.catalog;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.operationTail.then(work);
    this.operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async chooseAndImport(owner: BrowserWindow): Promise<ImportResult> {
    const selection = await dialog.showOpenDialog(owner, {
      title: 'Choose a Rekordbox XML export',
      buttonLabel: 'Open library',
      ...(this.rememberedPath === null
        ? {}
        : { defaultPath: this.rememberedPath }),
      properties: ['openFile'],
      filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }],
    });

    if (selection.canceled || selection.filePaths.length === 0) {
      return { kind: 'cancelled' };
    }
    const selectedPath = selection.filePaths[0];
    if (selectedPath === undefined) {
      return { kind: 'cancelled' };
    }

    try {
      const nextCatalog = await this.catalogFor(selectedPath);
      this.catalog = nextCatalog;
      this.rememberedPath = selectedPath;
      await this.remember(selectedPath);
      return { kind: 'imported', library: summaryFor(nextCatalog) };
    } catch (error: unknown) {
      if (error instanceof RekordboxXmlError) {
        return { kind: 'rejected', reason: error.reason };
      }
      return { kind: 'rejected', reason: 'cannot-read' };
    }
  }

  private async applyMutation(
    change: LibraryMutation,
  ): Promise<LibraryMutationResult> {
    const catalog = this.requireCatalog();
    if (change.revision !== catalog.revision) {
      return { kind: 'rejected', reason: 'stale-library' };
    }

    switch (change.kind) {
      case 'ignore-duplicate-group':
        return this.ignoreDuplicateGroup(catalog, change);
      case 'remove-song':
        return this.removeSong(catalog, change);
      case 'create-playlist':
        return this.createPlaylist(catalog, change);
      default: {
        const exhaustiveChange: never = change;
        return exhaustiveChange;
      }
    }
  }

  private async ignoreDuplicateGroup(
    catalog: CurrentCatalog,
    change: Extract<LibraryMutation, { kind: 'ignore-duplicate-group' }>,
  ): Promise<LibraryMutationResult> {
    const group = this.findDuplicates(change.mode).groups.find(
      (candidate) => candidate.key === change.groupKey,
    );
    if (group === undefined) {
      return { kind: 'rejected', reason: 'duplicate-not-found' };
    }
    const ignored = {
      ...this.ignoredDuplicateGroups,
      [JSON.stringify([catalog.sourcePath, group.key])]: trackKeysFor(catalog, group),
    };
    if (!await this.remember(catalog.sourcePath, ignored)) {
      return { kind: 'rejected', reason: 'cannot-save-preferences' };
    }
    this.ignoredDuplicateGroups = ignored;
    catalog.duplicateScans.clear();
    return {
      kind: 'duplicate-ignored',
      library: summaryFor(catalog),
      scan: this.findDuplicates(change.mode),
    };
  }

  private async removeSong(
    catalog: CurrentCatalog,
    change: Extract<LibraryMutation, { kind: 'remove-song' }>,
  ): Promise<LibraryMutationResult> {
    const track = catalog.tracks.find(
      (candidate) => candidate.song.id === change.songId,
    );
    if (track === undefined) {
      return { kind: 'rejected', reason: 'song-not-found' };
    }

    const sharedLocation =
      track.rawLocation !== null &&
      catalog.tracks.filter(
        (candidate) => candidate.rawLocation === track.rawLocation,
      ).length > 1;
    const reload = await this.writeAndReload(catalog, {
      kind: 'remove-track',
      trackId: track.rekordboxId,
      rawLocation: sharedLocation ? null : track.rawLocation,
    });
    if (reload.kind === 'rejected') {
      return reload;
    }

    this.catalog = reload.catalog;
    const fileAction = await fileActionFor({
      mediaPath: track.mediaPath,
      removeLocalFile: change.removeLocalFile,
      sharedLocation,
    });
    return {
      kind: 'song-removed',
      library: summaryFor(reload.catalog),
      fileAction,
    };
  }

  private async createPlaylist(
    catalog: CurrentCatalog,
    change: Extract<LibraryMutation, { kind: 'create-playlist' }>,
  ): Promise<LibraryMutationResult> {
    const name = change.name.trim();
    const distinctSongIds = new Set(change.songIds);
    if (
      name.length === 0 ||
      name.length > 100 ||
      [...name].some((character) => character.charCodeAt(0) < 32) ||
      change.songIds.length > 10_000 ||
      distinctSongIds.size !== change.songIds.length
    ) {
      return { kind: 'rejected', reason: 'invalid-playlist' };
    }

    const trackIds: string[] = [];
    for (const songId of change.songIds) {
      const track = catalog.tracks.find(
        (candidate) => candidate.song.id === songId,
      );
      if (track?.rekordboxId === null || track?.rekordboxId === undefined) {
        return { kind: 'rejected', reason: 'invalid-playlist' };
      }
      const matches = catalog.tracks.filter(
        (candidate) => candidate.rekordboxId === track.rekordboxId,
      );
      if (matches.length !== 1) {
        return { kind: 'rejected', reason: 'invalid-playlist' };
      }
      trackIds.push(track.rekordboxId);
    }

    const reload = await this.writeAndReload(catalog, {
      kind: 'create-root-playlist',
      name,
      trackIds,
    });
    if (reload.kind === 'rejected') {
      return reload;
    }
    this.catalog = reload.catalog;
    return {
      kind: 'playlist-created',
      library: summaryFor(reload.catalog),
    };
  }

  private async writeAndReload(
    catalog: CurrentCatalog,
    edit: RekordboxXmlEdit,
  ): Promise<ReloadResult> {
    try {
      await editRekordboxXml({
        edit,
        expectedFingerprint: catalog.fingerprint,
        filePath: catalog.sourcePath,
      });
      return { kind: 'ready', catalog: await this.catalogFor(catalog.sourcePath) };
    } catch (error: unknown) {
      if (error instanceof RekordboxWriteError) {
        if (error.reason === 'source-changed') {
          return { kind: 'rejected', reason: 'source-changed' };
        }
        if (error.reason === 'target-not-found') {
          return { kind: 'rejected', reason: 'song-not-found' };
        }
      }
      return { kind: 'rejected', reason: 'cannot-write' };
    }
  }

  private async catalogFor(filePath: string): Promise<CurrentCatalog> {
    const parsed = await parseRekordboxXml(filePath);
    const revision = randomUUID();
    const mediaPathBySongId = new Map<string, string>();
    for (const track of parsed.tracks) {
      if (track.mediaPath !== null) {
        mediaPathBySongId.set(track.song.id, track.mediaPath);
      }
    }

    const artwork = new TrackArtworkStore(revision, mediaPathBySongId);
    const tracks = parsed.tracks
      .map((track: ParsedTrack): CatalogTrack => ({
        ...track,
        song: {
          ...track.song,
          artworkUrl: artwork.urlFor(track.song.id),
          audioUrl: artwork.mediaUrlFor(track.song.id),
        },
      }))
      .sort(compareCatalogTracks);

    return {
      revision,
      sourcePath: filePath,
      sourceName: basename(filePath),
      importedAt: new Date().toISOString(),
      fingerprint: parsed.fingerprint,
      tracks,
      songs: tracks.map((track) => track.song),
      playlists: projectPlaylists(parsed.playlists, tracks),
      duplicateScans: new Map(),
      trackKeysBySongId: new Map(tracks.map((track) => [
        track.song.id,
        JSON.stringify([
          track.rekordboxId,
          track.mediaPath ?? track.rawLocation,
          ...(track.rekordboxId === null && track.rawLocation === null
            ? [track.song.artist, track.song.title, track.song.mixName]
            : []),
        ]),
      ])),
      artwork,
    };
  }

  private async remember(
    rekordboxXmlPath: string,
    ignoredDuplicateGroups = this.ignoredDuplicateGroups,
  ): Promise<boolean> {
    if (this.stateFilePath === null) {
      return false;
    }

    const state: RememberedLibrary = { rekordboxXmlPath, ignoredDuplicateGroups };
    try {
      await writeFile(this.stateFilePath, `${JSON.stringify(state)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return true;
    } catch {
      return false;
    }
  }
}
