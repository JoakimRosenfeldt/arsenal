import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { DEFAULT_MINIMUM_SONG_LENGTH_SECONDS } from './shared/preferences';

import {
  CueboxPlayer,
  type PlaybackController,
} from './CueboxPlayer';
import {
  CueboxSidebar,
  type PageId,
} from './CueboxSidebar';
import {
  DuplicatesPage,
  LibraryPage,
  PlaylistsPage,
  type LibraryView,
} from './CueboxPages';
import {
  SONG_PAGE_SIZE,
  DEFAULT_SONG_FILTERS,
  songMetadataGapCount,
  type DuplicateMatchMode,
  type DuplicateScan,
  type ImportFailure,
  type LibraryConnections,
  type LibraryConnectionResult,
  type LibrarySummary,
  type LibraryStatus,
  type LibraryStartupPreview,
  type LibraryStartupResult,
  type LibraryMutation,
  type LibraryMutationResult,
  type MutationFailure,
  type RekordboxPlaylist,
  type PlaylistWindowContext,
  type PlaylistWindowRequest,
  type PlaylistFolder,
  type SongRow,
  type SongFilters,
  type SyncResult,
} from './shared/dj-library';

import { FolderCreator, SmartPlaylistEditor } from './SmartPlaylistEditor';
import { TracklistExportDialog } from './TracklistExportDialog';
import { LibraryChangesDialog } from './LibraryChangesDialog';
import { LibraryConnectionsPage } from './LibraryConnectionsPage';
import { Preferences } from './Preferences';
import type { SmartPlaylistDefinition } from './shared/smart-playlists';

type DisplayError = ImportFailure | MutationFailure | 'unexpected';

type Feedback = Readonly<{
  tone: 'warning';
  message: string;
}>;

export type DuplicateViewState =
  | Readonly<{ kind: 'empty' }>
  | Readonly<{
      kind: 'ready';
      libraryVersion: string;
      scan: DuplicateScan;
    }>
  | Readonly<{
      kind: 'error';
      libraryVersion: string;
      mode: DuplicateMatchMode;
    }>;

const errorMessages: Readonly<Record<DisplayError, string>> = {
  'cannot-read': 'Could not open this file.',
  'not-rekordbox-xml':
    'Not a Rekordbox Collection export. In Rekordbox, use File > Library > Export Collection in xml format.',
  'not-serato-library': 'Choose a Serato library or _Serato_ folder.',
  'cannot-save-library': 'Could not save the connection. Check disk space and permissions.',
  'malformed-xml': 'This file is damaged. Export the collection again.',
  'stale-library': 'The library changed. Try again.',
  'source-changed': 'The library file changed. Import it again from Connections.',
  'song-not-found': 'That track is no longer in the library.',
  'duplicate-not-found': 'That duplicate group no longer exists.',
  'cannot-save-preferences': 'Could not ignore this group. Try again.',
  'invalid-playlist': 'Could not save this playlist.',
  'name-conflict': 'That name is already used here.',
  'folder-not-found': 'That folder no longer exists.',
  'playlist-sync-needed': 'Sync playlists before moving this one.',
  'serato-open': 'Close Serato before moving playlists and folders.',
  'cannot-write': 'Could not save the library. Check file permissions.',
  unexpected: 'Something went wrong. Restart Arsenal and try again.',
};

const feedbackForRemoval = (
  result: Extract<LibraryMutationResult, { kind: 'songs-removed' }>,
): Feedback | null => {
  const warnings = {
    shared: 'Kept files used by other tracks.',
    missing: 'Some files were not found.',
    unsupported: 'Kept files that are not audio.',
    failed: 'Some files could not be moved to Trash.',
  };
  const problems = [...new Set(result.fileActions)].flatMap((action) =>
    action === 'kept' || action === 'trashed' ? [] : [warnings[action]],
  );
  return problems.length === 0 ? null : { tone: 'warning', message: problems.join(' ') };
};

type PlaylistTree = Readonly<{
  playlists: readonly RekordboxPlaylist[];
  folders: readonly PlaylistFolder[];
}>;

const playlistPath = (node: RekordboxPlaylist | PlaylistFolder): readonly string[] =>
  'tracks' in node ? [...node.folderPath, node.name] : node.folderPath;

const movePlaylistTree = (
  tree: PlaylistTree,
  sourcePath: readonly string[],
  parentPath: readonly string[],
  beforePath: readonly string[] | null,
): PlaylistTree | null => {
  const key = (path: readonly string[]): string => JSON.stringify(path);
  const moved = [...tree.folders, ...tree.playlists].filter((node) => key(playlistPath(node)) === key(sourcePath));
  const node = moved[0];
  const parent = parentPath.length === 0 ? null : tree.folders.find((folder) => key(folder.folderPath) === key(parentPath));
  const parentId = parent?.id ?? null;
  const name = sourcePath.at(-1);
  if (moved.length !== 1 || node === undefined || name === undefined || (parentPath.length > 0 && parent === undefined) ||
    (beforePath !== null && ![...tree.folders, ...tree.playlists].some((candidate) =>
      candidate.id !== node.id && candidate.parentFolderId === parentId && key(playlistPath(candidate)) === key(beforePath))) ||
    (!('tracks' in node) && key(parentPath.slice(0, sourcePath.length)) === key(sourcePath)) ||
    [...tree.folders, ...tree.playlists].some((candidate) => candidate.id !== node.id &&
      candidate.parentFolderId === parentId && candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return null;
  }
  const destinationPath = [...parentPath, name];
  const movedFolder = 'tracks' in node ? null : node;
  const inMovedFolder = (path: readonly string[]): boolean => movedFolder !== null &&
    key(path.slice(0, sourcePath.length)) === key(sourcePath);
  const folders = tree.folders.map((folder) => ({ ...folder,
    folderPath: inMovedFolder(folder.folderPath)
      ? [...destinationPath, ...folder.folderPath.slice(sourcePath.length)] : folder.folderPath,
    parentFolderId: folder.id === movedFolder?.id ? parentId : folder.parentFolderId,
  }));
  const playlists = tree.playlists.map((playlist) => ({ ...playlist,
    folderPath: playlist.id === node.id ? parentPath : inMovedFolder(playlist.folderPath)
      ? [...destinationPath, ...playlist.folderPath.slice(sourcePath.length)] : playlist.folderPath,
    parentFolderId: playlist.id === node.id ? parentId : playlist.parentFolderId,
  }));
  const siblings = [...folders, ...playlists].filter((candidate) =>
    candidate.parentFolderId === parentId && candidate.id !== node.id).sort((left, right) => left.order - right.order);
  const position = beforePath === null ? siblings.length : siblings.findIndex((candidate) => key(playlistPath(candidate)) === key(beforePath));
  if (position < 0) return null;
  const reordered = [...siblings];
  const updated = [...folders, ...playlists].find((candidate) => candidate.id === node.id);
  if (updated === undefined) return null;
  reordered.splice(position, 0, updated);
  const order = new Map(reordered.map((candidate, index) => [candidate.id, index]));
  return {
    folders: folders.map((folder) => ({ ...folder, order: order.get(folder.id) ?? folder.order })),
    playlists: playlists.map((playlist) => ({ ...playlist, order: order.get(playlist.id) ?? playlist.order })),
  };
};

const loadPlaylistTree = async (): Promise<PlaylistTree> => {
  const [playlists, folders, order] = await Promise.all([
    window.djLibrary.listPlaylists(),
    window.djLibrary.listFolders(),
    window.djLibrary.playlistOrder(),
  ]);
  const positions = new Map(order.map((path, index) => [JSON.stringify(path), index]));
  return {
    playlists: playlists.map((playlist) => ({ ...playlist,
      order: positions.get(JSON.stringify([...playlist.folderPath, playlist.name])) ?? order.length + playlist.order,
    })),
    folders: folders.map((folder) => ({ ...folder,
      order: positions.get(JSON.stringify(folder.folderPath)) ?? order.length + folder.order,
    })),
  };
};

export const App = ({ playlistWindow }: Readonly<{ playlistWindow?: PlaylistWindowContext }>): JSX.Element => {
  const [editor, setEditor] = useState<(PlaylistWindowContext & { id: number; initialName?: string; smartDefinition?: SmartPlaylistDefinition }) | null>(playlistWindow ? { ...playlistWindow, id: 0 } : null);
  const editorSequence = useRef(0);
  const playlistEditor = editor?.request ?? null;
  const [activePage, setActivePage] = useState<PageId>(playlistWindow ? 'playlists' : 'library');
  const [loading, setLoading] = useState(true);
  const [minimumSongLengthSeconds, setMinimumSongLengthSeconds] = useState(DEFAULT_MINIMUM_SONG_LENGTH_SECONDS);
  const [operationBusy, setBusy] = useState(false);
  const operationPending = useRef(false);
  const pendingMutation = useRef<Promise<boolean> | null>(null);
  const navigationSequence = useRef(0);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [reloadSequence, setReloadSequence] = useState(0);
  const [backgroundSyncing, setBackgroundSyncing] = useState(false);
  const [backgroundLibrary, setBackgroundLibrary] = useState<LibraryStatus | null>(null);
  const handledBackgroundLibrary = useRef<LibraryStatus | null>(null);
  const busy = operationBusy || backgroundSyncing || reloadRequired;
  const [view, setView] = useState<LibraryView | null>(null);
  const [connections, setConnections] = useState<LibraryConnections | null>(null);
  const startupCheck = useRef<Promise<LibraryStartupPreview> | null>(null);
  const [startupPreview, setStartupPreview] = useState<LibraryStartupPreview | null>(null);
  const initialStateLoaded = useRef(false);
  const [startupSyncResult, setStartupSyncResult] = useState<Exclude<SyncResult, { kind: 'cancelled' }> | null>(null);
  const [playlists, setPlaylists] = useState<readonly RekordboxPlaylist[] | null>(null);
  const [folders, setFolders] = useState<readonly PlaylistFolder[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [exportPlaylistId, setExportPlaylistId] = useState<string | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const reportError = useCallback((message: string): void => setFeedback({ tone: 'warning', message }), []);
  const errorRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(DEFAULT_SONG_FILTERS);
  const [viewQuery, setViewQuery] = useState('');
  const [viewFilters, setViewFilters] = useState(DEFAULT_SONG_FILTERS);
  const [searching, setSearching] = useState(false);
  const searchSequence = useRef(0);
  const [duplicateMode, setDuplicateMode] =
    useState<DuplicateMatchMode>('smart');
  const [duplicateRefresh, setDuplicateRefresh] = useState(0);
  const [duplicateState, setDuplicateState] = useState<DuplicateViewState>({
    kind: 'empty',
  });
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playingSong, setPlayingSong] = useState<SongRow | null>(null);
  const [playbackQueue, setPlaybackQueue] = useState<readonly SongRow[]>([]);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const hasLibrary = view !== null;
  const libraryVersion = view?.library.revision ?? 'empty';
  const browseState = useRef({ query, filters, view, playlists });
  useEffect(() => { browseState.current = { query, filters, view, playlists }; }, [query, filters, view, playlists]);

  useEffect(() => {
    if (error === null && feedback === null) return;
    const dismissOutside = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (errorRef.current && !errorRef.current.contains(event.target)) setError(null);
      if (feedbackRef.current && !feedbackRef.current.contains(event.target)) setFeedback(null);
    };
    document.addEventListener('click', dismissOutside, true);
    return () => document.removeEventListener('click', dismissOutside, true);
  }, [error, feedback]);

  const showStartupResult = useCallback((startup: LibraryStartupResult): void => {
    setConnections(startup.connections);
    const syncResult = startup.syncResult?.kind === 'cancelled' ? null : startup.syncResult;
    setStartupSyncResult(syncResult);
    if (startup.warnings.length > 0) {
      setFeedback({ tone: 'warning', message: startup.warnings.join(' ') });
    }
    if (syncResult !== null || startup.warnings.length > 0) {
      setActivePage('connections');
    }
  }, []);

  useEffect(() => {
    if (playlistWindow) return;
    let active = true;
    startupCheck.current ??= window.djLibrary.checkStartupChanges();
    void startupCheck.current.then(async (preview) => {
      if (!active) return;
      if (preview.libraries.length > 0) {
        setStartupPreview(preview);
        return;
      }
      const startup = await window.djLibrary.resolveStartupChanges('skip');
      if (active) {
        showStartupResult(startup);
        setBackgroundLibrary(startup.status);
      }
    }).catch(() => {
      if (!active) return;
      setFeedback({ tone: 'warning', message: 'Could not check for library changes.' });
      setActivePage('connections');
    });
    return () => { active = false; };
  }, [playlistWindow, showStartupResult]);

  useEffect(() => {
    let active = true;

    const loadInitialState = async (): Promise<void> => {
      try {
        await pendingMutation.current;
        if (!active) return;
        const [status, settings, connected] = await Promise.all([
          window.djLibrary.status(), window.preferences.library(),
          playlistWindow ? Promise.resolve(null) : window.djLibrary.connections(),
        ]);
        if (!active) return;
        setConnections(connected);
        setMinimumSongLengthSeconds(settings.minimumSongLengthSeconds);
        if (playlistWindow && (status.kind === 'empty' || status.library.revision !== playlistWindow.request.revision)) {
          setError('stale-library');
          return;
        }
        if (status.kind === 'empty') {
          if (!playlistWindow) setActivePage('connections');
          initialStateLoaded.current = true;
          return;
        }

        const [page, tree] = await Promise.all([
          window.djLibrary.listSongs({
            offset: 0,
            limit: SONG_PAGE_SIZE,
          }),
          loadPlaylistTree(),
        ]);
        if (active) {
          if (!initialStateLoaded.current && !playlistWindow && connected !== null &&
            !connected.connections.some((connection) => connection.origin !== 'arsenal') &&
            status.library.totalSongCount === 0 && tree.playlists.length === 0 && tree.folders.length === 0) {
            setActivePage('connections');
          }
          initialStateLoaded.current = true;
          setView({ library: status.library, page });
          setPlaylists(tree.playlists);
          setFolders(tree.folders);
          setReloadRequired(false);
        }
      } catch {
        if (active) {
          setError('unexpected');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void loadInitialState();
    return () => {
      active = false;
    };
  }, [playlistWindow, minimumSongLengthSeconds, reloadSequence]);

  useEffect(() => {
    if (!hasLibrary || playlistWindow !== undefined || operationBusy) {
      return;
    }

    let active = true;

    void window.djLibrary
      .findDuplicates(duplicateMode)
      .then((scan) => {
        if (active) {
          setDuplicateState({
            kind: 'ready',
            libraryVersion,
            scan,
          });
        }
      })
      .catch(() => {
        if (active) {
          setDuplicateState({
            kind: 'error',
            libraryVersion,
            mode: duplicateMode,
          });
        }
      });

    return () => {
      active = false;
    };
  }, [duplicateMode, duplicateRefresh, hasLibrary, libraryVersion, playlistWindow, minimumSongLengthSeconds, operationBusy]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && ['f', 'k'].includes(event.key.toLocaleLowerCase())) {
        event.preventDefault();
        if (activePage === 'library') {
          document.getElementById('library-search')?.focus();
        }
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, [activePage]);

  const stopPlayback = useCallback((): void => {
    const audio = audioRef.current;
    audio?.pause();
    if (audio !== null) {
      audio.removeAttribute('src');
      audio.load();
    }
    setPlayingSong(null);
    setPlaybackQueue([]);
    setPlaying(false);
    setPosition(0);
    setAudioDuration(0);
    setPlaybackFailed(false);
  }, []);

  useEffect(() => window.preferences.onLibraryChanged((settings) => {
    if (settings.minimumSongLengthSeconds === minimumSongLengthSeconds) return;
    stopPlayback();
    searchSequence.current += 1;
    setSearching(false);
    setQuery('');
    setViewQuery('');
    setFilters(DEFAULT_SONG_FILTERS);
    setViewFilters(DEFAULT_SONG_FILTERS);
    setDuplicateState({ kind: 'empty' });
    setMinimumSongLengthSeconds(settings.minimumSongLengthSeconds);
  }), [minimumSongLengthSeconds, stopPlayback]);

  useEffect(() => {
    let active = true;
    let receivedActivity = false;
    const attentionMessage = 'Sync needs attention. See Connections.';
    const stopActivity = window.djLibrary.onSyncActivity((activity) => {
      receivedActivity = true;
      setBackgroundSyncing(activity.state === 'syncing');
      if (activity.state === 'attention') setFeedback({ tone: 'warning', message: attentionMessage });
      else setFeedback((current) => current?.message === attentionMessage ? null : current);
    });
    const stopChanges = window.djLibrary.onLibraryChanged((status) => {
      setBackgroundLibrary(status);
      if (playlistWindow && (status.kind === 'empty' || status.library.revision !== playlistWindow.request.revision)) {
        setError('stale-library');
      }
    });
    void window.djLibrary.syncActivity().then((activity) => {
      if (active && !receivedActivity) setBackgroundSyncing(activity.state === 'syncing');
    }).catch(() => undefined);
    return () => { active = false; stopActivity(); stopChanges(); };
  }, [playlistWindow]);

  useEffect(() => {
    if (playlistWindow || backgroundLibrary?.kind !== 'ready' || backgroundLibrary === handledBackgroundLibrary.current ||
      operationBusy || backgroundSyncing || loading) return;
    if (backgroundLibrary.library.revision === view?.library.revision) {
      handledBackgroundLibrary.current = backgroundLibrary;
      return;
    }
    let active = true;
    const sequence = ++searchSequence.current;
    void window.djLibrary.status().then(async (status) => {
      if (!active || sequence !== searchSequence.current || status.kind !== 'ready') return;
      const library = status.library;
      if (library.revision === view?.library.revision) {
        handledBackgroundLibrary.current = backgroundLibrary;
        return;
      }
      const [page, tree] = await Promise.all([
        window.djLibrary.searchSongs({ offset: Math.min(view?.page.offset ?? 0,
          Math.max(0, Math.floor(Math.max(0, library.songCount - 1) / SONG_PAGE_SIZE) * SONG_PAGE_SIZE)),
        limit: SONG_PAGE_SIZE, query, filters }),
        loadPlaylistTree(),
      ]);
      if (!active || sequence !== searchSequence.current) return;
      handledBackgroundLibrary.current = backgroundLibrary;
      setSearching(false);
      stopPlayback();
      setView({ library, page });
      setPlaylists(tree.playlists);
      setFolders(tree.folders);
      setSelectedPlaylistId((current) => tree.playlists.some((playlist) => playlist.id === current) ? current : null);
      setViewQuery(query);
      setViewFilters(filters);
      setDuplicateRefresh((current) => current + 1);
    }).catch(() => {
      if (active) setFeedback({ tone: 'warning', message: 'Sync finished, but the view could not refresh.' });
    });
    return () => { active = false; };
  }, [backgroundLibrary, operationBusy, backgroundSyncing, loading, view?.library.revision, view?.page.offset, playlistWindow, query, filters, stopPlayback]);

  const playSong = (song: SongRow, preserveQueue = false): void => {
    const audio = audioRef.current;
    if (audio === null || song.audioUrl === null) {
      return;
    }

    setPlaybackFailed(false);
    if (playingSong?.id === song.id) {
      if (audio.paused) {
        void audio.play().catch(() => setPlaybackFailed(true));
      } else {
        audio.pause();
      }
      return;
    }

    if (!preserveQueue) {
      const candidates = activePage === 'playlists' && playlistEditor === null
        ? playlists?.find((playlist) => playlist.id === selectedPlaylistId)?.tracks ?? []
        : view?.page.items ?? [];
      setPlaybackQueue(candidates.some((candidate) => candidate.id === song.id) ? candidates : [song]);
    }
    setPlayingSong(song);
    setPosition(0);
    setAudioDuration(song.durationSeconds ?? 0);
    audio.src = song.audioUrl;
    audio.load();
    void audio.play().catch(() => setPlaybackFailed(true));
  };

  const seekPlayback = (seconds: number): void => {
    const audio = audioRef.current;
    if (audio === null || playingSong === null) {
      return;
    }
    audio.currentTime = seconds;
    setPosition(seconds);
  };

  const playback: PlaybackController = {
    song: playingSong,
    playing,
    position,
    duration: audioDuration,
    failed: playbackFailed,
    play: playSong,
    seek: seekPlayback,
  };

  const refreshLibrary = async (library: LibrarySummary): Promise<void> => {
    const browsing = browseState.current;
    const sequence = searchSequence.current;
    const maxOffset = Math.max(0, Math.floor(Math.max(0, library.songCount - 1) / SONG_PAGE_SIZE) * SONG_PAGE_SIZE);
    const [page, tree] = await Promise.all([
      window.djLibrary.searchSongs({ offset: Math.min(browsing.view?.page.offset ?? 0, maxOffset),
        limit: SONG_PAGE_SIZE, query: browsing.query, filters: browsing.filters }),
      loadPlaylistTree(),
    ]);
    stopPlayback();
    if (sequence === searchSequence.current) {
      setSearching(false);
      setView({ library, page });
      setViewQuery(browsing.query);
      setViewFilters(browsing.filters);
    } else setView((current) => current === null ? null : { ...current, library });
    setPlaylists(tree.playlists);
    setFolders(tree.folders);
    setSelectedPlaylistId((current) => {
      const selected = browseState.current.playlists?.find((playlist) => playlist.id === current);
      return selected ? tree.playlists.find((playlist) =>
        JSON.stringify(playlistPath(playlist)) === JSON.stringify(playlistPath(selected)))?.id ?? null : null;
    });
  };

  const resolveStartupChanges = async (action: 'import' | 'skip'): Promise<void> => {
    if (operationPending.current) throw new Error('Another library action is still running.');
    operationPending.current = true;
    setBusy(true);
    searchSequence.current += 1;
    setSearching(false);
    setError(null);
    setFeedback(null);
    try {
      const startup = await window.djLibrary.resolveStartupChanges(action);
      showStartupResult(startup);
      try {
        if (startup.status.kind === 'ready') {
          if (startup.status.library.revision !== view?.library.revision) await refreshLibrary(startup.status.library);
        } else {
          stopPlayback();
          setView(null);
          setPlaylists(null);
          setFolders([]);
          setSelectedPlaylistId(null);
          setDuplicateState({ kind: 'empty' });
        }
      } catch {
        setReloadRequired(true);
      }
      setStartupPreview(null);
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  };

  const manageConnection = async (
    operation: () => Promise<LibraryConnectionResult>,
    openView = false,
    disconnectId?: string,
  ): Promise<LibraryConnectionResult> => {
    if (busy || operationPending.current) return { kind: 'cancelled' };
    operationPending.current = true;
    const navigation = navigationSequence.current;
    setBusy(true);
    setStartupSyncResult(null);
    searchSequence.current += 1;
    setSearching(false);
    setQuery(viewQuery);
    setFilters(viewFilters);
    setError(null);
    setFeedback(null);
    if (disconnectId && connections) setConnections({ ...connections,
      connections: connections.connections.filter((connection) => connection.id !== disconnectId) });

    try {
      const result = await operation();
      if (result.kind !== 'updated') {
        if (disconnectId) setConnections(connections);
        return result;
      }
      setConnections(result.connections);
      try {
        if (result.status.kind === 'ready') {
          if (result.status.library.revision !== view?.library.revision) await refreshLibrary(result.status.library);
          else {
            const tree = await loadPlaylistTree();
            setPlaylists(tree.playlists);
            setFolders(tree.folders);
          }
        } else {
          stopPlayback();
          setView(null);
          setPlaylists(null);
          setFolders([]);
          setSelectedPlaylistId(null);
          setDuplicateState({ kind: 'empty' });
        }
      } catch {
        setReloadRequired(true);
        if (navigation === navigationSequence.current) setActivePage('connections');
        return { ...result, warnings: [...result.warnings, 'Connection saved, but the view could not refresh.'] };
      }
      if (navigation === navigationSequence.current) setActivePage(openView && result.status.kind === 'ready' && result.warnings.length === 0 ? 'library' : 'connections');
      return result;
    } catch (error) {
      if (disconnectId) setConnections(connections);
      return { kind: 'rejected', message: error instanceof Error ? error.message : 'Could not update the library connection.' };
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  };

  const runSync = async (operation: () => Promise<SyncResult>): Promise<SyncResult> => {
    if (busy || operationPending.current) return { kind: 'cancelled' };
    operationPending.current = true;
    setBusy(true);
    setStartupSyncResult(null);
    searchSequence.current += 1;
    setSearching(false);
    setError(null);
    setFeedback(null);
    try {
      const result = await operation();
      if (result.kind === 'cancelled') return result;
      try {
        const status = await window.djLibrary.status();
        if (status.kind === 'ready' && (result.kind === 'synced' || status.library.revision !== view?.library.revision)) {
          await refreshLibrary(status.library);
        }
      } catch {
        setReloadRequired(true);
        return { ...result, warnings: [...result.warnings, 'The view could not refresh. Reload the library.'] };
      }
      return result;
    } catch (error) {
      return { kind: 'rejected', warnings: [], backupPaths: [],
        message: error instanceof Error ? error.message : 'Sync failed. Try again.',
      };
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  };

  const applyMutation = (
    changeFor: (revision: string) => LibraryMutation,
    songs: readonly SongRow[] = [],
  ): Promise<boolean> => {
    if (busy || operationPending.current || view === null || playlists === null) return Promise.resolve(false);
    const change = changeFor(libraryVersion);
    operationPending.current = true;
    setBusy(true);
    searchSequence.current += 1;
    setSearching(false);
    setError(null);
    setFeedback(null);
    const navigation = navigationSequence.current;
    let optimisticPlaylists = playlists;
    let optimisticFolders = folders;
    let rollbackEditor = editor;
    let optimisticSelectedId = selectedPlaylistId;
    const knownSongs = new Map([
      ...view.page.items, ...playlists.flatMap((playlist) => playlist.tracks),
      ...(duplicateState.kind === 'ready' ? duplicateState.scan.groups.flatMap((group) => group.candidates.map((candidate) => candidate.song)) : []),
      ...songs,
    ].map((song) => [song.id, song]));
    const tracksFor = (ids: readonly string[]): readonly SongRow[] => ids.flatMap((id) => {
      const song = knownSongs.get(id);
      return song ? [song] : [];
    });
    const temporaryId = `pending-${++editorSequence.current}`;

    switch (change.kind) {
      case 'ignore-duplicate-group':
        if (duplicateState.kind === 'ready') setDuplicateState({ ...duplicateState, scan: { ...duplicateState.scan,
          groups: duplicateState.scan.groups.filter((group) => group.key !== change.groupKey),
          ignoredGroupCount: duplicateState.scan.ignoredGroupCount + 1,
        } });
        break;
      case 'remove-songs': {
        const removedIds = new Set(change.songIds);
        const matches = (song: SongRow): boolean => {
          const text = [song.title, song.artist, song.album, song.genre, song.musicalKey].filter(Boolean).join(' ').toLocaleLowerCase();
          if (!viewQuery.trim().toLocaleLowerCase().split(/\s+/).every((term) => text.includes(term))) return false;
          if (viewFilters.source !== 'all' && song.source !== viewFilters.source) return false;
          if (viewFilters.metadata === 'complete') return songMetadataGapCount(song) === 0;
          if (viewFilters.metadata === 'incomplete') return songMetadataGapCount(song) > 0;
          return viewFilters.metadata !== 'no-cues' || song.cuePointCount === 0;
        };
        const total = Math.max(0, view.page.total - tracksFor([...removedIds]).filter(matches).length);
        setView({ library: { ...view.library, songCount: Math.max(0, view.library.songCount - removedIds.size),
          totalSongCount: Math.max(0, view.library.totalSongCount - removedIds.size) },
        page: { ...view.page, items: view.page.items.filter((song) => !removedIds.has(song.id)), total,
          hasNext: view.page.offset + view.page.limit < total } });
        optimisticPlaylists = playlists.map((playlist) => ({ ...playlist, tracks: playlist.tracks.filter((song) => !removedIds.has(song.id)) }));
        if (duplicateState.kind === 'ready') setDuplicateState({ ...duplicateState, scan: { ...duplicateState.scan,
          groups: duplicateState.scan.groups.map((group) => ({ ...group,
            candidates: group.candidates.filter((candidate) => !removedIds.has(candidate.song.id)),
          })).filter((group) => group.candidates.length > 1),
          trackCount: Math.max(0, duplicateState.scan.trackCount - removedIds.size),
        } });
        setPlaybackQueue((queue) => queue.filter((song) => !removedIds.has(song.id)));
        if (playingSong && removedIds.has(playingSong.id)) stopPlayback();
        break;
      }
      case 'set-playlist-tracks':
        optimisticPlaylists = playlists.map((playlist) => playlist.id === change.playlistId
          ? { ...playlist, tracks: tracksFor(change.songIds), missingTrackCount: 0 } : playlist);
        break;
      case 'remove-playlist':
        optimisticPlaylists = playlists.filter((playlist) => playlist.id !== change.playlistId);
        if (selectedPlaylistId === change.playlistId) optimisticSelectedId = null;
        break;
      case 'move-playlist-node': {
        const tree = movePlaylistTree({ playlists, folders }, change.sourcePath, change.parentPath, change.beforePath);
        if (tree) { optimisticPlaylists = tree.playlists; optimisticFolders = tree.folders; }
        break;
      }
      case 'create-folder':
      case 'create-playlist':
      case 'save-smart-playlist': {
        const folderPath = folders.find((folder) => folder.id === change.parentFolderId)?.folderPath ?? [];
        const name = change.name.trim();
        if (change.kind === 'create-folder') {
          optimisticFolders = [...folders, { id: temporaryId, name, parentFolderId: change.parentFolderId,
            folderPath: [...folderPath, name], order: playlists.length + folders.length }];
        } else {
          const existing = change.kind === 'save-smart-playlist' ? playlists.find((playlist) => playlist.id === change.playlistId) : undefined;
          const playlist: RekordboxPlaylist = { id: existing?.id ?? temporaryId, name, parentFolderId: change.parentFolderId,
            folderPath, order: existing?.order ?? playlists.length + folders.length,
            kind: change.kind === 'save-smart-playlist' ? 'smart' : 'regular',
            tracks: change.kind === 'create-playlist' ? tracksFor(change.songIds) : songs,
            missingTrackCount: 0, smartRules: existing?.smartRules ?? null,
            smartDefinition: change.kind === 'save-smart-playlist' ? change.definition : null,
          };
          optimisticPlaylists = existing ? playlists.map((item) => item.id === existing.id ? playlist : item) : [...playlists, playlist];
          optimisticSelectedId = playlist.id;
          setActivePage('playlists');
        }
        if (editor) rollbackEditor = { ...editor, initialName: name,
          initialSongs: change.kind === 'create-playlist' ? tracksFor(change.songIds) : editor.initialSongs,
          request: { ...editor.request, parentFolderId: change.parentFolderId },
          ...(change.kind === 'save-smart-playlist' ? { smartDefinition: change.definition } : {}),
        };
        setEditor(null);
        break;
      }
    }
    setPlaylists(optimisticPlaylists);
    setFolders(optimisticFolders);
    setSelectedPlaylistId(optimisticSelectedId);
    if (optimisticPlaylists.length !== playlists.length) setView((current) => current === null ? null : {
      ...current, library: { ...current.library, playlistCount: optimisticPlaylists.length },
    });

    const rollback = (): void => {
      setView(view);
      setPlaylists(playlists);
      setFolders(folders);
      setDuplicateState(duplicateState);
      if (change.kind === 'remove-songs') setPlaybackQueue(playbackQueue);
      if (navigation === navigationSequence.current) {
        setEditor(rollbackEditor);
        setSelectedPlaylistId(selectedPlaylistId);
        setActivePage(activePage);
      } else setSelectedPlaylistId((current) => current === temporaryId ? selectedPlaylistId : current);
    };

    const save = async (): Promise<boolean> => {
      let committed = false;
      try {
        const result = await window.djLibrary.mutate(change);
        if (result.kind === 'rejected') {
          rollback();
          if (result.message) setFeedback({ tone: 'warning', message: result.message });
          else setError(result.reason);
          return false;
        }
        committed = true;
        if (playlistWindow) { window.close(); return true; }
        if (result.warning) setFeedback({ tone: 'warning', message: result.warning });
        else if (result.kind === 'songs-removed') setFeedback(feedbackForRemoval(result));
        if (result.kind === 'duplicate-ignored') {
          setDuplicateState({ kind: 'ready', libraryVersion: result.library.revision, scan: result.scan });
          return true;
        }
        const maxOffset = Math.max(0, Math.floor(Math.max(0, result.library.songCount - 1) / SONG_PAGE_SIZE) * SONG_PAGE_SIZE);
        const [page, tree] = await Promise.all([
          window.djLibrary.searchSongs({ offset: Math.min(view.page.offset, maxOffset), limit: SONG_PAGE_SIZE, query: viewQuery, filters: viewFilters }),
          loadPlaylistTree(),
        ]);
        setView({ library: result.library, page });
        setPlaylists(tree.playlists);
        setFolders(tree.folders);
        setSelectedPlaylistId((current) => {
          const selected = optimisticPlaylists.find((playlist) => playlist.id === current);
          return selected ? tree.playlists.find((playlist) =>
            JSON.stringify(playlistPath(playlist)) === JSON.stringify(playlistPath(selected)))?.id ?? null : null;
        });
        return true;
      } catch {
        if (committed) {
          setReloadRequired(true);
          setFeedback({ tone: 'warning', message: 'Saved, but the view could not refresh.' });
        } else { rollback(); setError('unexpected'); }
        return committed;
      } finally {
        operationPending.current = false;
        pendingMutation.current = null;
        setBusy(false);
      }
    };
    const pending = save();
    pendingMutation.current = pending;
    return pending;
  };

  const movePlaylistNode = (sourcePath: readonly string[], parentPath: readonly string[], beforePath: readonly string[] | null): Promise<boolean> =>
    applyMutation((revision) => ({ kind: 'move-playlist-node', revision, sourcePath, parentPath, beforePath }));

  const openPlaylistEditor = (request: PlaylistWindowRequest, initialName = '', initialSongs: readonly SongRow[] = []): void => {
    if (busy || operationPending.current) return;
    const navigation = ++navigationSequence.current;
    const loadEditor = async (): Promise<void> => {
      const wanted = new Set(request.kind === 'playlist' ? request.songIds : []);
      const songs = new Map<string, SongRow>();
      for (const song of [...(view?.page.items ?? []), ...(playlists?.flatMap((playlist) => playlist.tracks) ?? []), ...initialSongs]) {
        if (wanted.has(song.id)) songs.set(song.id, song);
      }
      try {
        let offset = 0;
        while (songs.size < wanted.size) {
          const page = await window.djLibrary.listSongs({ offset, limit: SONG_PAGE_SIZE });
          for (const song of page.items) if (wanted.has(song.id)) songs.set(song.id, song);
          if (!page.hasNext) break;
          offset += page.limit;
        }
        if (navigation !== navigationSequence.current) return;
        if (songs.size !== wanted.size) { setError('song-not-found'); return; }
        setEditor({ id: ++editorSequence.current, request, initialSongs: [...wanted].flatMap((id) => {
          const song = songs.get(id);
          return song ? [song] : [];
        }), initialName });
        setActivePage('playlists');
      } catch { setError('unexpected'); }
    };
    void loadEditor();
  };

  const removeSongs = (songIds: readonly string[], removeLocalFile: boolean, songs: readonly SongRow[] = []): Promise<boolean> =>
    applyMutation((revision) => ({ kind: 'remove-songs', revision, songIds, removeLocalFile }), songs);

  const createPlaylist = (name: string, songIds: readonly string[], parentFolderId: string | null = null, songs: readonly SongRow[] = []): Promise<boolean> =>
    applyMutation((revision) => ({ kind: 'create-playlist', parentFolderId, revision, name, songIds }), songs);

  const addToPlaylist = (playlist: RekordboxPlaylist, songIds: readonly string[], songs: readonly SongRow[] = []): Promise<boolean> =>
    applyMutation((revision) => ({ kind: 'set-playlist-tracks', revision, playlistId: playlist.id,
      songIds: [...new Set([...playlist.tracks.map((song) => song.id), ...songIds])],
    }), songs);

  const changePage = async (offset: number, nextQuery = query, nextFilters: SongFilters = filters): Promise<void> => {
    if (view === null || offset < 0) {
      return;
    }

    const sequence = ++searchSequence.current;
    setSearching(true);
    setError(null);

    try {
      await pendingMutation.current;
      if (sequence !== searchSequence.current) return;
      const page = await window.djLibrary.searchSongs({
        offset,
        limit: SONG_PAGE_SIZE,
        query: nextQuery,
        filters: nextFilters,
      });
      if (sequence === searchSequence.current) {
        setView((current) => current === null ? null : { ...current, page });
        setViewQuery(nextQuery);
        setViewFilters(nextFilters);
      }
    } catch {
      if (sequence === searchSequence.current) {
        setError('unexpected');
        setQuery(viewQuery);
        setFilters(viewFilters);
      }
    } finally {
      if (sequence === searchSequence.current) {
        setSearching(false);
      }
    }
  };

  const navigate = (nextPage: PageId): void => {
    navigationSequence.current += 1;
    setEditor(null);
    setActivePage(nextPage);
    if (nextPage === 'connections' && !operationPending.current) {
      void window.djLibrary.connections().then(setConnections).catch(() => setError('unexpected'));
    }
  };

  const selectPlaylist = (playlistId: string): void => {
    navigationSequence.current += 1;
    setEditor(null);
    setSelectedPlaylistId(playlistId);
    setActivePage('playlists');
  };

  const openPlaylistMenu = async (parentFolderId: string | null, playlistId: string | null): Promise<void> => {
    if (busy || view === null) return;
    try {
      const kind = await window.djLibrary.playlistMenu(playlistId);
      if (kind === 'export-tracklist') {
        setExportPlaylistId(playlistId);
      } else if (kind === 'remove-playlist') {
        const playlist = playlists?.find((candidate) => candidate.id === playlistId);
        if (playlistId !== null && playlist && window.confirm(`Remove "${playlist.name}"?`)) {
          await applyMutation((revision) => ({ kind: 'remove-playlist', revision, playlistId }));
        }
      } else if (kind !== null) {
        openPlaylistEditor({ parentFolderId, revision: libraryVersion, ...(kind === 'playlist' ? { kind, songIds: [] } : { kind }) });
      }
    } catch {
      setError('unexpected');
    }
  };

  const cancelPlaylistEditor = (): void => {
    if (playlistWindow) { window.close(); return; }
    setEditor(null);
    setActivePage(selectedPlaylistId === null ? 'library' : 'playlists');
  };

  const rescanDuplicates = (): void => {
    setDuplicateState({ kind: 'empty' });
    setDuplicateRefresh((refresh) => refresh + 1);
  };

  const duplicateCount =
    duplicateState.kind === 'ready' &&
    duplicateState.libraryVersion === libraryVersion &&
    duplicateState.scan.mode === duplicateMode
      ? duplicateState.scan.groups.length
      : null;

  const page = (() => {
    switch (activePage) {
      case 'connections':
        return <LibraryConnectionsPage busy={busy} state={connections}
          initialSyncResult={startupSyncResult} onError={reportError}
          onImportBackup={(mode) => manageConnection(() => window.djLibrary.importBackup(mode), true)}
          onConnect={(kind) => manageConnection(() => window.djLibrary.connectLibrary(kind), true)}
          onManage={(action) => manageConnection(() => window.djLibrary.manageLibraryConnection(action), action.kind === 'open', action.kind === 'disconnect' ? action.id : undefined)}
          onImportChanges={(id) => manageConnection(() => window.djLibrary.manageLibraryConnection({ kind: 'open', id }))}
          onSync={(request) => runSync(() => window.djLibrary.syncLibraries(request))}
          onResolveMissing={(action) => runSync(() => window.djLibrary.resolveSyncMissingFile(action))} />;
      case 'preferences':
        return <Preferences onCancel={() => navigate('library')} onError={reportError} />;
      case 'library':
        return (
          <LibraryPage
            key={`${libraryVersion}-${minimumSongLengthSeconds}`}
            busy={busy}
            filters={filters}
            onSearch={(nextQuery, nextFilters) => {
              setQuery(nextQuery);
              setFilters(nextFilters);
              void changePage(0, nextQuery, nextFilters);
            }}
            onCreate={(songIds, songs) => openPlaylistEditor({ kind: 'playlist', parentFolderId: null, revision: libraryVersion, songIds }, '', songs)}
            onAdd={addToPlaylist}
            onRemove={removeSongs}
            onManageLibraries={() => navigate('connections')}
            onPage={(offset) => void changePage(offset)}
            playback={playback}
            playlists={playlists ?? []}
            query={query}
            searching={searching}
            view={view}
          />
        );
      case 'duplicates':
        return (
          <DuplicatesPage
            key={`${libraryVersion}-${minimumSongLengthSeconds}`}
            busy={busy}
            mode={duplicateMode}
            onIgnore={(groupKey) => applyMutation((revision) => ({
              kind: 'ignore-duplicate-group',
              revision,
              mode: duplicateMode,
              groupKey,
            }))}
            onManageLibraries={() => navigate('connections')}
            onModeChange={setDuplicateMode}
            onRescan={rescanDuplicates}
            onRemove={removeSongs}
            playback={playback}
            state={duplicateState}
            view={view}
          />
        );
      case 'playlists': {
        const editorKey = `${libraryVersion}-${editor?.id ?? 0}-${playlistEditor?.kind ?? 'view'}`;
        if (playlistEditor?.kind === 'folder') return <FolderCreator key={editorKey} busy={busy} folders={folders}
          initialParentFolderId={playlistEditor.parentFolderId} initialName={editor?.initialName ?? ''} onCancel={cancelPlaylistEditor}
          onCreate={(name, parentFolderId) => applyMutation((revision) => ({ kind: 'create-folder', revision, name, parentFolderId }))} />;
        if ((playlistEditor?.kind === 'smart-playlist' || playlistEditor?.kind === 'edit-smart-playlist') && view !== null) {
          const editing = playlistEditor.kind === 'edit-smart-playlist' ? playlists?.find((playlist) => playlist.id === playlistEditor.playlistId) : undefined;
          const initialDefinition = editor?.smartDefinition ?? editing?.smartDefinition;
          return <SmartPlaylistEditor key={editorKey} busy={busy} folders={folders} initialParentFolderId={playlistEditor.parentFolderId}
            minimumSongLengthSeconds={minimumSongLengthSeconds}
            initialName={editor?.initialName || editing?.name || ''}
            editing={playlistEditor.kind === 'edit-smart-playlist'}
            {...(initialDefinition ? { initialDefinition } : {})}
            onManual={(name, parentFolderId, definition) => setEditor((draft) => draft === null ? null : {
              ...draft, initialName: name, smartDefinition: definition,
              request: { kind: 'playlist', songIds: draft.initialSongs.map((song) => song.id), revision: libraryVersion, parentFolderId },
            })}
            revision={view.library.revision} playback={playback} onCancel={cancelPlaylistEditor}
            onSave={(name, parentFolderId, definition, songs) => applyMutation((revision) => ({
              kind: 'save-smart-playlist', revision, name, parentFolderId, definition,
              playlistId: playlistEditor.kind === 'edit-smart-playlist' ? playlistEditor.playlistId : null,
            }), songs)} />;
        }
        return (
          <PlaylistsPage
            key={`${editorKey}-${selectedPlaylistId ?? 'new'}`}
            busy={busy}
            minimumSongLengthSeconds={minimumSongLengthSeconds}
            creating={playlistEditor?.kind === 'playlist'}
            initialParentFolderId={playlistEditor?.parentFolderId ?? null}
            initialSongs={editor?.initialSongs ?? []}
            initialName={editor?.initialName ?? ''}
            onSmart={(name, parentFolderId, songs) => setEditor((draft) => draft === null ? null : {
              ...draft, initialName: name, initialSongs: songs,
              request: { kind: 'smart-playlist', revision: libraryVersion, parentFolderId },
            })}
            onUpdateTracks={(playlist, songIds, songs) => applyMutation((revision) => ({ kind: 'set-playlist-tracks', revision, playlistId: playlist.id, songIds }), songs)}
            onAdd={addToPlaylist}
            onCreateFromSelection={(songIds, songs) => openPlaylistEditor({ kind: 'playlist', parentFolderId: null, revision: libraryVersion, songIds }, '', songs)}
            onRemove={removeSongs}
            onMenu={(playlist) => void openPlaylistMenu(playlist.parentFolderId, playlist.id)}
            folders={folders}
            onCancel={cancelPlaylistEditor}
            onEditSmart={(playlist) => openPlaylistEditor({ kind: 'edit-smart-playlist', playlistId: playlist.id, parentFolderId: playlist.parentFolderId, revision: libraryVersion })}
            onCreate={createPlaylist}
            onManageLibraries={() => navigate('connections')}
            playback={playback}
            playlists={playlists}
            selectedPlaylistId={selectedPlaylistId}
            view={view}
          />
        );
      }
      default: {
        const exhaustivePage: never = activePage;
        return exhaustivePage;
      }
    }
  })();
  const exportPlaylist = playlists?.find((playlist) => playlist.id === exportPlaylistId) ?? null;

  return (
    <div className={playlistWindow ? 'playlist-action-window' : 'cuebox-app'}>
      {playlistWindow === undefined && <CueboxSidebar
        key={connections?.activeConnectionId ?? 'unconnected'}
        activePage={activePage}
        busy={busy}
        duplicateCount={duplicateCount}
        folders={folders}
        onMenu={(parentFolderId, playlistId) => void openPlaylistMenu(parentFolderId, playlistId)}
        onMove={movePlaylistNode}
        hasLibrary={view !== null}
        libraryId={connections?.activeConnectionId ?? null}
        onNavigate={navigate}
        onPlaylistSelect={selectPlaylist}
        playlists={playlists}
        selectedPlaylistId={playlistEditor === null ? selectedPlaylistId : null}
      />}
      <main className="workspace" id="main-content">
        {feedback !== null && (
          <div className={`app-feedback is-${feedback.tone}`} role="alert" ref={feedbackRef}>
            <p>{feedback.message}</p>
            <button type="button" onClick={() => setFeedback(null)} aria-label="Dismiss message">×</button>
          </div>
        )}
        {error !== null && (
          <div className="app-alert" role="alert" ref={errorRef}>
            <p>{errorMessages[error]}</p>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button>
          </div>
        )}
        {reloadRequired && <div className="app-alert" role="alert">
          <p>Reload the library before making another edit.</p>
          <button type="button" disabled={loading} onClick={() => {
            setQuery(''); setViewQuery(''); setFilters(DEFAULT_SONG_FILTERS); setViewFilters(DEFAULT_SONG_FILTERS);
            setSelectedPlaylistId(null); setEditor(null); setLoading(true); setReloadSequence((sequence) => sequence + 1);
          }}>Reload library</button>
        </div>}
        {loading ? (
          <div className="loading-state" role="status">
            <span className="loading-mark" aria-hidden />
            <p>Opening Arsenal</p>
          </div>
        ) : playlistWindow && view === null ? (
          <div className="detail-empty"><h2>Could not open this editor.</h2><button className="quiet-button" type="button" onClick={() => window.close()}>Close window</button></div>
        ) : page}
      </main>
      <audio
        className="global-audio"
        ref={audioRef}
        muted={muted}
        onLoadedMetadata={() => { if (audioRef.current) audioRef.current.volume = volume; }}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onDurationChange={(event) => {
          const duration = event.currentTarget.duration;
          setAudioDuration(Number.isFinite(duration) ? duration : 0);
        }}
        onEnded={() => setPlaying(false)}
        onError={() => setPlaybackFailed(true)}
      />
      {playlistWindow === undefined && <CueboxPlayer playback={{ ...playback, play: (song) => playSong(song, true) }}
        queue={playbackQueue}
        volume={volume} muted={muted} onMute={() => setMuted(!muted)}
        onVolume={(value) => { setVolume(value); setMuted(false); if (audioRef.current) audioRef.current.volume = value; }} /> }
      {playlistWindow === undefined && exportPlaylist !== null && (
        <TracklistExportDialog key={exportPlaylist.id} playlist={exportPlaylist} onError={reportError} onClose={() => setExportPlaylistId(null)} />
      )}
      {playlistWindow === undefined && !loading && startupPreview !== null && (
        <LibraryChangesDialog preview={startupPreview} busy={busy} onResolve={resolveStartupChanges} />
      )}
    </div>
  );
};
