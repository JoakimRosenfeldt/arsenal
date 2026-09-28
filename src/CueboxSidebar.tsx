import { useEffect, useRef, useState, type DragEvent, type JSX, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';

import { UiIcon } from './UiIcon';
import type { PlaylistFolder, RekordboxPlaylist } from './shared/dj-library';

const MIN_SIDEBAR_WIDTH = 170;
const MAX_SIDEBAR_WIDTH = 480;
const SIDEBAR_WIDTH_KEY = 'arsenal.sidebarWidth';
const COLLAPSED_FOLDERS_KEY = 'arsenal.collapsedPlaylistFolders';
const pathKey = (path: readonly string[]): string => JSON.stringify(path);
type DropPlacement = 'before' | 'inside' | 'after';

const moveCollapsedPath = (saved: string, from: readonly string[], to: readonly string[]): string => {
  try {
    const path: unknown = JSON.parse(saved);
    return Array.isArray(path) && path.every((part) => typeof part === 'string') &&
      pathKey(path.slice(0, from.length)) === pathKey(from)
      ? pathKey([...to, ...path.slice(from.length)]) : saved;
  } catch { return saved; }
};

const savedCollapsedFolders = (libraryId: string | null): ReadonlySet<string> => {
  if (libraryId === null) return new Set();
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`${COLLAPSED_FOLDERS_KEY}.${libraryId}`) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((path): path is string => typeof path === 'string') : []);
  } catch {
    return new Set();
  }
};

export type PageId =
  | 'library'
  | 'duplicates'
  | 'connections'
  | 'playlists'
  | 'preferences';

type NavigationItem = Readonly<{
  page: Exclude<PageId, 'playlists' | 'preferences'>;
  label: string;
  badge: string;
}>;

const collectionItems: readonly NavigationItem[] = [
  {
    page: 'connections',
    label: 'Connections',
    badge: '',
  },
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
  busy,
  collapsedFolderPaths,
  draggedPath,
  dropHint,
  onSelect,
  onFolderToggle,
  onMove,
  parentFolderId,
  folders,
  onMenu,
  playlists,
  setDraggedPath,
  setDropHint,
  selectedPlaylistId,
}: Readonly<{
  activePage: PageId;
  busy: boolean;
  collapsedFolderPaths: ReadonlySet<string>;
  draggedPath: readonly string[] | null;
  dropHint: Readonly<{ path: string; placement: DropPlacement }> | null;
  onSelect: (playlistId: string) => void;
  onFolderToggle: (folderPath: string, open: boolean) => void;
  onMove: (sourcePath: readonly string[], parentPath: readonly string[], beforePath: readonly string[] | null) => Promise<boolean>;
  parentFolderId: string | null;
  folders: readonly PlaylistFolder[];
  onMenu: (parentFolderId: string | null, playlistId: string | null) => void;
  playlists: readonly RekordboxPlaylist[];
  setDraggedPath: (path: readonly string[] | null) => void;
  setDropHint: (hint: Readonly<{ path: string; placement: DropPlacement }> | null) => void;
  selectedPlaylistId: string | null;
}>): JSX.Element => {
  const nodes: (PlaylistFolder | RekordboxPlaylist)[] = [...folders, ...playlists];
  const siblings = nodes.filter((node) => node.parentFolderId === parentFolderId).sort((a, b) => a.order - b.order);
  const parentPath = parentFolderId === null ? [] : folders.find((folder) => folder.id === parentFolderId)?.folderPath ?? [];
  const nodePath = (node: PlaylistFolder | RekordboxPlaylist): readonly string[] =>
    'tracks' in node ? [...node.folderPath, node.name] : node.folderPath;
  const dragStart = (event: DragEvent<HTMLElement>, path: readonly string[]): void => {
    if (busy) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', pathKey(path));
    setDraggedPath(path);
  };
  const placement = (event: DragEvent<HTMLElement>, folder: boolean): DropPlacement => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientY - rect.top) / rect.height;
    return fraction < (folder ? 0.25 : 0.5) ? 'before' : folder && fraction < 0.75 ? 'inside' : 'after';
  };
  const targetFor = (node: PlaylistFolder | RekordboxPlaylist, place: DropPlacement): Readonly<{
    parent: readonly string[]; before: readonly string[] | null;
  }> => {
    const path = nodePath(node);
    if (place === 'inside') return { parent: path, before: null };
    const remaining = siblings.filter((sibling) => pathKey(nodePath(sibling)) !== pathKey(draggedPath ?? []));
    const index = remaining.findIndex((sibling) => sibling.id === node.id);
    return { parent: parentPath, before: place === 'before' ? path : remaining[index + 1] ? nodePath(remaining[index + 1]!) : null };
  };
  const canDrop = (node: PlaylistFolder | RekordboxPlaylist, place: DropPlacement): boolean => {
    if (busy || draggedPath === null || pathKey(draggedPath) === pathKey(nodePath(node))) return false;
    const target = targetFor(node, place);
    return pathKey(target.parent.slice(0, draggedPath.length)) !== pathKey(draggedPath);
  };
  const dragOver = (event: DragEvent<HTMLElement>, node: PlaylistFolder | RekordboxPlaylist, folder: boolean): void => {
    event.stopPropagation();
    const place = placement(event, folder);
    if (!canDrop(node, place)) { setDropHint(null); return; }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropHint({ path: pathKey(nodePath(node)), placement: place });
  };
  const drop = (event: DragEvent<HTMLElement>, node: PlaylistFolder | RekordboxPlaylist, folder: boolean): void => {
    event.stopPropagation();
    event.preventDefault();
    const place = placement(event, folder);
    if (canDrop(node, place) && draggedPath !== null) {
      const target = targetFor(node, place);
      void onMove(draggedPath, target.parent, target.before);
    }
    setDraggedPath(null);
    setDropHint(null);
  };
  const rowClass = (path: readonly string[], base: string): string => {
    const hint = dropHint?.path === pathKey(path) ? dropHint.placement : null;
    return hint === null ? base : `${base} is-drop-${hint}`;
  };
  return (
    <div className={dropHint?.path === pathKey(parentPath) && dropHint.placement === 'inside'
      ? 'sidebar-playlist-branch is-drop-inside' : 'sidebar-playlist-branch'} onDragOver={(event) => {
      if (event.target !== event.currentTarget || draggedPath === null || busy ||
        pathKey(parentPath.slice(0, draggedPath.length)) === pathKey(draggedPath)) return;
      event.preventDefault();
      setDropHint({ path: pathKey(parentPath), placement: 'inside' });
    }} onDrop={(event) => {
      if (event.target !== event.currentTarget || draggedPath === null) return;
      event.preventDefault();
      event.stopPropagation();
      void onMove(draggedPath, parentPath, null);
      setDraggedPath(null);
      setDropHint(null);
    }}>
      {siblings.map((node) => {
        if ('tracks' in node) {
          const playlist = node;
          const active = activePage === 'playlists' && playlist.id === selectedPlaylistId;
          const path = nodePath(playlist);
          return (
            <button
              className={rowClass(path, active ? 'sidebar-playlist is-active' : 'sidebar-playlist')}
              type="button"
              draggable={!busy}
              onDragStart={(event) => dragStart(event, path)}
              onDragEnd={() => { setDraggedPath(null); setDropHint(null); }}
              onDragOver={(event) => dragOver(event, playlist, false)}
              onDrop={(event) => drop(event, playlist, false)}
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
        const folderPath = JSON.stringify(folder.folderPath);
        return (
          <details className="sidebar-playlist-folder" open={!collapsedFolderPaths.has(folderPath)}
            onToggle={(event) => onFolderToggle(folderPath, event.currentTarget.open)} key={folder.id}>
            <summary className={rowClass(folder.folderPath, '')} draggable={!busy}
              onDragStart={(event) => dragStart(event, folder.folderPath)}
              onDragEnd={() => { setDraggedPath(null); setDropHint(null); }}
              onDragOver={(event) => dragOver(event, folder, true)}
              onDrop={(event) => drop(event, folder, true)}
              {...playlistMenuEvents(() => onMenu(folder.id, null))}>
              <UiIcon name="folder" size={16} />
              <span>{folder.name}</span>
              <span className="folder-caret" aria-hidden><UiIcon name="chevron-right" size={14} /></span>
            </summary>
            <PlaylistBranch
              activePage={activePage}
              busy={busy}
              collapsedFolderPaths={collapsedFolderPaths}
              draggedPath={draggedPath}
              dropHint={dropHint}
              onSelect={onSelect}
              onFolderToggle={onFolderToggle}
              onMove={onMove}
              parentFolderId={folder.id}
              folders={folders}
              onMenu={onMenu}
              playlists={playlists}
              setDraggedPath={setDraggedPath}
              setDropHint={setDropHint}
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
  libraryId,
  folders,
  onMenu,
  onMove,
  onNavigate,
  onPlaylistSelect,
  playlists,
  selectedPlaylistId,
}: Readonly<{
  activePage: PageId;
  busy: boolean;
  duplicateCount: number | null;
  hasLibrary: boolean;
  libraryId: string | null;
  folders: readonly PlaylistFolder[];
  onMenu: (parentFolderId: string | null, playlistId: string | null) => void;
  onMove: (sourcePath: readonly string[], parentPath: readonly string[], beforePath: readonly string[] | null) => Promise<boolean>;
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
  const [collapsedFolderPaths, setCollapsedFolderPaths] = useState(() => savedCollapsedFolders(libraryId));
  const [draggedPath, setDraggedPath] = useState<readonly string[] | null>(null);
  const [dropHint, setDropHint] = useState<Readonly<{ path: string; placement: DropPlacement }> | null>(null);
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

  useEffect(() => {
    if (libraryId === null) return;
    try {
      localStorage.setItem(`${COLLAPSED_FOLDERS_KEY}.${libraryId}`, JSON.stringify([...collapsedFolderPaths]));
    } catch {
      // Folder toggles still work when storage is unavailable.
    }
  }, [collapsedFolderPaths, libraryId]);

  const toggleFolder = (folderPath: string, open: boolean): void => {
    setCollapsedFolderPaths((current) => {
      if (current.has(folderPath) === !open) return current;
      const next = new Set(current);
      if (open) next.delete(folderPath); else next.add(folderPath);
      return next;
    });
  };

  const moveNode = async (sourcePath: readonly string[], parentPath: readonly string[], beforePath: readonly string[] | null): Promise<boolean> => {
    const name = sourcePath.at(-1);
    if (name === undefined) return false;
    const destinationPath = [...parentPath, name];
    const folder = folders.find((candidate) => pathKey(candidate.folderPath) === pathKey(sourcePath));
    const migrate = folder !== undefined && ![...folders, ...(playlists ?? [])].some((candidate) =>
      candidate.id !== folder.id && pathKey('tracks' in candidate
        ? [...candidate.folderPath, candidate.name] : candidate.folderPath) === pathKey(destinationPath));
    if (migrate) setCollapsedFolderPaths((current) =>
      new Set([...current].map((saved) => moveCollapsedPath(saved, sourcePath, destinationPath))));
    const moved = await onMove(sourcePath, parentPath, beforePath);
    if (!moved && migrate) setCollapsedFolderPaths((current) =>
      new Set([...current].map((saved) => moveCollapsedPath(saved, destinationPath, sourcePath))));
    return moved;
  };

  const resize = (nextWidth: number): void => {
    setPreferredWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, Math.round(nextWidth))));
  };
  const stopResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const collection = collectionItems.map((item) => {
    if (item.page !== 'duplicates') {
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
          <div className="sidebar-playlist-title" {...playlistMenuEvents(() => onMenu(null, null))}
            onDragOver={(event) => {
              if (draggedPath === null || busy) return;
              event.preventDefault();
              setDropHint({ path: pathKey([]), placement: 'inside' });
            }}
            onDrop={(event) => {
              if (draggedPath === null || busy) return;
              event.preventDefault();
              void moveNode(draggedPath, [], null);
              setDraggedPath(null);
              setDropHint(null);
            }}>
            <p className="sidebar-section-label">Playlists</p>
            <button className="sidebar-add" type="button" aria-label="Create playlist or folder" aria-haspopup="menu"
              title="New playlist, smart playlist, or folder" disabled={!hasLibrary || busy} onClick={() => onMenu(null, null)}>+</button>
          </div>

          <div className="sidebar-playlist-tree" {...playlistMenuEvents(() => onMenu(null, null))}>
            {playlists !== null && (
              <PlaylistBranch
                activePage={activePage}
                busy={busy}
                collapsedFolderPaths={collapsedFolderPaths}
                draggedPath={draggedPath}
                dropHint={dropHint}
                onSelect={onPlaylistSelect}
                onFolderToggle={toggleFolder}
                onMove={moveNode}
                parentFolderId={null}
                folders={folders}
                onMenu={onMenu}
                playlists={playlists}
                setDraggedPath={setDraggedPath}
                setDropHint={setDropHint}
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
