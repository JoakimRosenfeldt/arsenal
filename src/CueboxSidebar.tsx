import type { JSX } from 'react';

import { PreferencesButton } from './Preferences';
import type { RekordboxPlaylist } from './shared/dj-library';

export type PageId =
  | 'library'
  | 'duplicates'
  | 'playlists';

type NavigationItem = Readonly<{
  page: Exclude<PageId, 'playlists'>;
  label: string;
  shortLabel: string;
  badge: string;
}>;

const collectionItems: readonly NavigationItem[] = [
  {
    page: 'library',
    label: 'Library',
    shortLabel: 'LI',
    badge: '',
  },
  {
    page: 'duplicates',
    label: 'Duplicates',
    shortLabel: 'DU',
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

type PlaylistBranchItem =
  | Readonly<{ kind: 'folder'; name: string }>
  | Readonly<{ kind: 'playlist'; playlist: RekordboxPlaylist }>;

const startsWithPath = (
  fullPath: readonly string[],
  parentPath: readonly string[],
): boolean =>
  parentPath.every((folder, index) => fullPath[index] === folder);

const itemsAtPath = (
  playlists: readonly RekordboxPlaylist[],
  path: readonly string[],
): readonly PlaylistBranchItem[] => {
  const items: PlaylistBranchItem[] = [];
  const folders = new Set<string>();

  for (const playlist of playlists) {
    if (!startsWithPath(playlist.folderPath, path)) {
      continue;
    }

    const childFolder = playlist.folderPath[path.length];
    if (childFolder === undefined) {
      items.push({ kind: 'playlist', playlist });
    } else if (!folders.has(childFolder)) {
      folders.add(childFolder);
      items.push({ kind: 'folder', name: childFolder });
    }
  }

  return items;
};

const PlaylistBranch = ({
  activePage,
  onSelect,
  path,
  playlists,
  selectedPlaylistId,
}: Readonly<{
  activePage: PageId;
  onSelect: (playlistId: string) => void;
  path: readonly string[];
  playlists: readonly RekordboxPlaylist[];
  selectedPlaylistId: string | null;
}>): JSX.Element => (
  <div className="sidebar-playlist-branch">
    {itemsAtPath(playlists, path).map((item) => {
      if (item.kind === 'playlist') {
        const active = activePage === 'playlists' && item.playlist.id === selectedPlaylistId;
        return (
          <button
            className={active ? 'sidebar-playlist is-active' : 'sidebar-playlist'}
            type="button"
            onClick={() => onSelect(item.playlist.id)}
            aria-current={active ? 'page' : undefined}
            title={item.playlist.kind === 'smart' ? `${item.playlist.name}, smart playlist` : item.playlist.name}
            key={item.playlist.id}
          >
            <span className={item.playlist.kind === 'smart' ? 'playlist-node-icon is-smart' : 'playlist-node-icon'} aria-hidden />
            <span>{item.playlist.name}</span>
            {item.playlist.kind === 'smart' && <small>Smart</small>}
          </button>
        );
      }

      const childPath = [...path, item.name];
      const playlistCount = playlists.filter((playlist) =>
        startsWithPath(playlist.folderPath, childPath),
      ).length;
      return (
        <details className="sidebar-playlist-folder" open key={childPath.join('\u0000')}>
          <summary>
            <span className="folder-caret" aria-hidden>›</span>
            <span>{item.name}</span>
            <small>{playlistCount}</small>
          </summary>
          <PlaylistBranch
            activePage={activePage}
            onSelect={onSelect}
            path={childPath}
            playlists={playlists}
            selectedPlaylistId={selectedPlaylistId}
          />
        </details>
      );
    })}
  </div>
);

export const CueboxSidebar = ({
  activePage,
  busy,
  duplicateCount,
  hasLibrary,
  onNavigate,
  onPlaylistSelect,
  onQueryChange,
  playlists,
  query,
  selectedPlaylistId,
  songCount,
}: Readonly<{
  activePage: PageId;
  busy: boolean;
  duplicateCount: number | null;
  hasLibrary: boolean;
  onNavigate: (page: PageId) => void;
  onPlaylistSelect: (playlistId: string) => void;
  onQueryChange: (query: string) => void;
  playlists: readonly RekordboxPlaylist[] | null;
  query: string;
  selectedPlaylistId: string | null;
  songCount: number;
}>): JSX.Element => {
  const collection = collectionItems.map((item) => {
    if (item.page === 'library') {
      return { ...item, badge: hasLibrary ? songCount.toLocaleString() : '—' };
    }

    return {
      ...item,
      badge: hasLibrary
        ? duplicateCount === null
          ? '…'
          : String(duplicateCount)
        : '—',
    };
  });

  const playlistPageActive = activePage === 'playlists' && selectedPlaylistId === null;

  return (
    <aside className="cuebox-sidebar" aria-label="Arsenal navigation">
      <div className="sidebar-top">
        <div className="cuebox-brand" aria-label="Arsenal">
          <span className="cuebox-mark" aria-hidden />
          <span className="sidebar-brand-text">Arsenal</span>
          <span className="sidebar-version">LOCAL</span>
        </div>

        <label className="sidebar-search" htmlFor="library-search">
          <span className="search-icon" aria-hidden />
          <input
            id="library-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder={hasLibrary ? 'Search collection' : 'Import to search'}
            maxLength={200}
            disabled={!hasLibrary || busy || activePage !== 'library'}
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

        <div className="sidebar-group sidebar-playlist-group">
          <p className="sidebar-section-label">Playlists</p>
          <button
            className={playlistPageActive ? 'sidebar-nav-item is-active' : 'sidebar-nav-item'}
            type="button"
            onClick={() => onNavigate('playlists')}
            aria-current={playlistPageActive ? 'page' : undefined}
            aria-label="Playlists"
          >
            <span className="nav-active-bar" aria-hidden />
            <span className="nav-short" aria-hidden>PL</span>
            <span className="nav-label">All playlists</span>
            <span className="nav-badge">{playlists?.length ?? (hasLibrary ? '…' : '—')}</span>
          </button>

          <div className="sidebar-playlist-tree">
            {playlists !== null && playlists.length > 0 && (
              <PlaylistBranch
                activePage={activePage}
                onSelect={onPlaylistSelect}
                path={[]}
                playlists={playlists}
                selectedPlaylistId={selectedPlaylistId}
              />
            )}
            {playlists !== null && playlists.length === 0 && (
              <p className="sidebar-playlist-empty">No playlists in this XML</p>
            )}
          </div>
        </div>
      </nav>
      <PreferencesButton className="sidebar-preferences" />
    </aside>
  );
};
