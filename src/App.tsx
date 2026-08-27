import { useEffect, useState, type JSX } from 'react';

import {
  SONG_PAGE_SIZE,
  type ImportFailure,
  type LibrarySummary,
  type SongPage,
  type SongRow,
} from './shared/dj-library';

type LibraryView = Readonly<{
  library: LibrarySummary;
  page: SongPage;
}>;

type DisplayError = ImportFailure | 'unexpected';

const errorMessages: Readonly<Record<DisplayError, string>> = {
  'cannot-read':
    'The XML file could not be read. Check that it still exists and that Arsenal has permission to open it.',
  'not-rekordbox-xml':
    'That file is not a supported Rekordbox Collection export. In Rekordbox, use File > Library > Export Collection in xml format.',
  'malformed-xml':
    'The XML file is incomplete or malformed. Export the collection again, then choose the new file.',
  unexpected:
    'Arsenal could not open the library. Close the app, reopen it, and try the export again.',
};

const formatDuration = (durationSeconds: number | null): string => {
  if (durationSeconds === null) {
    return 'Not set';
  }

  const rounded = Math.floor(durationSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = String(rounded % 60).padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
  }

  return `${minutes}:${seconds}`;
};

const formatBpm = (bpm: number | null): string =>
  bpm === null
    ? 'Not set'
    : bpm.toLocaleString(undefined, { maximumFractionDigits: 2 });

const formatImportedAt = (importedAt: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(importedAt));

const SongTableRow = ({ song }: Readonly<{ song: SongRow }>): JSX.Element => (
  <tr>
    <th scope="row">{song.title}</th>
    <td>{song.artist ?? 'Not set'}</td>
    <td>{song.album ?? 'Not set'}</td>
    <td>{song.genre ?? 'Not set'}</td>
    <td className="numeric-cell">{formatBpm(song.bpm)}</td>
    <td>{song.musicalKey ?? 'Not set'}</td>
    <td className="numeric-cell">{formatDuration(song.durationSeconds)}</td>
  </tr>
);

const EmptyLibrary = ({
  busy,
  error,
  onImport,
}: Readonly<{
  busy: boolean;
  error: DisplayError | null;
  onImport: () => void;
}>): JSX.Element => (
  <section className="empty-library" aria-labelledby="empty-title">
    <div className="empty-copy">
      <p className="eyebrow">01 / Import</p>
      <h1 id="empty-title">Your Rekordbox library. Nothing else.</h1>
      <p className="lede">
        Open a Rekordbox export to see its songs in one clear, read-only list.
      </p>

      {error && (
        <div className="error-banner" role="alert">
          <span className="error-label">Could not import</span>
          <p>{errorMessages[error]}</p>
        </div>
      )}

      <button
        className="primary-action"
        type="button"
        onClick={onImport}
        disabled={busy}
        aria-busy={busy}
      >
        <span>{busy ? 'Reading XML' : 'Choose Rekordbox XML'}</span>
        <span className={busy ? 'button-mark is-busy' : 'button-mark'} aria-hidden>
          {busy ? '' : '↗'}
        </span>
      </button>

      <ol className="import-steps">
        <li>
          <span>01</span>
          In Rekordbox, choose File &gt; Library &gt; Export Collection in xml
          format.
        </li>
        <li>
          <span>02</span>
          Choose that XML file here.
        </li>
        <li>
          <span>03</span>
          Browse your tracks. Arsenal changes nothing.
        </li>
      </ol>
    </div>

    <div className="record-panel" aria-hidden>
      <div className="record-shadow" />
      <div className="record">
        <div className="record-label">
          <strong>RB</strong>
          <span>XML</span>
        </div>
      </div>
      <p>LOCAL INPUT / READ ONLY</p>
    </div>

    <aside className="privacy-note">
      <span className="privacy-index">A</span>
      <div>
        <strong>Stays on this computer</strong>
        <p>
          No account, upload, cloud sync, or database. Closing Arsenal clears
          the imported view.
        </p>
      </div>
    </aside>
  </section>
);

const LibraryTable = ({
  view,
  busy,
  error,
  onImport,
  onPage,
}: Readonly<{
  view: LibraryView;
  busy: boolean;
  error: DisplayError | null;
  onImport: () => void;
  onPage: (offset: number) => void;
}>): JSX.Element => {
  const pageNumber = Math.floor(view.page.offset / view.page.limit) + 1;
  const pageCount = Math.max(1, Math.ceil(view.page.total / view.page.limit));

  return (
    <section className="library-view" aria-labelledby="library-title">
      <div className="library-heading">
        <div>
          <p className="eyebrow">Collection / Artist A-Z</p>
          <h1 id="library-title">
            {view.library.songCount.toLocaleString()} tracks
          </h1>
        </div>
        <button
          className="secondary-action"
          type="button"
          onClick={onImport}
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? 'Reading XML' : 'Import newer XML'}
          <span className={busy ? 'button-mark is-busy' : 'button-mark'} aria-hidden>
            {busy ? '' : '+'}
          </span>
        </button>
      </div>

      <dl className="library-meta">
        <div>
          <dt>Source</dt>
          <dd>{view.library.sourceName}</dd>
        </div>
        <div>
          <dt>Opened</dt>
          <dd>{formatImportedAt(view.library.importedAt)}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>Read only</dd>
        </div>
      </dl>

      {error && (
        <div className="error-banner compact" role="alert">
          <span className="error-label">Could not import</span>
          <p>{errorMessages[error]}</p>
        </div>
      )}

      <div className="table-frame" aria-busy={busy}>
        <table>
          <caption>Songs in the current Rekordbox Collection export</caption>
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Artist</th>
              <th scope="col">Album</th>
              <th scope="col">Genre</th>
              <th scope="col">BPM</th>
              <th scope="col">Key</th>
              <th scope="col">Time</th>
            </tr>
          </thead>
          <tbody>
            {view.page.items.length > 0 ? (
              view.page.items.map((song) => (
                <SongTableRow key={song.id} song={song} />
              ))
            ) : (
              <tr>
                <td className="empty-table" colSpan={7}>
                  This collection has no tracks.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <nav className="pagination" aria-label="Song pages">
        <p>
          Page <strong>{pageNumber}</strong> of {pageCount}
          <span>
            {view.page.total === 0
              ? '0 tracks shown'
              : `${view.page.offset + 1}-${Math.min(
                  view.page.offset + view.page.items.length,
                  view.page.total,
                )} shown`}
          </span>
        </p>
        <div>
          <button
            type="button"
            onClick={() => onPage(view.page.offset - view.page.limit)}
            disabled={busy || view.page.offset === 0}
          >
            ← Previous
          </button>
          <button
            type="button"
            onClick={() => onPage(view.page.offset + view.page.limit)}
            disabled={busy || !view.page.hasNext}
          >
            Next →
          </button>
        </div>
      </nav>
    </section>
  );
};

export const App = (): JSX.Element => {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<LibraryView | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);

  useEffect(() => {
    let active = true;

    const loadInitialState = async (): Promise<void> => {
      try {
        const status = await window.djLibrary.status();
        if (!active || status.kind === 'empty') {
          return;
        }

        const page = await window.djLibrary.listSongs({
          offset: 0,
          limit: SONG_PAGE_SIZE,
        });
        if (active) {
          setView({ library: status.library, page });
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

  const importLibrary = async (): Promise<void> => {
    if (busy) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const result = await window.djLibrary.importRekordboxExport();
      if (result.kind === 'cancelled') {
        return;
      }
      if (result.kind === 'rejected') {
        setError(result.reason);
        return;
      }

      const page = await window.djLibrary.listSongs({
        offset: 0,
        limit: SONG_PAGE_SIZE,
      });
      setView({ library: result.library, page });
    } catch {
      setError('unexpected');
    } finally {
      setBusy(false);
    }
  };

  const changePage = async (offset: number): Promise<void> => {
    if (busy || view === null) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const page = await window.djLibrary.listSongs({
        offset,
        limit: SONG_PAGE_SIZE,
      });
      setView({ library: view.library, page });
    } catch {
      setError('unexpected');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="wordmark" aria-label="Arsenal">
          <span className="wordmark-block">A</span>
          <span>ARSENAL</span>
        </div>
        <div className="local-status" role="status">
          <span aria-hidden />
          Local session
        </div>
        <p>REKORDBOX XML / VIEWER 01</p>
      </header>

      <main id="main-content">
        {loading ? (
          <div className="loading-state" role="status">
            <span className="loading-mark" aria-hidden />
            <p>Opening Arsenal</p>
          </div>
        ) : view === null ? (
          <EmptyLibrary
            busy={busy}
            error={error}
            onImport={() => void importLibrary()}
          />
        ) : (
          <LibraryTable
            view={view}
            busy={busy}
            error={error}
            onImport={() => void importLibrary()}
            onPage={(offset) => void changePage(offset)}
          />
        )}
      </main>

      <footer className="app-footer">
        <span>READ ONLY</span>
        <span>MEMORY ONLY</span>
        <span>NO NETWORK</span>
      </footer>
    </div>
  );
};
