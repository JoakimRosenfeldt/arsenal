import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

import { dialog, shell, type BrowserWindow } from 'electron';
import { DEFAULT_SONG_FILTERS, readSyncRequest, songMetadataGapCount } from '../shared/dj-library';
import { DEFAULT_MINIMUM_SONG_LENGTH_SECONDS, type LibrarySettings } from '../shared/preferences';

import type {
  DuplicateGroup,
  DuplicateMatchMode,
  DuplicateScan,
  ImportResult,
  LibraryMutation,
  LibraryMutationResult,
  LibraryStatus,
  LibrarySummary,
  LibrarySourceKind,
  LocalFileAction,
  MutationFailure,
  PageRequest,
  PlaylistFolder,
  RekordboxPlaylist,
  SongPage,
  SongRow,
  SongSearchRequest,
  SyncRequest,
  SyncDirection,
  SyncPreferences,
  SyncResult,
  SyncMissingFileAction,
} from '../shared/dj-library';
import {
  editRekordboxXml,
  RekordboxWriteError,
  type RekordboxXmlEdit,
} from './edit-rekordbox-xml';
import { findDuplicateScan } from './find-duplicates';
import { evaluateSmartPlaylist } from './smart-playlists';
import { describeSmartRules, evaluateArsenalSmartPlaylist, smartDefinitionError, type SmartPlaylistDefinition } from '../shared/smart-playlists';
import { suggestJevPlaylist } from './jev-playlist';
import type { PlaylistSuggestionProgress, PlaylistSuggestionRequest, PlaylistSuggestionResult } from '../shared/playlist-suggestions';
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
import { findSeratoSource, readSeratoLibrary, repairSeratoMissingFile, type SeratoSource } from './serato-library';
import { mergeRekordboxXml, rekordboxSyncLibrary, repairRekordboxMissingFile } from './sync-rekordbox-xml';
import { readSeratoWithPerformance, saveLibraryXml, syncLibraryFiles } from './sync-libraries';
import { mergeLibraries, normalizePath } from './library-sync-model';
import { resolveSeratoLibraryPaths, resolveSeratoMediaPath, seratoMediaPathKey } from './serato-paths';
import { findMissingSyncFiles, searchSyncMissingFiles } from './sync-missing-files';

type CatalogTrack = ParsedTrack;

type CurrentCatalog = Readonly<{
  revision: string;
  sourcePath: string;
  sourceName: string;
  sourceKind: LibrarySourceKind;
  seratoPath: string | null;
  importedAt: string;
  fingerprint: string;
  tracks: readonly CatalogTrack[];
  songs: readonly SongRow[];
  playlists: readonly RekordboxPlaylist[];
  folders: readonly PlaylistFolder[];
  duplicateScans: Map<DuplicateMatchMode, DuplicateScan>;
  trackKeysBySongId: ReadonlyMap<string, string>;
  artwork: TrackArtworkStore;
}>;

type RememberedLibrary = Readonly<{
  rekordboxXmlPath: string | null;
  seratoPath: string | null;
  minimumSongLengthSeconds: number;
  ignoredDuplicateGroups: Readonly<Record<string, readonly string[]>>;
  syncPreferences: SyncPreferences;
}>;

type ReloadResult =
  | Readonly<{ kind: 'ready'; catalog: CurrentCatalog }>
  | Readonly<{ kind: 'rejected'; reason: MutationFailure }>;

type MissingSyncContext = {
  rekordboxPath: string;
  serato: SeratoSource;
  workspacePath: string | null;
  result: Extract<SyncResult, { kind: 'missing-files' }>;
};

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
      rememberedPath !== null && (typeof rememberedPath !== 'string' ||
      rememberedPath.length === 0 ||
      !isAbsolute(rememberedPath))
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
    const minimumSongLengthSeconds = typeof stored.minimumSongLengthSeconds === 'number' &&
      Number.isSafeInteger(stored.minimumSongLengthSeconds) && stored.minimumSongLengthSeconds >= 0
      ? stored.minimumSongLengthSeconds : DEFAULT_MINIMUM_SONG_LENGTH_SECONDS;
    const seratoPath = typeof stored.seratoPath === 'string' && isAbsolute(stored.seratoPath) ? stored.seratoPath : null;
    const sync = isRecord(stored.syncPreferences) ? stored.syncPreferences : {};
    let request: SyncRequest | null = null;
    try { request = readSyncRequest(sync.request); } catch { /* Ignore invalid settings from an older version. */ }
    const syncPreferences: SyncPreferences = {
      request,
      rekordboxPath: typeof sync.rekordboxPath === 'string' && isAbsolute(sync.rekordboxPath) ? sync.rekordboxPath : null,
      seratoPath: typeof sync.seratoPath === 'string' && isAbsolute(sync.seratoPath) ? sync.seratoPath : null,
    };
    return { rekordboxXmlPath: rememberedPath, seratoPath, ignoredDuplicateGroups, minimumSongLengthSeconds, syncPreferences };
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
  sourceKind: catalog.sourceKind,
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
    const smart = playlist.smartDefinition !== null
      ? {
          ...evaluateArsenalSmartPlaylist(playlist.smartDefinition, tracks.map((track) => track.song)),
          status: {
            kind: 'evaluated' as const,
            message: 'Rules run against the current collection in Arsenal. Save rules to update the tracks in the XML.',
            conditions: [describeSmartRules(playlist.smartDefinition.rules)],
          },
        }
      : playlist.kind === 'smart'
      ? evaluateSmartPlaylist(playlist.rules, tracks, exportedTracks)
      : null;
    return {
      id: playlist.id,
      order: playlist.order,
      name: playlist.name,
      kind: playlist.kind,
      folderPath: playlist.folderPath,
      parentFolderId: playlist.parentFolderId,
      smartDefinition: playlist.smartDefinition,
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

  private rememberedSeratoPath: string | null = null;

  private savedSyncPreferences: SyncPreferences = { request: null, rekordboxPath: null, seratoPath: null };

  private missingSyncContext: MissingSyncContext | null = null;

  private minimumSongLengthSeconds = DEFAULT_MINIMUM_SONG_LENGTH_SECONDS;

  private ignoredDuplicateGroups: RememberedLibrary['ignoredDuplicateGroups'] = {};

  private operationTail: Promise<void> = Promise.resolve();

  private suggestionController: AbortController | null = null;

  async initialize(stateFilePath: string): Promise<void> {
    this.stateFilePath = stateFilePath;
    const remembered = await readRememberedLibrary(stateFilePath);
    this.rememberedPath = remembered?.rekordboxXmlPath ?? null;
    this.rememberedSeratoPath = remembered?.seratoPath ?? null;
    this.savedSyncPreferences = remembered?.syncPreferences ?? { request: null, rekordboxPath: null, seratoPath: null };
    this.ignoredDuplicateGroups = remembered?.ignoredDuplicateGroups ?? {};
    this.minimumSongLengthSeconds = remembered?.minimumSongLengthSeconds ?? DEFAULT_MINIMUM_SONG_LENGTH_SECONDS;
    if (this.rememberedPath === null) {
      return;
    }

    try {
      this.catalog = await this.catalogFor(this.rememberedPath, this.rememberedSeratoPath);
    } catch {
      this.catalog = null;
    }
  }

  status(): LibraryStatus {
    return this.catalog === null
      ? { kind: 'empty' }
      : { kind: 'ready', library: summaryFor(this.catalog) };
  }

  settings(): LibrarySettings {
    return { minimumSongLengthSeconds: this.minimumSongLengthSeconds };
  }

  saveMinimumSongLength(value: unknown): Promise<LibrarySettings> {
    return this.enqueue(async () => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error('Enter a whole number of seconds, zero or greater.');
      }
      if (value === this.minimumSongLengthSeconds) return this.settings();
      if (!await this.remember(this.rememberedPath, this.ignoredDuplicateGroups, value)) {
        throw new Error('Could not save library settings.');
      }
      this.minimumSongLengthSeconds = value;
      this.cancelSuggestions();
      if (this.catalog !== null) {
        this.catalog = {
          ...this.catalog,
          songs: this.catalog.tracks.map((track) => track.song).filter((song) => this.includesSong(song)),
          duplicateScans: new Map(),
        };
      }
      return this.settings();
    });
  }

  private includesSong(song: SongRow): boolean {
    return song.durationSeconds === null || song.durationSeconds >= this.minimumSongLengthSeconds;
  }

  listSongs(page: PageRequest): SongPage {
    return this.searchSongs({ ...page, query: '' });
  }

  searchSongs(request: SongSearchRequest): SongPage {
    const songs = this.requireCatalog().songs;
    const normalized = request.query.trim().toLocaleLowerCase();
    const filters = request.filters ?? DEFAULT_SONG_FILTERS;
    const terms = normalized.split(/\s+/).filter(Boolean);
    const matches = songs.filter((song) => {
      if (filters.source !== 'all' && song.source !== filters.source) return false;
      if (filters.metadata === 'incomplete' && songMetadataGapCount(song) === 0) return false;
      if (filters.metadata === 'complete' && songMetadataGapCount(song) > 0) return false;
      if (filters.metadata === 'no-cues' && song.cuePointCount > 0) return false;
      if (terms.length === 0) return true;
      const text = searchTextFor(song);
      return terms.every((term) => text.includes(term));
    });
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
    const catalog = this.requireCatalog();
    return catalog.playlists.map((playlist) => ({
      ...playlist,
      tracks: playlist.smartDefinition === null
        ? playlist.tracks.filter((song) => this.includesSong(song))
        : evaluateArsenalSmartPlaylist(playlist.smartDefinition, catalog.songs).tracks,
    }));
  }

  listFolders(): readonly PlaylistFolder[] {
    return this.requireCatalog().folders;
  }

  previewSmartPlaylist(revision: string, definition: SmartPlaylistDefinition) {
    const catalog = this.requireCatalog();
    if (revision !== catalog.revision) throw new Error('The library changed. Reopen the rule editor.');
    const result = evaluateArsenalSmartPlaylist(definition, catalog.songs);
    return { matchingCount: result.matchingCount, total: result.tracks.length, tracks: result.tracks.slice(0, 50) };
  }

  async suggestPlaylist(request: PlaylistSuggestionRequest, apiKey: string, onProgress: (progress: PlaylistSuggestionProgress) => void): Promise<PlaylistSuggestionResult> {
    const catalog = this.catalog;
    if (catalog === null || request.revision !== catalog.revision) {
      return { kind: 'rejected', reason: 'stale-library' };
    }
    this.cancelSuggestions();
    const controller = new AbortController();
    this.suggestionController = controller;
    try {
      const result = await suggestJevPlaylist(catalog.songs, request, apiKey, controller.signal, onProgress);
      return this.catalog === catalog ? result : { kind: 'rejected', reason: 'stale-library' };
    } catch {
      return { kind: 'rejected', reason: controller.signal.aborted ? 'cancelled' : 'failed' };
    } finally {
      if (this.suggestionController === controller) {
        this.suggestionController = null;
      }
    }
  }

  cancelSuggestions(): void {
    this.suggestionController?.abort();
    this.suggestionController = null;
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

  importSerato(owner: BrowserWindow): Promise<ImportResult> {
    return this.enqueue(async () => {
      const selection = await dialog.showOpenDialog(owner, {
        title: 'Choose the Serato Library or _Serato_ folder', buttonLabel: 'Import Serato library',
        defaultPath: this.rememberedSeratoPath ?? this.defaultSeratoPath(), properties: ['openDirectory'],
      });
      const selected = selection.filePaths[0];
      if (selection.canceled || selected === undefined) return { kind: 'cancelled' };
      try {
        const source = await findSeratoSource(selected);
        const { library, warnings } = await readSeratoWithPerformance(source);
        if (this.stateFilePath === null) return { kind: 'rejected', reason: 'cannot-save-library' };
        const directory = join(dirname(this.stateFilePath), 'libraries');
        await mkdir(directory, { recursive: true });
        const workspacePath = join(directory, `serato-${randomUUID()}.xml`);
        await saveLibraryXml(workspacePath, mergeRekordboxXml(library), null, false);
        const nextCatalog = await this.catalogFor(workspacePath, source.path);
        const previousSeratoPath = this.rememberedSeratoPath;
        this.rememberedSeratoPath = source.path;
        if (!await this.remember(workspacePath)) {
          this.rememberedSeratoPath = previousSeratoPath;
          return { kind: 'rejected', reason: 'cannot-save-library' };
        }
        this.cancelSuggestions();
        this.catalog = nextCatalog;
        this.rememberedPath = workspacePath;
        return { kind: 'imported', library: summaryFor(nextCatalog), warnings };
      } catch {
        return { kind: 'rejected', reason: 'not-serato-library' };
      }
    });
  }

  syncPreferences(): SyncPreferences {
    return {
      ...this.savedSyncPreferences,
      rekordboxPath: this.savedSyncPreferences.rekordboxPath ?? (this.catalog?.sourceKind === 'rekordbox' ? this.catalog.sourcePath : null),
      seratoPath: this.savedSyncPreferences.seratoPath ?? this.catalog?.seratoPath ?? null,
    };
  }

  chooseSyncLibrary(owner: BrowserWindow, kind: LibrarySourceKind, direction: SyncDirection): Promise<SyncPreferences | null> {
    return this.enqueue(async () => {
      const path = await this.chooseSyncPath(owner, kind, direction);
      if (path === null) return null;
      const preferences = await this.rememberSyncPreferences({ ...this.syncPreferences(), [kind === 'rekordbox' ? 'rekordboxPath' : 'seratoPath']: path });
      this.missingSyncContext = null;
      return preferences;
    });
  }

  private async chooseSyncPath(owner: BrowserWindow, kind: LibrarySourceKind, direction: SyncDirection): Promise<string | null> {
    const preferences = this.syncPreferences();
    if (kind === 'serato') {
      const remembered = preferences.seratoPath;
      const choice = await dialog.showOpenDialog(owner, {
        title: 'Choose the Serato Library or _Serato_ folder', buttonLabel: 'Use this Serato library',
        defaultPath: remembered === null ? this.defaultSeratoPath() : remembered.endsWith('.sqlite') ? dirname(remembered) : remembered,
        properties: ['openDirectory'],
      });
      const selected = choice.filePaths[0];
      if (choice.canceled || selected === undefined) return null;
      const source = await findSeratoSource(selected);
      await readSeratoWithPerformance(source, false);
      return source.path;
    }
    let selected: string | null;
    if (direction === 'serato-to-rekordbox') {
      const choice = await dialog.showSaveDialog(owner, {
        title: 'Choose the Rekordbox XML destination', buttonLabel: 'Use this XML',
        defaultPath: preferences.rekordboxPath ?? join(homedir(), 'rekordbox.xml'), filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }],
      });
      selected = choice.canceled ? null : choice.filePath ?? null;
    } else {
      const choice = await dialog.showOpenDialog(owner, {
        title: 'Choose a Rekordbox XML export', buttonLabel: 'Use this XML', properties: ['openFile'],
        ...(preferences.rekordboxPath === null ? {} : { defaultPath: preferences.rekordboxPath }),
        filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }],
      });
      selected = choice.canceled ? null : choice.filePaths[0] ?? null;
    }
    if (selected === null) return null;
    try {
      await parseRekordboxXml(selected);
    } catch (error) {
      if (!(direction === 'serato-to-rekordbox' && error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      if (!(await stat(dirname(selected))).isDirectory()) throw new Error('Choose an existing folder for the Rekordbox XML.');
    }
    return selected;
  }

  private async rememberSyncPreferences(preferences: SyncPreferences): Promise<SyncPreferences> {
    if (!await this.remember(this.rememberedPath, this.ignoredDuplicateGroups, this.minimumSongLengthSeconds, preferences)) {
      throw new Error('Could not save sync settings and library locations. Check disk space and permissions.');
    }
    this.savedSyncPreferences = preferences;
    return this.syncPreferences();
  }

  syncLibraries(owner: BrowserWindow, request: SyncRequest): Promise<SyncResult> {
    return this.enqueue(async () => {
      this.missingSyncContext = null;
      let result: SyncResult | null = null;
      try {
        const preferences = await this.rememberSyncPreferences({ ...this.syncPreferences(), request: readSyncRequest(request) });
        let rekordboxPath = preferences.rekordboxPath;
        if (rekordboxPath !== null) {
          const existingPath = rekordboxPath;
          try {
            if (!(await stat(existingPath)).isFile()) rekordboxPath = null;
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
            if (request.direction !== 'serato-to-rekordbox') rekordboxPath = null;
            else {
              try { if (!(await stat(dirname(existingPath))).isDirectory()) rekordboxPath = null; } catch { rekordboxPath = null; }
            }
          }
        }
        if (rekordboxPath === null) {
          rekordboxPath = await this.chooseSyncPath(owner, 'rekordbox', request.direction);
          if (rekordboxPath === null) return { kind: 'cancelled' };
          await this.rememberSyncPreferences({ ...this.syncPreferences(), rekordboxPath });
        }
        let seratoPath = preferences.seratoPath;
        if (seratoPath !== null) {
          try { await stat(seratoPath); } catch (error) {
            if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
            seratoPath = null;
          }
        }
        if (seratoPath === null) {
          seratoPath = await this.chooseSyncPath(owner, 'serato', request.direction);
          if (seratoPath === null) return { kind: 'cancelled' };
          await this.rememberSyncPreferences({ ...this.syncPreferences(), seratoPath });
        }
        const serato = await findSeratoSource(seratoPath);
        const matchesOpenSerato = this.catalog?.seratoPath !== null && this.catalog?.seratoPath !== undefined &&
          await seratoMediaPathKey(await resolveSeratoMediaPath(this.catalog.seratoPath)) === await seratoMediaPathKey(await resolveSeratoMediaPath(serato.path));
        const matchesOpenRekordbox = this.catalog?.sourceKind === 'rekordbox' &&
          await seratoMediaPathKey(this.catalog.sourcePath) === await seratoMediaPathKey(rekordboxPath);
        const workspace = this.catalog?.sourceKind === 'serato' && matchesOpenSerato
          ? rekordboxSyncLibrary(await parseRekordboxXml(this.catalog.sourcePath)) : null;
        result = await syncLibraryFiles({ rekordboxPath, serato, request, workspace });
        if (result.kind === 'missing-files') {
          this.missingSyncContext = { rekordboxPath, serato,
            workspacePath: workspace === null ? null : this.catalog?.sourcePath ?? null, result };
        }
        if (result.kind === 'synced' && this.catalog !== null && (matchesOpenSerato || matchesOpenRekordbox)) {
          if (this.catalog.sourceKind === 'serato') {
            const { library } = await readSeratoWithPerformance(serato);
            const previous = await readFile(this.catalog.sourcePath, 'utf8');
            const normalizedWorkspace = workspace === null ? null : await resolveSeratoLibraryPaths(workspace, library);
            let refreshed = normalizedWorkspace === null ? library : mergeLibraries(
              { ...library, playlists: normalizedWorkspace.playlists }, { ...normalizedWorkspace, playlists: library.playlists },
            );
            if (request.mode === 'replace' && request.direction === 'rekordbox-to-serato') {
              const tracks = request.fields.tracks ? library.tracks : refreshed.tracks;
              const available = new Set(tracks.map((track) => normalizePath(track.path)));
              refreshed = { tracks, playlists: request.fields.playlists ? library.playlists : refreshed.playlists.map((playlist) => ({
                ...playlist, trackPaths: playlist.trackPaths.filter((path) => available.has(normalizePath(path))),
              })) };
            }
            await saveLibraryXml(this.catalog.sourcePath, mergeRekordboxXml(refreshed), previous, false);
          }
          this.catalog = await this.catalogFor(this.catalog.sourcePath, this.catalog.seratoPath);
          this.cancelSuggestions();
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not sync the libraries.';
        if (result?.kind === 'synced') {
          return { ...result, warnings: [...result.warnings, `The libraries were synced, but Arsenal could not refresh its library: ${message}`] };
        }
        return { kind: 'rejected', message, warnings: [], backupPaths: [] };
      }
    });
  }

  private async missingSyncLibraries(context: MissingSyncContext) {
    let rekordbox;
    try { rekordbox = rekordboxSyncLibrary(await parseRekordboxXml(context.rekordboxPath)); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      rekordbox = { tracks: [], playlists: [] };
    }
    return {
      rekordbox,
      serato: await readSeratoLibrary(context.serato),
      workspace: context.workspacePath === null ? null : rekordboxSyncLibrary(await parseRekordboxXml(context.workspacePath)),
    };
  }

  private async refreshMissingSyncReport(context: MissingSyncContext, message?: string) {
    const libraries = await this.missingSyncLibraries(context);
    const files = await findMissingSyncFiles([
      { kind: 'rekordbox', library: libraries.rekordbox }, { kind: 'serato', library: libraries.serato },
      ...(libraries.workspace === null ? [] : [{ kind: 'serato' as const, library: libraries.workspace }]),
    ]);
    const previous = new Map(context.result.files.map((file) => [normalizePath(file.path), file.candidates]));
    context.result = { ...context.result, files: files.map((file) => ({ ...file, candidates: previous.get(normalizePath(file.path)) ?? [] })),
      message: message ?? (files.length ? `Resolve ${files.length} missing audio ${files.length === 1 ? 'file' : 'files'}, then retry sync.`
        : 'All missing files are resolved. Retry sync to continue.') };
    return libraries;
  }

  resolveSyncMissingFile(owner: BrowserWindow, action: SyncMissingFileAction): Promise<SyncResult> {
    return this.enqueue(async () => {
      const context = this.missingSyncContext;
      if (context === null) return { kind: 'rejected', warnings: [], backupPaths: [], message: 'Run sync again to check the current libraries for missing files.' };
      try {
        if (!context.result.files.some((file) => file.path === action.path)) throw new Error('This file is not in the current missing-file report. Retry sync.');
        const libraries = await this.refreshMissingSyncReport(context);
        const missing = context.result.files.find((file) => normalizePath(file.path) === normalizePath(action.path));
        if (!missing) return context.result;
        if (action.kind === 'search') {
          const picked = await dialog.showOpenDialog(owner, { title: 'Search folder for missing audio', properties: ['openDirectory'] });
          const directory = picked.filePaths[0];
          if (picked.canceled || !directory) return context.result;
          const found = await searchSyncMissingFiles([missing], [directory]);
          context.result = { ...context.result, files: context.result.files.map((file) => file.path === missing.path ? found.files[0] ?? file : file),
            warnings: [...context.result.warnings, ...found.warnings] };
          return context.result;
        }
        let replacementPath: string | null = action.kind === 'relink' ? action.replacementPath : null;
        if (action.kind === 'locate') {
          const picked = await dialog.showOpenDialog(owner, { title: `Locate ${basename(missing.path)}`, defaultPath: dirname(missing.path),
            properties: ['openFile'], filters: [{ name: 'Audio files', extensions: ['aac', 'aif', 'aifc', 'aiff', 'flac', 'm4a', 'mp2', 'mp3', 'mp4', 'oga', 'ogg', 'opus', 'wav', 'wma', 'wv'] }] });
          replacementPath = picked.filePaths[0] ?? null;
          if (picked.canceled || replacementPath === null) return context.result;
        }
        if (replacementPath !== null && !isSupportedAudioPath(replacementPath)) throw new Error('Choose a supported audio file.');
        const chosenPath = replacementPath;
        if (chosenPath !== null) context.result = { ...context.result, files: context.result.files.map((file) => file.path === missing.path
          ? { ...file, candidates: [...new Set([chosenPath, ...file.candidates])] } : file) };
        const contains = (library: typeof libraries.serato): boolean => library.tracks.some((track) => normalizePath(track.path) === normalizePath(missing.path));
        const workspacePath = context.workspacePath;
        const repairs = [
          ...(contains(libraries.serato) ? [() => repairSeratoMissingFile(context.serato, missing.path, replacementPath)] : []),
          ...(contains(libraries.rekordbox) ? [() => repairRekordboxMissingFile(context.rekordboxPath, missing.path, replacementPath)] : []),
          ...(libraries.workspace !== null && workspacePath !== null && contains(libraries.workspace)
            ? [() => repairRekordboxMissingFile(workspacePath, missing.path, replacementPath)] : []),
        ];
        for (const repair of repairs) {
          const result = await repair();
          context.result = { ...context.result, backupPaths: [...context.result.backupPaths, ...result.backupPaths],
            warnings: [...context.result.warnings, ...result.warnings] };
        }
        await this.refreshMissingSyncReport(context);
        if (this.catalog !== null && (await seratoMediaPathKey(this.catalog.sourcePath) === await seratoMediaPathKey(context.rekordboxPath) ||
          context.workspacePath !== null && await seratoMediaPathKey(this.catalog.sourcePath) === await seratoMediaPathKey(context.workspacePath))) {
          this.catalog = await this.catalogFor(this.catalog.sourcePath, this.catalog.seratoPath);
          this.cancelSuggestions();
        }
        return context.result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not resolve the missing file.';
        try { await this.refreshMissingSyncReport(context); } catch { /* Preserve the last report when a library cannot be read. */ }
        context.result = { ...context.result, warnings: [...context.result.warnings, message] };
        return context.result;
      }
    });
  }

  private defaultSeratoPath(): string {
    if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Serato', 'Library');
    if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Serato', 'Library');
    return join(homedir(), 'Music', '_Serato_');
  }

  mutate(change: LibraryMutation): Promise<LibraryMutationResult> {
    return this.enqueue(() => this.applyMutation(change));
  }

  private requireCatalog(): CurrentCatalog {
    if (this.catalog === null) {
      throw new Error('No library is open');
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
      this.cancelSuggestions();
      this.catalog = nextCatalog;
      this.rememberedPath = selectedPath;
      this.rememberedSeratoPath = null;
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
      case 'remove-songs':
        return this.removeSongs(catalog, change);
      case 'set-playlist-tracks':
        return this.setPlaylistTracks(catalog, change);
      case 'create-playlist':
      case 'create-folder':
      case 'save-smart-playlist':
        return this.createPlaylistNode(catalog, change);
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

  private async removeSongs(
    catalog: CurrentCatalog,
    change: Extract<LibraryMutation, { kind: 'remove-songs' }>,
  ): Promise<LibraryMutationResult> {
    const songIds = new Set(change.songIds);
    const tracks = catalog.tracks.filter((track) => songIds.has(track.song.id) && this.includesSong(track.song));
    if (tracks.length === 0 || tracks.length !== change.songIds.length) {
      return { kind: 'rejected', reason: 'song-not-found' };
    }

    const remaining = catalog.tracks.filter((track) => !songIds.has(track.song.id));
    const reload = await this.writeAndReload(catalog, {
      kind: 'remove-tracks',
      tracks: tracks.map((track) => ({
        trackId: track.rekordboxId,
        rawLocation: remaining.some((candidate) => candidate.rawLocation === track.rawLocation)
          ? null
          : track.rawLocation,
      })),
    });
    if (reload.kind === 'rejected') {
      return reload;
    }

    this.cancelSuggestions();
    this.catalog = reload.catalog;
    const handledPaths = new Set<string>();
    const fileActions: LocalFileAction[] = [];
    for (const track of tracks) {
      if (track.mediaPath === null && track.song.source !== 'local') {
        continue;
      }
      if (track.mediaPath !== null) {
        if (handledPaths.has(track.mediaPath)) {
          continue;
        }
        handledPaths.add(track.mediaPath);
      }
      fileActions.push(await fileActionFor({
        mediaPath: track.mediaPath,
        removeLocalFile: change.removeLocalFile,
        sharedLocation: remaining.some((candidate) =>
          (track.mediaPath !== null && candidate.mediaPath === track.mediaPath) ||
          (track.rawLocation !== null && candidate.rawLocation === track.rawLocation),
        ),
      }));
    }
    return {
      kind: 'songs-removed',
      library: summaryFor(reload.catalog),
      removedCount: tracks.length,
      fileActions,
    };
  }

  private async setPlaylistTracks(
    catalog: CurrentCatalog,
    change: Extract<LibraryMutation, { kind: 'set-playlist-tracks' }>,
  ): Promise<LibraryMutationResult> {
    const playlist = catalog.playlists.find((candidate) => candidate.id === change.playlistId);
    const songIds = new Set(change.songIds);
    if (
      playlist?.kind !== 'regular' ||
      songIds.size !== change.songIds.length ||
      songIds.size > 10_000
    ) {
      return { kind: 'rejected', reason: 'invalid-playlist' };
    }
    const bySongId = new Map(catalog.tracks.map((track) => [track.song.id, track]));
    const tracks: { trackId: string | null; rawLocation: string | null }[] = [];
    for (const songId of change.songIds) {
      const track = bySongId.get(songId);
      if (track === undefined || !this.includesSong(track.song)) {
        return { kind: 'rejected', reason: 'invalid-playlist' };
      }
      tracks.push({ trackId: track.rekordboxId, rawLocation: track.rawLocation });
    }
    const removedTracks = playlist.tracks.filter((song) => this.includesSong(song) && !songIds.has(song.id))
      .flatMap((song) => {
        const track = bySongId.get(song.id);
        return track ? [{ trackId: track.rekordboxId, rawLocation: track.rawLocation }] : [];
      });
    const reload = await this.writeAndReload(catalog, { kind: 'set-playlist-tracks', playlistId: playlist.id, tracks, removedTracks });
    if (reload.kind === 'rejected') return reload;
    this.cancelSuggestions();
    this.catalog = reload.catalog;
    return { kind: 'playlist-updated', library: summaryFor(reload.catalog), playlistId: playlist.id };
  }

  private async createPlaylistNode(
    catalog: CurrentCatalog,
    change: Extract<LibraryMutation, { kind: 'create-playlist' | 'create-folder' | 'save-smart-playlist' }>,
  ): Promise<LibraryMutationResult> {
    const name = change.name.trim();
    if (
      name.length === 0 ||
      name.length > 100 ||
      [...name].some((character) => character.charCodeAt(0) < 32)
    ) {
      return { kind: 'rejected', reason: 'invalid-playlist' };
    }

    if (change.parentFolderId !== null && !catalog.folders.some((folder) => folder.id === change.parentFolderId)) {
      return { kind: 'rejected', reason: 'folder-not-found' };
    }
    const editingId = change.kind === 'save-smart-playlist' ? change.playlistId : null;
    if (editingId !== null && !catalog.playlists.some((playlist) => playlist.id === editingId && playlist.smartDefinition !== null && playlist.parentFolderId === change.parentFolderId)) {
      return { kind: 'rejected', reason: 'invalid-playlist' };
    }
    if ([...catalog.folders, ...catalog.playlists].some((node) => node.id !== editingId && node.parentFolderId === change.parentFolderId && node.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return { kind: 'rejected', reason: 'name-conflict' };
    }
    if (change.kind === 'save-smart-playlist' && smartDefinitionError(change.definition) !== null) {
      return { kind: 'rejected', reason: 'invalid-playlist' };
    }
    const songIds = change.kind === 'create-playlist' ? change.songIds : change.kind === 'save-smart-playlist'
      ? evaluateArsenalSmartPlaylist(change.definition, catalog.songs).tracks.map((song) => song.id) : [];
    if (new Set(songIds).size !== songIds.length || (change.kind === 'create-playlist' && songIds.length > 10_000)) {
      return { kind: 'rejected', reason: 'invalid-playlist' };
    }

    const trackIds: string[] = [];
    const bySongId = new Map(catalog.tracks.map((track) => [track.song.id, track]));
    const idCounts = new Map<string, number>();
    for (const track of catalog.tracks) {
      if (track.rekordboxId !== null) idCounts.set(track.rekordboxId, (idCounts.get(track.rekordboxId) ?? 0) + 1);
    }
    for (const songId of songIds) {
      const track = bySongId.get(songId);
      if (track?.rekordboxId === null || track?.rekordboxId === undefined || !this.includesSong(track.song)) {
        return { kind: 'rejected', reason: 'invalid-playlist' };
      }
      if (idCounts.get(track.rekordboxId) !== 1) {
        return { kind: 'rejected', reason: 'invalid-playlist' };
      }
      trackIds.push(track.rekordboxId);
    }

    const edit: RekordboxXmlEdit = change.kind === 'create-folder'
      ? { kind: 'create-folder', name, parentFolderId: change.parentFolderId }
      : change.kind === 'save-smart-playlist' && change.playlistId !== null
        ? { kind: 'update-smart-playlist', playlistId: change.playlistId, name, trackIds, smartDefinition: change.definition }
        : { kind: 'create-playlist', name, trackIds, parentFolderId: change.parentFolderId, smartDefinition: change.kind === 'save-smart-playlist' ? change.definition : null };
    const reload = await this.writeAndReload(catalog, edit);
    if (reload.kind === 'rejected') {
      return reload;
    }
    this.cancelSuggestions();
    this.catalog = reload.catalog;
    if (change.kind === 'create-folder') return { kind: 'folder-created', library: summaryFor(reload.catalog) };
    const playlist = reload.catalog.playlists.find((candidate) => candidate.name === name && candidate.parentFolderId === change.parentFolderId);
    if (playlist === undefined) return { kind: 'rejected', reason: 'cannot-write' };
    return {
      kind: change.kind === 'save-smart-playlist' ? 'smart-playlist-saved' : 'playlist-created',
      playlistId: playlist.id,
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
      return { kind: 'ready', catalog: await this.catalogFor(catalog.sourcePath, catalog.seratoPath) };
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

  private async catalogFor(filePath: string, seratoPath: string | null = null): Promise<CurrentCatalog> {
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
      sourceName: seratoPath === null ? basename(filePath) : 'Serato library',
      sourceKind: seratoPath === null ? 'rekordbox' : 'serato',
      seratoPath,
      importedAt: new Date().toISOString(),
      fingerprint: parsed.fingerprint,
      tracks,
      songs: tracks.map((track) => track.song).filter((song) => this.includesSong(song)),
      playlists: projectPlaylists(parsed.playlists, tracks),
      folders: parsed.folders,
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
    rekordboxXmlPath: string | null,
    ignoredDuplicateGroups = this.ignoredDuplicateGroups,
    minimumSongLengthSeconds = this.minimumSongLengthSeconds,
    syncPreferences = this.savedSyncPreferences,
  ): Promise<boolean> {
    if (this.stateFilePath === null) {
      return false;
    }

    const state: RememberedLibrary = { rekordboxXmlPath, seratoPath: this.rememberedSeratoPath, ignoredDuplicateGroups, minimumSongLengthSeconds, syncPreferences };
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
