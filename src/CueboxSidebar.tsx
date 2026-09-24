import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';

import { UiIcon } from './UiIcon';
import type { PlaylistFolder, RekordboxPlaylist } from './shared/dj-library';

const MIN_SIDEBAR_WIDTH = 170;
const MAX_SIDEBAR_WIDTH = 480;
const SIDEBAR_WIDTH_KEY = 'arsenal.sidebarWidth';

export type PageId =
  | 'library'
  | 'duplicates'
  | 'playlists'
  | 'preferences';

type NavigationItem = Readonly<{
  page: Exclude<PageId, 'playlists' | 'preferences'>;
  label: string;
  badge: string;
}>;

const collectionItems: readonly NavigationItem[] = [
  {
    page: 'library',
    label: 'Library',
    badge: '',
  },
  {
    page: 'duplicates',
    label: 'Duplicates',
    badge: '',
  },
];

const NavigationGroup = ({
  activePage,
  items,
  onNavigate,
}: Readonly<{
  activePage: PageId;
  items: readonly NavigationItem[];
  onNavigate: (page: PageId) => void;
}>): JSX.Element => (
  <div className="sidebar-group">
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
  onMenu: (parentFolderId: string | null, playlistId: string | null) => void;
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
              {...playlistMenuEvents(() => onMenu(parentFolderId, playlist.id))}
              aria-current={active ? 'page' : undefined}
              title={playlist.kind === 'smart' ? `${playlist.name}, smart playlist` : playlist.name}
              key={playlist.id}
            >
              <UiIcon name="playlist" size={16} />
              <span>{playlist.name}</span>
            </button>
          );
        }
        const folder = node;
        return (
          <details className="sidebar-playlist-folder" open key={folder.id}>
            <summary {...playlistMenuEvents(() => onMenu(folder.id, null))}>
              <UiIcon name="folder" size={16} />
              <span>{folder.name}</span>
              <span className="folder-caret" aria-hidden><UiIcon name="chevron-right" size={14} /></span>
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
}: Readonly<{
  activePage: PageId;
  busy: boolean;
  duplicateCount: number | null;
  hasLibrary: boolean;
  folders: readonly PlaylistFolder[];
  onMenu: (parentFolderId: string | null, playlistId: string | null) => void;
  onNavigate: (page: PageId) => void;
  onPlaylistSelect: (playlistId: string) => void;
  playlists: readonly RekordboxPlaylist[] | null;
  selectedPlaylistId: string | null;
}>): JSX.Element => {
  const [preferredWidth, setPreferredWidth] = useState<number | null>(() => {
    try {
      const savedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      return Number.isFinite(savedWidth) && savedWidth >= MIN_SIDEBAR_WIDTH && savedWidth <= MAX_SIDEBAR_WIDTH
        ? savedWidth : null;
    } catch {
      return null;
    }
  });
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const maxWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, windowWidth - 480));
  const defaultWidth = windowWidth <= 800 ? 170 : windowWidth <= 1100 ? 190 : 224;
  const width = Math.min(preferredWidth ?? defaultWidth, maxWidth);

  useEffect(() => {
    const onResize = (): void => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (preferredWidth === null) return;
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(preferredWidth));
    } catch {
      // Resizing still works when storage is unavailable.
    }
  }, [preferredWidth]);

  const resize = (nextWidth: number): void => {
    setPreferredWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, Math.round(nextWidth))));
  };
  const stopResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const collection = collectionItems.map((item) => {
    if (item.page === 'library') {
      return item;
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
    <aside className="cuebox-sidebar" id="arsenal-sidebar" aria-label="Arsenal navigation" style={{ width }}>
      <div className="sidebar-top">
        <div className="cuebox-brand" aria-label="Arsenal">
          <span className="sidebar-brand-text">Arsenal</span>
        </div>

      </div>

      <nav className="sidebar-navigation" aria-label="Pages">
        <NavigationGroup
          activePage={activePage}
          items={collection}
          onNavigate={onNavigate}
        />

        <div className="sidebar-group sidebar-playlist-group">
          <div className="sidebar-playlist-title" {...playlistMenuEvents(() => onMenu(null, null))}>
            <p className="sidebar-section-label">Playlists</p>
            <button className="sidebar-add" type="button" aria-label="Create playlist or folder" aria-haspopup="menu"
              title="New playlist, smart playlist, or folder" disabled={!hasLibrary || busy} onClick={() => onMenu(null, null)}>+</button>
          </div>

          <div className="sidebar-playlist-tree" {...playlistMenuEvents(() => onMenu(null, null))}>
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
          </div>
        </div>
      </nav>
      <div className="sidebar-utilities">
        <button className={activePage === 'preferences' ? 'sidebar-preferences is-active' : 'sidebar-preferences'}
          type="button" aria-current={activePage === 'preferences' ? 'page' : undefined}
          onClick={() => onNavigate('preferences')}>
          <UiIcon name="settings" size={16} /><span>Preferences</span>
        </button>
      </div>
      <div
        className="sidebar-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label="Sidebar width"
        aria-orientation="vertical"
        aria-controls="arsenal-sidebar"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels`}
        title="Drag to resize sidebar"
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragStart.current = { x: event.clientX, width };
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId) || dragStart.current === null) return;
          resize(dragStart.current.width + event.clientX - dragStart.current.x);
        }}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onLostPointerCapture={() => { dragStart.current = null; }}
        onKeyDown={(event) => {
          let nextWidth: number;
          switch (event.key) {
            case 'ArrowLeft': nextWidth = width - 10; break;
            case 'ArrowRight': nextWidth = width + 10; break;
            case 'Home': nextWidth = MIN_SIDEBAR_WIDTH; break;
            case 'End': nextWidth = maxWidth; break;
            default: return;
          }
          event.preventDefault();
          resize(nextWidth);
        }}
      />
    </aside>
  );
};
