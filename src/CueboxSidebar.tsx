import type { JSX, KeyboardEvent, MouseEvent } from 'react';

import coffeeIconUrl from '../assets/buy-me-a-coffee.svg';
import type { PlaylistFolder, RekordboxPlaylist } from './shared/dj-library';

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

const playlistMenuEvents = (onMenu: () => void) => ({
  onContextMenu: (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onMenu();
  },
  onKeyDown: (event: KeyboardEvent) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      event.stopPropagation();
      onMenu();
    }
  },
});

const PlaylistBranch = ({
  activePage,
  onSelect,
  parentFolderId,
  folders,
  onMenu,
  playlists,
  selectedPlaylistId,
}: Readonly<{
  activePage: PageId;
  onSelect: (playlistId: string) => void;
  parentFolderId: string | null;
  folders: readonly PlaylistFolder[];
  onMenu: (parentFolderId: string | null) => void;
  playlists: readonly RekordboxPlaylist[];
  selectedPlaylistId: string | null;
}>): JSX.Element => {
  const nodes: (PlaylistFolder | RekordboxPlaylist)[] = [...folders, ...playlists];
  return (
    <div className="sidebar-playlist-branch">
      {nodes.filter((node) => node.parentFolderId === parentFolderId).sort((a, b) => a.order - b.order).map((node) => {
        if ('tracks' in node) {
          const playlist = node;
          const active = activePage === 'playlists' && playlist.id === selectedPlaylistId;
          return (
            <button
              className={active ? 'sidebar-playlist is-active' : 'sidebar-playlist'}
              type="button"
              onClick={() => onSelect(playlist.id)}
              {...playlistMenuEvents(() => onMenu(parentFolderId))}
              aria-current={active ? 'page' : undefined}
              title={playlist.kind === 'smart' ? `${playlist.name}, smart playlist` : playlist.name}
              key={playlist.id}
            >
              <span className={playlist.kind === 'smart' ? 'playlist-node-icon is-smart' : 'playlist-node-icon'} aria-hidden />
              <span>{playlist.name}</span>
              {playlist.kind === 'smart' && <small>Smart</small>}
            </button>
          );
        }
        const folder = node;
        const descendants = new Set([folder.id]);
        for (const child of folders) {
          if (child.parentFolderId !== null && descendants.has(child.parentFolderId)) descendants.add(child.id);
        }
        const playlistCount = playlists.filter((playlist) => playlist.parentFolderId !== null && descendants.has(playlist.parentFolderId)).length;
        return (
          <details className="sidebar-playlist-folder" open key={folder.id}>
            <summary {...playlistMenuEvents(() => onMenu(folder.id))}>
              <span className="folder-caret" aria-hidden>›</span>
              <span>{folder.name}</span>
              <small>{playlistCount}</small>
            </summary>
            <PlaylistBranch
              activePage={activePage}
              onSelect={onSelect}
              parentFolderId={folder.id}
              folders={folders}
              onMenu={onMenu}
              playlists={playlists}
              selectedPlaylistId={selectedPlaylistId}
            />
          </details>
        );
      })}
    </div>
  );
};

export const CueboxSidebar = ({
  activePage,
  busy,
  duplicateCount,
  hasLibrary,
  folders,
  onMenu,
  onNavigate,
  onPlaylistSelect,
  playlists,
  selectedPlaylistId,
  songCount,
}: Readonly<{
  activePage: PageId;
  busy: boolean;
  duplicateCount: number | null;
  hasLibrary: boolean;
  folders: readonly PlaylistFolder[];
  onMenu: (parentFolderId: string | null) => void;
  onNavigate: (page: PageId) => void;
  onPlaylistSelect: (playlistId: string) => void;
  playlists: readonly RekordboxPlaylist[] | null;
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

  return (
    <aside className="cuebox-sidebar" aria-label="Arsenal navigation">
      <div className="sidebar-top">
        <div className="cuebox-brand" aria-label="Arsenal">
          <span className="cuebox-mark" aria-hidden />
          <span className="sidebar-brand-text">Arsenal</span>
          <span className="sidebar-version">LOCAL</span>
        </div>

        <button className="sidebar-search" type="button" aria-label="Search collection"
          disabled={!hasLibrary || busy}
          onClick={() => {
            onNavigate('library');
            requestAnimationFrame(() => document.getElementById('library-search')?.focus());
          }}>
          <span className="search-icon" aria-hidden />
          <span className="sidebar-search-label">Search collection</span>
          <span className="search-shortcut" aria-hidden>⌘K</span>
        </button>
      </div>

      <nav className="sidebar-navigation" aria-label="Pages">
        <NavigationGroup
          activePage={activePage}
          items={collection}
          label="Collection"
          onNavigate={onNavigate}
        />

        <div className="sidebar-group sidebar-playlist-group">
          <div className="sidebar-playlist-title" {...playlistMenuEvents(() => onMenu(null))}>
            <p className="sidebar-section-label">Playlists</p>
            <button className="sidebar-add" type="button" aria-label="Create playlist or folder" aria-haspopup="menu"
              title="New playlist, smart playlist, or folder" disabled={!hasLibrary || busy} onClick={() => onMenu(null)}>+</button>
          </div>

          <div className="sidebar-playlist-tree" {...playlistMenuEvents(() => onMenu(null))}>
            {playlists !== null && (
              <PlaylistBranch
                activePage={activePage}
                onSelect={onPlaylistSelect}
                parentFolderId={null}
                folders={folders}
                onMenu={onMenu}
                playlists={playlists}
                selectedPlaylistId={selectedPlaylistId}
              />
            )}
            {playlists !== null && playlists.length === 0 && folders.length === 0 && (
              <p className="sidebar-playlist-empty">Use + to create a playlist or folder.</p>
            )}
          </div>
        </div>
      </nav>
      <div className="sidebar-support-footer">
        <a className="sidebar-support" href="https://www.buymeacoffee.com/joakim_mellonn"
          target="_blank" rel="noopener noreferrer" aria-label="Buy me a coffee" title="Buy me a coffee, opens in your browser">
          <img src={coffeeIconUrl} alt="" width={18} height={26} />
          <span>Buy me a coffee</span>
        </a>
      </div>
    </aside>
  );
};
