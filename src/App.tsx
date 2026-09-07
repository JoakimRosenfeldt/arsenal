import { useEffect, useRef, useState, type JSX } from 'react';

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
  type DuplicateMatchMode,
  type DuplicateScan,
  type ImportFailure,
  type LibraryMutation,
  type LibraryMutationResult,
  type MutationFailure,
  type RekordboxPlaylist,
  type SongRow,
} from './shared/dj-library';

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
    'Arsenal could not read that XML file. Check that it still exists and that this app can open it.',
  'not-rekordbox-xml':
    'That file is not a supported Rekordbox Collection export. In Rekordbox, choose File > Library > Export Collection in xml format.',
  'malformed-xml':
    'The XML file is incomplete or malformed. Export the collection again, then choose the new file.',
  'stale-library':
    'The library changed before this action ran. Try the action again.',
  'source-changed':
    'The XML changed outside Arsenal. Import it again before editing.',
  'song-not-found':
    'That track no longer exists in the open XML.',
  'duplicate-not-found':
    'That duplicate group is no longer in the list. Choose another group.',
  'cannot-save-preferences':
    'Arsenal could not save the ignored group. Check the app data folder permissions and try again.',
  'invalid-playlist':
    'The playlist name or track selection is not valid for this XML.',
  'cannot-write':
    'Arsenal could not save the XML. Check the file permissions and try again.',
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
      `Removed ${result.removedCount} ${result.removedCount === 1 ? 'track' : 'tracks'} from the Rekordbox XML.`,
      ...(trashedCount === 0 ? [] : [
        `Moved ${trashedCount} local ${trashedCount === 1 ? 'file' : 'files'} to Trash.`,
      ]),
      ...problems,
    ].join(' '),
  };
};

export const App = (): JSX.Element => {
  const [activePage, setActivePage] = useState<PageId>('library');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<LibraryView | null>(null);
  const [playlists, setPlaylists] = useState<readonly RekordboxPlaylist[] | null>(null);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [query, setQuery] = useState('');
  const [viewQuery, setViewQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const searchSequence = useRef(0);
  const [duplicateMode, setDuplicateMode] =
    useState<DuplicateMatchMode>('smart');
  const [duplicateState, setDuplicateState] = useState<DuplicateViewState>({
    kind: 'empty',
  });
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playingSong, setPlayingSong] = useState<SongRow | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const hasLibrary = view !== null;
  const libraryVersion = view?.library.revision ?? 'empty';

  useEffect(() => {
    let active = true;

    const loadInitialState = async (): Promise<void> => {
      try {
        const status = await window.djLibrary.status();
        if (!active || status.kind === 'empty') {
          return;
        }

        const [page, loadedPlaylists] = await Promise.all([
          window.djLibrary.listSongs({
            offset: 0,
            limit: SONG_PAGE_SIZE,
          }),
          window.djLibrary.listPlaylists(),
        ]);
        if (active) {
          setView({ library: status.library, page });
          setPlaylists(loadedPlaylists);
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
  }, []);

  useEffect(() => {
    if (!hasLibrary) {
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
  }, [duplicateMode, hasLibrary, libraryVersion]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        if (activePage === 'library') {
          document.getElementById('library-search')?.focus();
        }
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, [activePage]);

  const stopPlayback = (): void => {
    const audio = audioRef.current;
    audio?.pause();
    if (audio !== null) {
      audio.removeAttribute('src');
      audio.load();
    }
    setPlayingSong(null);
    setPlaying(false);
    setPosition(0);
    setAudioDuration(0);
    setPlaybackFailed(false);
  };

  const playSong = (song: SongRow): void => {
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

  const importLibrary = async (): Promise<void> => {
    if (busy) {
      return;
    }

    setBusy(true);
    setError(null);
    setFeedback(null);

    try {
      const result = await window.djLibrary.importRekordboxExport();
      if (result.kind === 'cancelled') {
        return;
      }
      if (result.kind === 'rejected') {
        setError(result.reason);
        return;
      }

      searchSequence.current += 1;
      setSearching(false);
      const [page, loadedPlaylists] = await Promise.all([
        window.djLibrary.listSongs({
          offset: 0,
          limit: SONG_PAGE_SIZE,
        }),
        window.djLibrary.listPlaylists(),
      ]);
      stopPlayback();
      setView({ library: result.library, page });
      setPlaylists(loadedPlaylists);
      setSelectedPlaylistId(null);
      setQuery('');
      setViewQuery('');
    } catch {
      setError('unexpected');
    } finally {
      setBusy(false);
    }
  };

  const applyMutation = async (
    changeFor: (revision: string) => LibraryMutation,
  ): Promise<boolean> => {
    if (busy || view === null) {
      return false;
    }

    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const result = await window.djLibrary.mutate(
        changeFor(view.library.revision),
      );
      if (result.kind === 'rejected') {
        setError(result.reason);
        return false;
      }

      if (result.kind === 'duplicate-ignored') {
        setDuplicateState({
          kind: 'ready',
          libraryVersion: result.library.revision,
          scan: result.scan,
        });
        setFeedback({
          tone: 'success',
          message: 'Group ignored. It will return when a new matching track is imported.',
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
      const [page, loadedPlaylists, scan] = await Promise.all([
        window.djLibrary.searchSongs({
          offset: Math.min(view.page.offset, maxOffset),
          limit: SONG_PAGE_SIZE,
          query,
        }),
        window.djLibrary.listPlaylists(),
        window.djLibrary.findDuplicates(duplicateMode),
      ]);
      setView({ library: result.library, page });
      setPlaylists(loadedPlaylists);
      setViewQuery(query);
      setDuplicateState({
        kind: 'ready',
        libraryVersion: result.library.revision,
        scan,
      });
      setFeedback(
        result.kind === 'songs-removed'
          ? feedbackForRemoval(result)
          : { tone: 'success', message: 'Playlist written to the Rekordbox XML.' },
      );
      return true;
    } catch {
      setError('unexpected');
      return false;
    } finally {
      setBusy(false);
    }
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
    if (removed && playingSong !== null && songIds.includes(playingSong.id)) {
      stopPlayback();
    }
    return removed;
  };

  const createPlaylist = (
    name: string,
    songIds: readonly string[],
  ): Promise<boolean> =>
    applyMutation((revision) => ({
      kind: 'create-playlist',
      revision,
      name,
      songIds,
    }));

  const changePage = async (offset: number, nextQuery = query): Promise<void> => {
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
      });
      if (sequence === searchSequence.current) {
        setView({ library: view.library, page });
        setViewQuery(nextQuery);
      }
    } catch {
      if (sequence === searchSequence.current) {
        setError('unexpected');
      }
    } finally {
      if (sequence === searchSequence.current) {
        setSearching(false);
      }
    }
  };

  const navigate = (nextPage: PageId): void => {
    setActivePage(nextPage);
    if (nextPage === 'playlists') {
      setSelectedPlaylistId(null);
    }
  };

  const selectPlaylist = (playlistId: string): void => {
    setSelectedPlaylistId(playlistId);
    setActivePage('playlists');
  };

  const duplicateCount =
    duplicateState.kind === 'ready' &&
    duplicateState.libraryVersion === libraryVersion &&
    duplicateState.scan.mode === duplicateMode
      ? duplicateState.scan.groups.length
      : null;

  const page = (() => {
    switch (activePage) {
      case 'library':
        return (
          <LibraryPage
            key={libraryVersion}
            busy={busy}
            onImport={() => void importLibrary()}
            onPage={(offset) => void changePage(offset)}
            playback={playback}
            query={viewQuery}
            searching={searching}
            view={view}
          />
        );
      case 'duplicates':
        return (
          <DuplicatesPage
            busy={busy}
            mode={duplicateMode}
            onIgnore={(groupKey) => applyMutation((revision) => ({
              kind: 'ignore-duplicate-group',
              revision,
              mode: duplicateMode,
              groupKey,
            }))}
            onImport={() => void importLibrary()}
            onModeChange={setDuplicateMode}
            onRemove={removeSongs}
            playback={playback}
            state={duplicateState}
            view={view}
          />
        );
      case 'playlists':
        return (
          <PlaylistsPage
            key={`${libraryVersion}-${selectedPlaylistId ?? 'all'}`}
            busy={busy}
            onCreate={createPlaylist}
            onImport={() => void importLibrary()}
            playback={playback}
            playlists={playlists}
            selectedPlaylistId={selectedPlaylistId}
            view={view}
          />
        );
      default: {
        const exhaustivePage: never = activePage;
        return exhaustivePage;
      }
    }
  })();

  return (
    <div className="cuebox-app">
      <CueboxSidebar
        activePage={activePage}
        busy={busy}
        duplicateCount={duplicateCount}
        hasLibrary={view !== null}
        onNavigate={navigate}
        onPlaylistSelect={selectPlaylist}
        onQueryChange={(nextQuery) => {
          setQuery(nextQuery);
          void changePage(0, nextQuery);
        }}
        playlists={playlists}
        query={query}
        selectedPlaylistId={selectedPlaylistId}
        songCount={view?.library.songCount ?? 0}
      />
      <main className="workspace" id="main-content">
        {feedback !== null && (
          <div className={`app-feedback is-${feedback.tone}`} role="status">
            <p>{feedback.message}</p>
            <button type="button" onClick={() => setFeedback(null)} aria-label="Dismiss message">×</button>
          </div>
        )}
        {error !== null && (
          <div className="app-alert" role="alert">
            <span>Action failed</span>
            <p>{errorMessages[error]}</p>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button>
          </div>
        )}
        {loading ? (
          <div className="loading-state" role="status">
            <span className="loading-mark" aria-hidden />
            <p>Opening Arsenal</p>
          </div>
        ) : page}
      </main>
      <audio
        className="global-audio"
        ref={audioRef}
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
      <CueboxPlayer onStop={stopPlayback} playback={playback} />
    </div>
  );
};
