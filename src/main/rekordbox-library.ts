import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';

import { dialog, shell, type BrowserWindow } from 'electron';
import { DJ_LIBRARY_CHANNELS, ARSENAL_LIBRARY_ID, DEFAULT_SONG_FILTERS, ONGOING_SYNC_REQUEST, readSyncRequest, readOrganizationOperation, songMetadataGapCount } from '../shared/dj-library';
import { sortSongs } from '../shared/library-columns';
import { DEFAULT_MINIMUM_SONG_LENGTH_SECONDS, type LibrarySettings, type SongBackupCleanup } from '../shared/preferences';
import { MUSIC_ORGANIZATION_OPTIONS, readMusicOrganization, type BackupConfiguration, type BackupConnection, type MusicOrganization } from '../shared/library-backup';

import type {
  LibraryOrganizationRequest,
  LibraryOrganizationPreview,
  LibraryOrganizationResult,
  LibraryOrganizationProgress,
  DuplicateGroup,
  DuplicateMatchMode,
  DuplicateScan,
  ImportResult,
  LibraryMutation,
  LibraryMutationResult,
  LibraryStatus,
  LibraryStartupAction,
  LibraryStartupResult,
  LibraryStartupPreview,
  LibrarySummary,
  LibrarySourceKind,
  SeratoVersion,
  LocalFileAction,
  MutationFailure,
  PageRequest,
  PlaylistFolder,
  RekordboxPlaylist,
  SongPage,
  SongRow,
  SongSearchRequest,
  SyncRequest,
  SyncActivity,
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
  type ParsedRekordboxLibrary,
} from './parse-rekordbox-xml';
import {
  TrackArtworkStore,
  type ArtworkAsset,
  isSupportedAudioPath,
} from './track-artwork';
import { assertSeratoClosed, seratoOrganizationFiles, seratoOrganizationSource, validateSeratoOrganizationDestination, findSeratoSource, moveSeratoNode, readSeratoLibrary, repairSeratoMissingFile, repairSeratoMissingFiles, type SeratoSource } from './serato-library';
import { mergeRekordboxXml, pathFromLocation, rekordboxSyncLibrary, repairRekordboxMissingFiles } from './sync-rekordbox-xml';
import { cloudMatcher, isCloudPath } from './cloud-tracks';
import { readSeratoWithPerformance, saveLibraryXml, syncArsenalLibraryToConnection } from './sync-libraries';
import { normalizePath, type PlaylistNodeMove, type SyncLibrary } from './library-sync-model';
import { resolveSeratoLibraryPaths, resolveSeratoMediaPath, seratoMediaPathKey } from './serato-paths';
import { seratoSqliteVersion } from './serato-sqlite';
import { findMissingSyncFiles, searchSyncMissingFiles } from './sync-missing-files';
import { PORTABLE_LIBRARY_FILENAME, readLibraryModel, readPortableLibrary, readPortableLibraryFingerprint, readPortableLibraryFolder, resolvePortableLibrary, writePortableLibrary } from './portable-library';
import { readLibrarySource, type PortableLibrarySource } from './library-source';
import { preparePrimaryLibraryEdit } from './apply-primary-library-edit';
import { loadArsenalLibrary, mergeArsenalLibrary, saveArsenalLibrary } from './arsenal-library';
import { describeLibraryChanges, portableLibraryPreview } from './library-changes';
import { readRekordboxDatabase, repairRekordboxDatabaseFiles } from './rekordbox-database';
import { removeSongBackups } from './serato-tag-io';
import { assertRekordboxClosed, detectRekordboxDatabase, isRekordboxDatabasePath, isRekordboxRunning, RekordboxRunningError } from './rekordbox-database-connection';

import { appendOrganizationJournal, assertOrganizationRestore, clearIncompleteOrganizationDestination, readOrganizationJournal, organizationMoveState, prepareOrganizationRecovery, undoOrganization, writeOrganizationJournal, type OrganizationJournal, type OrganizationRestore } from './organization-journal';
import { createOrganizationDirectory, sameOrganizationFile, organizationFileStamp, installMusicFile, unlinkMusicFile, defaultOrganizationRoot, moveMusicFile, planLibraryOrganization, relocatedLibrary, validateOrganizationPlan, type OrganizationPlan } from './reorganize-library';
import { saveRepairedLibraryFiles, type LibraryFileBackup, type LibraryFilesRepairResult } from './repair-library-files';
import { organizationDestination } from './organization-destination';

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
  origin?: 'portable' | 'arsenal';
  displayName?: string;
  sourceFingerprint?: string;
  sourceSyncFingerprint?: string;
  syncedPlaylistPaths?: readonly (readonly string[])[];
  removedTrackPaths?: readonly string[];
  workspaceFingerprint?: string;
  portableSource?: PortableLibrarySource;
}>;

type LibrarySourceSnapshot = Awaited<ReturnType<typeof readLibrarySource>>;

const organizationManifestHash = (manifest: Awaited<ReturnType<typeof readPortableLibrary>>): string =>
  createHash('sha256').update(JSON.stringify({ ...manifest, savedAt: undefined })).digest('hex');

type StoredLibraryBackup = Readonly<{
  id: string;
  directory: string;
  includeMusic: boolean;
  musicOrganization: MusicOrganization;
  manifestPath: string | null;
  manifestFingerprint: string | null;
  lastSavedAt: string | null;
  fingerprint: string | null;
}>;

type StoredSyncBaseline = Readonly<{
  lastSyncedAt: string;
}>;

type PendingRekordboxSync = Readonly<{
  connectionId: string;
  path: string;
  fingerprint: string;
  request: SyncRequest;
  library?: SyncLibrary;
}>;

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
  syncBaseline: StoredSyncBaseline | null;
  ongoingSyncPause: string | null;
  pendingRekordboxSync: PendingRekordboxSync | null;
}>;

type ReloadResult =
  | Readonly<{ kind: 'ready'; catalog: CurrentCatalog }>
  | Readonly<{ kind: 'rejected'; reason: MutationFailure; message?: string }>;

type MissingSyncTarget = SeratoSource | Readonly<{ kind: 'xml'; path: string; libraryKind: LibrarySourceKind }>
  | Readonly<{ kind: 'rekordbox-database'; path: string }>;

type MissingSyncContext = {
  targets: readonly MissingSyncTarget[];
  paths: ReadonlySet<string>;
  initialFiles: Extract<SyncResult, { kind: 'missing-files' }>['files'];
  knownPaths: Map<string, ReadonlySet<string>>;
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
    const connections: StoredLibraryConnection[] | null = Array.isArray(stored.connections) ? [] : null;
    for (const value of Array.isArray(stored.connections) ? stored.connections : []) {
      if (!isRecord(value) || typeof value.id !== 'string' || (value.kind !== 'rekordbox' && value.kind !== 'serato') ||
        typeof value.path !== 'string' || !isAbsolute(value.path)) continue;
      connections?.push({ id: value.id, kind: value.kind, path: value.path,
        workspacePath: value.kind === 'serato' && typeof value.workspacePath === 'string' && isAbsolute(value.workspacePath) ? value.workspacePath : null,
        dirty: value.kind === 'serato' && value.dirty !== false,
        ...(value.origin === 'portable' || value.origin === 'arsenal' ? { origin: value.origin } : {}),
        ...(typeof value.displayName === 'string' && value.displayName.trim() ? { displayName: value.displayName } : {}),
        ...(typeof value.sourceFingerprint === 'string' ? { sourceFingerprint: value.sourceFingerprint } : {}),
        ...(typeof value.sourceSyncFingerprint === 'string' ? { sourceSyncFingerprint: value.sourceSyncFingerprint } : {}),
        ...(Array.isArray(value.syncedPlaylistPaths) && value.syncedPlaylistPaths.every((path) => Array.isArray(path) && path.every((part) => typeof part === 'string'))
          ? { syncedPlaylistPaths: value.syncedPlaylistPaths } : {}),
        ...(Array.isArray(value.removedTrackPaths) && value.removedTrackPaths.every((path) => typeof path === 'string')
          ? { removedTrackPaths: value.removedTrackPaths } : {}),
        ...(typeof value.workspaceFingerprint === 'string' ? { workspaceFingerprint: value.workspaceFingerprint } : {}),
        ...(value.origin === 'portable' && isRecord(value.portableSource) && typeof value.portableSource.manifestPath === 'string' &&
          isAbsolute(value.portableSource.manifestPath) && Array.isArray(value.portableSource.searchRoots) &&
          value.portableSource.searchRoots.every((root) => typeof root === 'string' && isAbsolute(root))
          ? { portableSource: { manifestPath: value.portableSource.manifestPath, searchRoots: value.portableSource.searchRoots,
              ...(Array.isArray(value.portableSource.resolvedPaths) && value.portableSource.resolvedPaths.every((path) => typeof path === 'string' && isAbsolute(path))
                ? { resolvedPaths: value.portableSource.resolvedPaths } : {}),
              ...(isRecord(value.portableSource.resolvedTrackPaths) ? { resolvedTrackPaths: Object.fromEntries(Object.entries(value.portableSource.resolvedTrackPaths)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && isAbsolute(entry[1]))) } : {}) } } : {}) });
    }
    const backups: StoredLibraryBackup[] = [];
    for (const value of Array.isArray(stored.backups) ? stored.backups : []) {
      if (!isRecord(value) || typeof value.directory !== 'string' || !isAbsolute(value.directory) ||
        typeof value.includeMusic !== 'boolean') continue;
      const directory = value.directory;
      const id = typeof value.id === 'string' && value.id ? value.id
        : `backup-${createHash('sha256').update(normalizePath(directory)).digest('hex')}`;
      if (backups.some((backup) => backup.id === id || normalizePath(backup.directory) === normalizePath(directory))) continue;
      backups.push({ id, directory, includeMusic: value.includeMusic,
        musicOrganization: MUSIC_ORGANIZATION_OPTIONS.find((option) => option.value === value.musicOrganization)?.value ?? 'artist',
        manifestPath: typeof value.manifestPath === 'string' && isAbsolute(value.manifestPath) ? value.manifestPath : null,
        manifestFingerprint: typeof value.manifestFingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.manifestFingerprint) ? value.manifestFingerprint : null,
        lastSavedAt: typeof value.lastSavedAt === 'string' ? value.lastSavedAt : null,
        fingerprint: typeof value.fingerprint === 'string' && value.sourceConnectionId === undefined && value.connectionId === undefined
          ? value.fingerprint : null });
    }
    let pendingRekordboxSync: PendingRekordboxSync | null = null;
    const pending = stored.pendingRekordboxSync;
    if (isRecord(pending) && typeof pending.connectionId === 'string' && typeof pending.path === 'string' && isAbsolute(pending.path) &&
      typeof pending.fingerprint === 'string' && connections?.some((connection) => connection.id === pending.connectionId && connection.path === pending.path)) {
      pendingRekordboxSync = { connectionId: pending.connectionId, path: pending.path, fingerprint: pending.fingerprint,
        request: readSyncRequest(pending.request), ...(pending.library === undefined ? {} : { library: readLibraryModel(pending.library) }) };
    }
    return { rekordboxXmlPath: rememberedPath, seratoPath, ignoredDuplicateGroups, minimumSongLengthSeconds, syncPreferences, connections,
      activeConnectionId: typeof stored.activeConnectionId === 'string' && connections?.some((connection) => connection.id === stored.activeConnectionId) ? stored.activeConnectionId : null,
      sourceOfTruthId: typeof stored.sourceOfTruthId === 'string' && connections?.some((connection) => connection.id === stored.sourceOfTruthId) ? stored.sourceOfTruthId : null,
      backups, syncBaseline: isRecord(stored.syncBaseline) && typeof stored.syncBaseline.lastSyncedAt === 'string'
        ? { lastSyncedAt: stored.syncBaseline.lastSyncedAt } : null,
      ongoingSyncPause: typeof stored.ongoingSyncPause === 'string' ? stored.ongoingSyncPause : null, pendingRekordboxSync };
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
  totalSongCount: catalog.tracks.length,
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

  private arsenalPath = '';

  private arsenalWorkspace = '';

  private arsenalLibrary: SyncLibrary = { tracks: [], playlists: [] };

  private arsenalProjection: ParsedRekordboxLibrary | null = null;

  private stateFilePath: string | null = null;

  private rememberedPath: string | null = null;

  private rememberedSeratoPath: string | null = null;

  private savedSyncPreferences: SyncPreferences = { request: null, rekordboxPath: null, seratoPath: null };

  private missingSyncContext: MissingSyncContext | null = null;

  private connectedLibraries: readonly StoredLibraryConnection[] = [];

  private activeConnectionId: string | null = null;

  private sourceOfTruthId: string | null = null;

  private backups: readonly StoredLibraryBackup[] = [];

  private backupStates = new Map<string, Pick<BackupConnection, 'state' | 'message'>>();

  private backupTimer: ReturnType<typeof setInterval> | null = null;

  private backupPollQueued = false;

  private minimumSongLengthSeconds = DEFAULT_MINIMUM_SONG_LENGTH_SECONDS;

  private ignoredDuplicateGroups: RememberedLibrary['ignoredDuplicateGroups'] = {};

  private operationTail: Promise<void> = Promise.resolve();

  private suggestionController: AbortController | null = null;

  private startupChanges = new Set<string>();

  private startupBackupChanges = new Set<string>();

  private startupWarnings: string[] = [];

  private startupUnreadable = new Set<string>();

  private startupCheck: Promise<LibraryStartupResult> | null = null;

  private startupPreview: Promise<LibraryStartupPreview> | null = null;

  private startupSources = new Map<string, LibrarySourceSnapshot>();

  private startupComplete = false;

  private syncBaseline: StoredSyncBaseline | null = null;

  private ongoingSyncPause: string | null = null;

  private pendingRekordboxSync: PendingRekordboxSync | null = null;

  private nativeSyncTimer: ReturnType<typeof setInterval> | null = null;

  private currentSyncActivity: SyncActivity = { state: 'off', lastSyncedAt: null, result: null };

  private ongoingCheckQueued = false;

  private backgroundStopped = false;

  onSyncActivity: ((activity: SyncActivity) => void) | null = null;

  async initialize(stateFilePath: string): Promise<void> {
    this.stateFilePath = stateFilePath;
    this.organizationRecovery = await readOrganizationJournal(this.organizationJournalPath);
    const directory = join(dirname(stateFilePath), 'libraries');
    await mkdir(directory, { recursive: true });
    this.arsenalPath = join(directory, 'arsenal.json');
    this.arsenalWorkspace = join(directory, 'arsenal.xml');
    const owned = await loadArsenalLibrary(this.arsenalPath);
    const remembered = await readRememberedLibrary(stateFilePath);
    this.savedSyncPreferences = remembered?.syncPreferences ?? { request: null, rekordboxPath: null, seratoPath: null };
    this.syncBaseline = remembered?.syncBaseline ?? null;
    this.ongoingSyncPause = remembered?.ongoingSyncPause ?? null;
    this.pendingRekordboxSync = remembered?.pendingRekordboxSync ?? null;
    this.ignoredDuplicateGroups = remembered?.ignoredDuplicateGroups ?? {};
    this.minimumSongLengthSeconds = remembered?.minimumSongLengthSeconds ?? DEFAULT_MINIMUM_SONG_LENGTH_SECONDS;
    this.connectedLibraries = (remembered?.connections ?? []).filter((connection) => connection.id !== ARSENAL_LIBRARY_ID);
    this.backups = remembered?.backups ?? [];
    if (this.connectedLibraries.some((connection) => connection.origin === undefined) && this.savedSyncPreferences.request?.cadence !== 'ongoing') {
      this.savedSyncPreferences = { ...this.savedSyncPreferences, request: { ...ONGOING_SYNC_REQUEST, timingOffsetMs: this.savedSyncPreferences.request?.timingOffsetMs ?? 0 } };
    }
    if (remembered?.connections === null) {
      const paths = [
        { kind: 'rekordbox' as const, path: remembered.syncPreferences.rekordboxPath ?? (remembered.seratoPath === null ? remembered.rekordboxXmlPath : null) },
        { kind: 'serato' as const, path: remembered.syncPreferences.seratoPath ?? remembered.seratoPath },
      ];
      this.connectedLibraries = paths.flatMap(({ kind, path }) => path === null ? [] : [{ id: randomUUID(), kind, path,
        workspacePath: kind === 'serato' ? remembered.rekordboxXmlPath : null, dirty: kind === 'serato' }]);
    }
    if (owned !== null) this.arsenalLibrary = owned;
    else {
      const previous = this.connectedLibraries.find((connection) => connection.id === remembered?.sourceOfTruthId)
        ?? this.connectedLibraries.find((connection) => connection.id === remembered?.activeConnectionId) ?? this.connectedLibraries[0];
      if (previous) {
        try { this.arsenalLibrary = (await this.backupLibrary(previous)).library; }
        catch (error) { throw new Error(`Could not migrate your library into Arsenal. Existing files were kept. ${error instanceof Error ? error.message : ''}`); }
      }
      await saveArsenalLibrary(this.arsenalPath, this.arsenalLibrary);
    }
    if (this.organizationRecovery === null) await this.writeArsenalProjection();
    else this.arsenalProjection = await parseRekordboxXml(this.arsenalWorkspace);
    this.connectedLibraries = [{ id: ARSENAL_LIBRARY_ID, kind: 'rekordbox', origin: 'arsenal', displayName: 'Arsenal library',
      path: this.arsenalWorkspace, workspacePath: null, dirty: false }, ...this.connectedLibraries];
    this.activeConnectionId = ARSENAL_LIBRARY_ID;
    this.sourceOfTruthId = ARSENAL_LIBRARY_ID;
    this.rememberedPath = this.arsenalWorkspace;
    this.rememberedSeratoPath = null;
    this.catalog = await this.catalogFor(this.arsenalWorkspace, null, this.arsenalProjection);
    if (this.savedSyncPreferences.rekordboxPath === this.arsenalWorkspace) {
      this.savedSyncPreferences = { ...this.savedSyncPreferences, rekordboxPath: null };
    }
    for (const connection of this.connectedLibraries) {
      if (connection.origin === 'arsenal') continue;
      try {
        const source = await readLibrarySource(connection);
        if (connection.sourceFingerprint === undefined) {
          const updated = await this.acceptedSource(connection, source);
          this.connectedLibraries = this.connectedLibraries.map((candidate) => candidate.id === connection.id ? updated : candidate);
        } else if (connection.sourceFingerprint !== source.fingerprint && !(this.pendingRekordboxSync?.connectionId === connection.id &&
          this.pendingRekordboxSync.fingerprint === source.syncFingerprint)) {
          // DJ apps rewrite their files on launch, so only content edits since the last accepted snapshot need a review.
          const changes = source.syncFingerprint === connection.sourceSyncFingerprint ? [] : await this.sourceChanges(connection, source);
          if (changes === null || changes.length) {
            this.startupChanges.add(connection.id);
            this.startupSources.set(connection.id, source);
          } else {
            const updated = await this.acceptedSource(connection, source);
            this.connectedLibraries = this.connectedLibraries.map((candidate) => candidate.id === connection.id ? updated : candidate);
          }
        }
      } catch (error) {
        this.startupUnreadable.add(connection.id);
        this.startupWarnings.push(`${connection.displayName ?? basename(connection.path)}: ${error instanceof Error ? error.message : 'Could not check this connection.'}`);
      }
    }
    for (const backup of this.backups) {
      try {
        const current = await readPortableLibraryFingerprint(join(backup.directory, PORTABLE_LIBRARY_FILENAME));
        if (current !== null && current !== backup.manifestFingerprint) {
          this.startupBackupChanges.add(backup.id);
          this.backupStates.set(backup.id, { state: 'error', message: 'This library file changed since the last backup. Review its changes when Arsenal opens.' });
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          const message = error instanceof Error ? error.message : 'Could not check this backup file.';
          this.startupWarnings.push(`${backup.directory}: ${message}`);
          this.backupStates.set(backup.id, { state: 'error', message });
        }
      }
    }
    if (!await this.remember(this.rememberedPath)) throw new Error('Could not save Arsenal library settings.');
    this.currentSyncActivity = { state: this.pendingRekordboxSync !== null ? this.ongoingSyncPause === null ? 'waiting' : 'attention'
      : this.savedSyncPreferences.request?.cadence !== 'ongoing' ? 'off'
      : this.ongoingSyncPause === null ? 'watching' : 'attention', lastSyncedAt: this.syncBaseline?.lastSyncedAt ?? null,
      result: this.ongoingSyncPause !== null ? { kind: 'rejected', message: this.ongoingSyncPause, warnings: [], backupPaths: [] }
        : this.pendingRekordboxSync !== null ? { kind: 'queued', message: 'Saved in Arsenal. Waiting for Rekordbox to close before updating Collection.', warnings: [], backupPaths: [] } : null };
    this.disposeBackups();
    this.backgroundStopped = false;
    this.backupTimer = setInterval(() => {
      if (this.startupComplete) this.requestBackup();
    }, 30_000);
    this.backupTimer.unref();
    this.nativeSyncTimer = setInterval(() => this.requestPendingRekordboxSync(), 2000);
    this.nativeSyncTimer.unref();
  }

  private async writeArsenalProjection(xml = mergeRekordboxXml(this.arsenalLibrary)): Promise<void> {
    let previous: string | null = null;
    try { previous = await readFile(this.arsenalWorkspace, 'utf8'); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await saveLibraryXml(this.arsenalWorkspace, xml, previous, false);
    this.arsenalProjection = await parseRekordboxXml(this.arsenalWorkspace);
  }

  private async saveArsenalState(library: SyncLibrary): Promise<CurrentCatalog> {
    const previous = this.arsenalLibrary;
    const projection = this.arsenalProjection;
    try {
      const xml = mergeRekordboxXml(library);
      await saveArsenalLibrary(this.arsenalPath, library);
      this.arsenalLibrary = library;
      await this.writeArsenalProjection(xml);
      return await this.catalogFor(this.arsenalWorkspace, null, this.arsenalProjection);
    } catch (error) {
      if (this.arsenalLibrary !== previous) {
        await saveArsenalLibrary(this.arsenalPath, previous);
        this.arsenalLibrary = previous;
      }
      this.arsenalProjection = projection;
      await this.writeArsenalProjection().catch(() => undefined);
      throw error;
    }
  }

  private async commitArsenalProjection(edit?: RekordboxXmlEdit): Promise<CurrentCatalog> {
    const before = this.arsenalProjection;
    if (before === null) throw new Error('The Arsenal library is not initialized.');
    const parsed = await parseRekordboxXml(this.arsenalWorkspace);
    const projected = rekordboxSyncLibrary(parsed, { includeNonLocal: true });
    const originals = new Map(before.tracks.map((track, index) => [track.rekordboxId, this.arsenalLibrary.tracks[index]]));
    const oldLocations = new Map(before.tracks.map((track) => [track.rekordboxId, track.rawLocation]));
    const paths = new Map<string, string>();
    const replacements = new Map<string, string>();
    const tracks = parsed.tracks.map((track, index) => {
      const original = originals.get(track.rekordboxId);
      const current = projected.tracks[index];
      if (!original || !current) throw new Error('The Arsenal library projection changed unexpectedly.');
      const location = current.location ?? current.path;
      const repaired = oldLocations.get(track.rekordboxId) !== track.rawLocation;
      const path = repaired && original.location === undefined ? location : original.path;
      paths.set(current.path, path);
      replacements.set(original.path, path);
      return repaired ? { ...original, path, ...(original.location === undefined ? {} : { location }) } : original;
    });
    const movedPath = (path: readonly string[]) => edit?.kind === 'move-playlist-node' &&
      edit.sourcePath.every((part, index) => path[index] === part)
      ? [...edit.parentPath, ...path.slice(edit.sourcePath.length - 1)] : path;
    const originalsByPath = new Map(this.arsenalLibrary.playlists.map((playlist) => [JSON.stringify(movedPath(playlist.path)), playlist]));
    const changed = edit?.kind === 'set-playlist-tracks' || edit?.kind === 'update-smart-playlist'
      ? before.playlists.find((playlist) => playlist.id === edit.playlistId) : undefined;
    const changedPath = changed ? JSON.stringify([...changed.folderPath,
      edit?.kind === 'update-smart-playlist' ? edit.name : changed.name]) : null;
    const library: SyncLibrary = { tracks, playlists: projected.playlists.map((playlist) => {
      const key = JSON.stringify(playlist.path);
      const original = originalsByPath.get(key);
      if (original && key !== changedPath) return { ...original, path: playlist.path,
        trackPaths: original.trackPaths.flatMap((path) => replacements.get(path) ?? []) };
      return { ...playlist, trackPaths: playlist.trackPaths.map((path) => paths.get(path) ?? path) };
    }) };
    return this.saveArsenalState(library);
  }

  private async importIntoArsenal(incoming: SyncLibrary): Promise<void> {
    const library = mergeArsenalLibrary(this.arsenalLibrary, incoming);
    this.catalog = await this.saveArsenalState(library);
  }

  checkStartupChanges(): Promise<LibraryStartupPreview> {
    if (this.organizationRecovery !== null) return Promise.resolve({ libraries: [], syncAfterImport: false, warnings: [],
      organizationRecovery: { journalPath: this.organizationJournalPath, moveCount: this.organizationRecovery.moves.length,
        operation: this.organizationRecovery.operation ?? { kind: 'move' } } });
    if (this.startupComplete) return Promise.resolve({ libraries: [], syncAfterImport: false, warnings: [] });
    this.startupPreview ??= this.enqueue(async () => {
      const libraries: LibraryStartupPreview['libraries'][number][] = [];
      for (const connection of this.connectedLibraries) {
        if (!this.startupChanges.has(connection.id)) continue;
        const name = connection.portableSource ? 'Portable library' : connection.kind === 'rekordbox' ? 'Rekordbox' : 'Serato';
        try {
          const source = this.startupSources.get(connection.id) ?? await readLibrarySource(connection);
          this.startupSources.set(connection.id, source);
          const incoming = source.library ?? (source.portableManifestPath === null ? null
            : portableLibraryPreview(this.arsenalLibrary, await readPortableLibrary(source.portableManifestPath)));
          libraries.push({ id: connection.id, name, changes: incoming === null
            ? ['Library changes are ready to import.'] : await this.sourceChanges(connection, source)
              ?? describeLibraryChanges(this.arsenalLibrary, mergeArsenalLibrary(this.arsenalLibrary, incoming)) });
        } catch {
          libraries.push({ id: connection.id, name, changes: ['Changes could not be read. Try importing again once the library is available.'] });
        }
      }
      for (const backup of this.backups) {
        if (!this.startupBackupChanges.has(backup.id)) continue;
        try {
          const manifest = await readPortableLibrary(join(backup.directory, PORTABLE_LIBRARY_FILENAME));
          const incoming = portableLibraryPreview(this.arsenalLibrary, manifest);
          const importedById = new Map(manifest.tracks.map((track, index) => [track.id, incoming.tracks[index]]));
          const local = { ...this.arsenalLibrary, tracks: this.arsenalLibrary.tracks.map((track) =>
            importedById.get(`track-${createHash('sha256').update(normalizePath(track.path)).digest('hex')}`) ?? track) };
          libraries.push({ id: backup.id, name: 'Arsenal backup',
            changes: describeLibraryChanges(this.arsenalLibrary, mergeArsenalLibrary(local, incoming)) });
        } catch {
          libraries.push({ id: backup.id, name: 'Arsenal backup', changes: ['Changes could not be read. Try importing again once the backup is available.'] });
        }
      }
      const targets = this.selectedSyncConnections();
      return { libraries, warnings: this.startupWarnings,
        syncAfterImport: targets.length > 0 && !targets.some((connection) => this.startupUnreadable.has(connection.id)) };
    }, false);
    return this.startupPreview;
  }

  resolveStartupChanges(owner: BrowserWindow, action: LibraryStartupAction): Promise<LibraryStartupResult> {
    if (action === 'undo-reorganization' || action === 'keep-reorganization') return this.enqueue(async () => {
      const journal = this.organizationRecovery;
      if (journal === null) throw new Error('There is no unfinished reorganization.');
      const copy = journal.operation?.kind === 'copy';
      const relink = journal.operation?.kind !== 'copy' || journal.operation.useCopies;
      const warnings: string[] = [];
      try {
        const persisted = await loadArsenalLibrary(this.arsenalPath);
        if (persisted === null) throw new Error('The saved Arsenal library is unavailable. Keep the journal and retry recovery.');
        this.arsenalLibrary = persisted;
        const replacements = new Map<string, string>();
        if (action === 'undo-reorganization') {
          warnings.push(...await undoOrganization(journal, undefined, (move) => appendOrganizationJournal(this.organizationJournalPath, { moves: [move], restores: [], createdDirectories: [] })));
          for (const move of journal.moves) replacements.set(normalizePath(move.to), move.from);
          this.arsenalLibrary = await loadArsenalLibrary(this.arsenalPath) ?? this.arsenalLibrary;
        } else {
          await prepareOrganizationRecovery(journal);
          const locations = new Map<string, string>();
          for (const move of journal.moves) await organizationMoveState(move, copy);
          for (const move of journal.moves) {
            if (!copy) await clearIncompleteOrganizationDestination(move);
            let state = await organizationMoveState(move, copy);
            if (!copy && !state.to && !state.from && state.temporary) {
              if (state.fromStamp !== null && !await sameOrganizationFile(move.from, move.temporary)) await unlinkMusicFile(move.from);
              await rm(join(dirname(move.from), `${basename(move.temporary)}.undo`), { force: true });
              await installMusicFile(move.temporary, move.from, {
                onCopy: async (sha256) => { move.sha256 = sha256; await appendOrganizationJournal(this.organizationJournalPath, { moves: [move], restores: [], createdDirectories: [] }); },
                onDestination: async (stamp, installed) => { move.rollbackInstalled = installed; move.rollbackStamp = stamp; await appendOrganizationJournal(this.organizationJournalPath, { moves: [move], restores: [], createdDirectories: [] }); },
              });
              state = await organizationMoveState(move);
            }
            if (!state.to && !state.from) throw new Error(`The audio is unavailable: ${move.from}, ${move.to}`);
            locations.set(move.to, state.to ? move.to : move.from);
          }
          for (const [from, to] of journal.replacements ?? journal.moves.map((move) => [normalizePath(move.from), move.to] as const)) {
            const location = locations.get(to);
            if (location !== undefined && location === to) replacements.set(from, location);
          }
          for (const move of journal.moves) {
            const location = locations.get(move.to);
            if (location !== undefined) replacements.set(normalizePath(move.to), location);
          }
          if (relink) {
            if (copy) for (const move of journal.moves) if (replacements.get(normalizePath(move.to)) === move.to && await organizationDestination(dirname(move.to)) !== 'internal') {
              throw new Error('Copied files can only replace the active library on a verified internal drive.');
            }
            const targets = await this.organizationTargets(owner, journal, replacements);
            await this.assertOrganizationClosed(targets);
            warnings.push(...await this.relinkOrganization(owner, targets, replacements, journal, true));
          }
          for (const move of journal.moves) {
            let state = await organizationMoveState(move, copy);
            if (copy && state.to) continue;
            if (state.to && state.fromStamp !== null && move.from !== move.to) {
              if (await sameOrganizationFile(move.from, move.to)) {
                await moveMusicFile(move.from, move.to, move.temporary, {
                  onCopy: async (sha256) => { move.sha256 = sha256; await appendOrganizationJournal(this.organizationJournalPath, { moves: [move], restores: [], createdDirectories: [] }); },
                  onDestination: async (stamp, installed) => { move.installed = installed; move.destinationStamp = stamp; await appendOrganizationJournal(this.organizationJournalPath, { moves: [move], restores: [], createdDirectories: [] }); },
                });
                state = await organizationMoveState(move);
              } else await unlinkMusicFile(move.from);
            } else if (!state.to && state.toStamp !== null) {
              if (state.destinationOwned && !await sameOrganizationFile(move.from, move.to)) await unlinkMusicFile(move.to);
              else warnings.push(`Kept an unverified file at the interrupted destination: ${move.to}`);
            }
            if (state.temporaryStamp !== null) await unlinkMusicFile(move.temporary);
            await rm(`${move.temporary}.copy`, { force: true });
            await rm(join(dirname(move.from), `${basename(move.temporary)}.undo`), { force: true });
          }
        }
        for (const move of journal.moves) {
          const state = await organizationMoveState(move, copy && action === 'keep-reorganization');
          const original = action === 'undo-reorganization' || replacements.get(normalizePath(move.to)) === move.from;
          if (original ? !state.from : !state.to) {
            throw new Error(`The audio is unavailable at its recovered location: ${move.from}, ${move.to}`);
          }
        }
        if (relink) warnings.push(...await this.finishOrganization(replacements, journal));
      } catch (error) { throw new Error(this.organizationError(error)); }
      await rm(this.organizationJournalPath);
      this.organizationRecovery = null;
      this.startupPreview = null;
      this.startupCheck = null;
      this.startupSources.clear();
      return { connections: null, status: this.status(), warnings, syncResult: null,
        message: action === 'undo-reorganization' ? copy ? 'Copy undone. Original files kept.' : 'Reorganization undone.'
          : copy && !relink ? 'Completed copies kept. Arsenal and DJ apps still use the original files.' : 'Current file locations kept. Library backups remain available.' };
    }, false).then(async (result) => ({ ...result, connections: await this.connections() }));
    if (this.organizationRecovery !== null) return Promise.reject(new Error('Undo or keep the unfinished reorganization first.'));
    this.startupCheck ??= this.importStartupChanges(owner, action).then((result) => {
      this.startupComplete = true;
      this.startupWarnings = [];
      this.startupSources.clear();
      this.requestPendingRekordboxSync();
      return result;
    }).catch((error: unknown) => {
      this.startupCheck = null;
      throw error;
    });
    return this.startupCheck;
  }

  private async importStartupChanges(owner: BrowserWindow, action: 'import' | 'skip'): Promise<LibraryStartupResult> {
    const warnings = [...this.startupWarnings];
    let imported = 0;
    const request = await this.enqueue(async (): Promise<SyncRequest | null> => {
      if (action === 'skip') return null;
      const changed = this.connectedLibraries.filter((connection) => this.startupChanges.has(connection.id));
      const changedBackups = this.backups.filter((backup) => this.startupBackupChanges.has(backup.id));
      const changedCount = changed.length + changedBackups.length;
      if (!changedCount) return null;
      const preferences = this.syncPreferences();
      const targets = this.selectedSyncConnections();
      const unreadableSync = targets.some((connection) => this.startupUnreadable.has(connection.id));
      const savedRequest = !unreadableSync && targets.length ? preferences.request : null;
      if (unreadableSync) warnings.push('Automatic sync was skipped because a selected sync library could not be checked.');
      let failed = false;
      for (const connection of changed) {
        try {
          let source = await readLibrarySource(connection);
          const localPath = connection.kind === 'serato' ? connection.workspacePath : connection.portableSource ? connection.path : null;
          const local = localPath === null ? null : await parseRekordboxXml(localPath);
          const conflict = connection.kind === 'serato' && connection.dirty ||
            connection.portableSource !== undefined && local !== null && connection.workspaceFingerprint !== undefined && local.fingerprint !== connection.workspaceFingerprint;
          let importing = connection;
          if (conflict) {
            const choice = await dialog.showMessageBox(owner, {
              type: 'warning', title: 'Local library edits conflict',
              message: `${connection.displayName ?? basename(connection.path)} has unsynced Arsenal edits.`,
              detail: 'Importing the external version will replace these local edits. Arsenal will save a backup of the local library first.',
              buttons: ['Keep local edits', 'Import external version'], defaultId: 0, cancelId: 0,
            });
            if (choice.response !== 1) {
              failed = true;
              warnings.push(`${connection.displayName ?? basename(connection.path)}: Local edits were kept. External changes remain available for the next session.`);
              continue;
            }
            if (localPath === null || local === null) throw new Error('The local library could not be read for backup.');
            source = await readLibrarySource(connection);
            importing = { ...connection, dirty: false, workspaceFingerprint: local.fingerprint };
          }
          const prepared = await this.prepareConnection(importing, source, conflict);
          const accepted = prepared.connection;
          await this.saveConnections({ connections: this.connectedLibraries.map((candidate) => candidate.id === connection.id ? accepted : candidate),
            catalog: prepared.catalog, library: prepared.library });
          this.startupChanges.delete(connection.id);
          imported += 1;
          warnings.push(...prepared.warnings);
        } catch (error) {
          failed = true;
          warnings.push(`${connection.displayName ?? basename(connection.path)}: ${error instanceof Error ? error.message : 'Could not import changes.'}`);
        }
      }
      for (const backup of changedBackups) {
        try {
          const manifestPath = join(backup.directory, PORTABLE_LIBRARY_FILENAME);
          const manifestFingerprint = await readPortableLibraryFingerprint(manifestPath);
          const manifest = await readPortableLibrary(manifestPath);
          if (this.stateFilePath === null) throw new Error('Library settings are not initialized.');
          const resolved = await resolvePortableLibrary(manifest, manifestPath, [],
            join(dirname(this.stateFilePath ?? this.arsenalPath), 'libraries', 'media', `backup-${backup.id}`));
          if (await readPortableLibraryFingerprint(manifestPath) !== manifestFingerprint) throw new Error('The library file changed during import. Wait for your cloud app to finish syncing and retry.');
          if (resolved.missingFiles.length) throw new Error('Some music files have not arrived. Wait for the Music folder to finish syncing, or open the library file to locate your music.');
          const existing = new Map(this.arsenalLibrary.tracks.map((track) =>
            [`track-${createHash('sha256').update(normalizePath(track.path)).digest('hex')}`, track]));
          const references = new Map<string, string>();
          const replacements = new Map<string, SyncLibrary['tracks'][number]>();
          const importedTracks = resolved.library.tracks.map((track) => {
            const previous = existing.get(track.song.id);
            if (!previous) return track;
            references.set(track.path, previous.path);
            const replacement = { ...track, path: previous.path, location: track.location ?? track.path,
              song: { ...track.song, id: previous.song.id } };
            replacements.set(previous.path, replacement);
            return replacement;
          });
          const local = { ...this.arsenalLibrary, tracks: this.arsenalLibrary.tracks.map((track) => replacements.get(track.path) ?? track) };
          const incoming = { tracks: importedTracks, playlists: resolved.library.playlists.map((playlist) => ({ ...playlist,
            trackPaths: playlist.trackPaths.map((path) => references.get(path) ?? path) })) };
          this.catalog = await this.saveArsenalState(mergeArsenalLibrary(local, incoming));
          const previous = this.backups;
          this.backups = previous.map((candidate) => candidate.id === backup.id ? { ...backup, manifestPath,
            manifestFingerprint, fingerprint: null, lastSavedAt: manifest.savedAt } : candidate);
          if (!await this.remember(this.rememberedPath)) {
            this.backups = previous;
            throw new Error('Imported the library, but could not save the folder status.');
          }
          this.startupBackupChanges.delete(backup.id);
          warnings.push(...resolved.warnings);
          imported += 1;
        } catch (error) {
          failed = true;
          warnings.push(`${backup.directory}: ${error instanceof Error ? error.message : 'Could not import changes.'}`);
        }
      }
      this.cancelSuggestions();
      if (failed && savedRequest !== null) warnings.push('Automatic sync was skipped because some changed libraries could not be imported.');
      return failed ? null : savedRequest;
    }, false);
    const syncResult = request === null ? null : await this.syncLibraries(owner, request);
    if (imported > 0 && request === null) this.requestBackup();
    return { connections: await this.connections(), status: this.status(), warnings, syncResult,
      message: imported ? `Imported changes from ${imported} ${imported === 1 ? 'library' : 'libraries'}.` : null };
  }

  private sourceSnapshotPath(id: string): string {
    return join(dirname(this.arsenalPath), `source-${id}.json`);
  }

  // Changes in a source since Arsenal last accepted it, or null when no snapshot was saved yet.
  private async sourceChanges(connection: StoredLibraryConnection, source: LibrarySourceSnapshot): Promise<readonly string[] | null> {
    if (source.library === null) return null;
    let snapshot: SyncLibrary;
    try { snapshot = JSON.parse(await readFile(this.sourceSnapshotPath(connection.id), 'utf8')) as SyncLibrary; } catch { return null; }
    return describeLibraryChanges(snapshot, source.library);
  }

  private async acceptedSource(connection: StoredLibraryConnection, source: LibrarySourceSnapshot,
    expectedManifest?: Awaited<ReturnType<typeof readPortableLibrary>>): Promise<StoredLibraryConnection> {
    if (!connection.portableSource) {
      if (source.library !== null) await writeFile(this.sourceSnapshotPath(connection.id), JSON.stringify(source.library));
      return { ...connection, sourceFingerprint: source.fingerprint, sourceSyncFingerprint: source.syncFingerprint };
    }
    const portableSource = { ...connection.portableSource, manifestPath: source.portableManifestPath ?? connection.portableSource.manifestPath };
    if (expectedManifest !== undefined && JSON.stringify(await readPortableLibrary(portableSource.manifestPath)) !== JSON.stringify(expectedManifest)) {
      throw new Error('The portable library changed during import. Try again after the cloud folder finishes syncing.');
    }
    const accepted = await readLibrarySource({ ...connection, portableSource, followLatest: false });
    if (expectedManifest !== undefined && JSON.stringify(await readPortableLibrary(portableSource.manifestPath)) !== JSON.stringify(expectedManifest)) {
      throw new Error('The portable library changed during import. Try again after the cloud folder finishes syncing.');
    }
    return { ...connection, sourceFingerprint: accepted.fingerprint, portableSource,
      workspaceFingerprint: (await parseRekordboxXml(connection.path)).fingerprint };
  }

  private async acknowledgeWrites(ids: readonly string[], acceptPending = false): Promise<void> {
    const changed = new Set(ids);
    let updated = false;
    const connections: StoredLibraryConnection[] = [];
    for (const connection of this.connectedLibraries) {
      if (connection.origin === 'arsenal' || !changed.has(connection.id) || !acceptPending && this.startupChanges.has(connection.id) || connection.portableSource) {
        connections.push(connection);
        continue;
      }
      try {
        connections.push(await this.acceptedSource(connection, await readLibrarySource(connection)));
        updated = true;
      } catch {
        connections.push(connection);
      }
    }
    if (updated) await this.saveConnections({ connections });
  }

  status(): LibraryStatus {
    return this.catalog === null
      ? { kind: 'empty' }
      : { kind: 'ready', library: summaryFor(this.catalog) };
  }

  backupStatus(): readonly BackupConnection[] {
    return this.backups.map((backup) => this.backupConnection(backup));
  }

  private backupConnection(backup: StoredLibraryBackup): BackupConnection {
    const primaryConnected = this.catalog !== null;
    return {
      id: backup.id, directory: backup.directory,
      manifestPath: backup.manifestPath, includeMusic: backup.includeMusic, musicOrganization: backup.musicOrganization,
      state: 'ready', lastSavedAt: backup.lastSavedAt, message: null,
      ...this.backupStates.get(backup.id),
      ...(!primaryConnected ? { state: 'error', message: 'Connect or open your Arsenal library to resume automatic backups. Existing backups are kept.' } satisfies Pick<BackupConnection, 'state' | 'message'> : {}),
    };
  }

  configureBackup(owner: BrowserWindow, request: BackupConfiguration): Promise<BackupConnection | null> {
    return this.enqueue(async () => {
      const musicOrganization = readMusicOrganization(request.musicOrganization);
      if (this.catalog === null) {
        throw new Error('Connect or open your Arsenal library before connecting a backup folder.');
      }
      let backup: StoredLibraryBackup;
      if (request.kind === 'update') {
        const current = this.backups.find((candidate) => candidate.id === request.id);
        if (!current) throw new Error('This folder is no longer connected.');
        backup = { ...current, includeMusic: request.includeMusic, musicOrganization, fingerprint: null };
      } else {
        const chosen = await dialog.showOpenDialog(owner, {
          title: 'Connect a backup folder', buttonLabel: 'Connect folder', properties: ['openDirectory', 'createDirectory'],
        });
        const selected = chosen.filePaths[0];
        if (chosen.canceled || !selected) return null;
        const directory = await resolveSeratoMediaPath(selected);
        for (const existing of this.backups) {
          if (normalizePath(await resolveSeratoMediaPath(existing.directory)) === normalizePath(directory)) {
            throw new Error('This backup folder is already connected. Change its settings on the existing connection.');
          }
        }
        try {
          await stat(join(directory, PORTABLE_LIBRARY_FILENAME));
          throw new Error('This folder already contains an Arsenal library. Open its library file to import it, or choose another backup folder.');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        const id = randomUUID();
        backup = { id, directory, includeMusic: request.includeMusic, musicOrganization,
          manifestPath: null, manifestFingerprint: null, lastSavedAt: null, fingerprint: null };
      }
      const previous = this.backups;
      this.backups = request.kind === 'update' ? previous.map((candidate) => candidate.id === backup.id ? backup : candidate) : [...previous, backup];
      if (!await this.remember(this.rememberedPath)) {
        this.backups = previous;
        throw new Error('Could not save backup settings. Check disk space and permissions.');
      }
      await this.saveBackup(backup, true);
      return this.backupConnection(this.backups.find((candidate) => candidate.id === backup.id) ?? backup);
    }, false);
  }

  backupNow(id: string): Promise<BackupConnection> {
    return this.enqueue(async () => {
      const backup = this.backups.find((candidate) => candidate.id === id);
      if (!backup) throw new Error('This folder is no longer connected.');
      await this.saveBackup(backup, true);
      return this.backupConnection(this.backups.find((candidate) => candidate.id === id) ?? backup);
    }, false);
  }

  stopBackup(id: string): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.backups;
      this.backups = previous.filter((backup) => backup.id !== id);
      if (!await this.remember(this.rememberedPath)) {
        this.backups = previous;
        throw new Error('Could not save backup settings.');
      }
      this.backupStates.delete(id);
    });
  }

  disposeBackups(): void {
    if (this.backupTimer !== null) clearInterval(this.backupTimer);
    this.backupTimer = null;
    if (this.nativeSyncTimer !== null) clearInterval(this.nativeSyncTimer);
    this.nativeSyncTimer = null;
    this.backgroundStopped = true;
  }

  async whenIdle(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.operationTail;
      await pending;
    } while (pending !== this.operationTail);
  }

  importBackup(owner: BrowserWindow, mode: 'folder' | 'snapshot' = 'folder'): Promise<LibraryConnectionResult> {
    return this.enqueue(async () => {
      let workspacePath: string | null = null;
      let mediaDirectory: string | null = null;
      try {
        const chosen = await dialog.showOpenDialog(owner, mode === 'snapshot'
          ? { title: 'Open an Arsenal library file', buttonLabel: 'Open library', properties: ['openFile'],
              filters: [{ name: 'Arsenal library', extensions: ['json'] }] }
          : { title: 'Open an Arsenal library folder', buttonLabel: 'Open library', properties: ['openDirectory'] });
        const selectedPath = chosen.filePaths[0];
        if (chosen.canceled || !selectedPath) return { kind: 'cancelled' };
        const { manifest, manifestPath } = mode === 'folder' ? await readPortableLibraryFolder(selectedPath)
          : { manifest: await readPortableLibrary(selectedPath), manifestPath: selectedPath };
        if (this.stateFilePath === null) throw new Error('Library settings are not initialized.');
        const directory = join(dirname(this.stateFilePath ?? this.arsenalPath), 'libraries');
        await mkdir(directory, { recursive: true });
        const connectionId = randomUUID();
        mediaDirectory = join(directory, 'media', connectionId);
        const searchRoots: string[] = [];
        let resolved = await resolvePortableLibrary(manifest, manifestPath, searchRoots, mediaDirectory);
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
          resolved = await resolvePortableLibrary(manifest, manifestPath, searchRoots, mediaDirectory);
        }
        workspacePath = join(directory, `imported-${connectionId}.xml`);
        await saveLibraryXml(workspacePath, mergeRekordboxXml(resolved.library), null, false);
        const pending: StoredLibraryConnection = { id: connectionId, kind: 'rekordbox', path: workspacePath,
          workspacePath: null, dirty: false, origin: 'portable', displayName: manifest.name,
          portableSource: { manifestPath, searchRoots, resolvedPaths: resolved.library.tracks.filter((track) => track.song.source === 'local')
            .map((track) => track.location ?? track.path).filter(isAbsolute),
            resolvedTrackPaths: Object.fromEntries(resolved.library.tracks.filter((track) => track.song.source === 'local' && isAbsolute(track.location ?? track.path))
              .map((track) => [track.song.id, track.location ?? track.path])) } };
        const connection = await this.acceptedSource(pending, await readLibrarySource({ ...pending, followLatest: false }), manifest);
        await this.saveConnections({ connections: [...this.connectedLibraries, connection], library: resolved.library });
        workspacePath = null;
        mediaDirectory = null;
        this.cancelSuggestions();
        return { kind: 'updated', connections: await this.connections(), status: this.status(), warnings: [
          ...resolved.warnings,
          ...(resolved.missingFiles.length ? [`${resolved.missingFiles.length} audio files remain unplayable. Import the backup again after recovering the music.`] : []),
        ] };
      } catch (error) {
        return { kind: 'rejected', message: error instanceof Error ? error.message : 'Could not open the Arsenal library.' };
      } finally {
        if (workspacePath !== null) await rm(workspacePath, { force: true }).catch(() => undefined);
        if (mediaDirectory !== null && !this.arsenalLibrary.tracks.some((track) => (track.location ?? track.path).startsWith(`${mediaDirectory}/`))) {
          await rm(mediaDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    });
  }

  private async backupLibrary(connection: StoredLibraryConnection) {
    const native = connection.kind === 'serato' && (!connection.dirty || connection.workspacePath === null);
    const snapshot = connection.origin === 'arsenal' ? { library: this.arsenalLibrary, warnings: [] }
      : connection.kind === 'rekordbox' && isRekordboxDatabasePath(connection.path) ? await readRekordboxDatabase(connection.path)
      : native ? await readSeratoWithPerformance(await findSeratoSource(connection.path))
      : { library: rekordboxSyncLibrary(await parseRekordboxXml(connection.workspacePath ?? connection.path), { includeNonLocal: true }), warnings: [] };
    const fingerprint = createHash('sha256').update(JSON.stringify(readLibraryModel(snapshot.library)));
    const tracks = snapshot.library.tracks.filter((track) => track.song.source === 'local');
    for (let offset = 0; offset < tracks.length; offset += 32) {
      const states = await Promise.all(tracks.slice(offset, offset + 32).map(async (track) => {
        try {
          const file = await stat(track.location ?? track.path);
          return JSON.stringify([track.path, file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs]);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
          return JSON.stringify([track.path, 'missing']);
        }
      }));
      for (const state of states) {
        fingerprint.update(state);
      }
    }
    return { ...snapshot, fingerprint: fingerprint.digest('hex') };
  }

  private async saveBackup(backup: StoredLibraryBackup, force = false): Promise<void> {
    if (this.organizationRecovery !== null) {
      if (force) throw new Error('Undo or keep the unfinished reorganization before backing up.');
      return;
    }
    try {
      if (this.startupBackupChanges.has(backup.id)) throw new Error('This library file has changes waiting for import. Reopen Arsenal to review them before backing up.');
      const connection = this.connectedLibraries.find((candidate) => candidate.id === this.sourceOfTruthId);
      if (!connection) throw new Error('Connect or open your Arsenal library to resume automatic backups. Existing backups are kept.');
      const snapshot = await this.backupLibrary(connection);
      if (!force && backup.fingerprint === snapshot.fingerprint && backup.manifestPath !== null &&
        (this.backupStates.get(backup.id)?.state ?? 'ready') === 'ready') {
        try {
          const current = await readPortableLibraryFingerprint(backup.manifestPath);
          if (current !== null && current === backup.manifestFingerprint) return;
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
        }
      }
      this.backupStates.set(backup.id, { state: 'saving', message: null });
      const verified = await this.backupLibrary(connection);
      if (verified.fingerprint !== snapshot.fingerprint) throw new Error('The library changed while preparing its backup. Arsenal will retry automatically.');
      const saved = await writePortableLibrary({ directory: backup.directory, library: snapshot.library,
        name: 'Arsenal library',
        includeMusic: backup.includeMusic, musicOrganization: backup.musicOrganization,
        expectedManifestFingerprint: backup.manifestFingerprint });
      this.backups = this.backups.map((candidate) => candidate.id === backup.id
        ? { ...backup, manifestPath: saved.manifestPath, manifestFingerprint: saved.manifestFingerprint,
            lastSavedAt: saved.savedAt, fingerprint: snapshot.fingerprint } : candidate);
      if (!await this.remember(this.rememberedPath)) {
        throw new Error('The backup was saved, but Arsenal could not save its status. Check disk space and permissions.');
      }
      const warnings = [...new Set([...snapshot.warnings, ...saved.warnings])];
      this.backupStates.set(backup.id, { state: 'ready', message: warnings.length ? warnings.join('\n') : null });
    } catch (error) {
      this.backupStates.set(backup.id, { state: 'error', message: error instanceof Error ? error.message : 'Could not save the library backup.' });
    }
  }

  private async updateBackups(): Promise<void> {
    for (const backup of this.backups) await this.saveBackup(backup);
  }

  private requestBackup(): void {
    if (this.organizationRecovery !== null || !this.backups.length || this.backupPollQueued) return;
    this.backupPollQueued = true;
    void this.enqueue(() => this.updateBackups(), false).catch(() => undefined)
      .finally(() => { this.backupPollQueued = false; });
  }

  async connections(): Promise<LibraryConnections> {
    const connections = await Promise.all(this.connectedLibraries.map(async (connection) => {
      const location = connection.kind === 'serato' && !connection.path.endsWith('.sqlite')
        ? join(connection.path, 'database V2') : connection.path;
      let available = false;
      try { available = (await stat(location)).isFile(); } catch { /* Keep unavailable connections so they can be located again. */ }
      let seratoVersion: SeratoVersion | null = null;
      if (available && connection.kind === 'serato' && connection.path.endsWith('.sqlite')) {
        try { seratoVersion = seratoSqliteVersion(connection.path); } catch { /* Unreadable libraries keep the generic label. */ }
      }
      return { id: connection.id, kind: connection.kind, path: connection.path, available,
        ...(connection.origin ? { origin: connection.origin } : {}),
        ...(connection.kind === 'rekordbox' && connection.origin === undefined
          ? { format: isRekordboxDatabasePath(connection.path) ? 'rekordbox-database' as const : 'rekordbox-xml' as const } : {}),
        ...(seratoVersion !== null ? { format: `serato-${seratoVersion}` as const } : {}),
        name: connection.displayName ?? (connection.kind === 'rekordbox' ? isRekordboxDatabasePath(connection.path) ? 'Rekordbox Collection' : basename(connection.path)
          : `Serato (${basename(connection.path.endsWith('.sqlite') ? dirname(connection.path) : connection.path)})`) };
    }));
    return { connections, backupConnections: this.backupStatus(), activeConnectionId: this.activeConnectionId, sourceOfTruthId: this.sourceOfTruthId };
  }

  private async saveConnections({ connections = this.connectedLibraries, syncPreferences = this.savedSyncPreferences, catalog = this.catalog, library, replace = false, backups = this.backups }: Readonly<{
      connections?: readonly StoredLibraryConnection[];
      syncPreferences?: SyncPreferences;
      catalog?: CurrentCatalog | null;
      library?: SyncLibrary | null;
      replace?: boolean;
      backups?: readonly StoredLibraryBackup[];
    }>): Promise<void> {
    const previousLibrary = this.arsenalLibrary;
    const previousCatalog = this.catalog;
    const incoming = library !== undefined && library !== null ? library
      : catalog !== null && catalog.sourcePath !== this.arsenalWorkspace
        ? rekordboxSyncLibrary(await parseRekordboxXml(catalog.sourcePath), { includeNonLocal: true }) : null;
    if (replace) this.catalog = await this.saveArsenalState(incoming ?? { tracks: [], playlists: [] });
    else if (incoming !== null) await this.importIntoArsenal(incoming);
    const preferences = syncPreferences;
    const pending = this.pendingRekordboxSync;
    const pendingRekordboxSync = !replace && pending !== null && connections.some((connection) => connection.id === pending.connectionId && connection.path === pending.path) &&
      preferences.rekordboxPath === pending.path && !(library !== undefined && library !== null &&
        connections.find((connection) => connection.id === pending.connectionId)?.sourceSyncFingerprint !==
        this.connectedLibraries.find((connection) => connection.id === pending.connectionId)?.sourceSyncFingerprint) ? pending : null;
    if (!connections.some((connection) => connection.id === ARSENAL_LIBRARY_ID)) throw new Error('Arsenal is the primary library and cannot be disconnected.');
    if (!await this.writeRemembered({ rekordboxXmlPath: this.arsenalWorkspace, seratoPath: null, syncPreferences: preferences,
      connections, activeConnectionId: ARSENAL_LIBRARY_ID, sourceOfTruthId: ARSENAL_LIBRARY_ID,
      ignoredDuplicateGroups: this.ignoredDuplicateGroups, minimumSongLengthSeconds: this.minimumSongLengthSeconds,
      backups, syncBaseline: this.syncBaseline, ongoingSyncPause: this.ongoingSyncPause, pendingRekordboxSync })) {
      if (previousLibrary !== this.arsenalLibrary) {
        await saveArsenalLibrary(this.arsenalPath, previousLibrary);
        this.arsenalLibrary = previousLibrary;
        this.catalog = previousCatalog;
        await this.writeArsenalProjection();
      }
      throw new Error('Could not save library connections. Check disk space and permissions.');
    }
    for (const connection of connections) {
      const previous = this.connectedLibraries.find((candidate) => candidate.id === connection.id);
      if (connection.sourceFingerprint !== undefined && connection.sourceFingerprint !== previous?.sourceFingerprint) this.startupChanges.delete(connection.id);
    }
    this.connectedLibraries = connections;
    if (backups !== this.backups) {
      for (const backup of this.backups) if (!backups.includes(backup)) this.backupStates.delete(backup.id);
      this.backups = backups;
    }
    this.activeConnectionId = ARSENAL_LIBRARY_ID;
    this.sourceOfTruthId = ARSENAL_LIBRARY_ID;
    this.savedSyncPreferences = preferences;
    this.pendingRekordboxSync = pendingRekordboxSync;
    this.rememberedPath = this.arsenalWorkspace;
    this.rememberedSeratoPath = null;
    if (preferences.request?.cadence !== 'ongoing' && this.pendingRekordboxSync === null && this.currentSyncActivity.state !== 'syncing' && this.currentSyncActivity.state !== 'off') {
      this.setSyncActivity('off');
    }
  }

  private async prepareConnection(connection: StoredLibraryConnection, source?: LibrarySourceSnapshot, backupWorkspace = false) {
    if (connection.portableSource) {
      const incoming = source ?? await readLibrarySource(connection);
      const parsed = await parseRekordboxXml(connection.path);
      if (incoming.fingerprint === connection.sourceFingerprint) {
        return { connection, catalog: await this.catalogFor(connection.path), library: null, warnings: incoming.warnings };
      }
      if (connection.workspaceFingerprint !== undefined && parsed.fingerprint !== connection.workspaceFingerprint) {
        throw new Error('Unsynced Arsenal edits were kept. Back up your local library and import the updated portable snapshot as a separate library to resolve the changes.');
      }
      const manifestPath = incoming.portableManifestPath;
      if (manifestPath === null) throw new Error('The portable library source could not be located.');
      const exactSource = { ...connection, portableSource: { ...connection.portableSource, manifestPath }, followLatest: false };
      if ((await readLibrarySource(exactSource)).fingerprint !== incoming.fingerprint) throw new Error('The portable library changed before import. Try again.');
      const manifest = await readPortableLibrary(manifestPath);
      const resolved = await resolvePortableLibrary(manifest, manifestPath, connection.portableSource.searchRoots,
        join(dirname(connection.path), 'media', connection.id), connection.portableSource.resolvedPaths, connection.portableSource.resolvedTrackPaths);
      if ((await readLibrarySource(exactSource)).fingerprint !== incoming.fingerprint) throw new Error('The portable library changed during import. Try again.');
      const previous = await readFile(connection.path, 'utf8');
      if (createHash('sha256').update(previous).digest('hex') !== parsed.fingerprint) throw new Error('The local library changed during import. Try again.');
      const backup = await saveLibraryXml(connection.path, mergeRekordboxXml(resolved.library), previous);
      const updated = { ...connection, portableSource: { ...connection.portableSource,
        resolvedPaths: resolved.library.tracks.filter((track) => track.song.source === 'local').map((track) => track.location ?? track.path).filter(isAbsolute),
        resolvedTrackPaths: Object.fromEntries(resolved.library.tracks.filter((track) => track.song.source === 'local' && isAbsolute(track.location ?? track.path))
          .map((track) => [track.song.id, track.location ?? track.path])) } };
      return { connection: await this.acceptedSource(updated, incoming, manifest), catalog: null, library: resolved.library,
        warnings: [...incoming.warnings, ...resolved.warnings, ...(resolved.missingFiles.length ? [`${resolved.missingFiles.length} audio files could not be located.`] : []),
          ...(backup === null ? [] : [`Previous local library saved to ${backup}`])] };
    }
    if (connection.kind === 'rekordbox') {
      const incoming = source ?? await readLibrarySource(connection);
      if (incoming.library === null) throw new Error('The Rekordbox library could not be read.');
      return { connection: await this.acceptedSource(connection, incoming), catalog: null, library: incoming.library,
        warnings: isRekordboxDatabasePath(connection.path) ? [...incoming.warnings,
          'Direct Rekordbox sync supports playlists and existing-track details. Cues, loops, beatgrids, new tracks, and Collection removal are not supported yet. Native intelligent playlists stay in Rekordbox.'] : incoming.warnings };
    }
    if (connection.dirty && connection.workspacePath !== null) {
      return { connection, catalog: await this.catalogFor(connection.workspacePath, connection.path), library: null,
        warnings: ['Arsenal has unsynced edits in this Serato connection. They were kept. Sync tracks and playlists to Serato before refreshing from its library.'] };
    }
    const native = await findSeratoSource(connection.path);
    const incoming = source ?? await readLibrarySource(connection);
    if (incoming.library === null) throw new Error('The Serato library could not be read.');
    if (this.stateFilePath === null) throw new Error('Library settings are not initialized.');
    const directory = join(dirname(this.stateFilePath ?? this.arsenalPath), 'libraries');
    await mkdir(directory, { recursive: true });
    const workspacePath = connection.workspacePath ?? join(directory, `serato-${randomUUID()}.xml`);
    let previous: string | null = null;
    try { previous = await readFile(workspacePath, 'utf8'); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (backupWorkspace && connection.workspaceFingerprint !== undefined &&
      (await parseRekordboxXml(workspacePath)).fingerprint !== connection.workspaceFingerprint) {
      throw new Error('The local library changed while waiting for confirmation. Import its changes again.');
    }
    const backup = await saveLibraryXml(workspacePath, mergeRekordboxXml(incoming.library), previous, backupWorkspace);
    const updated = { ...connection, path: await resolveSeratoMediaPath(native.path), workspacePath, dirty: false };
    return { connection: await this.acceptedSource(updated, incoming),
      catalog: null, library: incoming.library, warnings: [...incoming.warnings, ...(backup === null ? [] : [`Previous local library saved to ${backup}`])] };
  }

  connectLibrary(owner: BrowserWindow, kind: LibrarySourceKind, seratoVersion?: SeratoVersion): Promise<LibraryConnectionResult> {
    return this.enqueue(async () => {
      try {
        const selected = await this.chooseSyncPath(owner, kind, 'rekordbox-to-serato', seratoVersion);
        if (selected === null) return { kind: 'cancelled' };
        const path = await resolveSeratoMediaPath(selected);
        const existing = this.connectedLibraries.find((connection) => connection.kind === kind && normalizePath(connection.path) === normalizePath(path));
        const prepared = await this.prepareConnection(existing ?? { id: randomUUID(), kind, path, workspacePath: null, dirty: false });
        const accepted = prepared.connection;
        const connections = existing ? this.connectedLibraries.map((connection) => connection.id === existing.id ? accepted : connection)
          : [...this.connectedLibraries, accepted];
        const preferences = this.syncPreferences();
        await this.saveConnections({ connections, catalog: prepared.catalog, library: prepared.library,
          syncPreferences: { ...preferences, [kind === 'rekordbox' ? 'rekordboxPath' : 'seratoPath']: path,
            request: { ...ONGOING_SYNC_REQUEST, timingOffsetMs: preferences.request?.timingOffsetMs ?? 0 } } });
        this.ongoingSyncPause = null;
        this.cancelSuggestions();
        this.requestOngoingSync();
        return { kind: 'updated', connections: await this.connections(), status: this.status(), warnings: prepared.warnings };
      } catch (error) {
        return { kind: 'rejected', message: error instanceof Error ? error.message : 'Could not connect the library.' };
      }
    });
  }

  manageLibraryConnection(owner: BrowserWindow, action: LibraryConnectionAction): Promise<LibraryConnectionResult> {
    return this.enqueue(async () => {
      try {
        if (this.organizationRecovery !== null && (action.kind === 'disconnect' || action.kind === 'replace' || action.kind === 'reset' || action.kind === 'locate')) {
          throw new Error('Undo or keep the unfinished reorganization before changing library connections.');
        }
        const connection = this.connectedLibraries.find((candidate) => candidate.id === action.id);
        if (!connection) throw new Error('This library is no longer connected.');
        const stopOngoing = (preferences: SyncPreferences): SyncPreferences => ({ ...preferences,
          request: preferences.request === null ? null : { ...preferences.request, cadence: 'once' } });
        if (action.kind === 'reset' && connection.origin === 'arsenal') {
          await this.saveConnections({ connections: [connection], library: null, catalog: null, replace: true, backups: [],
            syncPreferences: { ...stopOngoing(this.savedSyncPreferences), rekordboxPath: null, seratoPath: null } });
          this.ongoingSyncPause = null;
          this.cancelSuggestions();
          return { kind: 'updated', connections: await this.connections(), status: this.status(), warnings: [] };
        }
        if (action.kind === 'reset') {
          const prepared = await this.prepareConnection(connection);
          await this.saveConnections({ connections: this.connectedLibraries.map((candidate) => candidate.id === connection.id ? prepared.connection : candidate),
            catalog: prepared.catalog, library: prepared.library, replace: true });
          this.ongoingSyncPause = null;
          this.cancelSuggestions();
          return { kind: 'updated', connections: await this.connections(), status: this.status(), warnings: prepared.warnings };
        }
        if (connection.origin === 'arsenal') {
          if (action.kind !== 'open' && action.kind !== 'refresh') throw new Error('Arsenal is the primary library and cannot be replaced or disconnected.');
          return { kind: 'updated', connections: await this.connections(), status: this.status(), warnings: [] };
        }
        if (action.kind === 'source-of-truth') {
          throw new Error('Arsenal is always the primary library. Import this connection to add its contents.');
        } else if (action.kind === 'disconnect') {
          const connections = this.connectedLibraries.filter((candidate) => candidate.id !== connection.id);
          const preferences = this.syncPreferences();
          const key = connection.kind === 'rekordbox' ? 'rekordboxPath' : 'seratoPath';
          const nextPath = connections.find((candidate) => candidate.origin === undefined && candidate.kind === connection.kind)?.path ?? null;
          await this.saveConnections({ connections,
            catalog: this.catalog,
            syncPreferences: { ...preferences, [key]: preferences[key] === connection.path ? nextPath : preferences[key] } });
          this.startupUnreadable.delete(connection.id);
          this.startupChanges.delete(connection.id);
          this.startupSources.delete(connection.id);
          await rm(this.sourceSnapshotPath(connection.id), { force: true });
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
              catalog: prepared.catalog, library: prepared.library,
              syncPreferences: { ...preferences, [key]: preferences[key] === connection.path ? path : preferences[key] } });
          } catch (error) {
            if (prepared.connection.workspacePath !== null && prepared.connection.workspacePath !== connection.workspacePath) {
              await rm(prepared.connection.workspacePath, { force: true }).catch(() => undefined);
            }
            throw error;
          }
          this.cancelSuggestions();
          this.requestOngoingSync();
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
            catalog: prepared?.catalog ?? this.catalog, library: prepared?.library ?? null,
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
    const ordered = request.sort && request.sort.length > 0 ? sortSongs(matches, request.sort) : matches;
    const total = ordered.length;
    const limit = request.limit;
    const lastOffset = Math.floor(Math.max(0, total - 1) / limit) * limit;
    const offset = Math.min(request.offset, lastOffset);
    const items = ordered.slice(offset, offset + limit);
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
    return activeOrder;
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

  cleanUpSongBackups(): Promise<SongBackupCleanup> {
    return this.enqueue(() => removeSongBackups(this.arsenalLibrary.tracks.flatMap((track) =>
      [track.path, track.location ?? track.path].filter(isAbsolute))), false);
  }

  async findDuplicates(mode: DuplicateMatchMode): Promise<DuplicateScan> {
    const catalog = this.requireCatalog();
    const cached = catalog.duplicateScans.get(mode);
    if (cached !== undefined) {
      return cached;
    }

    const fileKeys = new Map<string, string>();
    if (mode === 'same-file') {
      const tracks = catalog.tracks.filter((track) => this.includesSong(track.song));
      const files = await Promise.all(tracks.map(async (track) => {
        if (track.mediaPath === null) return null;
        try { const file = await stat(track.mediaPath, { bigint: true }); return file.isFile() ? file : null; } catch { return null; }
      }));
      for (const [index, track] of tracks.entries()) {
        const file = files[index];
        if (file && track.mediaPath !== null) fileKeys.set(track.song.id, file.dev !== 0n && file.ino !== 0n
          ? `file:${file.dev}:${file.ino}` : `path:${normalizePath(await resolveSeratoMediaPath(track.mediaPath))}`);
      }
      const localFile = cloudMatcher(tracks.flatMap((track, index) => track.mediaPath !== null && files[index]
        ? [{ name: basename(track.mediaPath), length: track.song.durationSeconds, value: fileKeys.get(track.song.id) ?? '' }] : []), false);
      for (const [index, track] of tracks.entries()) {
        if (files[index]) continue;
        const path = track.mediaPath ?? pathFromLocation(track.rawLocation) ?? track.rawLocation;
        const cloud = path !== null && isCloudPath(path) ? localFile(basename(path), track.song.durationSeconds) : undefined;
        if (cloud !== undefined) fileKeys.set(track.song.id, cloud);
        else if (track.mediaPath !== null) fileKeys.set(track.song.id, `path:${normalizePath(track.mediaPath)}`);
      }
    }
    const unfiltered = findDuplicateScan(catalog.songs, mode, fileKeys);
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

  syncActivity(): SyncActivity {
    return this.currentSyncActivity;
  }

  private setSyncActivity(state: SyncActivity['state'], result = this.currentSyncActivity.result): void {
    this.currentSyncActivity = { state, lastSyncedAt: this.syncBaseline?.lastSyncedAt ?? null, result };
    this.onSyncActivity?.(this.currentSyncActivity);
  }

  private async pauseOngoingSync(message: string, result: SyncActivity['result'] = null): Promise<void> {
    this.ongoingSyncPause = message;
    const saved = await this.remember(this.rememberedPath);
    const paused = result ?? { kind: 'rejected', message, warnings: [], backupPaths: [] } satisfies SyncResult;
    this.setSyncActivity('attention', saved ? paused : { ...paused,
      warnings: [...paused.warnings, 'Could not save the paused sync state. Stop ongoing sync before closing Arsenal.'] });
  }

  private selectedSyncConnections(request = this.savedSyncPreferences.request): readonly StoredLibraryConnection[] {
    if (request === null) return [];
    const preferences = this.syncPreferences();
    const kinds: LibrarySourceKind[] = request.direction === 'both' ? ['rekordbox', 'serato']
      : [request.direction === 'rekordbox-to-serato' ? 'serato' : 'rekordbox'];
    return kinds.flatMap((kind) => {
      const path = kind === 'rekordbox' ? preferences.rekordboxPath : preferences.seratoPath;
      const connection = this.connectedLibraries.find((entry) => entry.origin === undefined && entry.kind === kind && entry.path === path);
      return connection ? [connection] : [];
    });
  }

  private ongoingEditTargets(): readonly StoredLibraryConnection[] {
    if (this.organizationRecovery !== null || this.savedSyncPreferences.request?.cadence !== 'ongoing' || this.ongoingSyncPause !== null || !this.startupComplete) return [];
    return this.selectedSyncConnections().filter((connection) => !this.startupChanges.has(connection.id) && !this.startupUnreadable.has(connection.id));
  }

  requestOngoingSync(): void {
    if (this.organizationRecovery !== null || this.backgroundStopped || !this.startupComplete || this.savedSyncPreferences.request?.cadence !== 'ongoing' ||
      this.ongoingSyncPause !== null || this.ongoingCheckQueued) return;
    this.ongoingCheckQueued = true;
    void this.enqueue(() => this.checkOngoingSync()).catch(() => undefined)
      .finally(() => { this.ongoingCheckQueued = false; });
  }

  private async checkOngoingSync(): Promise<void> {
    const request = this.savedSyncPreferences.request;
    if (this.organizationRecovery !== null || this.backgroundStopped || !this.startupComplete || request?.cadence !== 'ongoing' || this.ongoingSyncPause !== null ||
      !this.selectedSyncConnections(request).length) return;
    await this.syncNow(request);
  }

  private requestPendingRekordboxSync(): void {
    if (this.organizationRecovery !== null || this.backgroundStopped || !this.startupComplete || this.pendingRekordboxSync === null || this.ongoingSyncPause !== null || this.ongoingCheckQueued) return;
    this.ongoingCheckQueued = true;
    void this.enqueue(async () => {
      try {
        const pending = this.pendingRekordboxSync;
        if (this.organizationRecovery !== null || pending === null || this.backgroundStopped || await isRekordboxRunning()) return;
        await this.syncNow(pending.request, true);
      } catch (error) {
        await this.pauseOngoingSync(error instanceof Error ? error.message : 'Could not apply queued Rekordbox changes.');
      }
    }, false).catch(() => undefined).finally(() => { this.ongoingCheckQueued = false; });
  }

  private async stageRekordboxSync(connection: StoredLibraryConnection, request: SyncRequest): Promise<void> {
    const previous = this.pendingRekordboxSync;
    const previousConnections = this.connectedLibraries;
    const fingerprint = previous?.connectionId === connection.id && previous.path === connection.path ? previous.fingerprint
      : connection.sourceSyncFingerprint ?? (await readLibrarySource(connection)).syncFingerprint;
    this.pendingRekordboxSync = { connectionId: connection.id, path: connection.path, fingerprint, request,
      ...(request.cadence === 'ongoing' ? {} : { library: this.arsenalLibrary }) };
    if (connection.syncedPlaylistPaths === undefined) this.connectedLibraries = this.connectedLibraries.map((candidate) => candidate.id === connection.id
      ? { ...candidate, syncedPlaylistPaths: this.arsenalLibrary.playlists.map((playlist) => playlist.path) } : candidate);
    if (!await this.remember(this.rememberedPath)) {
      this.pendingRekordboxSync = previous;
      this.connectedLibraries = previousConnections;
      throw new Error('Could not save queued Rekordbox changes. Check disk space and permissions.');
    }
  }

  syncPreferences(): SyncPreferences {
    return { ...this.savedSyncPreferences,
      rekordboxPath: this.savedSyncPreferences.rekordboxPath ?? this.connectedLibraries.find((entry) => entry.kind === 'rekordbox' && entry.origin === undefined)?.path ?? null,
      seratoPath: this.savedSyncPreferences.seratoPath ?? this.connectedLibraries.find((entry) => entry.kind === 'serato' && entry.origin === undefined)?.path ?? null,
    };
  }

  chooseSyncLibrary(owner: BrowserWindow, kind: LibrarySourceKind, direction: SyncDirection): Promise<SyncPreferences | null> {
    return this.enqueue(async () => {
      const path = await this.chooseSyncPath(owner, kind, direction);
      if (path === null) return null;
      const canonical = await resolveSeratoMediaPath(path);
      const existing = this.connectedLibraries.some((connection) => connection.kind === kind && normalizePath(connection.path) === normalizePath(canonical));
      let added: StoredLibraryConnection = { id: randomUUID(), kind, path: canonical, workspacePath: null, dirty: false };
      if (!existing) {
        try { added = await this.acceptedSource(added, await readLibrarySource(added)); } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
      await this.saveConnections({ connections: existing ? this.connectedLibraries : [...this.connectedLibraries, added],
        syncPreferences: { ...this.syncPreferences(), [kind === 'rekordbox' ? 'rekordboxPath' : 'seratoPath']: canonical } });
      return this.syncPreferences();
    });
  }

  private async chooseSyncPath(owner: BrowserWindow, kind: LibrarySourceKind, direction: SyncDirection, seratoVersion?: SeratoVersion): Promise<string | null> {
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
      if (seratoVersion !== undefined) {
        const found = source.kind === 'sqlite' ? seratoSqliteVersion(source.path) : 4;
        if (found !== seratoVersion) throw new Error(`This is a Serato ${found} library. Connect it as Serato ${found}.`);
      }
      await readSeratoWithPerformance(source, false);
      return source.path;
    }
    let selected: string | null;
    const detected = isRekordboxDatabasePath(preferences.rekordboxPath ?? '') ? preferences.rekordboxPath : await detectRekordboxDatabase();
    if (detected !== null) {
      const choice = await dialog.showMessageBox(owner, {
        type: 'question', title: 'Connect Rekordbox', message: 'Connect to Rekordbox Collection?',
        detail: 'Collection sync adds tracks and applies playlist and track-detail edits automatically while Rekordbox is closed. XML connections require a separate import in Rekordbox.',
        buttons: ['Connect Collection', 'Choose another library', 'Cancel'], defaultId: 0, cancelId: 2,
      });
      if (choice.response === 2) return null;
      if (choice.response === 0) { await readRekordboxDatabase(detected); return detected; }
    }
    if (direction === 'serato-to-rekordbox') {
      const choice = await dialog.showSaveDialog(owner, {
        title: 'Choose the Rekordbox XML destination', buttonLabel: 'Use this XML',
        defaultPath: preferences.rekordboxPath !== null && !isRekordboxDatabasePath(preferences.rekordboxPath) ? preferences.rekordboxPath : join(homedir(), 'rekordbox.xml'),
        filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }],
      });
      selected = choice.canceled ? null : choice.filePath ?? null;
    } else {
      const choice = await dialog.showOpenDialog(owner, {
        title: 'Choose a Rekordbox Collection or XML library', buttonLabel: 'Use this library', properties: ['openFile'],
        ...(preferences.rekordboxPath === null ? {} : { defaultPath: preferences.rekordboxPath }),
        filters: [{ name: 'Rekordbox libraries', extensions: ['db', 'xml'] }],
      });
      selected = choice.canceled ? null : choice.filePaths[0] ?? null;
    }
    if (selected === null) return null;
    if (isRekordboxDatabasePath(selected)) { await readRekordboxDatabase(selected); return selected; }
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
    return this.enqueue(() => this.syncNow(requested));
  }

  private async syncNow(requested: SyncRequest, nativeOnly = false): Promise<SyncResult> {
    this.ongoingSyncPause = null;
    this.setSyncActivity('syncing', null);
    let result = await this.syncOnce(requested, nativeOnly);
    if (result.kind === 'synced') {
      try {
        const selected = this.selectedSyncConnections(requested).filter((connection) => !nativeOnly || connection.kind === 'rekordbox' && isRekordboxDatabasePath(connection.path));
        this.syncBaseline = { lastSyncedAt: new Date().toISOString() };
        for (const connection of selected) {
          this.startupChanges.delete(connection.id);
          this.startupUnreadable.delete(connection.id);
        }
        if (!await this.remember(this.rememberedPath)) throw new Error('Could not save the sync status. Check disk space and permissions.');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not record the synced libraries.';
        result = { ...result, warnings: [...result.warnings, message] };
        if (this.savedSyncPreferences.request?.cadence === 'ongoing') {
          await this.pauseOngoingSync(message, result);
          return result;
        }
      }
    }
    if (result.kind === 'queued') {
      this.setSyncActivity('waiting', result);
    } else if (result.kind !== 'synced' && (nativeOnly || this.savedSyncPreferences.request?.cadence === 'ongoing')) {
      await this.pauseOngoingSync(result.kind === 'cancelled' ? 'Sync was cancelled.' : result.message,
        result.kind === 'cancelled' ? null : result);
    } else {
      this.setSyncActivity(this.pendingRekordboxSync !== null ? 'waiting' : this.savedSyncPreferences.request?.cadence === 'ongoing' ? 'watching' : 'off',
        result.kind === 'cancelled' ? null : result);
    }
    return result;
  }

  private async syncOnce(requested: SyncRequest, nativeOnly = false): Promise<SyncResult> {
    const warnings: string[] = [];
    const backupPaths: string[] = [];
    let synced = 0;
    let queued = false;
    let trackCount = 0;
    let playlistCount = 0;
    let skippedTrackCount = 0;
    let importConnectionIds: string[] = [];
    try {
      const request = readSyncRequest(requested);
      if (!nativeOnly) await this.rememberSyncPreferences({ ...this.syncPreferences(), request });
      const targets = this.selectedSyncConnections(request).filter((connection) => !nativeOnly || connection.kind === 'rekordbox' && isRekordboxDatabasePath(connection.path));
      if (!targets.length) throw new Error('Connect a DJ library and choose it as a sync destination. Your Arsenal library is saved locally.');
      importConnectionIds = targets.filter((connection) => this.startupChanges.has(connection.id)).map((connection) => connection.id);
      if (targets.some((connection) => this.startupChanges.has(connection.id) || this.startupUnreadable.has(connection.id))) {
        throw new Error('A sync destination has changes waiting for import or could not be checked. Import its connection before syncing. Your Arsenal library is saved locally.');
      }
      this.missingSyncContext = null;
      const protectedMediaRoots = [...this.backups.flatMap((backup) => ['Music', 'media'].map((name) => join(backup.directory, name))),
        ...this.connectedLibraries.flatMap((connection) => {
          const source = connection.portableSource;
          return source ? ['Music', 'media'].map((name) => join(dirname(source.manifestPath), name)) : [];
        })];
      for (const target of targets) {
        const nativeRekordbox = target.kind === 'rekordbox' && isRekordboxDatabasePath(target.path);
        if (nativeRekordbox && !nativeOnly) await this.stageRekordboxSync(target, request);
        const pending = nativeRekordbox ? this.pendingRekordboxSync : null;
        const library = pending?.library ?? this.arsenalLibrary;
        if (nativeRekordbox && !await isRekordboxRunning()) {
          const current = await readLibrarySource(target);
          if (pending !== null && current.syncFingerprint !== pending.fingerprint) {
            this.startupChanges.add(target.id);
            importConnectionIds = [target.id];
            throw new Error('Rekordbox changed while Arsenal updates were queued. Import its changes in Connections before resuming sync. Arsenal edits were kept.');
          }
        }
        const paths = new Set(library.playlists.map((playlist) => JSON.stringify(playlist.path)));
        const removePlaylistPaths = nativeRekordbox && request.fields.playlists
          ? (this.connectedLibraries.find((connection) => connection.id === target.id)?.syncedPlaylistPaths ?? []).filter((path) => !paths.has(JSON.stringify(path))) : [];
        const removedTrackPaths = nativeRekordbox && request.fields.tracks
          ? this.connectedLibraries.find((connection) => connection.id === target.id)?.removedTrackPaths ?? [] : [];
        // A track added back in Arsenal after its removal stays in the Collection.
        const trackPaths = new Set(library.tracks.map((track) => normalizePath(track.location ?? track.path)));
        const removeTrackPaths = removedTrackPaths.filter((path) => !trackPaths.has(normalizePath(path)));
        const result = await syncArsenalLibraryToConnection({ library, target, request, protectedMediaRoots, removePlaylistPaths, removeTrackPaths });
        warnings.push(...('warnings' in result ? result.warnings : []));
        backupPaths.push(...('backupPaths' in result ? result.backupPaths : []));
        if (result.kind === 'queued') { queued = true; continue; }
        if (result.kind === 'missing-files') {
          const context: MissingSyncContext = { targets: await this.connectedSyncTargets(), paths: new Set(result.files.map((file) => normalizePath(file.path))),
            initialFiles: result.files, knownPaths: new Map(), result: { ...result, warnings, backupPaths } };
          this.missingSyncContext = context;
          await this.refreshMissingSyncReport(context);
          return context.result;
        }
        if (result.kind !== 'synced') return result.kind === 'cancelled' ? result : { ...result, warnings, backupPaths,
          message: `${result.message}${synced ? ' Some destinations were already updated.' : ''}` };
        synced += 1;
        trackCount = Math.max(trackCount, result.trackCount);
        playlistCount = Math.max(playlistCount, result.playlistCount);
        skippedTrackCount = Math.max(skippedTrackCount, result.skippedTrackCount);
        this.connectedLibraries = this.connectedLibraries.map((connection) => connection.id === target.id ? { ...connection, dirty: false,
          ...(nativeRekordbox && request.fields.playlists ? { syncedPlaylistPaths: library.playlists.map((playlist) => playlist.path) } : {}),
          ...(nativeRekordbox && request.fields.tracks ? { removedTrackPaths: [] } : {}) } : connection);
        if (nativeRekordbox) this.pendingRekordboxSync = null;
        await this.acknowledgeWrites([target.id], true);
      }
      if (queued) return { kind: 'queued', warnings, backupPaths,
        message: `Saved in Arsenal. Waiting for Rekordbox to close before updating Collection.${synced ? ' Other destinations were updated.' : ''}` };
      return { kind: 'synced', trackCount, playlistCount, skippedTrackCount, warnings, backupPaths,
        message: `Saved Arsenal changes to ${synced} ${synced === 1 ? 'destination' : 'destinations'}.${targets.some((target) => target.kind === 'rekordbox' && isRekordboxDatabasePath(target.path)) ? ' Rekordbox Collection will show the changes on its next launch.' : ''}${targets.some((target) => target.kind === 'rekordbox' && !isRekordboxDatabasePath(target.path)) ? ' Rekordbox XML needs a separate Collection import.' : ''}${targets.some((target) => target.kind === 'serato') ? ' Reopen Serato to load the changes.' : ''}${skippedTrackCount ? ` Up to ${skippedTrackCount} tracks were skipped. Review the warnings for details.` : ''}` };
    } catch (error) {
      return { kind: 'rejected', warnings, backupPaths, message: `${error instanceof Error ? error.message : 'Could not sync the library.'}${synced ? ' Some destinations were already updated.' : ''}`,
        ...(importConnectionIds.length ? { importConnectionIds } : {}) };
    }
  }

  private async connectedSyncTargets(): Promise<MissingSyncTarget[]> {
    const targets: MissingSyncTarget[] = [];
    for (const connection of this.connectedLibraries) {
      if (connection.kind === 'rekordbox') targets.push(isRekordboxDatabasePath(connection.path)
        ? { kind: 'rekordbox-database', path: connection.path } : { kind: 'xml', path: connection.path, libraryKind: 'rekordbox' });
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
        const library = target.kind === 'xml' ? rekordboxSyncLibrary(await parseRekordboxXml(target.path))
          : target.kind === 'rekordbox-database' ? (await readRekordboxDatabase(target.path, { performance: false })).library : await readSeratoLibrary(target);
        const tracks = library.tracks.filter((track) => context.paths.has(normalizePath(track.path)));
        context.knownPaths.set(target.path, new Set(tracks.map((track) => normalizePath(track.path))));
        libraries.push({ target, kind: target.kind === 'xml' ? target.libraryKind : target.kind === 'rekordbox-database' ? 'rekordbox' : 'serato', library: { ...library, tracks } });
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
        const kind = target.kind === 'xml' ? target.libraryKind : target.kind === 'rekordbox-database' ? 'rekordbox' : 'serato';
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

  private organizationRecovery: OrganizationJournal | null = null;

  private get organizationJournalPath(): string { return join(dirname(this.stateFilePath ?? this.arsenalPath), 'reorganization-journal.json'); }

  private organizationPlan: Readonly<{
    revision: string; plan: OrganizationPlan; targetState: string;
    targets: Awaited<ReturnType<RekordboxLibrary['organizationTargets']>>;
    replacements: ReadonlyMap<string, string>;
  }> | null = null;

  organizationRoot(): Promise<string> {
    return this.enqueue(async () => defaultOrganizationRoot(this.arsenalLibrary), false);
  }

  async chooseOrganizationRoot(owner: BrowserWindow): Promise<string | null> {
    const picked = await dialog.showOpenDialog(owner, { title: 'Choose music destination',
      defaultPath: await this.organizationRoot(), properties: ['openDirectory', 'createDirectory'] });
    return picked.canceled ? null : picked.filePaths[0] ?? null;
  }

  private organizationProgress(owner: BrowserWindow, phase: LibraryOrganizationProgress['phase'], completed: number, total: number): void {
    try {
      if (!owner.isDestroyed()) owner.webContents.send(DJ_LIBRARY_CHANNELS.organizationProgress, { phase, completed, total } satisfies LibraryOrganizationProgress);
    } catch { /* Complete recovery even if the window closes. */ }
  }

  private async organizationTargetState(targets: Readonly<{
    libraries: readonly Readonly<{ target: MissingSyncTarget }>[]; portable: readonly Readonly<{ path: string }>[];
  }>,
    progress: (completed: number, total: number) => void = () => undefined): Promise<string> {
    const paths: string[] = [];
    for (const { target } of targets.libraries) {
      if (target.kind === 'legacy' || target.kind === 'sqlite') paths.push(...await seratoOrganizationFiles(target));
      else if (target.kind === 'rekordbox-database') paths.push(target.path, `${target.path}-wal`, join(dirname(target.path), 'masterPlaylists6.xml'));
      else paths.push(target.path);
    }
    paths.push(this.arsenalPath, this.arsenalWorkspace, ...targets.portable.map((portable) => portable.path));
    for (const { path } of targets.portable) {
      const source = await readLibrarySource({ kind: 'rekordbox', path, portableSource: { manifestPath: path, searchRoots: [] } });
      if (source.portableManifestPath !== null) paths.push(source.portableManifestPath);
    }
    const states = [];
    const ordered = [...new Set(paths)].sort();
    for (let offset = 0; offset < ordered.length; offset += 32) {
      states.push(...await Promise.all(ordered.slice(offset, offset + 32).map(async (path) => {
        try {
          const info = await stat(path, { bigint: true });
          return [path, String(info.size), String(info.mtimeNs)];
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [path, 'missing'];
          throw error;
        }
      })));
      progress(Math.min(offset + 32, ordered.length), ordered.length);
    }
    return JSON.stringify(states);
  }

  private async organizationTargets(owner: BrowserWindow, journal?: OrganizationJournal, replacements?: ReadonlyMap<string, string>) {
    const required = new Set((journal?.targets?.filter((target) => replacements === undefined || target.paths.some((path) => replacements.has(normalizePath(path)))).map((target) => target.path)
      ?? journal?.restores.map((restore) => restore.path) ?? []).map(normalizePath));
    const targets = (await this.connectedSyncTargets()).filter((target) => normalizePath(target.path) !== normalizePath(this.arsenalWorkspace) &&
      (journal?.targets === undefined || required.has(normalizePath(target.path))));
    const portablePaths = new Set<string>();
    const acceptedConnections: string[] = [];
    for (const connection of this.connectedLibraries) {
      if (connection.origin === 'arsenal') continue;
      const manifestPath = connection.portableSource?.manifestPath;
      if (journal !== undefined && (manifestPath === undefined || journal.targets !== undefined && !required.has(normalizePath(manifestPath)))) continue;
      try {
        const source = await readLibrarySource({ ...connection, ...(journal === undefined ? {} : { followLatest: false }) });
        if (source.fingerprint === connection.sourceFingerprint && !this.startupChanges.has(connection.id)) acceptedConnections.push(connection.id);
        if (manifestPath !== undefined) portablePaths.add(source.portableManifestPath ?? manifestPath);
      } catch (error) {
        if (manifestPath !== undefined && (journal === undefined || required.has(normalizePath(manifestPath)))) throw error;
        if (journal !== undefined) this.startupUnreadable.add(connection.id);
        else throw new Error(`Could not read ${connection.displayName ?? basename(connection.path)} for reorganization. ${error instanceof Error ? error.message : ''}`);
      }
    }
    const targetState = journal === undefined ? await this.organizationTargetState({ libraries: targets.map((target) => ({ target })),
      portable: [...portablePaths].map((path) => ({ path })) }, (completed, total) => this.organizationProgress(owner, 'validating', completed, total)) : null;
    const libraries = [];
    for (const target of targets) {
      try {
        if (target.kind === 'rekordbox-database') {
          const native = await readRekordboxDatabase(target.path, { performance: false });
          libraries.push({ target, nativePaths: native.library.tracks.map((track) => track.location ?? track.path), duplicatePaths: [], cloudLocalPaths: native.cloudLocalPaths });
        } else {
          const source = target.kind === 'xml' ? null : await seratoOrganizationSource(target);
          const nativePaths = target.kind === 'xml'
            ? rekordboxSyncLibrary(await parseRekordboxXml(target.path), { includeNonLocal: true }).tracks.map((track) => track.location ?? track.path)
            : source?.paths ?? [];
          libraries.push({ target, nativePaths, duplicatePaths: source?.duplicatePaths ?? [], cloudLocalPaths: [] });
        }
      } catch (error) {
        if (journal === undefined || required.has(normalizePath(target.path))) throw error;
      }
      this.organizationProgress(owner, 'validating', libraries.length, targets.length);
    }
    const portable = [];
    for (const path of portablePaths) {
      try { portable.push({ path, manifest: await readPortableLibrary(path), before: await readFile(path) }); } catch (error) {
        if (journal === undefined || required.has(normalizePath(path))) throw error;
      }
    }
    const currentState = await this.organizationTargetState({ libraries, portable });
    if (targetState !== null && currentState !== targetState) throw new Error('A connected library changed while reading its paths. Preview again.');
    return { libraries, portable, targetState: currentState, acceptedConnections };
  }

  previewOrganization(request: LibraryOrganizationRequest, owner: BrowserWindow): Promise<LibraryOrganizationPreview> {
    return this.enqueue(async () => {
      if (this.organizationRecovery !== null) throw new Error(`Resolve the unfinished reorganization first. Journal: ${this.organizationJournalPath}`);
      this.organizationPlan = null;
      this.organizationProgress(owner, 'validating', 0, 1);
      const catalog = this.requireCatalog();
      const operation = readOrganizationOperation(request.operation);
      const relink = operation.kind === 'move' || operation.useCopies;
      if (operation.kind === 'copy' && operation.useCopies && await organizationDestination(request.destinationRoot) !== 'internal') {
        throw new Error('Copied files can only replace the active library on a verified internal drive.');
      }
      const targets = relink ? await this.organizationTargets(owner) : { libraries: [], portable: [], acceptedConnections: [],
        targetState: await this.organizationTargetState({ libraries: [], portable: [] }) };
      const { targetState } = targets;
      const referencedPaths = [...this.arsenalLibrary.tracks.map((track) => track.location ?? track.path),
        ...targets.libraries.flatMap(({ nativePaths }) => nativePaths),
        ...targets.portable.flatMap(({ path, manifest }) => manifest.tracks.flatMap((track) => track.media.kind !== 'local' ? []
          : [track.media.originalPath, ...(track.media.relativePath === null ? [] : [join(dirname(path), track.media.relativePath)])]))];
      const keys = new Map<string, string>();
      const paths = [...new Set(referencedPaths)];
      for (let offset = 0; offset < paths.length; offset += 32) {
        await Promise.all(paths.slice(offset, offset + 32).map(async (path) => {
          try { keys.set(path, await seratoMediaPathKey(await resolveSeratoMediaPath(path))); } catch (error) {
            if (!(error instanceof Error && 'code' in error && ['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM'].includes(String(error.code)))) throw error;
            keys.set(path, `path:${normalizePath(path)}`);
          }
        }));
        this.organizationProgress(owner, 'validating', Math.min(offset + 32, paths.length), paths.length);
      }
      const seratoTargets = targets.libraries.flatMap(({ target, nativePaths, duplicatePaths }) => target.kind === 'sqlite' || target.kind === 'legacy'
        ? [{ target, keys: new Set(nativePaths.map((path) => keys.get(path))), duplicateKeys: new Set(duplicatePaths.map((path) => keys.get(path))) }] : []);
      const plan = await planLibraryOrganization(this.arsenalLibrary, { ...request, operation }, referencedPaths, relink ? targets.libraries.flatMap((target) => target.cloudLocalPaths) : [],
        !relink ? [] : [...targets.portable.flatMap(({ path, manifest }) => manifest.tracks.flatMap((track) =>
          track.media.kind === 'local' && track.media.relativePath !== null ? [join(dirname(path), track.media.relativePath)] : [])),
          ...this.backups.filter((backup) => backup.includeMusic).flatMap((backup) => ['Music', 'media'].map((name) => join(backup.directory, name)))], async (from, to) => {
          const key = await seratoMediaPathKey(from);
          for (const source of seratoTargets) if (relink && source.keys.has(key)) {
            if (source.duplicateKeys.has(key)) throw new Error('Multiple Serato SQLite assets share this audio file; keep their current paths');
            await validateSeratoOrganizationDestination(source.target, to);
          }
        }, (completed, total) => this.organizationProgress(owner, 'validating', completed, total));
      const destinations = new Map<string, string>();
      const moves = plan.preview.entries.filter((entry) => entry.kind === 'move');
      for (let offset = 0; offset < moves.length; offset += 32) {
        await Promise.all(moves.slice(offset, offset + 32).map(async (entry) => { destinations.set(await seratoMediaPathKey(entry.from), entry.to); }));
        this.organizationProgress(owner, 'validating', Math.min(offset + 32, moves.length), moves.length);
      }
      const replacements = new Map<string, string>();
      for (const [path, key] of keys) {
        const destination = destinations.get(key);
        if (destination !== undefined) replacements.set(normalizePath(path), destination);
      }
      for (const entry of plan.preview.entries) if (entry.kind === 'move') replacements.set(normalizePath(entry.from), entry.to);
      readLibraryModel(relocatedLibrary(this.arsenalLibrary, replacements));
      if (await this.organizationTargetState(targets) !== targetState) throw new Error('A connected library changed during preview. Preview again.');
      this.organizationPlan = { revision: catalog.revision, plan, targets, replacements, targetState };
      return plan.preview;
    }, false);
  }

  private organizationError(error: unknown): string {
    return error instanceof RekordboxRunningError ? 'Close Rekordbox and try again.'
      : error instanceof Error ? error.message : 'Could not reorganize the library.';
  }

  private async assertOrganizationClosed(targets: Awaited<ReturnType<RekordboxLibrary['organizationTargets']>>): Promise<void> {
    try {
      if (targets.libraries.some(({ target }) => target.kind === 'rekordbox-database' || target.kind === 'xml' && target.libraryKind === 'rekordbox')) await assertRekordboxClosed();
      if (targets.libraries.some(({ target }) => target.kind === 'sqlite' || target.kind === 'legacy' || target.kind === 'xml' && target.libraryKind === 'serato')) await assertSeratoClosed();
    } catch (error) { throw new Error(this.organizationError(error)); }
  }

  private registerOrganizationBackup(journal: OrganizationJournal, kind: OrganizationRestore['kind'], libraryKind?: OrganizationRestore['libraryKind'], keepRecovery = false) {
    return async (backup: LibraryFileBackup): Promise<void> => {
      const index = journal.restores.findIndex((restore) => restore.path === backup.path);
      let previous = journal.restores[index];
      if (previous !== undefined && previous.backupPath !== backup.backupPath) {
        try { await assertOrganizationRestore({ ...previous, path: backup.backupPath }); } catch (error) {
          if (!keepRecovery) throw error;
          // Preserve later edits in the fresh Undo backup.
          previous = undefined;
        }
      }
      const restore: OrganizationRestore = { ...backup, kind, ...(libraryKind === undefined ? {} : { libraryKind }),
        backupPath: previous?.backupPath ?? backup.backupPath,
        expectedHashes: [...new Set([...previous?.expectedHashes ?? [], ...backup.expectedHashes ?? [],
          ...previous?.expectedHash ? [previous.expectedHash] : [], ...backup.expectedHash ? [backup.expectedHash] : []])],
        ...(backup.databaseHashes || previous?.databaseHashes ? { databaseHashes: [...new Set([...previous?.databaseHashes ?? [], ...backup.databaseHashes ?? []])] } : {}),
      };
      if (index < 0) journal.restores.push(restore);
      else journal.restores[index] = restore;
      // A fresh Keep backup may already reference destinations that Undo must retain.
      if (keepRecovery && previous === undefined) journal.preserveDestinations = true;
      await appendOrganizationJournal(this.organizationJournalPath, { moves: [], restores: [restore], createdDirectories: [],
        ...(journal.preserveDestinations ? { preserveDestinations: true } : {}) });
    };
  }

  private async relinkOrganization(owner: BrowserWindow, targets: Awaited<ReturnType<RekordboxLibrary['organizationTargets']>>,
    replacements: ReadonlyMap<string, string>, journal: OrganizationJournal, keepRecovery = false): Promise<string[]> {
    const warnings: string[] = [];
    const progress = (phase: LibraryOrganizationProgress['phase'], completed: number, total: number) => this.organizationProgress(owner, phase, completed, total);
    const assertClosed = () => this.assertOrganizationClosed(targets);
    progress('relinking', 0, targets.libraries.length + targets.portable.length + 1);
    let completed = 0;
    for (const { target, nativePaths } of targets.libraries) {
      const repairs = [...new Map(nativePaths.map((path) => [normalizePath(path), path])).values()].flatMap((missingPath) => {
        const replacementPath = replacements.get(normalizePath(missingPath));
        return replacementPath === undefined || replacementPath === missingPath ? [] : [{ missingPath, replacementPath }];
      });
      if (repairs.length) {
        await assertClosed();
        const options = { mode: 'reorganize', forceBackup: true, onBackup: this.registerOrganizationBackup(journal, target.kind, target.kind === 'xml' ? target.libraryKind : undefined, keepRecovery) } satisfies Parameters<typeof repairRekordboxDatabaseFiles>[2];
        const result: LibraryFilesRepairResult = target.kind === 'rekordbox-database' ? await repairRekordboxDatabaseFiles(target.path, repairs, options)
          : target.kind === 'xml' ? await repairRekordboxMissingFiles(target.path, repairs, options) : { ...await repairSeratoMissingFiles(target, repairs, options), failures: [] };
        warnings.push(...result.warnings);
        if (result.failures.length) throw new Error(result.failures.map((failure) => `${failure.path}: ${failure.message}`).join(' '));
      }
      progress('relinking', ++completed, targets.libraries.length + targets.portable.length + 1);
    }
    for (const portable of targets.portable) {
      const tracks = portable.manifest.tracks.map((track) => {
        if (track.media.kind !== 'local') return track;
        const replacement = replacements.get(normalizePath(track.media.originalPath));
        return replacement === undefined || replacement === track.media.originalPath ? track : { ...track, media: { ...track.media, originalPath: replacement } };
      });
      if (tracks.some((track, index) => track !== portable.manifest.tracks[index])) {
        await saveRepairedLibraryFiles([{ path: portable.path, before: portable.before,
          after: Buffer.from(`${JSON.stringify({ ...portable.manifest, tracks }, null, 2)}\n`) }], assertClosed, { onBackup: this.registerOrganizationBackup(journal, 'portable', undefined, keepRecovery) });
      }
      progress('relinking', ++completed, targets.libraries.length + targets.portable.length + 1);
    }
    await assertClosed();
    const relocated = relocatedLibrary(this.arsenalLibrary, replacements);
    await saveRepairedLibraryFiles([
      { path: this.arsenalPath, before: await readFile(this.arsenalPath),
        after: Buffer.from(`${JSON.stringify({ format: 'arsenal-library', version: 1, library: readLibraryModel(relocated) })}\n`) },
      { path: this.arsenalWorkspace, before: await readFile(this.arsenalWorkspace), after: Buffer.from(mergeRekordboxXml(relocated)) },
    ].filter(({ before, after }) => !before.equals(after)), assertClosed, { onBackup: this.registerOrganizationBackup(journal, 'arsenal', undefined, keepRecovery) });
    this.arsenalLibrary = relocated;
    progress('relinking', ++completed, targets.libraries.length + targets.portable.length + 1);
    return warnings;
  }

  private async acceptedOrganizationSource(connection: StoredLibraryConnection, source: LibrarySourceSnapshot,
    replacements: ReadonlyMap<string, string>, journal: OrganizationJournal): Promise<StoredLibraryConnection | null> {
    if (source.library !== null) {
      let snapshot: SyncLibrary;
      try { snapshot = readLibraryModel(JSON.parse(await readFile(this.sourceSnapshotPath(connection.id), 'utf8'))); } catch { return null; }
      const relocated = relocatedLibrary(snapshot, replacements);
      const expected = connection.kind === 'serato' ? await resolveSeratoLibraryPaths(relocated) : relocated;
      if (describeLibraryChanges(expected, source.library).length || describeLibraryChanges(source.library, expected).length) return null;
      const tracks = new Map(expected.tracks.map((track) => [normalizePath(track.path), track]));
      if (source.library.tracks.some((track) => {
        const previous = tracks.get(normalizePath(track.path));
        return previous === undefined || normalizePath(previous.location ?? previous.path) !== normalizePath(track.location ?? track.path) ||
          !isDeepStrictEqual(previous.performance?.beatgrids ?? [], track.performance?.beatgrids ?? []);
      })) return null;
      return this.acceptedSource(connection, source);
    }
    const path = source.portableManifestPath;
    if (path === null) return null;
    const target = journal.targets?.find((target) => target.path === path);
    const restore = journal.restores.find((restore) => restore.kind === 'portable' && restore.path === path);
    const manifest = await readPortableLibrary(path);
    const before = restore === undefined ? manifest : await readPortableLibrary(restore.backupPath);
    const expected = { ...before, tracks: before.tracks.map((track) => track.media.kind !== 'local' ? track
      : { ...track, media: { ...track.media, originalPath: replacements.get(normalizePath(track.media.originalPath)) ?? track.media.originalPath } }) };
    const expectedHash = restore === undefined ? target?.manifestHash : organizationManifestHash(expected);
    if (expectedHash !== organizationManifestHash(manifest)) return null;
    return this.acceptedSource(connection, source, manifest);
  }

  private async finishOrganization(replacements: ReadonlyMap<string, string>, journal: OrganizationJournal): Promise<string[]> {
    this.missingSyncContext = null;
    this.cancelSuggestions();
    await this.writeArsenalProjection();
    this.catalog = await this.catalogFor(this.arsenalWorkspace, null, this.arsenalProjection);
    const warnings: string[] = [];
    const connections: StoredLibraryConnection[] = [];
    for (const connection of this.connectedLibraries) {
      if (connection.origin === 'arsenal') { connections.push(connection); continue; }
      let updated = connection.portableSource === undefined ? connection : { ...connection, portableSource: { ...connection.portableSource,
        resolvedPaths: (connection.portableSource.resolvedPaths ?? []).map((path) => replacements.get(normalizePath(path)) ?? path),
        resolvedTrackPaths: Object.fromEntries(Object.entries(connection.portableSource.resolvedTrackPaths ?? {})
          .map(([id, path]) => [id, replacements.get(normalizePath(path)) ?? path])) } };
      try {
        const source = await readLibrarySource(updated);
        const accepted = journal.acceptedConnections?.includes(connection.id)
          ? await this.acceptedOrganizationSource(updated, source, replacements, journal) : null;
        if (accepted !== null) {
          updated = accepted;
          this.startupChanges.delete(connection.id);
          this.startupSources.delete(connection.id);
        } else if (source.fingerprint !== connection.sourceFingerprint ||
          source.portableManifestPath !== null && source.portableManifestPath !== connection.portableSource?.manifestPath) {
          this.startupChanges.add(connection.id);
          this.startupSources.set(connection.id, source);
        }
        this.startupUnreadable.delete(connection.id);
      } catch (error) {
        this.startupUnreadable.add(connection.id);
        warnings.push(`${connection.displayName ?? basename(connection.path)}: ${error instanceof Error ? error.message : 'Could not check this connection.'}`);
      }
      connections.push(updated);
    }
    this.connectedLibraries = connections;
    if (!await this.remember(this.rememberedPath)) throw new Error('Could not save connection settings. Keep the journal and retry recovery.');
    return warnings;
  }

  applyOrganization(owner: BrowserWindow, id: string): Promise<LibraryOrganizationResult> {
    return this.enqueue(async () => {
      const pending = this.organizationPlan;
      this.organizationPlan = null;
      if (pending === null || pending.plan.preview.id !== id || pending.revision !== this.requireCatalog().revision) {
        throw new Error('The library changed. Preview the reorganization again.');
      }
      if (this.organizationRecovery !== null) throw new Error('Undo or keep the unfinished reorganization before reorganizing files.');
      if (this.pendingRekordboxSync !== null || this.startupChanges.size || this.startupUnreadable.size) {
        throw new Error('Resolve pending library changes in Connections before reorganizing files.');
      }
      const { plan, targets, replacements } = pending;
      const operation = plan.preview.operation;
      const copy = operation.kind === 'copy';
      const relink = operation.kind === 'move' || operation.useCopies;
      const progress = (phase: LibraryOrganizationProgress['phase'], completed: number, total: number) => this.organizationProgress(owner, phase, completed, total);
      progress('validating', 0, 1);
      if (await this.organizationTargetState(targets, (completed, total) => progress('validating', completed, total)) !== pending.targetState) throw new Error('A connected library changed. Preview the reorganization again.');
      const assertClosed = () => this.assertOrganizationClosed(targets);
      if (relink) await assertClosed();
      if (copy && relink && await organizationDestination(plan.preview.destinationRoot) !== 'internal') throw new Error('Copied files can only replace the active library on a verified internal drive.');
      await validateOrganizationPlan(plan, (completed, total) => progress('validating', completed, total));
      const moves = plan.preview.entries.filter((entry) => entry.kind === 'move');
      if (!moves.length) return { fileCount: 0, operation, backupPaths: [], warnings: [] };
      const journal: OrganizationJournal = { operation, moves: moves.map((move) => ({ from: move.from, to: move.to,
        temporary: join(dirname(move.to), `.arsenal-${randomUUID()}.tmp`), sha256: null, stamp: plan.stamps.get(move.from) ?? null,
        destinationStamp: null, rollbackStamp: null, completed: false })), restores: [], createdDirectories: [], replacements: [...replacements], acceptedConnections: targets.acceptedConnections,
        targets: [...targets.libraries.map(({ target, nativePaths }) => ({ path: target.path, paths: nativePaths.filter((path) => replacements.has(normalizePath(path))) })),
          ...targets.portable.map(({ path, manifest }) => ({ path, manifestHash: organizationManifestHash(manifest),
            paths: manifest.tracks.flatMap((track) => track.media.kind === 'local' && replacements.has(normalizePath(track.media.originalPath)) ? [track.media.originalPath] : []) }))] };
      await writeOrganizationJournal(this.organizationJournalPath, journal);
      this.organizationRecovery = journal;
      const warnings: string[] = [];
      const originalLibrary = this.arsenalLibrary;
      try {
        progress(copy ? 'copying' : 'moving', 0, moves.length);
        for (const [index, move] of moves.entries()) {
          const record = journal.moves[index];
          if (record === undefined) throw new Error('The move journal is incomplete.');
          await createOrganizationDirectory(plan.preview.destinationRoot, dirname(move.to), journal.createdDirectories, async (directory) => {
            await appendOrganizationJournal(this.organizationJournalPath, { moves: [], restores: [], createdDirectories: [directory] });
          });
          await validateOrganizationPlan({ ...plan, preview: { ...plan.preview, entries: [move] } });
          const options = {
            onCopy: async (sha256) => { record.sha256 = sha256; await appendOrganizationJournal(this.organizationJournalPath, { moves: [record], restores: [], createdDirectories: [] }); },
            onDestination: async (stamp, installed) => { record.installed = installed; record.destinationStamp = stamp; await appendOrganizationJournal(this.organizationJournalPath, { moves: [record], restores: [], createdDirectories: [] }); },
          } satisfies NonNullable<Parameters<typeof installMusicFile>[2]>;
          if (copy) await installMusicFile(move.from, move.to, { ...options, copyOnly: true });
          else await moveMusicFile(move.from, move.to, record.temporary, options);
          record.destinationStamp = await organizationFileStamp(move.to);
          record.completed = true;
          await appendOrganizationJournal(this.organizationJournalPath, { moves: [record], restores: [], createdDirectories: [] });
          progress(copy ? 'copying' : 'moving', index + 1, moves.length);
        }
        if (relink) await assertClosed();
        if (copy && relink && await organizationDestination(plan.preview.destinationRoot) !== 'internal') throw new Error('The destination is no longer a verified internal drive. Original library paths were kept.');
        if (await this.organizationTargetState(targets, (completed, total) => progress('validating', completed, total)) !== pending.targetState) throw new Error('A connected library changed while files moved. Preview again.');
        if (relink) warnings.push(...await this.relinkOrganization(owner, targets, replacements, journal));
      } catch (error) {
        const message = this.organizationError(error);
        try {
          warnings.push(...await undoOrganization(journal, (completed, total) => progress('rolling-back', completed, total), (move) => appendOrganizationJournal(this.organizationJournalPath, { moves: [move], restores: [], createdDirectories: [] })));
          this.arsenalLibrary = originalLibrary;
          if (relink) warnings.push(...await this.finishOrganization(new Map(moves.map((move) => [normalizePath(move.to), move.from])), journal));
          await rm(this.organizationJournalPath);
          this.organizationRecovery = null;
        } catch (recoveryError) {
          try {
            this.arsenalLibrary = await loadArsenalLibrary(this.arsenalPath) ?? this.arsenalLibrary;
            this.arsenalProjection = await parseRekordboxXml(this.arsenalWorkspace);
            this.catalog = await this.catalogFor(this.arsenalWorkspace, null, this.arsenalProjection);
          } catch { warnings.push('Reload Arsenal after completing recovery.'); }
          throw new Error(`${message} ${this.organizationError(recoveryError)} ${warnings.join(' ')} Journal: ${this.organizationJournalPath}. Backups: ${journal.restores.map((restore) => restore.backupPath).join(', ')}`);
        }
        throw new Error(`${message} ${copy ? 'Copies were removed and original files kept.' : 'Moved files and connected libraries were restored.'} ${warnings.join(' ')}`.trim());
      }
      if (relink) warnings.push(...await this.finishOrganization(replacements, journal));
      await rm(this.organizationJournalPath);
      this.organizationRecovery = null;
      return { fileCount: moves.length, operation, backupPaths: journal.restores.map((restore) => restore.backupPath), warnings };
    });
  }

  resolveSyncMissingFile(owner: BrowserWindow, action: SyncMissingFileAction): Promise<SyncResult> {
    return this.enqueue(async () => {
      const context = this.missingSyncContext;
      if (context === null) return { kind: 'rejected', warnings: [], backupPaths: [], message: 'Run sync again to check the current libraries for missing files.' };
      const repairedPaths = new Set<string>();
      const failures: string[] = [];
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
        const batch: { missingPath: string; replacementPath: string | null }[] = [];
        for (const missing of missingFiles) {
          const replacementPath = replacements.get(normalizePath(missing.path)) ?? null;
          if (replacementPath !== null && !isSupportedAudioPath(replacementPath)) {
            context.result = { ...context.result, warnings: [...context.result.warnings, `${missing.path}: Choose a supported audio file.`] };
            continue;
          }
          if (replacementPath !== null) context.result = { ...context.result, files: context.result.files.map((file) => file.path === missing.path
            ? { ...file, candidates: [...new Set([replacementPath, ...file.candidates])] } : file) };
          batch.push({ missingPath: missing.path, replacementPath });
        }
        // Each library is read, backed up and written once for the whole batch.
        const targets = [...libraries].sort((left, right) => Number(left.target.kind === 'xml') - Number(right.target.kind === 'xml'));
        for (const { target, library } of targets) {
          const present = new Set(library.tracks.map((track) => normalizePath(track.path)));
          const repairs = batch.filter((repair) => present.has(normalizePath(repair.missingPath)));
          if (!repairs.length) continue;
          const name = target.kind === 'rekordbox-database' ? 'Rekordbox Collection' : basename(target.path);
          const describe = (error: unknown): string => error instanceof RekordboxRunningError ? 'Close Rekordbox, then try again.'
            : error instanceof Error ? error.message : 'Could not repair the connected library.';
          try {
            let result: { backupPaths: readonly string[]; warnings: readonly string[]; failures: readonly { path: string; message: string }[] };
            if (target.kind === 'rekordbox-database') result = await repairRekordboxDatabaseFiles(target.path, repairs);
            else if (target.kind === 'xml') result = await repairRekordboxMissingFiles(target.path, repairs);
            else {
              const backupPaths: string[] = [];
              const warnings: string[] = [];
              const failed: { path: string; message: string }[] = [];
              for (const repair of repairs) {
                try {
                  const repaired = await repairSeratoMissingFile(target, repair.missingPath, repair.replacementPath);
                  backupPaths.push(...repaired.backupPaths);
                  warnings.push(...repaired.warnings);
                } catch (error) { failed.push({ path: repair.missingPath, message: describe(error) }); }
              }
              result = { backupPaths, warnings, failures: failed };
            }
            if (result.failures.length < repairs.length) repairedPaths.add(normalizePath(target.path));
            failures.push(...result.failures.map((failure) => `${basename(failure.path)} in ${name}: ${failure.message}`));
            context.result = { ...context.result, backupPaths: [...context.result.backupPaths, ...result.backupPaths],
              warnings: [...context.result.warnings, ...result.warnings] };
          } catch (error) {
            failures.push(`${repairs.length === 1 ? basename(repairs[0]?.missingPath ?? '') : `${repairs.length} files`} in ${name}: ${describe(error)}`);
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
          this.catalog = await this.commitArsenalProjection();
          this.cancelSuggestions();
        } catch (error) {
          context.result = { ...context.result, warnings: [...context.result.warnings,
            `Arsenal could not refresh its library: ${error instanceof Error ? error.message : 'Could not read the repaired collection.'}`] };
        }
      }
      await this.acknowledgeWrites(this.connectedLibraries.filter((connection) => repairedPaths.has(normalizePath(connection.path))).map((connection) => connection.id));
      return failures.length ? { kind: 'rejected', message: failures.join(' '), warnings: [], backupPaths: [] } : context.result;
    });
  }

  private defaultSeratoPath(): string {
    if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Serato', 'Library');
    if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Serato', 'Library');
    return join(homedir(), 'Music', '_Serato_');
  }

  private mutationWarning: string | undefined;

  mutate(change: LibraryMutation): Promise<LibraryMutationResult> {
    return this.enqueue(async () => {
      this.mutationWarning = undefined;
      const result = await this.applyMutation(change);
      if (result.kind === 'rejected' || result.kind === 'duplicate-ignored') return result;
      this.requestOngoingSync();
      return this.mutationWarning === undefined ? result : { ...result, warning: this.mutationWarning };
    });
  }

  private requireCatalog(): CurrentCatalog {
    if (this.catalog === null) {
      throw new Error('No library is open');
    }
    return this.catalog;
  }

  private enqueue<T>(work: () => Promise<T>, updateBackups = true): Promise<T> {
    const operation = this.operationTail.then(work).finally(() => {
      if (updateBackups) this.requestBackup();
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
    const group = (await this.findDuplicates(change.mode)).groups.find(
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
      scan: await this.findDuplicates(change.mode),
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
    const { keepSongIds, ...removal } = change;
    if (keepSongIds !== undefined) {
      const visible = new Set(catalog.songs.map((song) => song.id));
      for (const playlist of catalog.playlists) {
        if (playlist.kind !== 'regular') continue;
        const ids = [...new Set(playlist.tracks.map((song) => song.id).filter((id) => visible.has(id)))];
        const present = new Set(ids);
        const next = ids.flatMap((id) => {
          const keepId = keepSongIds[id];
          if (keepId === undefined || present.has(keepId) || !visible.has(keepId) || songIds.has(keepId)) return [id];
          present.add(keepId);
          return [id, keepId];
        });
        if (next.length === ids.length) continue;
        const result = await this.setPlaylistTracks(this.requireCatalog(),
          { kind: 'set-playlist-tracks', revision: change.revision, playlistId: playlist.id, songIds: next });
        if (result.kind === 'rejected') return result;
      }
      return this.removeSongs(this.requireCatalog(), removal);
    }

    const remaining = catalog.tracks.filter((track) => !songIds.has(track.song.id));
    const before = this.arsenalLibrary;
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
    // Native Rekordbox Collections only receive additions and updates from syncs, so removals are queued for the next sync.
    const kept = new Set(this.arsenalLibrary.tracks.map((track) => normalizePath(track.location ?? track.path)));
    const removedPaths = before.tracks.map((track) => track.location ?? track.path).filter((path) => !kept.has(normalizePath(path)));
    if (removedPaths.length) {
      const previousConnections = this.connectedLibraries;
      this.connectedLibraries = this.connectedLibraries.map((connection) => connection.kind === 'rekordbox' && isRekordboxDatabasePath(connection.path)
        ? { ...connection, removedTrackPaths: [...new Set([...connection.removedTrackPaths ?? [], ...removedPaths])] } : connection);
      if (!await this.remember(this.rememberedPath)) {
        this.connectedLibraries = previousConnections;
        this.mutationWarning = 'Removed in Arsenal, but the removal could not be queued for Rekordbox. Check disk space and permissions.';
      }
    }
    const handledPaths = new Set<string>();
    const fileActions: LocalFileAction[] = [];
    // A remaining entry may reach the same file through a differently spelled path.
    const remainingFiles = change.removeLocalFile ? new Set(await Promise.all(remaining.flatMap((track) =>
      track.mediaPath === null ? [] : [seratoMediaPathKey(track.mediaPath)]))) : new Set<string>();
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
        ) || (track.mediaPath !== null && remainingFiles.has(await seratoMediaPathKey(track.mediaPath))),
      }));
    }
    if (fileActions.includes('trashed') && this.activeConnectionId !== null) await this.acknowledgeWrites([this.activeConnectionId]);
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
    const reload = await this.writeAndReload(catalog, { kind: 'move-playlist-node', ...move });
    if (reload.kind === 'rejected') return reload;
    this.catalog = reload.catalog;
    for (const connection of this.savedSyncPreferences.request?.fields.playlists ? this.ongoingEditTargets() : []) {
      if (connection.kind === 'rekordbox' && isRekordboxDatabasePath(connection.path)) continue;
      try {
        if (connection.kind === 'serato') await moveSeratoNode(await findSeratoSource(connection.path), move);
        else {
          const target = await parseRekordboxXml(connection.path);
          await editRekordboxXml({ filePath: connection.path, expectedFingerprint: target.fingerprint, edit: { kind: 'move-playlist-node', ...move } });
        }
        await this.acknowledgeWrites([connection.id]);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not sync the playlist move.';
        await this.pauseOngoingSync(message);
        this.mutationWarning = `Saved in Arsenal. Ongoing sync paused: ${message}`;
        break;
      }
    }
    this.cancelSuggestions();
    return { kind: 'playlist-node-moved', library: summaryFor(this.catalog), sourcePath: move.sourcePath,
      destinationPath: [...move.parentPath, move.sourcePath.at(-1) ?? ''] };
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
    const followers: { connection: StoredLibraryConnection; save: () => Promise<void> }[] = [];
    let syncError: string | null = null;
    for (const connection of this.ongoingEditTargets()) {
      try {
        if (connection.kind === 'rekordbox' && isRekordboxDatabasePath(connection.path)) {
          const request = this.savedSyncPreferences.request;
          if (request !== null) await this.stageRekordboxSync(connection, request);
          continue;
        }
        if (edit.kind === 'move-playlist-node') continue;
        const fields = this.savedSyncPreferences.request?.fields;
        const save = await preparePrimaryLibraryEdit({ sourcePath: catalog.sourcePath, expectedFingerprint: catalog.fingerprint,
          edit, primary: connection, ...(fields ? { fields } : {}) });
        followers.push({ connection, save });
      } catch (error) { syncError = error instanceof Error ? error.message : 'The destination could not accept this edit.'; }
    }
    let reloaded: CurrentCatalog;
    try {
      await editRekordboxXml({ edit, expectedFingerprint: catalog.fingerprint, filePath: this.arsenalWorkspace });
      reloaded = await this.commitArsenalProjection(edit);
    } catch (error) {
      return { kind: 'rejected', reason: error instanceof RekordboxWriteError && error.reason === 'source-changed' ? 'source-changed' : 'cannot-write',
        message: error instanceof Error ? error.message : 'Could not save your Arsenal library.' };
    }
    for (const follower of followers) {
      try { await follower.save(); await this.acknowledgeWrites([follower.connection.id]); }
      catch (error) { syncError = error instanceof Error ? error.message : 'The destination could not accept this edit.'; }
    }
    if (syncError !== null) {
      await this.pauseOngoingSync(syncError);
      this.mutationWarning = `Saved in Arsenal. Ongoing sync paused: ${syncError}`;
    }
    return { kind: 'ready', catalog: reloaded };
  }

  private async catalogFor(filePath: string, seratoPath: string | null = null, snapshot: ParsedRekordboxLibrary | null = null): Promise<CurrentCatalog> {
    const parsed = snapshot ?? await parseRekordboxXml(filePath);
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
      sourceName: filePath === this.arsenalWorkspace ? 'Arsenal library' : this.connectedLibraries.find((connection) => connection.path === (seratoPath ?? filePath))?.displayName
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
      connections: this.connectedLibraries, activeConnectionId: this.activeConnectionId, sourceOfTruthId: this.sourceOfTruthId, backups: this.backups,
      syncBaseline: this.syncBaseline, ongoingSyncPause: this.ongoingSyncPause, pendingRekordboxSync: this.pendingRekordboxSync });
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
