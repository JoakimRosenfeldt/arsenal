import type { JSX } from 'react';

export type PageId =
  | 'library'
  | 'duplicates'
  | 'crate-builder'
  | 'gig-prep';

type NavigationItem =
  | Readonly<{
      kind: 'page';
      page: PageId;
      label: string;
      shortLabel: string;
      badge: string;
    }>
  | Readonly<{
      kind: 'unavailable';
      label: string;
      shortLabel: string;
      badge: string;
    }>;

const collectionItems: readonly NavigationItem[] = [
  {
    kind: 'page',
    page: 'library',
    label: 'Library',
    shortLabel: 'LI',
    badge: '',
  },
  {
    kind: 'page',
    page: 'duplicates',
    label: 'Duplicates',
    shortLabel: 'DU',
    badge: '',
  },
  {
    kind: 'unavailable',
    label: 'Tag cleanup',
    shortLabel: 'TC',
    badge: '—',
  },
  {
    kind: 'unavailable',
    label: 'Analyze queue',
    shortLabel: 'AQ',
    badge: '—',
  },
];

const curationItems: readonly NavigationItem[] = [
  {
    kind: 'page',
    page: 'crate-builder',
    label: 'Crate builder',
    shortLabel: 'CB',
    badge: '',
  },
  {
    kind: 'page',
    page: 'gig-prep',
    label: 'Gig prep',
    shortLabel: 'GP',
    badge: '',
  },
];

const NavigationGroup = ({
  activePage,
  items,
  label,
  onNavigate,
}: Readonly<{
  activePage: PageId;
  items: readonly NavigationItem[];
  label: string;
  onNavigate: (page: PageId) => void;
}>): JSX.Element => (
  <div className="sidebar-group">
    <p className="sidebar-section-label">{label}</p>
    <div className="sidebar-nav-list">
      {items.map((item) => {
        if (item.kind === 'unavailable') {
          return (
            <button
              className="sidebar-nav-item is-unavailable"
              type="button"
              disabled
              title={`${item.label} is not included in this design handoff`}
              key={item.label}
            >
              <span className="nav-active-bar" aria-hidden />
              <span className="nav-short" aria-hidden>{item.shortLabel}</span>
              <span className="nav-label">{item.label}</span>
              <span className="nav-badge">{item.badge}</span>
            </button>
          );
        }

        const isActive = item.page === activePage;
        return (
          <button
            className={isActive ? 'sidebar-nav-item is-active' : 'sidebar-nav-item'}
            type="button"
            onClick={() => onNavigate(item.page)}
            aria-current={isActive ? 'page' : undefined}
            aria-label={item.label}
            key={item.page}
          >
            <span className="nav-active-bar" aria-hidden />
            <span className="nav-short" aria-hidden>{item.shortLabel}</span>
            <span className="nav-label">{item.label}</span>
            <span className="nav-badge">{item.badge}</span>
          </button>
        );
      })}
    </div>
  </div>
);

export const CueboxSidebar = ({
  activePage,
  busy,
  duplicateCount,
  hasLibrary,
  onImport,
  onNavigate,
  onQueryChange,
  query,
  songCount,
  sourceName,
}: Readonly<{
  activePage: PageId;
  busy: boolean;
  duplicateCount: number;
  hasLibrary: boolean;
  onImport: () => void;
  onNavigate: (page: PageId) => void;
  onQueryChange: (query: string) => void;
  query: string;
  songCount: number;
  sourceName: string | null;
}>): JSX.Element => {
  const collection = collectionItems.map((item) => {
    if (item.kind === 'unavailable') {
      return item;
    }

    if (item.page === 'library') {
      return { ...item, badge: hasLibrary ? songCount.toLocaleString() : '—' };
    }

    if (item.page === 'duplicates') {
      return { ...item, badge: hasLibrary ? String(duplicateCount) : '—' };
    }

    return item;
  });

  return (
    <aside className="cuebox-sidebar" aria-label="Cuebox navigation">
      <div className="sidebar-top">
        <div className="cuebox-brand" aria-label="Cuebox">
          <span className="cuebox-mark" aria-hidden />
          <span className="sidebar-brand-text">Cuebox</span>
          <span className="sidebar-version">LOCAL</span>
        </div>

        <label className="sidebar-search" htmlFor="library-search">
          <span className="search-icon" aria-hidden />
          <input
            id="library-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder={hasLibrary ? 'Filter this page' : 'Import to search'}
            disabled={!hasLibrary}
          />
          <span className="search-shortcut" aria-hidden>⌘K</span>
        </label>
      </div>

      <nav className="sidebar-navigation" aria-label="Pages">
        <NavigationGroup
          activePage={activePage}
          items={collection}
          label="Collection"
          onNavigate={onNavigate}
        />
        <NavigationGroup
          activePage={activePage}
          items={curationItems}
          label="Curation"
          onNavigate={onNavigate}
        />
      </nav>

      <div className="sidebar-playlists">
        <p className="sidebar-section-label">Playlists</p>
        <div className="sidebar-note">
          <span aria-hidden>↳</span>
          <p>Playlist data is not loaded from this XML viewer.</p>
        </div>
      </div>

      <div className="sidebar-session">
        <div className="session-heading">
          <span className={hasLibrary ? 'session-dot is-ready' : 'session-dot'} aria-hidden />
          <span>{hasLibrary ? 'XML ready' : 'No library open'}</span>
        </div>
        <p title={sourceName ?? undefined}>
          {sourceName ?? 'Choose a Rekordbox Collection export to begin.'}
        </p>
        <button type="button" onClick={onImport} disabled={busy}>
          {busy ? 'Reading XML' : hasLibrary ? 'Replace XML' : 'Choose XML'}
        </button>
        <span className="session-mode">READ ONLY · MEMORY ONLY</span>
      </div>
    </aside>
  );
};
