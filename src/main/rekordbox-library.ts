import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

import { dialog, shell, type BrowserWindow } from 'electron';
import { DEFAULT_SONG_FILTERS, readSyncRequest, songMetadataGapCount } from '../shared/dj-library';
import { DEFAULT_MINIMUM_SONG_LENGTH_SECONDS, type LibrarySettings } from '../shared/preferences';
import type { BackupStatus } from '../shared/library-backup';

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
  LibraryConnections,
  LibraryConnectionAction,
  LibraryConnectionResult,
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
} from './parse-rekordbox-xml';
import {
  TrackArtworkStore,
  type ArtworkAsset,
  isSupportedAudioPath,
} from './track-artwork';
import { assertSeratoClosed, findSeratoSource, moveSeratoNode, readSeratoLibrary, repairSeratoMissingFile, type SeratoSource } from './serato-library';
import { mergeRekordboxXml, rekordboxSyncLibrary, repairRekordboxMissingFile } from './sync-rekordbox-xml';
import { readSeratoWithPerformance, saveLibraryXml, syncLibraryFiles } from './sync-libraries';
import { normalizePath, type PlaylistNodeMove, type SyncLibrary } from './library-sync-model';
import { seratoSmartRules } from './serato-smart-crates';
import { resolveSeratoLibraryPaths, resolveSeratoMediaPath, seratoMediaPathKey } from './serato-paths';
import { findMissingSyncFiles, searchSyncMissingFiles } from './sync-missing-files';
import { readPortableLibrary, resolvePortableLibrary, writePortableLibrary } from './portable-library';

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

type StoredLibraryConnection = Readonly<{
  id: string;
  kind: LibrarySourceKind;
  path: string;
  workspacePath: string | null;
  dirty: boolean;
  origin?: 'portable';
  displayName?: string;
}>;

type StoredLibraryBackup = Readonly<{
  connectionId: string;
  directory: string;
  includeMusic: boolean;
  manifestPath: string | null;
  lastSavedAt: string | null;
  fingerprint: string | null;
}>;

const preferencesForPrimary = (connection: StoredLibraryConnection, preferences: SyncPreferences): SyncPreferences => ({
  ...preferences,
  [connection.kind === 'rekordbox' ? 'rekordboxPath' : 'seratoPath']: connection.path,
  request: { direction: connection.kind === 'rekordbox' ? 'rekordbox-to-serato' : 'serato-to-rekordbox',
    conflictSource: connection.kind, mode: 'merge', timingOffsetMs: preferences.request?.timingOffsetMs ?? 0,
    fields: preferences.request?.fields ?? { tracks: true, metadata: true, playlists: true, hotCues: true, loops: true, beatgrids: true } },
});

type RememberedLibrary = Readonly<{
  rekordboxXmlPath: string | null;
  seratoPath: string | null;
  minimumSongLengthSeconds: number;
  ignoredDuplicateGroups: Readonly<Record<string, readonly string[]>>;
  syncPreferences: SyncPreferences;
  connections: readonly StoredLibraryConnection[] | null;
  activeConnectionId: string | null;
  sourceOfTruthId: string | null;
  backups: readonly StoredLibraryBackup[];
}>;

type ReloadResult =
  | Readonly<{ kind: 'ready'; catalog: CurrentCatalog }>
  | Readonly<{ kind: 'rejected'; reason: MutationFailure }>;

type MissingSyncTarget = SeratoSource | Readonly<{ kind: 'xml'; path: string; libraryKind: LibrarySourceKind }>;

type MissingSyncContext = {
  targets: readonly MissingSyncTarget[];
  paths: ReadonlySet<string>;
  initialFiles: Extract<SyncResult, { kind: 'missing-files' }>['files'];
  knownPaths: Map<string, ReadonlySet<string>>;
  result: Extract<SyncResult, { kind: 'missing-files' }>;
};

const sameWorkspaceEntries = (left: SyncLibrary, right: SyncLibrary): boolean => {
  const entries = (library: SyncLibrary) => JSON.stringify({ tracks: library.tracks.map((track) => normalizePath(track.path)).sort(),
    playlists: library.playlists.map((playlist) => {
      const smart = seratoSmartRules(playlist);
      return { path: JSON.stringify(playlist.path), tracks: playlist.trackPaths.map(normalizePath).sort(),
        smart: smart ? { version: smart.version, rules: smart.rules } : null };
    }) });
  return entries(left) === entries(right);
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
    const connections: StoredLibraryConnection[] | null = Array.isArray(stored.connections) ? [] : null;
    for (const value of Array.isArray(stored.connections) ? stored.connections : []) {
      if (!isRecord(value) || typeof value.id !== 'string' || (value.kind !== 'rekordbox' && value.kind !== 'serato') ||
        typeof value.path !== 'string' || !isAbsolute(value.path)) continue;
      connections?.push({ id: value.id, kind: value.kind, path: value.path,
        workspacePath: value.kind === 'serato' && typeof value.workspacePath === 'string' && isAbsolute(value.workspacePath) ? value.workspacePath : null,
        dirty: value.kind === 'serato' && value.dirty !== false,
        ...(value.origin === 'portable' ? { origin: value.origin } : {}),
        ...(typeof value.displayName === 'string' && value.displayName.trim() ? { displayName: value.displayName } : {}) });
    }
    const backups: StoredLibraryBackup[] = [];
    for (const value of Array.isArray(stored.backups) ? stored.backups : []) {
      if (!isRecord(value) || typeof value.connectionId !== 'string' ||
        !connections?.some((connection) => connection.id === value.connectionId) ||
        typeof value.directory !== 'string' || !isAbsolute(value.directory) || typeof value.includeMusic !== 'boolean' ||
        backups.some((backup) => backup.connectionId === value.connectionId)) continue;
      backups.push({ connectionId: value.connectionId, directory: value.directory, includeMusic: value.includeMusic,
        manifestPath: typeof value.manifestPath === 'string' && isAbsolute(value.manifestPath) ? value.manifestPath : null,
        lastSavedAt: typeof value.lastSavedAt === 'string' ? value.lastSavedAt : null,
        fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : null });
    }
    return { rekordboxXmlPath: rememberedPath, seratoPath, ignoredDuplicateGroups, minimumSongLengthSeconds, syncPreferences, connections,
      activeConnectionId: typeof stored.activeConnectionId === 'string' && connections?.some((connection) => connection.id === stored.activeConnectionId) ? stored.activeConnectionId : null,
      sourceOfTruthId: typeof stored.sourceOfTruthId === 'string' && connections?.some((connection) => connection.id === stored.sourceOfTruthId) ? stored.sourceOfTruthId : null,
      backups };
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

  private stateFilePath: string | null = null;

  private rememberedPath: string | null = null;

  private rememberedSeratoPath: string | null = null;

  private savedSyncPreferences: SyncPreferences = { request: null, rekordboxPath: null, seratoPath: null };

  private missingSyncContext: MissingSyncContext | null = null;

  private connectedLibraries: readonly StoredLibraryConnection[] = [];

  private activeConnectionId: string | null = null;

  private sourceOfTruthId: string | null = null;

  private backups: readonly StoredLibraryBackup[] = [];

  private backupStates = new Map<string, Pick<BackupStatus, 'state' | 'message'>>();

  private backupTimer: ReturnType<typeof setInterval> | null = null;

  private backupPollQueued = false;

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
    this.connectedLibraries = remembered?.connections ?? [];
    this.activeConnectionId = remembered?.activeConnectionId ?? null;
    this.sourceOfTruthId = remembered?.sourceOfTruthId ?? null;
    this.backups = remembered?.backups ?? [];
    if (this.rememberedPath !== null) {
      try { this.catalog = await this.catalogFor(this.rememberedPath, this.rememberedSeratoPath); } catch { this.catalog = null; }
    }
    if (remembered?.connections === null) {
      const migrated: StoredLibraryConnection[] = [];
      const add = async (kind: LibrarySourceKind, path: string, workspacePath: string | null = null) => {
        let canonical = path;
        try { canonical = await resolveSeratoMediaPath(path); } catch { /* Keep unavailable saved locations for recovery. */ }
        const previous = migrated.find((connection) => connection.kind === kind && normalizePath(connection.path) === normalizePath(canonical));
        if (previous) return previous;
        const connection: StoredLibraryConnection = { id: randomUUID(), kind, path: canonical, workspacePath, dirty: kind === 'serato' && workspacePath !== null };
        migrated.push(connection);
        return connection;
      };
      if (this.rememberedPath !== null) {
        const active = this.rememberedSeratoPath === null ? await add('rekordbox', this.rememberedPath)
          : await add('serato', this.rememberedSeratoPath, this.rememberedPath);
        this.activeConnectionId = active.id;
      }
      if (this.savedSyncPreferences.rekordboxPath !== null) {
        const connection = await add('rekordbox', this.savedSyncPreferences.rekordboxPath);
        this.savedSyncPreferences = { ...this.savedSyncPreferences, rekordboxPath: connection.path };
      }
      if (this.savedSyncPreferences.seratoPath !== null) {
        const connection = await add('serato', this.savedSyncPreferences.seratoPath);
        this.savedSyncPreferences = { ...this.savedSyncPreferences, seratoPath: connection.path };
      }
      this.connectedLibraries = migrated;
      if (!await this.remember(this.rememberedPath)) throw new Error('Could not save migrated library connections. Check disk space and permissions.');
    }
    if (this.sourceOfTruthId === null && this.connectedLibraries.length) await this.saveConnections({});
    const active = this.connectedLibraries.find((connection) => connection.id === this.activeConnectionId);
    if (active !== undefined) {
      try {
        const prepared = await this.prepareConnection(active);
        await this.saveConnections({ connections: this.connectedLibraries.map((connection) => connection.id === active.id ? prepared.connection : connection), catalog: prepared.catalog });
      } catch { this.catalog = null; }
    }
    this.disposeBackups();
    this.backupTimer = setInterval(() => {
      if (!this.backups.length || this.backupPollQueued) return;
      this.backupPollQueued = true;
      void this.enqueue(async () => undefined).catch(() => undefined).finally(() => { this.backupPollQueued = false; });
    }, 30_000);
    this.backupTimer.unref();
  }

  status(): LibraryStatus {
    return this.catalog === null
      ? { kind: 'empty' }
      : { kind: 'ready', library: summaryFor(this.catalog) };
  }

  backupStatus(): BackupStatus {
    const backup = this.backups.find((candidate) => candidate.connectionId === this.activeConnectionId);
    return {
      connectionId: this.activeConnectionId, directory: backup?.directory ?? null,
      manifestPath: backup?.manifestPath ?? null, includeMusic: backup?.includeMusic ?? false,
      state: backup ? 'ready' : 'off', lastSavedAt: backup?.lastSavedAt ?? null, message: null,
      ...(backup ? this.backupStates.get(backup.connectionId) : {}),
    };
  }

  configureBackup(owner: BrowserWindow, includeMusic: boolean): Promise<BackupStatus | null> {
    return this.enqueue(async () => {
      const connection = this.connectedLibraries.find((candidate) => candidate.id === this.activeConnectionId);
      if (!connection) throw new Error('Open a library before choosing its backup folder.');
      const chosen = await dialog.showOpenDialog(owner, {
        title: 'Choose a backup folder', buttonLabel: 'Back up here', properties: ['openDirectory', 'createDirectory'],
      });
      const directory = chosen.filePaths[0];
      if (chosen.canceled || !directory) return null;
      const backup: StoredLibraryBackup = { connectionId: connection.id,
        directory: join(directory, `Arsenal-${randomUUID()}`), includeMusic,
        manifestPath: null, lastSavedAt: null, fingerprint: null };
      const previous = this.backups;
      this.backups = [...previous.filter((candidate) => candidate.connectionId !== connection.id), backup];
      if (!await this.remember(this.rememberedPath)) {
        this.backups = previous;
        throw new Error('Could not save backup settings. Check disk space and permissions.');
      }
      await this.saveBackup(connection, backup, true);
      return this.backupStatus();
    }, false);
  }

  backupNow(): Promise<BackupStatus> {
    return this.enqueue(async () => {
      const connection = this.connectedLibraries.find((candidate) => candidate.id === this.activeConnectionId);
      const backup = this.backups.find((candidate) => candidate.connectionId === connection?.id);
      if (!connection || !backup) throw new Error('Choose a backup folder first.');
      await this.saveBackup(connection, backup, true);
      return this.backupStatus();
    }, false);
  }

  stopBackup(): Promise<BackupStatus> {
    return this.enqueue(async () => {
      const previous = this.backups;
      this.backups = previous.filter((backup) => backup.connectionId !== this.activeConnectionId);
      if (!await this.remember(this.rememberedPath)) {
        this.backups = previous;
        throw new Error('Could not save backup settings.');
      }
      if (this.activeConnectionId) this.backupStates.delete(this.activeConnectionId);
      return this.backupStatus();
    });
  }

  disposeBackups(): void {
    if (this.backupTimer !== null) clearInterval(this.backupTimer);
    this.backupTimer = null;
  }

  importBackup(owner: BrowserWindow): Promise<LibraryConnectionResult> {
    return this.enqueue(async () => {
      let workspacePath: string | null = null;
      try {
        const chosen = await dialog.showOpenDialog(owner, { title: 'Import a library backup', buttonLabel: 'Import library',
          properties: ['openFile'], filters: [{ name: 'Library backup', extensions: ['json'] }] });
        const manifestPath = chosen.filePaths[0];
        if (chosen.canceled || !manifestPath) return { kind: 'cancelled' };
        const manifest = await readPortableLibrary(manifestPath);
        const searchRoots: string[] = [];
        let resolved = await resolvePortableLibrary(manifest, manifestPath, searchRoots);
        while (resolved.missingFiles.length > 0) {
          const missing = resolved.missingFiles.length;
          const choice = await dialog.showMessageBox(owner, {
            type: 'question', title: 'Locate your music', message: `${missing} audio ${missing === 1 ? 'file is' : 'files are'} missing on this computer.`,
            detail: 'Choose a folder containing your music. Arsenal checks file contents before linking tracks. Missing files will stay unplayable. You can import this backup again after recovering the music.',
            buttons: ['Choose music folder', 'Import with missing files', 'Cancel'], defaultId: 0, cancelId: 2,
          });
          if (choice.response === 2) return { kind: 'cancelled' };
          if (choice.response === 1) break;
          const music = await dialog.showOpenDialog(owner, { title: 'Find music for this library',
            buttonLabel: 'Search this folder', properties: ['openDirectory'] });
          const root = music.filePaths[0];
          if (music.canceled || !root) continue;
          if (!searchRoots.includes(root)) searchRoots.push(root);
          resolved = await resolvePortableLibrary(manifest, manifestPath, searchRoots);
        }
        if (this.stateFilePath === null) throw new Error('Library settings are not initialized.');
        const directory = join(dirname(this.stateFilePath), 'libraries');
        await mkdir(directory, { recursive: true });
        workspacePath = join(directory, `imported-${randomUUID()}.xml`);
        await saveLibraryXml(workspacePath, mergeRekordboxXml(resolved.library), null, false);
        const connection: StoredLibraryConnection = { id: randomUUID(), kind: 'rekordbox', path: workspacePath,
          workspacePath: null, dirty: false, origin: 'portable', displayName: manifest.name };
        const catalog = { ...await this.catalogFor(workspacePath), sourceName: manifest.name };
        await this.saveConnections({ connections: [...this.connectedLibraries, connection], activeConnectionId: connection.id, catalog });
        workspacePath = null;
        this.cancelSuggestions();
        return { kind: 'updated', connections: await this.connections(), status: this.status(), warnings: [
          ...resolved.warnings,
          ...(resolved.missingFiles.length ? [`${resolved.missingFiles.length} audio files remain unplayable. Import the backup again after recovering the music.`] : []),
        ] };
      } catch (error) {
        if (workspacePath !== null) await rm(workspacePath, { force: true }).catch(() => undefined);
        return { kind: 'rejected', message: error instanceof Error ? error.message : 'Could not import the library backup.' };
      }
    });
  }

  private async backupLibrary(connection: StoredLibraryConnection) {
    const native = connection.kind === 'serato' && (!connection.dirty || connection.workspacePath === null);
    const snapshot = native ? await readSeratoWithPerformance(await findSeratoSource(connection.path))
      : { library: rekordboxSyncLibrary(await parseRekordboxXml(connection.workspacePath ?? connection.path), { includeNonLocal: true }), warnings: [] };
    const fingerprint = createHash('sha256').update(JSON.stringify(snapshot.library));
    for (const track of snapshot.library.tracks) {
      if (track.song.source !== 'local') continue;
      try {
        const file = await stat(track.location ?? track.path);
        fingerprint.update(JSON.stringify([track.path, file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs]));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
        fingerprint.update(JSON.stringify([track.path, 'missing']));
      }
    }
    return { ...snapshot, fingerprint: fingerprint.digest('hex') };
  }

  private async saveBackup(connection: StoredLibraryConnection, backup: StoredLibraryBackup, force = false): Promise<void> {
    try {
      const snapshot = await this.backupLibrary(connection);
      if (!force && backup.fingerprint === snapshot.fingerprint && backup.manifestPath !== null &&
        this.backupStates.get(connection.id)?.state === 'ready') {
        try { if ((await stat(backup.manifestPath)).isFile()) return; } catch (error) {
          if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
        }
      }
      this.backupStates.set(connection.id, { state: 'saving', message: null });
      const verified = await this.backupLibrary(connection);
      if (verified.fingerprint !== snapshot.fingerprint) throw new Error('The library changed while preparing its backup. Arsenal will retry automatically.');
      const saved = await writePortableLibrary({ directory: backup.directory, library: snapshot.library,
        name: connection.displayName ?? (connection.kind === 'serato' ? 'Serato library' : basename(connection.path)),
        includeMusic: backup.includeMusic });
      const previous = this.backups;
      this.backups = previous.map((candidate) => candidate.connectionId === connection.id
        ? { ...backup, manifestPath: saved.manifestPath, lastSavedAt: saved.savedAt, fingerprint: snapshot.fingerprint } : candidate);
      if (!await this.remember(this.rememberedPath)) {
        this.backups = previous;
        throw new Error('The backup was saved, but Arsenal could not save its status. Check disk space and permissions.');
      }
      const warnings = [...new Set([...snapshot.warnings, ...saved.warnings])];
      this.backupStates.set(connection.id, { state: 'ready', message: warnings.length ? warnings.join('\n') : null });
    } catch (error) {
      this.backupStates.set(connection.id, { state: 'error', message: error instanceof Error ? error.message : 'Could not save the library backup.' });
    }
  }

  private async updateBackups(): Promise<void> {
    for (const backup of this.backups) {
      const connection = this.connectedLibraries.find((candidate) => candidate.id === backup.connectionId);
      if (connection) await this.saveBackup(connection, backup);
    }
  }

  async connections(): Promise<LibraryConnections> {
    const connections = await Promise.all(this.connectedLibraries.map(async (connection) => {
      const location = connection.kind === 'serato' && !connection.path.endsWith('.sqlite')
        ? join(connection.path, 'database V2') : connection.path;
      let available = false;
      try { available = (await stat(location)).isFile(); } catch { /* Keep unavailable connections so they can be located again. */ }
      return { id: connection.id, kind: connection.kind, path: connection.path, available,
        ...(connection.origin ? { origin: connection.origin } : {}),
        name: connection.displayName ?? (connection.kind === 'rekordbox' ? basename(connection.path)
          : `Serato (${basename(connection.path.endsWith('.sqlite') ? dirname(connection.path) : connection.path)})`) };
    }));
    return { connections, activeConnectionId: this.activeConnectionId, sourceOfTruthId: this.sourceOfTruthId };
  }

  private async saveConnections({ connections = this.connectedLibraries, activeConnectionId = this.activeConnectionId,
    sourceOfTruthId = this.sourceOfTruthId, syncPreferences = this.savedSyncPreferences, catalog = this.catalog }: Readonly<{
      connections?: readonly StoredLibraryConnection[];
      activeConnectionId?: string | null;
      sourceOfTruthId?: string | null;
      syncPreferences?: SyncPreferences;
      catalog?: CurrentCatalog | null;
    }>): Promise<void> {
    const active = connections.find((connection) => connection.id === activeConnectionId);
    const primary = connections.find((connection) => connection.id === sourceOfTruthId) ?? connections[0];
    const primaryId = primary?.id ?? null;
    const preferences = primary && primaryId !== this.sourceOfTruthId ? preferencesForPrimary(primary, syncPreferences) : syncPreferences;
    const rekordboxXmlPath = active?.kind === 'rekordbox' ? active.path : active?.workspacePath ?? null;
    const seratoPath = active?.kind === 'serato' ? active.path : null;
    if (!await this.writeRemembered({ rekordboxXmlPath, seratoPath, syncPreferences: preferences, connections, activeConnectionId, sourceOfTruthId: primaryId,
      ignoredDuplicateGroups: this.ignoredDuplicateGroups, minimumSongLengthSeconds: this.minimumSongLengthSeconds,
      backups: this.backups.filter((backup) => connections.some((connection) => connection.id === backup.connectionId)) })) {
      throw new Error('Could not save library connections. Check disk space and permissions.');
    }
    this.connectedLibraries = connections;
    this.activeConnectionId = activeConnectionId;
    this.sourceOfTruthId = primaryId;
    this.savedSyncPreferences = preferences;
    this.rememberedPath = rekordboxXmlPath;
    this.rememberedSeratoPath = seratoPath;
    this.catalog = catalog;
    this.backups = this.backups.filter((backup) => connections.some((connection) => connection.id === backup.connectionId));
  }

  private async prepareConnection(connection: StoredLibraryConnection) {
    if (connection.kind === 'rekordbox') return { connection, catalog: await this.catalogFor(connection.path), warnings: [] };
    if (connection.dirty && connection.workspacePath !== null) {
      return { connection, catalog: await this.catalogFor(connection.workspacePath, connection.path),
        warnings: ['Arsenal has unsynced edits in this Serato connection. They were kept. Sync tracks and playlists to Serato before refreshing from its library.'] };
    }
    const source = await findSeratoSource(connection.path);
    const { library, warnings } = await readSeratoWithPerformance(source);
    if (this.stateFilePath === null) throw new Error('Library settings are not initialized.');
    const directory = join(dirname(this.stateFilePath), 'libraries');
    await mkdir(directory, { recursive: true });
    const workspacePath = connection.workspacePath ?? join(directory, `serato-${randomUUID()}.xml`);
    let previous: string | null = null;
    try { previous = await readFile(workspacePath, 'utf8'); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await saveLibraryXml(workspacePath, mergeRekordboxXml(library), previous, false);
    return { connection: { ...connection, path: await resolveSeratoMediaPath(source.path), workspacePath, dirty: false },
      catalog: await this.catalogFor(workspacePath, source.path), warnings };
  }

  connectLibrary(owner: BrowserWindow, kind: LibrarySourceKind): Promise<LibraryConnectionResult> {
    return this.enqueue(async () => {
      try {
        const selected = await this.chooseSyncPath(owner, kind, 'rekordbox-to-serato');
        if (selected === null) return { kind: 'cancelled' };
        const path = await resolveSeratoMediaPath(selected);
        const existing = this.connectedLibraries.find((connection) => connection.kind === kind && normalizePath(connection.path) === normalizePath(path));
        const prepared = await this.prepareConnection(existing ?? { id: randomUUID(), kind, path, workspacePath: null, dirty: false });
        const connections = existing ? this.connectedLibraries.map((connection) => connection.id === existing.id ? prepared.connection : connection)
          : [...this.connectedLibraries, prepared.connection];
        await this.saveConnections({ connections, activeConnectionId: prepared.connection.id, catalog: prepared.catalog,
          syncPreferences: { ...this.syncPreferences(), [kind === 'rekordbox' ? 'rekordboxPath' : 'seratoPath']: path } });
        this.cancelSuggestions();
        return { kind: 'updated', connections: await this.connections(), status: this.status(), warnings: prepared.warnings };
      } catch (error) {
        return { kind: 'rejected', message: error instanceof Error ? error.message : 'Could not connect the library.' };
      }
    });
  }

  selectSyncLibrary(id: string): Promise<SyncPreferences> {
    return this.enqueue(async () => {
      const connection = this.connectedLibraries.find((candidate) => candidate.id === id);
      if (!connection) throw new Error('This library is no longer connected.');
      if (!(await this.connections()).connections.find((candidate) => candidate.id === id)?.available) {
        throw new Error('This library is unavailable. Open Connections to choose a replacement or disconnect it.');
      }
      await this.saveConnections({ syncPreferences: { ...this.syncPreferences(),
        [connection.kind === 'rekordbox' ? 'rekordboxPath' : 'seratoPath']: connection.path } });
      return this.syncPreferences();
    });
  }

  manageLibraryConnection(owner: BrowserWindow, action: LibraryConnectionAction): Promise<LibraryConnectionResult> {
    return this.enqueue(async () => {
      try {
        const connection = this.connectedLibraries.find((candidate) => candidate.id === action.id);
        if (!connection) throw new Error('This library is no longer connected.');
        if (action.kind === 'source-of-truth') {
          await this.saveConnections({ sourceOfTruthId: connection.id, syncPreferences: preferencesForPrimary(connection, this.syncPreferences()) });
        } else if (action.kind === 'disconnect') {
          const connections = this.connectedLibraries.filter((candidate) => candidate.id !== connection.id);
          const preferences = this.syncPreferences();
          const key = connection.kind === 'rekordbox' ? 'rekordboxPath' : 'seratoPath';
          const nextPath = connections.find((candidate) => candidate.kind === connection.kind)?.path ?? null;
          await this.saveConnections({ connections, sourceOfTruthId: this.sourceOfTruthId === connection.id ? null : this.sourceOfTruthId,
            activeConnectionId: this.activeConnectionId === connection.id ? null : this.activeConnectionId,
            catalog: this.activeConnectionId === connection.id ? null : this.catalog,
            syncPreferences: { ...preferences, [key]: preferences[key] === connection.path ? nextPath : preferences[key] } });
        } else if (action.kind === 'replace') {
          const selected = await this.chooseSyncPath(owner, connection.kind, 'rekordbox-to-serato');
          if (selected === null) return { kind: 'cancelled' };
          const path = await resolveSeratoMediaPath(selected);
          if (normalizePath(path) === normalizePath(connection.path)) {
            return { kind: 'updated', connections: await this.connections(), status: this.status(), warnings: [] };
          }
          if (this.connectedLibraries.some((candidate) => candidate.kind === connection.kind && normalizePath(candidate.path) === normalizePath(path))) {
            throw new Error('That library is already connected. Open its existing connection.');
          }
          const prepared = await this.prepareConnection({ id: connection.id, kind: connection.kind, path, workspacePath: null, dirty: false });
          try {
            const preferences = this.syncPreferences();
            const key = connection.kind === 'rekordbox' ? 'rekordboxPath' : 'seratoPath';
            await this.saveConnections({ connections: this.connectedLibraries.map((candidate) => candidate.id === connection.id ? prepared.connection : candidate),
              catalog: this.activeConnectionId === connection.id ? prepared.catalog : this.catalog,
              syncPreferences: this.sourceOfTruthId === connection.id ? preferencesForPrimary(prepared.connection, preferences)
                : { ...preferences, [key]: preferences[key] === connection.path ? path : preferences[key] } });
          } catch (error) {
            if (prepared.connection.workspacePath !== null && prepared.connection.workspacePath !== connection.workspacePath) {
              await rm(prepared.connection.workspacePath, { force: true }).catch(() => undefined);
            }
            throw error;
          }
          this.cancelSuggestions();
          return { kind: 'updated', connections: await this.connections(), status: this.status(), warnings: prepared.warnings };
        } else {
          let updated = connection;
          if (action.kind === 'locate') {
            const selected = await this.chooseSyncPath(owner, connection.kind, 'rekordbox-to-serato');
            if (selected === null) return { kind: 'cancelled' };
            const path = await resolveSeratoMediaPath(selected);
            if (this.connectedLibraries.some((candidate) => candidate.id !== connection.id && candidate.kind === connection.kind && normalizePath(candidate.path) === normalizePath(path))) {
              throw new Error('That library is already connected. Open its existing connection.');
            }
            updated = { ...connection, path };
          }
          const shouldOpen = action.kind !== 'locate' || this.activeConnectionId === connection.id;
          const prepared = shouldOpen ? await this.prepareConnection(updated) : null;
          const preferences = this.syncPreferences();
          const key = connection.kind === 'rekordbox' ? 'rekordboxPath' : 'seratoPath';
          await this.saveConnections({ connections: this.connectedLibraries.map((candidate) => candidate.id === connection.id ? prepared?.connection ?? updated : candidate),
            activeConnectionId: shouldOpen ? connection.id : this.activeConnectionId, catalog: prepared?.catalog ?? this.catalog,
            syncPreferences: { ...preferences, [key]: preferences[key] === connection.path ? updated.path : preferences[key] } });
          this.cancelSuggestions();
          return { kind: 'updated', connections: await this.connections(), status: this.status(), warnings: prepared?.warnings ?? [] };
        }
        this.cancelSuggestions();
        return { kind: 'updated', connections: await this.connections(), status: this.status(), warnings: [] };
      } catch (error) {
        return { kind: 'rejected', message: error instanceof Error ? error.message : 'Could not update the library connection.' };
      }
    });
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

  async playlistOrder(): Promise<readonly (readonly string[])[]> {
    const catalog = this.requireCatalog();
    const activeOrder = [...catalog.folders.map((folder) => ({ path: folder.folderPath, order: folder.order })),
      ...catalog.playlists.map((playlist) => ({ path: [...playlist.folderPath, playlist.name], order: playlist.order }))]
      .sort((left, right) => left.order - right.order).map((node) => node.path);
    const primary = this.connectedLibraries.find((connection) => connection.id === this.sourceOfTruthId);
    if (primary === undefined || primary.id === this.activeConnectionId) return activeOrder;
    try {
      const xmlPath = primary.kind === 'rekordbox' ? primary.path : primary.dirty ? primary.workspacePath : null;
      if (xmlPath !== null) {
        const parsed = await parseRekordboxXml(xmlPath);
        return [...parsed.folders.map((folder) => ({ path: folder.folderPath, order: folder.order })),
          ...parsed.playlists.map((playlist) => ({ path: [...playlist.folderPath, playlist.name], order: playlist.order }))]
          .sort((left, right) => left.order - right.order).map((node) => node.path);
      }
      const library = await readSeratoLibrary(await findSeratoSource(primary.path));
      const paths: string[][] = [];
      const seen = new Set<string>();
      for (const playlist of library.playlists) {
        for (let depth = 1; depth <= playlist.path.length; depth += 1) {
          const path = playlist.path.slice(0, depth);
          const key = JSON.stringify(path);
          if (!seen.has(key)) { seen.add(key); paths.push(path); }
        }
      }
      return paths;
    } catch {
      return activeOrder;
    }
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
    const result = await this.connectLibrary(owner, 'rekordbox');
    return result.kind === 'cancelled' ? result : result.kind === 'updated' && result.status.kind === 'ready'
      ? { kind: 'imported', library: result.status.library, warnings: result.warnings } : { kind: 'rejected', reason: 'cannot-read' };
  }

  async importSerato(owner: BrowserWindow): Promise<ImportResult> {
    const result = await this.connectLibrary(owner, 'serato');
    return result.kind === 'cancelled' ? result : result.kind === 'updated' && result.status.kind === 'ready'
      ? { kind: 'imported', library: result.status.library, warnings: result.warnings } : { kind: 'rejected', reason: 'not-serato-library' };
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
      const canonical = await resolveSeratoMediaPath(path);
      const existing = this.connectedLibraries.some((connection) => connection.kind === kind && normalizePath(connection.path) === normalizePath(canonical));
      await this.saveConnections({ connections: existing ? this.connectedLibraries : [...this.connectedLibraries,
        { id: randomUUID(), kind, path: canonical, workspacePath: null, dirty: false }],
        syncPreferences: { ...this.syncPreferences(), [kind === 'rekordbox' ? 'rekordboxPath' : 'seratoPath']: canonical } });
      return this.syncPreferences();
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

  syncLibraries(_owner: BrowserWindow, requested: SyncRequest): Promise<SyncResult> {
    return this.enqueue(async () => {
      let result: SyncResult | null = null;
      try {
        const validated = readSyncRequest(requested);
        const primary = this.connectedLibraries.find((connection) => connection.id === this.sourceOfTruthId);
        const conflictSource = validated.direction === 'both' ? primary?.kind
          : validated.direction === 'rekordbox-to-serato' ? 'rekordbox' : 'serato';
        if (conflictSource === undefined) throw new Error('Choose a primary library on Connections before syncing both ways.');
        const request = { ...validated, conflictSource };
        const preferences = await this.rememberSyncPreferences({ ...this.syncPreferences(), request });
        if (preferences.rekordboxPath === null || preferences.seratoPath === null) {
          throw new Error('Open Connections to connect and choose a Rekordbox and Serato library before syncing.');
        }
        const rekordboxPath = await resolveSeratoMediaPath(preferences.rekordboxPath);
        const seratoPath = await resolveSeratoMediaPath(preferences.seratoPath);
        const selectedRekordbox = this.connectedLibraries.find((connection) => connection.kind === 'rekordbox' && normalizePath(connection.path) === normalizePath(rekordboxPath));
        const selectedSerato = this.connectedLibraries.find((connection) => connection.kind === 'serato' && normalizePath(connection.path) === normalizePath(seratoPath));
        const availability = await this.connections();
        if (!selectedRekordbox || !selectedSerato ||
          !availability.connections.find((connection) => connection.id === selectedRekordbox.id)?.available ||
          !availability.connections.find((connection) => connection.id === selectedSerato.id)?.available) {
          throw new Error('A selected sync library is unavailable or disconnected. Open Connections to connect a replacement.');
        }
        if (request.direction === 'both' && primary?.id !== selectedRekordbox.id && primary?.id !== selectedSerato.id) {
          throw new Error('Two-way sync must include the primary library. Select it for sync or change Primary on Connections.');
        }
        if (this.missingSyncContext !== null) {
          await this.refreshMissingSyncReport(this.missingSyncContext);
          if (this.missingSyncContext.result.files.length) return this.missingSyncContext.result;
        }
        this.missingSyncContext = null;
        const serato = await findSeratoSource(seratoPath);
        const matchesOpenRekordbox = this.catalog?.sourceKind === 'rekordbox' &&
          await seratoMediaPathKey(this.catalog.sourcePath) === await seratoMediaPathKey(rekordboxPath);
        const workspace = selectedSerato.dirty && selectedSerato.workspacePath !== null
          ? rekordboxSyncLibrary(await parseRekordboxXml(selectedSerato.workspacePath)) : null;
        result = await syncLibraryFiles({ rekordboxPath, serato, request, workspace });
        if (result.kind === 'missing-files') {
          const context: MissingSyncContext = { targets: await this.connectedSyncTargets(),
            paths: new Set(result.files.map((file) => normalizePath(file.path))), initialFiles: result.files, knownPaths: new Map(), result };
          this.missingSyncContext = context;
          try { await this.refreshMissingSyncReport(context); } catch (error) {
            context.result = { ...context.result, warnings: [...context.result.warnings,
              error instanceof Error ? error.message : 'Could not read every connected library.'] };
          }
          result = context.result;
        }
        if (result.kind === 'synced') {
          if (request.direction !== 'serato-to-rekordbox') {
            let dirty = selectedSerato.dirty;
            if (dirty && workspace !== null && request.fields.tracks && request.fields.playlists) {
              const native = await readSeratoLibrary(serato);
              dirty = !(request.mode === 'replace' || sameWorkspaceEntries(await resolveSeratoLibraryPaths(workspace, native), native));
              if (dirty) result = { ...result, warnings: [...result.warnings,
                'Serato still differs from the staged Arsenal tracks or playlists. The workspace edits were kept. Use a one-way overwrite to apply removals, or review the remaining differences.'] };
            }
            if (!dirty) {
              const prepared = await this.prepareConnection({ ...selectedSerato, dirty: false });
              await this.saveConnections({ connections: this.connectedLibraries.map((connection) => connection.id === selectedSerato.id ? prepared.connection : connection),
                catalog: this.activeConnectionId === selectedSerato.id ? prepared.catalog : this.catalog });
              result = { ...result, warnings: [...result.warnings, ...prepared.warnings] };
            }
          }
          if (matchesOpenRekordbox && this.catalog !== null) this.catalog = await this.catalogFor(this.catalog.sourcePath, this.catalog.seratoPath);
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

  private async connectedSyncTargets(): Promise<MissingSyncTarget[]> {
    const targets: MissingSyncTarget[] = [];
    for (const connection of this.connectedLibraries) {
      if (connection.kind === 'rekordbox') targets.push({ kind: 'xml', path: connection.path, libraryKind: 'rekordbox' });
      else {
        targets.push({ kind: connection.path.endsWith('.sqlite') ? 'sqlite' : 'legacy', path: connection.path });
        if (connection.workspacePath !== null) targets.push({ kind: 'xml', path: connection.workspacePath, libraryKind: 'serato' });
      }
    }
    const canonical = new Map<string, MissingSyncTarget>();
    for (const target of targets) {
      let path = target.path;
      try { path = await resolveSeratoMediaPath(path); } catch { /* The read below reports unavailable connections. */ }
      if (!canonical.has(normalizePath(path))) canonical.set(normalizePath(path), { ...target, path });
    }
    return [...canonical.values()];
  }

  private async refreshMissingSyncReport(context: MissingSyncContext, message?: string) {
    context.targets = await this.connectedSyncTargets();
    const libraries: { target: MissingSyncTarget; kind: LibrarySourceKind; library: SyncLibrary }[] = [];
    const failures: { target: MissingSyncTarget; message: string }[] = [];
    for (const target of context.targets) {
      try {
        const library = target.kind === 'xml' ? rekordboxSyncLibrary(await parseRekordboxXml(target.path)) : await readSeratoLibrary(target);
        const tracks = library.tracks.filter((track) => context.paths.has(normalizePath(track.path)));
        context.knownPaths.set(target.path, new Set(tracks.map((track) => normalizePath(track.path))));
        libraries.push({ target, kind: target.kind === 'xml' ? target.libraryKind : 'serato', library: { ...library, tracks } });
      } catch (error) {
        failures.push({ target, message: `${target.path}: ${error instanceof Error ? error.message : 'Could not read the connected library.'} Open Connections to choose a replacement or disconnect this library before completing recovery.` });
      }
    }
    const found = await findMissingSyncFiles(libraries);
    const previous = new Map(context.result.files.map((file) => [normalizePath(file.path), file.candidates]));
    const byPath = new Map(found.map((file) => [normalizePath(file.path), { ...file, candidates: previous.get(normalizePath(file.path)) ?? [],
      libraryPaths: libraries.filter(({ library }) => library.tracks.some((track) => normalizePath(track.path) === normalizePath(file.path)))
        .map(({ target }) => target.path) }]));
    for (const { target } of failures) {
      for (const file of context.initialFiles) {
        const key = normalizePath(file.path);
        const known = context.knownPaths.get(target.path);
        if (known && !known.has(key)) continue;
        try { if ((await stat(file.path)).isFile()) continue; } catch (error) {
          if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
        }
        const current = byPath.get(key);
        const kind = target.kind === 'xml' ? target.libraryKind : 'serato';
        byPath.set(key, { ...file, ...current, candidates: current?.candidates ?? previous.get(key) ?? file.candidates,
          libraries: [...new Set([...current?.libraries ?? [], kind])], libraryPaths: [...current?.libraryPaths ?? [], target.path] });
      }
    }
    const files = [...byPath.values()];
    context.result = { ...context.result, files, warnings: [...new Set([...context.result.warnings, ...failures.map((failure) => failure.message)])],
      message: message ?? (files.length ? `Resolve ${files.length} missing audio ${files.length === 1 ? 'file' : 'files'}, then retry sync.`
        : 'All missing files are resolved. Retry sync to continue.') };
    return libraries;
  }

  resolveSyncMissingFile(owner: BrowserWindow, action: SyncMissingFileAction): Promise<SyncResult> {
    return this.enqueue(async () => {
      const context = this.missingSyncContext;
      if (context === null) return { kind: 'rejected', warnings: [], backupPaths: [], message: 'Run sync again to check the current libraries for missing files.' };
      const repairedPaths = new Set<string>();
      try {
        const requestedPaths = 'paths' in action ? action.paths : action.kind === 'relink-many'
          ? action.replacements.map((replacement) => replacement.path) : [action.path];
        if (!requestedPaths.length || requestedPaths.some((path) => !context.result.files.some((file) => file.path === path))) {
          throw new Error('A selected file is not in the current missing-file report. Retry sync.');
        }
        const selectedPaths = new Set(requestedPaths.map(normalizePath));
        if (action.kind === 'relink-many' && selectedPaths.size !== action.replacements.length) {
          throw new Error('Choose each missing file only once.');
        }
        const libraries = await this.refreshMissingSyncReport(context);
        const missingFiles = context.result.files.filter((file) => selectedPaths.has(normalizePath(file.path)));
        if (!missingFiles.length) return context.result;
        if (action.kind === 'search' || action.kind === 'search-many') {
          const picked = await dialog.showOpenDialog(owner, { title: 'Search folder for missing audio', properties: ['openDirectory'] });
          const directory = picked.filePaths[0];
          if (picked.canceled || !directory) return context.result;
          const found = await searchSyncMissingFiles(missingFiles, [directory]);
          const searched = new Map(found.files.map((file) => [normalizePath(file.path), file]));
          context.result = { ...context.result, files: context.result.files.map((file) => searched.get(normalizePath(file.path)) ?? file),
            warnings: [...context.result.warnings, ...found.warnings] };
          return context.result;
        }
        const replacements = new Map<string, string>(action.kind === 'relink-many'
          ? action.replacements.map((replacement) => [normalizePath(replacement.path), replacement.replacementPath])
          : action.kind === 'relink' ? [[normalizePath(action.path), action.replacementPath]] : []);
        if (action.kind === 'locate') {
          const picked = await dialog.showOpenDialog(owner, { title: `Locate ${basename(action.path)}`, defaultPath: dirname(action.path),
            properties: ['openFile'], filters: [{ name: 'Audio files', extensions: ['aac', 'aif', 'aifc', 'aiff', 'flac', 'm4a', 'mp2', 'mp3', 'mp4', 'oga', 'ogg', 'opus', 'wav', 'wma', 'wv'] }] });
          const replacementPath = picked.filePaths[0];
          if (picked.canceled || replacementPath === undefined) return context.result;
          replacements.set(normalizePath(action.path), replacementPath);
        }
        for (const missing of missingFiles) {
          const replacementPath = replacements.get(normalizePath(missing.path)) ?? null;
          if (replacementPath !== null && !isSupportedAudioPath(replacementPath)) {
            context.result = { ...context.result, warnings: [...context.result.warnings, `${missing.path}: Choose a supported audio file.`] };
            continue;
          }
          if (replacementPath !== null) context.result = { ...context.result, files: context.result.files.map((file) => file.path === missing.path
            ? { ...file, candidates: [...new Set([replacementPath, ...file.candidates])] } : file) };
          const repairs = libraries.filter(({ library }) => library.tracks.some((track) => normalizePath(track.path) === normalizePath(missing.path)))
            .sort((left, right) => Number(left.target.kind === 'xml') - Number(right.target.kind === 'xml'));
          for (const { target } of repairs) {
            try {
              const current = target.kind === 'xml' ? rekordboxSyncLibrary(await parseRekordboxXml(target.path)) : await readSeratoLibrary(target);
              if (!current.tracks.some((track) => normalizePath(track.path) === normalizePath(missing.path))) continue;
              const result = target.kind === 'xml' ? await repairRekordboxMissingFile(target.path, missing.path, replacementPath)
                : await repairSeratoMissingFile(target, missing.path, replacementPath);
              repairedPaths.add(normalizePath(target.path));
              context.result = { ...context.result, backupPaths: [...context.result.backupPaths, ...result.backupPaths],
                warnings: [...context.result.warnings, ...result.warnings] };
            } catch (error) {
              context.result = { ...context.result, warnings: [...context.result.warnings,
                `${missing.path} in ${target.path}: ${error instanceof Error ? error.message : 'Could not repair the connected library.'}`] };
            }
          }
        }
        await this.refreshMissingSyncReport(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not resolve the missing file.';
        try { await this.refreshMissingSyncReport(context); } catch { /* Preserve the last report when a library cannot be read. */ }
        context.result = { ...context.result, warnings: [...context.result.warnings, message] };
      }
      if (this.catalog !== null && repairedPaths.has(normalizePath(await resolveSeratoMediaPath(this.catalog.sourcePath)))) {
        try {
          this.catalog = await this.catalogFor(this.catalog.sourcePath, this.catalog.seratoPath);
          this.cancelSuggestions();
        } catch (error) {
          context.result = { ...context.result, warnings: [...context.result.warnings,
            `Arsenal could not refresh its library: ${error instanceof Error ? error.message : 'Could not read the repaired collection.'}`] };
        }
      }
      return context.result;
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

  private enqueue<T>(work: () => Promise<T>, updateBackups = true): Promise<T> {
    const operation = this.operationTail.then(async () => {
      try { return await work(); } finally { if (updateBackups) await this.updateBackups(); }
    });
    this.operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
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
      case 'remove-playlist':
        return this.removePlaylist(catalog, change);
      case 'move-playlist-node':
        return this.movePlaylistNode(catalog, change);
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

  private async removePlaylist(
    catalog: CurrentCatalog,
    change: Extract<LibraryMutation, { kind: 'remove-playlist' }>,
  ): Promise<LibraryMutationResult> {
    if (!catalog.playlists.some((playlist) => playlist.id === change.playlistId)) {
      return { kind: 'rejected', reason: 'invalid-playlist' };
    }
    const reload = await this.writeAndReload(catalog, { kind: 'remove-playlist', playlistId: change.playlistId });
    if (reload.kind === 'rejected') return reload;
    this.cancelSuggestions();
    this.catalog = reload.catalog;
    return { kind: 'playlist-removed', library: summaryFor(reload.catalog) };
  }

  private async movePlaylistNode(
    catalog: CurrentCatalog,
    change: Extract<LibraryMutation, { kind: 'move-playlist-node' }>,
  ): Promise<LibraryMutationResult> {
    const move: PlaylistNodeMove = change;
    const key = (path: readonly string[]): string => JSON.stringify(path);
    const sourceKey = key(move.sourcePath);
    const parentKey = key(move.parentPath);
    const sourceName = move.sourcePath.at(-1);
    if (!sourceName || (move.parentPath.length >= move.sourcePath.length &&
      key(move.parentPath.slice(0, move.sourcePath.length)) === sourceKey) ||
      (move.beforePath !== null && (key(move.beforePath.slice(0, -1)) !== parentKey || key(move.beforePath) === sourceKey))) {
      return { kind: 'rejected', reason: 'invalid-playlist' };
    }
    const validate = (paths: readonly (readonly string[])[], folderPaths: readonly (readonly string[])[]): void => {
      const all = new Set(paths.map(key));
      const folders = new Set(folderPaths.map(key));
      if (!all.has(sourceKey) || (move.parentPath.length > 0 && !folders.has(parentKey)) ||
        (move.beforePath !== null && !all.has(key(move.beforePath))) ||
        paths.some((path) => key(path) !== sourceKey && key(path.slice(0, -1)) === parentKey &&
          path.at(-1)?.toLocaleLowerCase() === sourceName.toLocaleLowerCase())) {
        throw new Error('This move cannot be saved in every connected library. Sync playlists first.');
      }
    };
    const xmlPaths = (parsed: Awaited<ReturnType<typeof parseRekordboxXml>>) => ({
      paths: [...parsed.folders.map((folder) => folder.folderPath),
        ...parsed.playlists.map((playlist) => [...playlist.folderPath, playlist.name])],
      folders: parsed.folders.map((folder) => folder.folderPath),
    });
    const edits: { kind: 'xml'; path: string; fingerprint: string }[] = [];
    const natives: { kind: 'serato'; source: SeratoSource }[] = [];
    try {
      const connections = this.connectedLibraries.length ? this.connectedLibraries : [{
        id: 'current', kind: catalog.sourceKind, path: catalog.seratoPath ?? catalog.sourcePath,
        workspacePath: catalog.sourceKind === 'serato' ? catalog.sourcePath : null, dirty: false,
      } satisfies StoredLibraryConnection];
      for (const connection of connections) {
        if (connection.kind === 'rekordbox') {
          const parsed = await parseRekordboxXml(connection.path);
          const structure = xmlPaths(parsed);
          validate(structure.paths, structure.folders);
          edits.push({ kind: 'xml', path: connection.path, fingerprint: parsed.fingerprint });
        } else {
          await assertSeratoClosed();
          const source = await findSeratoSource(connection.path);
          const native = await readSeratoLibrary(source);
          const paths = native.playlists.map((playlist) => playlist.path);
          const folders = [...native.playlists.filter((playlist) => playlist.kind !== 'smart').map((playlist) => playlist.path),
            ...paths.flatMap((path) => path.slice(0, -1).map((_, index) => path.slice(0, index + 1)))];
          validate([...paths, ...folders], folders);
          natives.push({ kind: 'serato', source });
          if (connection.workspacePath !== null && (connection.dirty || connection.id === this.activeConnectionId || connection.id === 'current')) {
            const parsed = await parseRekordboxXml(connection.workspacePath);
            const structure = xmlPaths(parsed);
            validate(structure.paths, structure.folders);
            edits.push({ kind: 'xml', path: connection.workspacePath, fingerprint: parsed.fingerprint });
          }
        }
      }
    } catch (error) {
      return { kind: 'rejected', reason: error instanceof Error && error.message.includes('Close Serato')
        ? 'serato-open' : 'playlist-sync-needed' };
    }
    let saved = 0;
    let warning: string | undefined;
    const targets = [...edits.sort((left, right) => Number(right.path === catalog.sourcePath) - Number(left.path === catalog.sourcePath)), ...natives];
    for (const target of targets) {
      try {
        if (target.kind === 'xml') await editRekordboxXml({ edit: { kind: 'move-playlist-node', ...move },
          expectedFingerprint: target.fingerprint, filePath: target.path });
        else await moveSeratoNode(target.source, move);
        saved += 1;
      } catch (error) {
        if (saved === 0) return { kind: 'rejected', reason: error instanceof RekordboxWriteError &&
          error.reason === 'source-changed' ? 'source-changed' : error instanceof Error &&
          error.message.includes('Close Serato') ? 'serato-open' : 'cannot-write' };
        warning = `The move reached ${saved} connected library file${saved === 1 ? '' : 's'}, but another save failed. Sync playlists to repair the difference.`;
        break;
      }
    }
    try {
      this.catalog = await this.catalogFor(catalog.sourcePath, catalog.seratoPath);
    } catch {
      return { kind: 'rejected', reason: 'cannot-write' };
    }
    this.cancelSuggestions();
    return { kind: 'playlist-node-moved', library: summaryFor(this.catalog), sourcePath: move.sourcePath,
      destinationPath: [...move.parentPath, sourceName], ...(warning ? { warning } : {}) };
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
      if (catalog.sourceKind === 'serato') {
        const connection = this.connectedLibraries.find((candidate) => candidate.id === this.activeConnectionId);
        if (connection && !connection.dirty) {
          await this.saveConnections({ connections: this.connectedLibraries.map((candidate) => candidate.id === connection.id ? { ...candidate, dirty: true } : candidate) });
        }
      }
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
      sourceName: this.connectedLibraries.find((connection) => connection.path === (seratoPath ?? filePath))?.displayName
        ?? (seratoPath === null ? basename(filePath) : 'Serato library'),
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

    return this.writeRemembered({ rekordboxXmlPath, seratoPath: this.rememberedSeratoPath, ignoredDuplicateGroups, minimumSongLengthSeconds, syncPreferences,
      connections: this.connectedLibraries, activeConnectionId: this.activeConnectionId, sourceOfTruthId: this.sourceOfTruthId, backups: this.backups });
  }

  private async writeRemembered(state: RememberedLibrary): Promise<boolean> {
    if (this.stateFilePath === null) return false;
    const temporary = `${this.stateFilePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, this.stateFilePath);
      return true;
    } catch {
      return false;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
