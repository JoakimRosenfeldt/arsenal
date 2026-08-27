import { useEffect, useMemo, useState, type JSX } from 'react';

import {
  CueboxSidebar,
  type PageId,
} from './CueboxSidebar';
import {
  CrateBuilderPage,
  DuplicatesPage,
  GigPrepPage,
  LibraryPage,
  duplicateGroupsFor,
  type LibraryView,
} from './CueboxPages';
import {
  SONG_PAGE_SIZE,
  type ImportFailure,
} from './shared/dj-library';

type DisplayError = ImportFailure | 'unexpected';

const errorMessages: Readonly<Record<DisplayError, string>> = {
  'cannot-read':
    'Cuebox could not read that XML file. Check that it still exists and that this app can open it.',
  'not-rekordbox-xml':
    'That file is not a supported Rekordbox Collection export. In Rekordbox, choose File > Library > Export Collection in xml format.',
  'malformed-xml':
    'The XML file is incomplete or malformed. Export the collection again, then choose the new file.',
  unexpected:
    'Cuebox could not open the library. Close the app, reopen it, and try the export again.',
};

export const App = (): JSX.Element => {
  const [activePage, setActivePage] = useState<PageId>('library');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<LibraryView | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [query, setQuery] = useState('');

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

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        document.getElementById('library-search')?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
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
      setQuery('');
    } catch {
      setError('unexpected');
    } finally {
      setBusy(false);
    }
  };

  const changePage = async (offset: number): Promise<void> => {
    if (busy || view === null || offset < 0) {
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
      setQuery('');
    } catch {
      setError('unexpected');
    } finally {
      setBusy(false);
    }
  };

  const duplicateCount = useMemo(
    () => duplicateGroupsFor(view?.page.items ?? []).length,
    [view?.page.items],
  );
  const libraryVersion = view?.library.importedAt ?? 'empty';

  const page = (() => {
    switch (activePage) {
      case 'library':
        return (
          <LibraryPage
            key={libraryVersion}
            busy={busy}
            onImport={() => void importLibrary()}
            onPage={(offset) => void changePage(offset)}
            query={query}
            view={view}
          />
        );
      case 'duplicates':
        return (
          <DuplicatesPage
            key={libraryVersion}
            busy={busy}
            onImport={() => void importLibrary()}
            view={view}
          />
        );
      case 'crate-builder':
        return (
          <CrateBuilderPage
            key={libraryVersion}
            busy={busy}
            onImport={() => void importLibrary()}
            view={view}
          />
        );
      case 'gig-prep':
        return (
          <GigPrepPage
            key={libraryVersion}
            busy={busy}
            onImport={() => void importLibrary()}
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
        onImport={() => void importLibrary()}
        onNavigate={setActivePage}
        onQueryChange={setQuery}
        query={query}
        songCount={view?.library.songCount ?? 0}
        sourceName={view?.library.sourceName ?? null}
      />
      <main className="workspace" id="main-content">
        {error !== null && (
          <div className="app-alert" role="alert">
            <span>Could not import</span>
            <p>{errorMessages[error]}</p>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button>
          </div>
        )}
        {loading ? (
          <div className="loading-state" role="status">
            <span className="loading-mark" aria-hidden />
            <p>Opening Cuebox</p>
          </div>
        ) : page}
      </main>
    </div>
  );
};
