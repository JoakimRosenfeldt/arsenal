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
  type DuplicateMatchMode,
  type DuplicateScan,
  type ImportFailure,
  type LibraryConnections,
  type LibraryConnectionResult,
  type LibrarySummary,
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
import { LibraryConnectionsPage } from './LibraryConnectionsPage';
import { Preferences } from './Preferences';
import type { SmartPlaylistDefinition } from './shared/smart-playlists';

type DisplayError = ImportFailure | MutationFailure | 'unexpected';

type Feedback = Readonly<{
  tone: 'success' | 'warning';
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
  'cannot-read':
    'Could not open this file. Check that it still exists and try again.',
  'not-rekordbox-xml':
    'That file is not a supported Rekordbox Collection export. In Rekordbox, choose File > Library > Export Collection in xml format.',
  'not-serato-library':
    'Choose a Serato Library folder containing root.sqlite or location.sqlite, or an _Serato_ folder containing database V2.',
  'cannot-save-library':
    'Could not save the library connection. Check the available disk space and permissions.',
  'malformed-xml':
    'This file is damaged. Export the collection again, then choose the new file.',
  'stale-library':
    'The library changed before this action ran. Try the action again.',
  'source-changed':
    'The library file changed. Open its connection on the Connections page before editing.',
  'song-not-found':
    'That track is no longer in the library.',
  'duplicate-not-found':
    'That duplicate group is no longer in the list. Choose another group.',
  'cannot-save-preferences':
    'Could not ignore this group. Try again.',
  'invalid-playlist':
    'Could not save this playlist. Check its name, tracks, and rules.',
  'name-conflict': 'A playlist or folder with this name already exists here. Choose another name.',
  'folder-not-found': 'The destination folder no longer exists. Choose another folder.',
  'playlist-sync-needed': 'This playlist move cannot be saved in every connected library. Sync playlists first.',
  'serato-open': 'Close Serato before moving playlists and folders.',
  'cannot-write':
    'Could not save the library. Check the file permissions and try again.',
  unexpected:
    'Arsenal could not complete that action. Close the app, reopen it, and try again.',
};

const feedbackForRemoval = (
  result: Extract<LibraryMutationResult, { kind: 'songs-removed' }>,
): Feedback => {
  const warnings = {
    shared: 'Files still used by other tracks were kept.',
    missing: 'Some local files could not be found.',
    unsupported: 'Files not recognized as audio were kept.',
    failed: 'Some local files could not be moved to Trash.',
  };
  const problems = [...new Set(result.fileActions)].flatMap((action) =>
    action === 'kept' || action === 'trashed' ? [] : [warnings[action]],
  );
  const trashedCount = result.fileActions.filter((action) => action === 'trashed').length;
  return {
    tone: problems.length === 0 ? 'success' : 'warning',
    message: [
      `Removed ${result.removedCount} ${result.removedCount === 1 ? 'track' : 'tracks'}.`,
      ...(trashedCount === 0 ? [] : [
        `Moved ${trashedCount} ${trashedCount === 1 ? 'file' : 'files'} to Trash.`,
      ]),
      ...problems,
    ].join(' '),
  };
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
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<LibraryView | null>(null);
  const [connections, setConnections] = useState<LibraryConnections | null>(null);
  const [playlists, setPlaylists] = useState<readonly RekordboxPlaylist[] | null>(null);
  const [folders, setFolders] = useState<readonly PlaylistFolder[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [exportPlaylistId, setExportPlaylistId] = useState<string | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
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

  useEffect(() => {
    let active = true;

    const loadInitialState = async (): Promise<void> => {
      try {
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
          setView({ library: status.library, page });
          setPlaylists(tree.playlists);
          setFolders(tree.folders);
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
  }, [playlistWindow, minimumSongLengthSeconds]);

  useEffect(() => {
    if (!hasLibrary || playlistWindow !== undefined) {
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
  }, [duplicateMode, duplicateRefresh, hasLibrary, libraryVersion, playlistWindow, minimumSongLengthSeconds]);

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
    searchSequence.current += 1;
    setSearching(false);
    const [page, tree] = await Promise.all([
      window.djLibrary.listSongs({ offset: 0, limit: SONG_PAGE_SIZE }),
      loadPlaylistTree(),
    ]);
    stopPlayback();
    setView({ library, page });
    setPlaylists(tree.playlists);
    setFolders(tree.folders);
    setSelectedPlaylistId(null);
    setQuery('');
    setViewQuery('');
    setFilters(DEFAULT_SONG_FILTERS);
    setViewFilters(DEFAULT_SONG_FILTERS);
  };

  const manageConnection = async (
    operation: () => Promise<LibraryConnectionResult>,
    openView = false,
  ): Promise<LibraryConnectionResult> => {
    if (busy) return { kind: 'cancelled' };
    setBusy(true);
    searchSequence.current += 1;
    setSearching(false);
    setQuery(viewQuery);
    setFilters(viewFilters);
    setError(null);
    setFeedback(null);

    try {
      const result = await operation();
      if (result.kind !== 'updated') return result;
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
        setActivePage('connections');
        return { ...result, warnings: [...result.warnings, 'Connection saved, but Arsenal could not refresh the collection view. Open the connection again.'] };
      }
      setActivePage(openView && result.status.kind === 'ready' && result.warnings.length === 0 ? 'library' : 'connections');
      return result;
    } catch (error) {
      return { kind: 'rejected', message: error instanceof Error ? error.message : 'Could not update the library connection.' };
    } finally {
      setBusy(false);
    }
  };

  const runSync = async (operation: () => Promise<SyncResult>): Promise<SyncResult> => {
    if (busy) return { kind: 'cancelled' };
    setBusy(true);
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
        return { ...result, warnings: [...result.warnings, 'Arsenal could not refresh the library view. Reopen the library to see the changes.'] };
      }
      return result;
    } catch (error) {
      return { kind: 'rejected', warnings: [], backupPaths: [],
        message: error instanceof Error ? error.message : 'Could not finish syncing. Check the libraries and try again.',
      };
    } finally {
      setBusy(false);
    }
  };

  const applyOperation = async (
    operation: () => Promise<LibraryMutationResult | null>,
  ): Promise<boolean> => {
    if (busy || view === null) {
      return false;
    }

    setBusy(true);
    searchSequence.current += 1;
    setSearching(false);
    setError(null);
    setFeedback(null);
    try {
      const result = await operation();
      if (result === null) return false;
      if (result.kind === 'rejected') {
        setError(result.reason);
        return false;
      }

      if (playlistWindow !== undefined) {
        window.close();
        return true;
      }

      if (result.kind === 'duplicate-ignored') {
        setDuplicateState({
          kind: 'ready',
          libraryVersion: result.library.revision,
          scan: result.scan,
        });
        setFeedback({
          tone: 'success',
          message: 'Group ignored.',
        });
        return true;
      }

      if (result.kind === 'playlist-node-moved') {
        const tree = await loadPlaylistTree();
        setView((current) => current === null ? null : { ...current, library: result.library });
        setPlaylists(tree.playlists);
        setFolders(tree.folders);
        if (result.warning) setFeedback({ tone: 'warning', message: result.warning });
        setSelectedPlaylistId((current) => {
          const selected = playlists?.find((playlist) => playlist.id === current);
          if (!selected) return null;
          const path = [...selected.folderPath, selected.name];
          const moved = JSON.stringify(path.slice(0, result.sourcePath.length)) === JSON.stringify(result.sourcePath);
          const wanted = moved ? [...result.destinationPath, ...path.slice(result.sourcePath.length)] : path;
          return tree.playlists.find((playlist) =>
            JSON.stringify([...playlist.folderPath, playlist.name]) === JSON.stringify(wanted))?.id ?? null;
        });
        return true;
      }

      searchSequence.current += 1;
      setSearching(false);
      const maxOffset = Math.max(
        0,
        Math.floor(Math.max(0, result.library.songCount - 1) / SONG_PAGE_SIZE) *
          SONG_PAGE_SIZE,
      );
      const [page, tree, scan] = await Promise.all([
        window.djLibrary.searchSongs({
          offset: Math.min(view.page.offset, maxOffset),
          limit: SONG_PAGE_SIZE,
          query,
          filters,
        }),
        loadPlaylistTree(),
        window.djLibrary.findDuplicates(duplicateMode),
      ]);
      setView({ library: result.library, page });
      setPlaylists(tree.playlists);
      setFolders(tree.folders);
      setViewQuery(query);
      setViewFilters(filters);
      setDuplicateState({
        kind: 'ready',
        libraryVersion: result.library.revision,
        scan,
      });
      setFeedback(result.kind === 'songs-removed'
          ? feedbackForRemoval(result)
          : { tone: 'success', message: result.kind === 'folder-created' ? 'Folder created.' : result.kind === 'smart-playlist-saved' ? 'Smart playlist saved.' : result.kind === 'playlist-updated' ? 'Playlist saved.' : result.kind === 'playlist-removed' ? 'Playlist removed.' : 'Playlist created.' });
      if (result.kind === 'playlist-created' || result.kind === 'smart-playlist-saved' || result.kind === 'playlist-updated') {
        setEditor(null);
        setSelectedPlaylistId(result.playlistId);
        setActivePage('playlists');
      } else if (result.kind === 'folder-created') {
        setEditor(null);
      } else if (result.kind === 'playlist-removed') {
        setSelectedPlaylistId(null);
      }
      return true;
    } catch {
      setError('unexpected');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const applyMutation = (changeFor: (revision: string) => LibraryMutation): Promise<boolean> =>
    applyOperation(() => window.djLibrary.mutate(changeFor(libraryVersion)));

  const movePlaylistNode = async (sourcePath: readonly string[], parentPath: readonly string[], beforePath: readonly string[] | null): Promise<boolean> => {
    if (busy || view === null || playlists === null) return false;
    const optimistic = movePlaylistTree({ playlists, folders }, sourcePath, parentPath, beforePath);
    if (optimistic !== null) {
      setPlaylists(optimistic.playlists);
      setFolders(optimistic.folders);
    }
    const saved = await applyMutation((revision) => ({ kind: 'move-playlist-node', revision, sourcePath, parentPath, beforePath }));
    if (!saved && optimistic !== null) {
      setPlaylists(playlists);
      setFolders(folders);
    }
    return saved;
  };

  const openPlaylistEditor = (request: PlaylistWindowRequest, initialName = ''): void => {
    const loadEditor = async (): Promise<void> => {
      const wanted = new Set(request.kind === 'playlist' ? request.songIds : []);
      const songs = new Map<string, SongRow>();
      for (const song of [...(view?.page.items ?? []), ...(playlists?.flatMap((playlist) => playlist.tracks) ?? [])]) {
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

  const removeSongs = async (
    songIds: readonly string[],
    removeLocalFile: boolean,
  ): Promise<boolean> => {
    const removed = await applyMutation((revision) => ({
      kind: 'remove-songs',
      revision,
      songIds,
      removeLocalFile,
    }));
    if (removed) setPlaybackQueue((queue) => queue.filter((song) => !songIds.includes(song.id)));
    if (removed && playingSong !== null && songIds.includes(playingSong.id)) {
      stopPlayback();
    }
    return removed;
  };

  const createPlaylist = (
    name: string,
    songIds: readonly string[],
    parentFolderId: string | null = null,
  ): Promise<boolean> =>
    applyMutation((revision) => ({
      kind: 'create-playlist',
      parentFolderId,
      revision,
      name,
      songIds,
    }));

  const addToPlaylist = (playlist: RekordboxPlaylist, songIds: readonly string[]): Promise<boolean> =>
    applyMutation((revision) => ({
      kind: 'set-playlist-tracks', revision, playlistId: playlist.id,
      songIds: [...new Set([...playlist.tracks.map((song) => song.id), ...songIds])],
    }));

  const changePage = async (offset: number, nextQuery = query, nextFilters: SongFilters = filters): Promise<void> => {
    if (busy || view === null || offset < 0) {
      return;
    }

    const sequence = ++searchSequence.current;
    setSearching(true);
    setError(null);

    try {
      const page = await window.djLibrary.searchSongs({
        offset,
        limit: SONG_PAGE_SIZE,
        query: nextQuery,
        filters: nextFilters,
      });
      if (sequence === searchSequence.current) {
        setView({ library: view.library, page });
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
    if (busy) return;
    setEditor(null);
    setActivePage(nextPage);
    if (nextPage === 'connections') {
      void window.djLibrary.connections().then(setConnections).catch(() => setError('unexpected'));
    }
  };

  const selectPlaylist = (playlistId: string): void => {
    if (busy) return;
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
        if (playlistId !== null && playlist && window.confirm(`Remove "${playlist.name}"? The tracks will stay in your library.`)) {
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
          onImportBackup={() => manageConnection(() => window.djLibrary.importBackup())}
          onConnect={(kind) => manageConnection(() => window.djLibrary.connectLibrary(kind))}
          onManage={(action) => manageConnection(() => window.djLibrary.manageLibraryConnection(action), action.kind === 'open')}
          onSync={(request) => runSync(() => window.djLibrary.syncLibraries(request))}
          onResolveMissing={(action) => runSync(() => window.djLibrary.resolveSyncMissingFile(action))} />;
      case 'preferences':
        return <Preferences onCancel={() => setActivePage('library')} onSaved={() => setFeedback({ tone: 'success', message: 'Preferences saved.' })} />;
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
            onCreate={(songIds) => openPlaylistEditor({ kind: 'playlist', parentFolderId: null, revision: libraryVersion, songIds })}
            onAdd={addToPlaylist}
            onRemove={removeSongs}
            onManageLibraries={() => navigate('connections')}
            onSync={() => navigate('connections')}
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
            onSync={() => navigate('connections')}
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
          initialParentFolderId={playlistEditor.parentFolderId} onCancel={cancelPlaylistEditor}
          onCreate={(name, parentFolderId) => applyMutation((revision) => ({ kind: 'create-folder', revision, name, parentFolderId }))} />;
        if ((playlistEditor?.kind === 'smart-playlist' || playlistEditor?.kind === 'edit-smart-playlist') && view !== null) {
          const editing = playlistEditor.kind === 'edit-smart-playlist' ? playlists?.find((playlist) => playlist.id === playlistEditor.playlistId) : undefined;
          const initialDefinition = editing?.smartDefinition ?? editor?.smartDefinition;
          return <SmartPlaylistEditor key={editorKey} busy={busy} folders={folders} initialParentFolderId={playlistEditor.parentFolderId}
            minimumSongLengthSeconds={minimumSongLengthSeconds}
            initialName={editing?.name ?? editor?.initialName ?? ''}
            editing={playlistEditor.kind === 'edit-smart-playlist'}
            {...(initialDefinition ? { initialDefinition } : {})}
            onManual={(name, parentFolderId, definition) => setEditor((draft) => draft === null ? null : {
              ...draft, initialName: name, smartDefinition: definition,
              request: { kind: 'playlist', songIds: draft.initialSongs.map((song) => song.id), revision: libraryVersion, parentFolderId },
            })}
            revision={view.library.revision} playback={playback} onCancel={cancelPlaylistEditor}
            onSave={(name, parentFolderId, definition) => applyMutation((revision) => ({
              kind: 'save-smart-playlist', revision, name, parentFolderId, definition,
              playlistId: playlistEditor.kind === 'edit-smart-playlist' ? playlistEditor.playlistId : null,
            }))} />;
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
            onUpdateTracks={(playlist, songIds) => applyMutation((revision) => ({ kind: 'set-playlist-tracks', revision, playlistId: playlist.id, songIds }))}
            onAdd={addToPlaylist}
            onCreateFromSelection={(songIds) => openPlaylistEditor({ kind: 'playlist', parentFolderId: null, revision: libraryVersion, songIds })}
            onRemove={removeSongs}
            onMenu={(playlist) => void openPlaylistMenu(playlist.parentFolderId, playlist.id)}
            folders={folders}
            onCancel={cancelPlaylistEditor}
            onEditSmart={(playlist) => openPlaylistEditor({ kind: 'edit-smart-playlist', playlistId: playlist.id, parentFolderId: playlist.parentFolderId, revision: libraryVersion })}
            onExport={(playlist) => setExportPlaylistId(playlist.id)}
            onCreate={createPlaylist}
            onManageLibraries={() => navigate('connections')}
            onSync={() => navigate('connections')}
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
          <div className={`app-feedback is-${feedback.tone}`} role="status" ref={feedbackRef}>
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
        <TracklistExportDialog key={exportPlaylist.id} playlist={exportPlaylist} onClose={() => setExportPlaylistId(null)} />
      )}
    </div>
  );
};
