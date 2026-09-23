import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react';

import type { DuplicateViewState } from './App';
import './FocusedPages.css';
import { UiIcon } from './UiIcon';
import { TracklistExportDialog } from './TracklistExportDialog';
import { TrackWaveform } from './TrackWaveform';
import { HelpTooltip } from './HelpTooltip';
import { PlaylistSuggestions } from './PlaylistSuggestions';
import { PlaylistIdentity } from './SmartPlaylistEditor';
import {
  TrackArtwork,
  type PlaybackController,
} from './CueboxPlayer';
import {
  DUPLICATE_MATCH_MODES,
  SONG_PAGE_SIZE,
  SONG_SOURCE_LABELS,
  SONG_METADATA_FILTERS,
  DEFAULT_SONG_FILTERS,
  songMetadataGapCount,
  type DuplicateGroup,
  type DuplicateMatchMode,
  type DuplicateScan,
  type LibrarySummary,
  type RekordboxPlaylist,
  type PlaylistFolder,
  type SongPage,
  type SongRow,
  type SongSearchRequest,
  type SongFilters,
} from './shared/dj-library';

export type LibraryView = Readonly<{
  library: LibrarySummary;
  page: SongPage;
}>;

type CommonPageProps = Readonly<{
  busy: boolean;
  onImport: () => void;
  playback: PlaybackController;
  view: LibraryView | null;
}>;

const formatDuration = (durationSeconds: number | null): string => {
  if (durationSeconds === null || !Number.isFinite(durationSeconds)) {
    return 'Not set';
  }

  const rounded = Math.max(0, Math.floor(durationSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = String(rounded % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
};

const formatBpm = (bpm: number | null): string =>
  bpm === null
    ? '—'
    : bpm.toLocaleString(undefined, { maximumFractionDigits: 2 });

const formatRowNumber = (offset: number, index: number): string =>
  String(offset + index + 1).padStart(2, '0');

const formatCues = (song: SongRow): string =>
  song.cuePointCount === 0
    ? 'No cues'
    : `${song.cuePointCount} ${song.cuePointCount === 1 ? 'cue' : 'cues'} · ${song.hotCueCount} hot`;

const SongLabels = ({ song }: Readonly<{ song: SongRow }>): JSX.Element => (
  <span className="song-labels">
    <span>{SONG_SOURCE_LABELS[song.source]}</span>
    <span title={`${song.hotCueCount} hot cues · ${Math.max(0, song.cuePointCount - song.hotCueCount)} memory cues`}>
      {formatCues(song)}
    </span>
  </span>
);

const totalTime = (songs: readonly SongRow[]): string => {
  const seconds = Math.floor(songs.reduce((total, song) => total + (song.durationSeconds ?? 0), 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(seconds % 60).padStart(2, '0')} sec`;
};

const trackColumns = [
  { key: 'bpm', label: 'BPM', width: 64 },
  { key: 'key', label: 'KEY', width: 60 },
  { key: 'time', label: 'Time', width: 66 },
  { key: 'genre', label: 'Genre', width: 130 },
  { key: 'album', label: 'Album', width: 146 },
] as const;
type TrackColumn = typeof trackColumns[number]['key'];
const defaultColumns = (): ReadonlySet<TrackColumn> => new Set(trackColumns.map((column) => column.key));
const trackGrid = (columns: ReadonlySet<TrackColumn>): string =>
  `20px 28px minmax(180px, 1fr) ${trackColumns.filter((column) => columns.has(column.key)).map((column) => `${column.width}px`).join(' ')} 24px`;
const TrackFacts = ({ song, columns }: Readonly<{ song: SongRow; columns: ReadonlySet<TrackColumn> }>): JSX.Element => <>
  {columns.has('bpm') && <span className="numeric" role="cell">{formatBpm(song.bpm)}</span>}
  {columns.has('key') && <span className="numeric" role="cell">{song.musicalKey ?? '—'}</span>}
  {columns.has('time') && <span className="numeric" role="cell">{formatDuration(song.durationSeconds)}</span>}
  {columns.has('genre') && <span className="truncate" role="cell">{song.genre ?? '—'}</span>}
  {columns.has('album') && <span className="truncate" role="cell">{song.album ?? '—'}</span>}
</>;
const ColumnControl = ({ columns, onChange }: Readonly<{
  columns: ReadonlySet<TrackColumn>; onChange: (columns: ReadonlySet<TrackColumn>) => void;
}>): JSX.Element => (
  <details className="focused-popover">
    <summary className="quiet-button"><UiIcon name="columns" size={16} /> Columns</summary>
    <div className="focused-popover-panel">
      {trackColumns.map((column) => <label key={column.key}>
        <input type="checkbox" checked={columns.has(column.key)} onChange={(event) => {
          const next = new Set(columns);
          if (event.currentTarget.checked) next.add(column.key); else next.delete(column.key);
          onChange(next);
        }} />{column.label}
      </label>)}
    </div>
  </details>
);
const TrackNumber = ({ song, index, offset = 0, playback }: Readonly<{
  song: SongRow; index: number; offset?: number; playback: PlaybackController;
}>): JSX.Element => {
  const playing = playback.song?.id === song.id && playback.playing;
  return <button className={playing ? 'focused-track-number is-playing' : 'focused-track-number'} type="button"
    disabled={song.audioUrl === null} aria-label={`${playing ? 'Pause' : 'Play'} ${song.title}`}
    onClick={(event) => { event.stopPropagation(); playback.play(song); }} onDoubleClick={(event) => event.stopPropagation()}>
    <span className="focused-row-number">{formatRowNumber(offset, index)}</span>
    <span className="focused-row-play"><UiIcon name={playing ? 'volume' : 'play'} size={16} /></span>
  </button>;
};

const NoLibrary = ({
  busy,
  onImport,
}: Readonly<{
  busy: boolean;
  onImport: () => void;
}>): JSX.Element => (
  <section className="page-empty" aria-labelledby="empty-page-title">
    <div className="page-empty-mark" aria-hidden>
      <span />
      <span />
      <span />
    </div>
    <h1 id="empty-page-title">Import your library</h1>
    <button className="accent-button" type="button" onClick={onImport} disabled={busy}>
      {busy ? 'Importing…' : 'Choose Rekordbox XML'}
    </button>
  </section>
);

export const LibraryPage = ({
  busy,
  filters,
  onCreate,
  onImport,
  onPage,
  onRemove,
  onSearch,
  playback,
  query,
  searching,
  view,
}: CommonPageProps &
  Readonly<{
    onPage: (offset: number) => void;
    onCreate: (songIds: readonly string[]) => void;
    onRemove: RemoveSongs;
    onSearch: (query: string, filters: SongFilters) => void;
    filters: SongFilters;
    query: string;
    searching: boolean;
  }>): JSX.Element => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [selection, setSelection] = useState<ReadonlyMap<string, SongRow>>(new Map());
  const [action, setAction] = useState<'remove' | null>(null);
  const [menuError, setMenuError] = useState(false);
  const [columns, setColumns] = useState(defaultColumns);
  const [exporting, setExporting] = useState(false);
  const [exportPlaylist, setExportPlaylist] = useState<RekordboxPlaylist | null>(null);
  const anchorId = useRef<string | null>(null);
  const inspectorRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!inspectorOpen) return;
    const dismissOutside = (event: MouseEvent): void => {
      if (!window.matchMedia('(max-width: 1150px)').matches || !(event.target instanceof Node)) return;
      if (!inspectorRef.current?.contains(event.target)) {
        setInspectorOpen(false);
      }
    };
    document.addEventListener('click', dismissOutside, true);
    return () => document.removeEventListener('click', dismissOutside, true);
  }, [inspectorOpen]);

  if (view === null) {
    return (
      <NoLibrary
        busy={busy}
        onImport={onImport}
      />
    );
  }

  const visibleSongs = view.page.items;
  const selectedSongs = [...selection.values()];
  const selectedOnPage = visibleSongs.filter((song) => selection.has(song.id)).length;
  const allOnPageSelected = visibleSongs.length > 0 && selectedOnPage === visibleSongs.length;
  const selectionLocked = busy || searching || action !== null;
  const filtered = query.length > 0 || filters.source !== 'all' || filters.metadata !== 'all';
  const selectedSong =
    visibleSongs.find((song) => song.id === selectedId) ??
    visibleSongs[0] ??
    null;
  const pageNumber = Math.floor(view.page.offset / view.page.limit) + 1;
  const pageCount = Math.max(1, Math.ceil(view.page.total / view.page.limit));

  const selectedIsActive = selectedSong?.id === playback.song?.id;
  const displayedDuration = selectedIsActive && playback.duration > 0
    ? playback.duration
    : selectedSong?.durationSeconds ?? 0;
  const displayedPosition = selectedIsActive ? playback.position : 0;

  const selectSong = (song: SongRow, toggle: boolean, range: boolean): void => {
    if (selectionLocked) return;
    setSelectedId(song.id);
    const anchorIndex = visibleSongs.findIndex((candidate) => candidate.id === anchorId.current);
    const index = visibleSongs.indexOf(song);
    const next = new Map(toggle || range ? selection : []);
    if (range && anchorIndex >= 0) {
      for (const candidate of visibleSongs.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1)) {
        next.set(candidate.id, candidate);
      }
    } else if (toggle && next.has(song.id)) {
      next.delete(song.id);
    } else {
      next.set(song.id, song);
    }
    if (!range || anchorIndex < 0) anchorId.current = song.id;
    setSelection(next);
  };

  const selectPage = (): void => {
    const next = new Map(selection);
    for (const song of visibleSongs) {
      if (allOnPageSelected) next.delete(song.id);
      else next.set(song.id, song);
    }
    setSelection(next);
  };

  const openTrackMenu = async (song: SongRow): Promise<void> => {
    if (selectionLocked) return;
    const songs = selection.has(song.id) ? selectedSongs : [song];
    setSelection(new Map(songs.map((item) => [item.id, item])));
    setSelectedId(song.id);
    setMenuError(false);
    try {
      const choice = await window.djLibrary.trackMenu({
        count: songs.length,
        playable: song.audioUrl !== null,
        playing: song.id === playback.song?.id && playback.playing,
      });
      if (choice === 'play') playback.play(song);
      if (choice === 'inspect') setInspectorOpen(true);
      if (choice === 'create-playlist') onCreate(songs.map((selected) => selected.id));
      if (choice === 'remove-songs') setAction('remove');
      if (choice === 'clear-selection') setSelection(new Map());
    } catch {
      setMenuError(true);
    }
  };

  const exportTracks = async (): Promise<void> => {
    setExporting(true);
    setMenuError(false);
    try {
      const tracks: SongRow[] = [];
      let offset = 0;
      let hasNext = true;
      while (hasNext) {
        const page = await window.djLibrary.listSongs({ offset, limit: SONG_PAGE_SIZE });
        tracks.push(...page.items);
        hasNext = page.hasNext && page.items.length > 0;
        offset += page.limit;
      }
      setExportPlaylist({ id: 'library', name: 'All tracks', order: 0, kind: 'regular', folderPath: [],
        parentFolderId: null, tracks, missingTrackCount: 0, smartRules: null, smartDefinition: null });
    } catch {
      setMenuError(true);
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="workspace-page library-page focused-library" aria-labelledby="library-title">
      <header className="page-header library-header">
        <div className="page-title-line">
          <h1 id="library-title">All tracks</h1>
          <p>{view.library.songCount.toLocaleString()} tracks{view.page.total === view.library.songCount && !view.page.hasNext && view.page.offset === 0 ? ` · ${totalTime(visibleSongs)}` : ''}</p>
        </div>
        <div className="header-actions">
          <button className="quiet-button focused-export" type="button" onClick={() => void exportTracks()} disabled={busy || exporting}>
            <UiIcon name="download" size={16} /> {exporting ? 'Preparing…' : 'Export tracklist'}
          </button>
          <button className="accent-button" type="button" onClick={onImport} disabled={busy}>
            <UiIcon name="upload" size={16} /> {busy ? 'Importing…' : 'Import XML'}
          </button>
        </div>
      </header>

      <div className="library-tools">
        <label className="library-search">
          <span className="search-icon" aria-hidden />
          <span className="visually-hidden">Search tracks</span>
          <input id="library-search" type="search" placeholder="Search tracks, artists or albums"
            value={query} maxLength={200} disabled={busy || action !== null}
            onChange={(event) => onSearch(event.currentTarget.value, filters)} />
          <kbd aria-hidden>⌘F</kbd>
        </label>
        <details className="focused-popover">
          <summary className={filtered ? 'quiet-button is-filtered' : 'quiet-button'}><UiIcon name="filters" size={16} /> Filters</summary>
          <div className="focused-popover-panel focused-filter-panel">
            <label>Source
              <select aria-label="Filter by source" value={filters.source} disabled={busy || action !== null}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  const source = value === 'all' ? 'all' : Object.keys(SONG_SOURCE_LABELS)
                    .find((key): key is keyof typeof SONG_SOURCE_LABELS => key === value);
                  if (source !== undefined) onSearch(query, { ...filters, source });
                }}>
                <option value="all">All sources</option>
                {Object.entries(SONG_SOURCE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
            <label>Metadata
              <select aria-label="Filter by metadata" value={filters.metadata} disabled={busy || action !== null}
                onChange={(event) => {
                  const metadata = Object.keys(SONG_METADATA_FILTERS)
                    .find((key): key is keyof typeof SONG_METADATA_FILTERS => key === event.currentTarget.value);
                  if (metadata !== undefined) onSearch(query, { ...filters, metadata });
                }}>
                {Object.entries(SONG_METADATA_FILTERS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
            {filtered && <button className="quiet-button" type="button" disabled={busy || action !== null}
              onClick={() => onSearch('', DEFAULT_SONG_FILTERS)}>Clear filters</button>}
          </div>
        </details>
        <ColumnControl columns={columns} onChange={setColumns} />
      </div>

      {menuError && <p className="library-menu-error" role="alert">Could not complete this action. Please try again.</p>}

      <div className="library-body">
        <div className="track-table" role="table" aria-label="Library tracks"
          onKeyDown={(event) => {
            if (selectionLocked) return;
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
              event.preventDefault();
              const next = new Map(selection);
              for (const song of visibleSongs) next.set(song.id, song);
              setSelection(next);
            }
            if (event.key === 'Escape') setSelection(new Map());
          }}>
          <div className="track-table-head" role="row" style={{ gridTemplateColumns: trackGrid(columns) }}>
            <span role="columnheader">
              <input type="checkbox" aria-label="Select all tracks on this page" checked={allOnPageSelected}
                ref={(input) => { if (input) input.indeterminate = selectedOnPage > 0 && !allOnPageSelected; }}
                onChange={selectPage} disabled={selectionLocked || visibleSongs.length === 0} />
            </span>
            <span role="columnheader"># ↑</span>
            <span role="columnheader">Track</span>
            {trackColumns.filter((column) => columns.has(column.key)).map((column) => <span role="columnheader" key={column.key}>{column.label}</span>)}
            <span role="columnheader"><span className="visually-hidden">Actions</span></span>
          </div>
          <div className="track-table-body" role="rowgroup" aria-busy={busy || searching}>
            {searching ? (
              <div className="inline-empty" role="status">Searching collection…</div>
            ) : visibleSongs.length === 0 ? (
              <div className="inline-empty">
                <strong>{view.library.songCount === 0 ? 'No tracks' : 'No matching tracks'}</strong>
                {filtered && <button className="quiet-button" type="button" disabled={busy || action !== null}
                  onClick={() => onSearch('', DEFAULT_SONG_FILTERS)}>Clear search and filters</button>}
              </div>
            ) : (
              visibleSongs.map((song, index) => {
                const isSelected = selection.has(song.id);
                const isPlaying = song.id === playback.song?.id && playback.playing;
                return (
                  <div
                    className={`track-row${isSelected ? ' is-selected' : ''}${isPlaying ? ' is-playing' : ''}`}
                    style={{ gridTemplateColumns: trackGrid(columns) }}
                    role="row"
                    tabIndex={0}
                    onClick={(event) => selectSong(song, event.metaKey || event.ctrlKey, event.shiftKey)}
                    onDoubleClick={() => { if (!selectionLocked) playback.play(song); }}
                    onContextMenu={(event) => { event.preventDefault(); void openTrackMenu(song); }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget || selectionLocked) return;
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault();
                        void openTrackMenu(song);
                      } else if (event.key === 'Enter') {
                        event.preventDefault();
                        setSelectedId(song.id);
                        setInspectorOpen(true);
                      } else if (event.key === ' ') {
                        event.preventDefault();
                        selectSong(song, true, event.shiftKey);
                      }
                    }}
                    title={`${song.title} by ${song.artist ?? 'Unknown artist'}`}
                    key={song.id}
                  >
                    <span role="cell">
                      <input type="checkbox" aria-label={`Select ${song.title} by ${song.artist ?? 'Unknown artist'}`}
                        checked={isSelected} disabled={selectionLocked}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onChange={(event) => selectSong(song, true, event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey)} />
                    </span>
                    <span role="cell"><TrackNumber song={song} index={index} offset={view.page.offset} playback={playback} /></span>
                    <span className="track-identity" role="cell">
                      <strong>{song.title}</strong>
                      <small>{song.artist ?? 'Unknown artist'}</small>
                    </span>
                    <TrackFacts song={song} columns={columns} />
                    <span role="cell">
                      <button className="track-menu-button" type="button" aria-label={`Actions for ${song.title}`} aria-haspopup="menu"
                        disabled={selectionLocked}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onClick={(event) => { event.stopPropagation(); void openTrackMenu(song); }}>⋯</button>
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {selectedSong !== null && inspectorOpen && (
          <aside className={inspectorOpen ? 'library-inspector is-open' : 'library-inspector'} aria-label="Selected track inspector" ref={inspectorRef}>
            <button className="inspector-close" type="button" onClick={() => setInspectorOpen(false)} aria-label="Close inspector">×</button>
            <div className="inspector-title">
              <TrackArtwork loadEagerly song={selectedSong} size="large" />
              <div>
                <h2>{selectedSong.title}</h2>
                <p>{selectedSong.artist ?? 'Unknown artist'}</p>
                <SongLabels song={selectedSong} />
              </div>
            </div>
            <div className="inspector-profile">
              <div className="section-label-row">
                <span>{formatDuration(displayedPosition)}</span>
                <span>{formatDuration(displayedDuration)}</span>
              </div>
              <TrackWaveform
                disabled={!selectedIsActive || selectedSong.audioUrl === null}
                duration={displayedDuration}
                onSeek={playback.seek}
                position={displayedPosition}
                song={selectedSong}
              />
              <div className="inspector-player">
                <button
                  type="button"
                  onClick={() => playback.play(selectedSong)}
                  disabled={selectedSong.audioUrl === null}
                >
                  {selectedIsActive && playback.playing ? 'Pause' : 'Play'}
                </button>
                {(selectedSong.audioUrl === null || (playback.failed && selectedIsActive)) && (
                  <span>Audio unavailable</span>
                )}
              </div>
            </div>
            <dl className="inspector-stats">
              <div><dt>BPM</dt><dd>{formatBpm(selectedSong.bpm)}</dd></div>
              <div><dt>Key</dt><dd>{selectedSong.musicalKey ?? '—'}</dd></div>
              <div><dt>Time</dt><dd>{formatDuration(selectedSong.durationSeconds)}</dd></div>
              <div><dt>Genre</dt><dd>{selectedSong.genre ?? 'Not set'}</dd></div>
              <div><dt>Album</dt><dd>{selectedSong.album ?? 'Not set'}</dd></div>
              <div><dt>Gaps</dt><dd>{songMetadataGapCount(selectedSong)}</dd></div>
            </dl>
          </aside>
        )}
      </div>

      {selectedSongs.length > 0 && (
        <LibrarySelectionActions busy={busy || searching} action={action} onAction={setAction}
          onClear={() => { setSelection(new Map()); setAction(null); }}
          onCreate={onCreate} onRemove={onRemove} songs={selectedSongs}
          hiddenCount={selection.size - selectedOnPage} />
      )}

      <nav className="page-pagination" aria-label="Song pages">
        <p>
          {filtered && `${view.page.total.toLocaleString()} results`}
          {pageCount > 1 && <span>Page <strong>{pageNumber}</strong> of {pageCount}</span>}
        </p>
        {pageCount > 1 && <div>
          <button type="button" onClick={() => onPage(view.page.offset - view.page.limit)} disabled={busy || searching || view.page.offset === 0}>
            ← Previous
          </button>
          <button type="button" onClick={() => onPage(view.page.offset + view.page.limit)} disabled={busy || searching || !view.page.hasNext}>
            Next →
          </button>
        </div>}
      </nav>
      {exportPlaylist !== null && <TracklistExportDialog playlist={exportPlaylist} onClose={() => setExportPlaylist(null)} />}
    </section>
  );
};

type DuplicateModeCopy = Readonly<{
  emptyTitle: string;
  label: string;
}>;

const duplicateModeCopy: Readonly<Record<DuplicateMatchMode, DuplicateModeCopy>> = {
  smart: {
    label: 'Smart',
    emptyTitle: 'No smart matches',
  },
  exact: {
    label: 'Exact',
    emptyTitle: 'No exact matches',
  },
  versions: {
    label: 'All versions',
    emptyTitle: 'No matching versions',
  },
  'dj-edits': {
    label: 'DJ edits',
    emptyTitle: 'No matching DJ edits',
  },
  remixes: {
    label: 'Remixes',
    emptyTitle: 'No matching remixes',
  },
};

const variantSummaryFor = (group: DuplicateGroup): string => {
  const labels = [...new Set(
    group.candidates.map((candidate) => candidate.variantLabel),
  )];
  const visible = labels.slice(0, 3).join(' · ');
  return labels.length > 3 ? `${visible} +${labels.length - 3}` : visible;
};

type RemoveSongs = (songIds: readonly string[], removeLocalFile: boolean) => Promise<boolean>;

const FileRemovalOption = ({
  busy,
  checked,
  onChange,
  songs,
}: Readonly<{
  busy: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
  songs: readonly SongRow[];
}>): JSX.Element => {
  const disabledReason = busy
    ? 'Wait until the current action finishes.'
    : !songs.some((song) => song.audioUrl !== null)
      ? songs.length === 1
        ? 'No audio file available.'
        : 'No audio files available for these tracks.'
      : null;

  return (
    <div className="file-removal-option">
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.currentTarget.checked)}
          disabled={disabledReason !== null}
        />
        {songs.length === 1
          ? 'Also move the audio file to Trash'
          : 'Also move audio files to Trash'}
      </label>
      {disabledReason !== null && <HelpTooltip label="Audio file removal">{disabledReason}</HelpTooltip>}
    </div>
  );
};

const LibrarySelectionActions = ({
  action, busy, hiddenCount, onAction, onClear, onCreate, onRemove, songs,
}: Readonly<{
  action: 'remove' | null;
  busy: boolean;
  hiddenCount: number;
  onAction: (action: 'remove' | null) => void;
  onClear: () => void;
  onCreate: (songIds: readonly string[]) => void;
  onRemove: RemoveSongs;
  songs: readonly SongRow[];
}>): JSX.Element => {
  const [removeLocalFile, setRemoveLocalFile] = useState(false);
  const actionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (action !== null) actionRef.current?.focus();
  }, [action]);
  const tooMany = songs.length > 10_000;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || tooMany || action !== 'remove') return;
    if (await onRemove(songs.map((song) => song.id), removeLocalFile)) onClear();
  };

  return (
    <form className="library-selection-actions" onSubmit={(event) => void submit(event)} aria-label="Selected track actions">
      {action === 'remove' && (
        <div className="duplicate-selection-review" ref={actionRef} tabIndex={-1}>
          <div className="help-label">
            <strong>Remove {songs.length} selected {songs.length === 1 ? 'track' : 'tracks'}?</strong>
            <HelpTooltip label="Removing tracks">Removes tracks from the library and playlists. Audio files are kept unless selected below.</HelpTooltip>
          </div>
          <ul aria-label="Tracks to remove">
            {songs.map((song) => <li key={song.id}>{song.title} · {song.artist ?? 'Unknown artist'} · Track {song.id}</li>)}
          </ul>
          <FileRemovalOption busy={busy} checked={removeLocalFile} onChange={setRemoveLocalFile} songs={songs} />
        </div>
      )}
      <div className="duplicate-selection-toolbar">
        <span role="status">{songs.length.toLocaleString()} selected
          {hiddenCount > 0 && <><small> · {hiddenCount.toLocaleString()} hidden</small> <HelpTooltip label="Hidden selections">Selected tracks on other pages or outside filters.</HelpTooltip></>}
          {tooMany && <> <HelpTooltip label="Selection limit">Select at most 10,000 tracks per action.</HelpTooltip></>}
        </span>
        {action === null ? <>
          <button className="quiet-button" type="button" onClick={onClear} disabled={busy}>Clear selection</button>
          <button className="quiet-button" type="button" onClick={() => onCreate(songs.map((song) => song.id))} disabled={busy || tooMany}>Create playlist</button>
          <button className="danger-button" type="button" onClick={() => onAction('remove')} disabled={busy || tooMany}>Remove selected</button>
        </> : <>
          <button className="quiet-button" type="button" onClick={() => { setRemoveLocalFile(false); onAction(null); }} disabled={busy}>Cancel</button>
          <button className="danger-button" type="submit" disabled={busy || tooMany}>
            {busy ? 'Saving…' : `Remove ${songs.length} ${songs.length === 1 ? 'track' : 'tracks'}`}
          </button>
        </>}
      </div>
    </form>
  );
};

const DuplicateSelectionActions = ({
  busy,
  onClear,
  onRemove,
  songs,
}: Readonly<{
  busy: boolean;
  onClear: () => void;
  onRemove: RemoveSongs;
  songs: readonly SongRow[];
}>): JSX.Element => {
  const [confirming, setConfirming] = useState(false);
  const [removeLocalFile, setRemoveLocalFile] = useState(false);

  return (
    <footer className="duplicate-selection-actions" aria-label="Selected tracks">
      {confirming && (
        <div className="duplicate-selection-review">
          <div className="help-label">
            <strong>Remove {songs.length} selected {songs.length === 1 ? 'track' : 'tracks'}?</strong>
            <HelpTooltip label="Removing tracks">Also removes these tracks from playlists.</HelpTooltip>
          </div>
          <ul aria-label="Tracks to remove">
            {songs.map((song) => (
              <li key={song.id}>
                {song.title} · {song.artist ?? 'Unknown artist'} · Track {song.id}
                <SongLabels song={song} />
              </li>
            ))}
          </ul>
          <FileRemovalOption
            busy={busy}
            checked={removeLocalFile}
            onChange={setRemoveLocalFile}
            songs={songs}
          />
        </div>
      )}
      <div className="duplicate-selection-toolbar">
        <span role="status">
          {songs.length} selected
          {songs.length > 10_000 && <> <HelpTooltip label="Selection limit">Select at most 10,000 tracks per removal.</HelpTooltip></>}
        </span>
        <button className="quiet-button" type="button" onClick={onClear} disabled={busy}>
          Clear selection
        </button>
        {confirming ? (
          <>
            <button className="quiet-button" type="button" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={() => {
                void onRemove(songs.map((song) => song.id), removeLocalFile).then((removed) => {
                  if (removed) {
                    onClear();
                  }
                });
              }}
            >
              {busy ? 'Removing' : `Remove ${songs.length} ${songs.length === 1 ? 'track' : 'tracks'}`}
            </button>
          </>
        ) : (
          <button className="danger-button" type="button" onClick={() => setConfirming(true)} disabled={busy || songs.length > 10_000}>
            Remove selected
          </button>
        )}
      </div>
    </footer>
  );
};

export const DuplicatesPage = ({
  busy,
  mode,
  onIgnore,
  onImport,
  onModeChange,
  onRemove,
  onRescan,
  playback,
  state,
  view,
}: CommonPageProps &
  Readonly<{
    mode: DuplicateMatchMode;
    onIgnore: (groupKey: string) => Promise<boolean>;
    onModeChange: (mode: DuplicateMatchMode) => void;
    onRemove: RemoveSongs;
    onRescan: () => void;
    state: DuplicateViewState;
  }>): JSX.Element => {
  const [selection, setSelection] = useState<{
    key: string | null;
    index: number;
    groups: readonly DuplicateGroup[];
  }>({
    key: null,
    index: 0,
    groups: [],
  });
  const [chosenIds, setChosenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectionVersion, setSelectionVersion] = useState<string | null>(null);

  if (view === null) {
    return (
      <NoLibrary
        busy={busy}
        onImport={onImport}
      />
    );
  }

  const scan: DuplicateScan | null =
    state.kind === 'ready' &&
    state.libraryVersion === view.library.revision &&
    state.scan.mode === mode
      ? state.scan
      : null;
  const stateMode =
    state.kind === 'ready'
      ? state.scan.mode
      : state.kind === 'error'
        ? state.mode
        : null;
  const scanning =
    state.kind === 'empty' ||
    state.libraryVersion !== view.library.revision ||
    stateMode !== mode;
  const scanFailed =
    state.kind === 'error' &&
    state.libraryVersion === view.library.revision &&
    state.mode === mode;
  const groups = scan?.groups ?? [];
  const suggestedIds = groups.flatMap((group) =>
    group.recommendedKeepSongId === null
      ? []
      : group.candidates
        .filter((candidate) => candidate.song.id !== group.recommendedKeepSongId)
        .map((candidate) => candidate.song.id),
  );
  const currentSelectionVersion = JSON.stringify([view.library.revision, mode]);
  if (selectionVersion !== currentSelectionVersion) {
    setSelectionVersion(currentSelectionVersion);
    setChosenIds(new Set());
  }
  const chosenSongs = groups.flatMap((group) => group.candidates)
    .filter((candidate) => chosenIds.has(candidate.song.id))
    .map((candidate) => candidate.song);
  const remainingKeys = new Set(groups.map((group) => group.key));
  const nearbyGroup = [
    ...selection.groups.slice(selection.index),
    ...selection.groups.slice(0, selection.index).reverse(),
  ].find((group) => remainingKeys.has(group.key));
  const selectedGroup =
    groups.find((group) => group.key === selection.key) ??
    groups.find((group) => group.key === nearbyGroup?.key) ?? groups[0] ?? null;
  const selectedIndex = selectedGroup === null ? 0 : groups.indexOf(selectedGroup);
  if (scan !== null && (selection.groups !== groups || selection.key !== (selectedGroup?.key ?? null) || selection.index !== selectedIndex)) {
    setSelection({ key: selectedGroup?.key ?? null, index: selectedIndex, groups });
  }
  const copy = duplicateModeCopy[mode];
  const emptyTitle = (scan?.ignoredGroupCount ?? 0) > 0
    ? 'No groups left to review'
    : copy.emptyTitle;

  const comparisonRows: readonly Readonly<{ label: string; value: (song: SongRow) => string }>[] = [
    { label: 'Length', value: (song) => formatDuration(song.durationSeconds) },
    { label: 'BPM', value: (song) => formatBpm(song.bpm) },
    { label: 'Key', value: (song) => song.musicalKey ?? '—' },
    { label: 'Format', value: (song) => [song.fileKind, song.bitRateKbps === null ? null : `${song.bitRateKbps} kbps`].filter(Boolean).join(' · ') || '—' },
    { label: 'Cue points', value: (song) => String(song.cuePointCount) },
    { label: 'Source', value: (song) => SONG_SOURCE_LABELS[song.source] },
  ];
  const modeDescription: Record<DuplicateMatchMode, string> = {
    versions: 'Find alternate mixes of the same title and artist.',
    exact: 'Find tracks with the same title and artist.',
    smart: 'Find likely duplicates and suggested versions to keep.',
    'dj-edits': 'Find DJ edits of the same title and artist.',
    remixes: 'Find remixes of the same title and artist.',
  };

  return (
    <section className="workspace-page duplicates-page focused-duplicates" aria-labelledby="duplicates-title">
      <header className="page-header">
        <div className="page-title-line">
          <h1 id="duplicates-title">Duplicates</h1>
          {!scanning && !scanFailed && <p>{groups.length} {groups.length === 1 ? 'group' : 'groups'} · {scan?.trackCount ?? 0} tracks</p>}
        </div>
        <div className="header-actions">
          <button className="quiet-button" type="button" onClick={onRescan} disabled={busy || scanning}>
            <UiIcon name="refresh" size={16} /> {scanning ? 'Scanning…' : 'Scan again'}
          </button>
        </div>
      </header>
      <div className="focused-duplicate-controls">
        <label htmlFor="duplicate-match-mode">Match by</label>
        <select id="duplicate-match-mode" value={mode} disabled={busy} onChange={(event) => {
          const next = DUPLICATE_MATCH_MODES.find((option) => option === event.currentTarget.value);
          if (next) {
            setSelection({ key: null, index: 0, groups: [] });
            onModeChange(next);
          }
        }}>
          {DUPLICATE_MATCH_MODES.map((option) => <option value={option} key={option}>{option === 'versions' ? 'Versions' : duplicateModeCopy[option].label}</option>)}
        </select>
        <span>{modeDescription[mode]}</span>
        {mode === 'smart' && <button className="quiet-button" type="button" disabled={busy || scanning || suggestedIds.length === 0}
          onClick={() => setChosenIds(new Set(suggestedIds.slice(0, 10_000)))}>
          Select suggested ({Math.min(suggestedIds.length, 10_000).toLocaleString()})
        </button>}
      </div>

      <div className="duplicates-body">
        <aside className="duplicate-groups" aria-label="Matched track groups">
          <div className="panel-heading">To review</div>
          {!scanning && !scanFailed && groups.map((group, index) => {
            const isActive = group.key === selectedGroup?.key;
            return <button className={isActive ? 'duplicate-group is-active' : 'duplicate-group'} type="button"
              onClick={() => setSelection({ key: group.key, index, groups })} aria-current={isActive ? 'true' : undefined} key={group.key}>
              <strong>{group.title}</strong><span className="focused-group-count">{group.candidates.length}</span>
              <span>{group.artist}</span><small>{variantSummaryFor(group)}</small>
            </button>;
          })}
        </aside>
        <div className="duplicate-detail">
          {scanning ? <div className="detail-empty" role="status"><span className="loading-mark" aria-hidden /><h2>Scanning library…</h2></div>
            : scanFailed ? <div className="detail-empty" role="alert"><h2>Scan unavailable</h2><p>Try scanning again.</p></div>
            : selectedGroup === null ? <div className="detail-empty"><h2>{emptyTitle}</h2></div>
            : <>
              <div className="focused-comparison-heading">
                <div><h2>{selectedGroup.title}</h2><p>{selectedGroup.artist}</p></div>
                <button className="accent-button" type="button" disabled={busy} onClick={() => void onIgnore(selectedGroup.key)}>
                  <UiIcon name="check" size={16} /> Keep {selectedGroup.candidates.length === 2 ? 'both' : 'all'}
                </button>
              </div>
              <p className="focused-comparison-notice"><UiIcon name="info" size={16} />{new Set(selectedGroup.candidates.map(({ song }) => song.durationSeconds)).size > 1
                ? 'These mixes have different lengths. Preview both before removing a version.'
                : selectedGroup.matchReason || 'Preview these tracks before removing a version.'}</p>
              <div className="focused-comparison-scroll">
                <div className="focused-comparison-table" role="table" aria-label="Compare duplicate versions">
                  <div className="focused-comparison-row focused-comparison-track" role="row" style={{ gridTemplateColumns: `104px repeat(${selectedGroup.candidates.length}, minmax(220px, 1fr))` }}>
                    <span role="columnheader"><span className="visually-hidden">Track</span></span>
                    {selectedGroup.candidates.map((candidate) => {
                      const song = candidate.song;
                      const playing = playback.song?.id === song.id && playback.playing;
                      return <div role="columnheader" className="focused-comparison-version" key={song.id}>
                        <label><input type="checkbox" checked={chosenIds.has(song.id)} disabled={busy}
                          aria-label={`Select ${song.title} for removal`} onChange={(event) => {
                            const next = new Set(chosenIds);
                            if (event.currentTarget.checked) next.add(song.id); else next.delete(song.id);
                            setChosenIds(next);
                          }} /><span>{song.title}</span></label>
                        <button className={playing ? 'focused-preview is-playing' : 'focused-preview'} type="button"
                          onClick={() => playback.play(song)} disabled={song.audioUrl === null}>
                          <UiIcon name={playing ? 'pause' : 'play'} size={16} />{playing ? 'Pause' : 'Preview'}
                        </button>
                        {selectedGroup.recommendedKeepSongId === song.id && <small className="focused-keeper">Suggested keeper</small>}
                      </div>;
                    })}
                  </div>
                  {comparisonRows.map((row) => {
                    const different = new Set(selectedGroup.candidates.map(({ song }) => row.value(song))).size > 1;
                    return <div className={different ? 'focused-comparison-row is-different' : 'focused-comparison-row'} role="row" key={row.label}
                      style={{ gridTemplateColumns: `104px repeat(${selectedGroup.candidates.length}, minmax(220px, 1fr))` }}>
                      <span role="rowheader">{row.label}</span>
                      {selectedGroup.candidates.map(({ song }) => <span role="cell" key={song.id}>{row.value(song)}</span>)}
                    </div>;
                  })}
                </div>
              </div>
              <div className="focused-duplicate-footer">
                {chosenSongs.length > 0 ? <DuplicateSelectionActions busy={busy} onClear={() => setChosenIds(new Set())} onRemove={onRemove}
                  songs={chosenSongs} key={JSON.stringify([currentSelectionVersion, chosenSongs.map((song) => song.id)])} />
                  : <><p>Select a version to remove from the library.<br />Audio files stay on disk.</p>
                    <button className="quiet-button" type="button" disabled>Remove selected</button></>}
              </div>
            </>}
        </div>
      </div>
    </section>
  );
};

export const PlaylistsPage = ({
  busy, minimumSongLengthSeconds, creating, initialParentFolderId, initialName = '', initialSongs,
  folders, onCancel, onEditSmart, onExport, onCreate, onImport, onSmart, onUpdateTracks, onMenu,
  playback, playlists, selectedPlaylistId, view,
}: CommonPageProps & Readonly<{
  minimumSongLengthSeconds: number;
  creating: boolean;
  initialParentFolderId: string | null;
  initialName?: string;
  initialSongs: readonly SongRow[];
  folders: readonly PlaylistFolder[];
  onCancel: () => void;
  onEditSmart: (playlist: RekordboxPlaylist) => void;
  onExport: (playlist: RekordboxPlaylist) => void;
  onCreate: (name: string, songIds: readonly string[], parentFolderId: string | null) => Promise<boolean>;
  onSmart?: (name: string, parentFolderId: string | null, songs: readonly SongRow[]) => void;
  onUpdateTracks?: (playlist: RekordboxPlaylist, songIds: readonly string[]) => Promise<boolean>;
  onMenu?: (playlist: RekordboxPlaylist) => void;
  playlists: readonly RekordboxPlaylist[] | null;
  selectedPlaylistId: string | null;
}>): JSX.Element => {
  const [parentFolderId, setParentFolderId] = useState(initialParentFolderId);
  const [name, setName] = useState(initialName);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SongPage | null>(null);
  const [searchRequest, setSearchRequest] = useState<SongSearchRequest>({ query: '', offset: 0, limit: SONG_PAGE_SIZE });
  const [chosenSongs, setChosenSongs] = useState<ReadonlyMap<string, SongRow>>(() => new Map(initialSongs.map((song) => [song.id, song])));
  const [loadingSongs, setLoadingSongs] = useState(creating);
  const [searchFailed, setSearchFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [columns, setColumns] = useState(defaultColumns);
  const [filters, setFilters] = useState<SongFilters>(DEFAULT_SONG_FILTERS);
  const draggedSongId = useRef<string | null>(null);
  const picking = creating || adding;

  useEffect(() => {
    if (!picking) return;
    let active = true;
    void window.djLibrary.searchSongs(searchRequest).then((songs) => {
      if (active) { setResults(songs); setLoadingSongs(false); setSearchFailed(false); }
    }, () => {
      if (active) { setResults(null); setLoadingSongs(false); setSearchFailed(true); }
    });
    return () => { active = false; };
  }, [picking, searchRequest, minimumSongLengthSeconds]);

  useEffect(() => {
    if (!picking) return;
    const timer = window.setTimeout(() => {
      setLoadingSongs(true);
      setSearchRequest({ query, offset: 0, limit: SONG_PAGE_SIZE });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [picking, query]);

  useEffect(() => window.preferences.onLibraryChanged((settings) => {
    if (settings.minimumSongLengthSeconds === minimumSongLengthSeconds) return;
    setChosenSongs((current) => new Map([...current].filter(([, song]) =>
      song.durationSeconds === null || song.durationSeconds >= settings.minimumSongLengthSeconds)));
    setResults(null);
    setLoadingSongs(picking);
  }), [picking, minimumSongLengthSeconds]);

  if (view === null) return <NoLibrary busy={busy} onImport={onImport} />;

  const selectedPlaylist = playlists?.find((playlist) => playlist.id === selectedPlaylistId) ?? null;
  const existingIds = new Set(selectedPlaylist?.tracks.map((song) => song.id) ?? []);
  const matches = (song: SongRow): boolean => {
    const text = `${song.title} ${song.artist ?? ''} ${song.album ?? ''}`.toLocaleLowerCase();
    if (!text.includes(query.toLocaleLowerCase())) return false;
    if (filters.source !== 'all' && song.source !== filters.source) return false;
    if (filters.metadata === 'incomplete') return songMetadataGapCount(song) > 0;
    if (filters.metadata === 'complete') return songMetadataGapCount(song) === 0;
    if (filters.metadata === 'no-cues') return song.cuePointCount === 0;
    return true;
  };
  const visibleTracks = picking
    ? (showAll ? results?.items ?? [] : results?.items.slice(0, 6) ?? [])
    : selectedPlaylist?.tracks.filter(matches) ?? [];
  const selectableTracks = visibleTracks.filter((song) => !adding || !existingIds.has(song.id));
  const allSelected = selectableTracks.length > 0 && selectableTracks.every((song) => chosenSongs.has(song.id));
  const selectedCount = selectableTracks.filter((song) => chosenSongs.has(song.id)).length;
  const chosen = [...chosenSongs.values()];
  const canReorder = !picking && selectedPlaylist?.kind === 'regular' && onUpdateTracks !== undefined && !busy && query === '' && filters.source === 'all' && filters.metadata === 'all';

  const toggleSong = (song: SongRow): void => {
    if (adding && existingIds.has(song.id)) return;
    setChosenSongs((current) => {
      const next = new Map(current);
      if (next.has(song.id)) next.delete(song.id); else next.set(song.id, song);
      return next;
    });
  };
  const moveSong = (songId: string, destination: number): void => {
    if (!selectedPlaylist || !onUpdateTracks || !canReorder) return;
    const ids = selectedPlaylist.tracks.map((song) => song.id);
    const index = ids.indexOf(songId);
    if (index < 0 || destination < 0 || destination >= ids.length || index === destination) return;
    ids.splice(index, 1);
    ids.splice(destination, 0, songId);
    void onUpdateTracks(selectedPlaylist, ids);
  };
  const closePicker = (): void => {
    if (creating) onCancel(); else { setAdding(false); setQuery(''); setChosenSongs(new Map()); }
  };
  const save = async (): Promise<void> => {
    if (creating) { await onCreate(name, [...chosenSongs.keys()], parentFolderId); return; }
    if (selectedPlaylist && onUpdateTracks && await onUpdateTracks(selectedPlaylist, [...selectedPlaylist.tracks.map((song) => song.id), ...chosenSongs.keys()])) closePicker();
  };

  return (
    <section className={`workspace-page playlists-page focused-playlists${picking ? ' is-creating' : ''}`} aria-labelledby="playlists-title">
      <header className="page-header">
        <div className="page-title-line">
          <h1 id="playlists-title">{creating ? 'New playlist' : adding ? `Add tracks to ${selectedPlaylist?.name ?? 'playlist'}` : selectedPlaylist?.name ?? 'Playlist'}</h1>
          {!picking && selectedPlaylist && <p>{selectedPlaylist.tracks.length} tracks · {totalTime(selectedPlaylist.tracks)}</p>}
        </div>
        {!picking && selectedPlaylist !== null && <div className="header-actions">
          <button className="quiet-button focused-export" type="button" onClick={() => onExport(selectedPlaylist)}><UiIcon name="download" size={16} /> Export tracklist</button>
          {selectedPlaylist.smartDefinition ? <button className="accent-button" type="button" disabled={busy} onClick={() => onEditSmart(selectedPlaylist)}>Edit rules</button>
            : selectedPlaylist.kind === 'regular' && onUpdateTracks && <button className="accent-button" type="button" disabled={busy} onClick={() => {
              setChosenSongs(new Map()); setQuery(''); setLoadingSongs(true); setAdding(true);
            }}><UiIcon name="plus" size={16} /> Add tracks</button>}
          {onMenu && <button className="focused-playlist-menu" type="button" aria-label="Playlist actions" onClick={() => onMenu(selectedPlaylist)}>⋯</button>}
        </div>}
      </header>

      {playlists === null && !picking ? <div className="detail-empty" role="status"><h2>Loading playlists…</h2></div>
        : selectedPlaylist === null && !picking ? <div className="detail-empty"><h2>{playlists?.length === 0 ? 'No playlists' : 'Choose a playlist'}</h2></div>
        : <>
          <div className="focused-playlist-content">
            {creating && <>
              <PlaylistIdentity name={name} parentFolderId={parentFolderId} folders={folders}
                onNameChange={setName} onParentFolderChange={setParentFolderId} disabled={busy} />
              <div className="focused-playlist-type" role="group" aria-label="Playlist type">
                <button type="button" aria-pressed="true">Manual</button>
                {onSmart && <button type="button" aria-pressed="false" disabled={busy} onClick={() => onSmart(name, parentFolderId, chosen)}>Smart</button>}
                <span>Choose tracks and arrange them yourself.</span>
              </div>
            </>}
            <div className="library-tools">
              <label className="library-search"><span className="search-icon" aria-hidden /><span className="visually-hidden">{picking ? 'Search tracks' : 'Search this playlist'}</span>
                <input id="playlist-track-search" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} maxLength={200}
                  placeholder={picking ? 'Search tracks, artists or albums' : 'Search this playlist'} disabled={busy} />
              </label>
              {picking ? <button className="quiet-button" type="button" aria-expanded={suggestionsOpen} onClick={() => setSuggestionsOpen(!suggestionsOpen)}>
                <UiIcon name="chevron-down" size={16} /> Suggestions</button> : <>
                <details className="focused-popover"><summary className="quiet-button"><UiIcon name="filters" size={16} /> Filters</summary>
                  <div className="focused-popover-panel focused-filter-panel">
                    <label>Source<select value={filters.source} onChange={(event) => {
                      const source = event.currentTarget.value === 'all' ? 'all' : Object.keys(SONG_SOURCE_LABELS).find((key): key is keyof typeof SONG_SOURCE_LABELS => key === event.currentTarget.value);
                      if (source !== undefined) setFilters({ ...filters, source });
                    }}><option value="all">All sources</option>{Object.entries(SONG_SOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label>Metadata<select value={filters.metadata} onChange={(event) => {
                      const metadata = Object.keys(SONG_METADATA_FILTERS).find((key): key is keyof typeof SONG_METADATA_FILTERS => key === event.currentTarget.value);
                      if (metadata) setFilters({ ...filters, metadata });
                    }}>{Object.entries(SONG_METADATA_FILTERS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
                    <button className="quiet-button" type="button" onClick={() => setFilters(DEFAULT_SONG_FILTERS)}>Clear filters</button>
                  </div>
                </details>
                <ColumnControl columns={columns} onChange={setColumns} />
              </>}
            </div>
            {picking && suggestionsOpen && <PlaylistSuggestions busy={busy} chosenSongs={chosenSongs}
              onAdd={(song) => { if (!adding || !existingIds.has(song.id)) setChosenSongs((current) => new Map(current).set(song.id, song)); }}
              playback={playback} revision={view.library.revision} />}
            {!picking && selectedPlaylist?.smartRules && selectedPlaylist.smartRules.conditions.length > 0 && <details className="focused-playlist-rules">
              <summary>Smart playlist rules</summary><ul>{selectedPlaylist.smartRules.conditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul>
            </details>}
            {searchFailed && picking && <p className="playlist-search-error" role="alert">Arsenal could not search this collection.</p>}
            <div className="track-table focused-playlist-table" role="table" aria-label={picking ? 'Tracks to add' : 'Playlist tracks'} aria-busy={picking && loadingSongs}>
              <div className="track-table-head" role="row" style={{ gridTemplateColumns: trackGrid(columns) }}>
                <span role="columnheader">{picking && <input type="checkbox" aria-label="Select all visible tracks" checked={allSelected} disabled={busy || loadingSongs || selectableTracks.length === 0}
                  ref={(input) => { if (input) input.indeterminate = selectedCount > 0 && !allSelected; }} onChange={() => {
                    const next = new Map(chosenSongs);
                    for (const song of selectableTracks) { if (allSelected) next.delete(song.id); else next.set(song.id, song); }
                    setChosenSongs(next);
                  }} />}</span>
                <span role="columnheader">#{picking ? ' ↑' : ''}</span><span role="columnheader">Track</span>
                {trackColumns.filter((column) => columns.has(column.key)).map((column) => <span role="columnheader" key={column.key}>{column.label}</span>)}
                <span role="columnheader"><span className="visually-hidden">Actions</span></span>
              </div>
              <div className="track-table-body" role="rowgroup">
                {picking && loadingSongs ? <div className="inline-empty" role="status">Searching collection…</div> : visibleTracks.map((song, index) => {
                  const selected = chosenSongs.has(song.id);
                  const playing = playback.song?.id === song.id && playback.playing;
                  const alreadyAdded = adding && existingIds.has(song.id);
                  const trackIndex = picking ? index : selectedPlaylist?.tracks.indexOf(song) ?? index;
                  return <div className={`track-row${selected ? ' is-selected' : ''}${playing ? ' is-playing' : ''}`} role="row" key={`${song.id}-${index}`}
                    style={{ gridTemplateColumns: trackGrid(columns) }}
                    onDoubleClick={() => playback.play(song)}
                    onDragOver={(event) => { if (canReorder) event.preventDefault(); }}
                    onDrop={(event) => { event.preventDefault(); if (draggedSongId.current) moveSong(draggedSongId.current, trackIndex); draggedSongId.current = null; }}>
                    <span role="cell">{picking ? <input type="checkbox" checked={selected || alreadyAdded} disabled={busy || alreadyAdded}
                      aria-label={alreadyAdded ? `${song.title} is already in this playlist` : `Select ${song.title}`} onChange={() => toggleSong(song)} />
                      : canReorder ? <button className="focused-drag-handle" type="button" draggable aria-label={`Drag ${song.title} to reorder`}
                        onDragStart={(event) => { draggedSongId.current = song.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', song.id); }}
                        onDragEnd={() => { draggedSongId.current = null; }}><UiIcon name="grip" size={14} /></button> : null}</span>
                    <span role="cell"><TrackNumber song={song} index={trackIndex} offset={picking ? results?.offset ?? 0 : 0} playback={playback} /></span>
                    <span className="track-identity" role="cell"><strong>{song.title}</strong><small>{song.artist ?? 'Unknown artist'}</small></span>
                    <TrackFacts song={song} columns={columns} />
                    <span role="cell">{!picking && <details className="focused-popover focused-row-menu"><summary className="track-menu-button" aria-label={`Actions for ${song.title}`}>⋯</summary>
                      <div className="focused-popover-panel">
                        <button type="button" disabled={song.audioUrl === null} onClick={() => playback.play(song)}>{playing ? 'Pause' : 'Play'}</button>
                        {canReorder && <><button type="button" disabled={trackIndex === 0} onClick={() => moveSong(song.id, trackIndex - 1)}>Move up</button>
                          <button type="button" disabled={trackIndex === (selectedPlaylist?.tracks.length ?? 0) - 1} onClick={() => moveSong(song.id, trackIndex + 1)}>Move down</button></>}
                      </div>
                    </details>}</span>
                  </div>;
                })}
                {!(picking && loadingSongs) && visibleTracks.length === 0 && <div className="inline-empty"><strong>{query ? 'No matching tracks' : picking ? 'No tracks found' : 'This playlist is empty'}</strong></div>}
              </div>
            </div>
            {picking && results && <nav className="focused-picker-pagination" aria-label="Track search pages">
              <p>Showing {visibleTracks.length} of {results.total.toLocaleString()} tracks{results.offset > 0 ? ` · Page ${Math.floor(results.offset / results.limit) + 1}` : ''}</p>
              <div>
                {results.offset > 0 && <button className="quiet-button" type="button" disabled={loadingSongs} onClick={() => { setLoadingSongs(true); setSearchRequest({ ...searchRequest, offset: Math.max(0, results.offset - results.limit) }); }}>Previous</button>}
                {!showAll && (results.items.length > 6 || results.hasNext) ? <button className="quiet-button" type="button" onClick={() => setShowAll(true)}><UiIcon name="chevron-down" size={16} /> Show all tracks</button>
                  : results.hasNext && <button className="quiet-button" type="button" disabled={loadingSongs} onClick={() => { setLoadingSongs(true); setSearchRequest({ ...searchRequest, offset: results.offset + results.limit }); }}>Next</button>}
              </div>
            </nav>}
            {!picking && selectedPlaylist && selectedPlaylist.missingTrackCount > 0 && <p className="playlist-missing">{selectedPlaylist.missingTrackCount} missing {selectedPlaylist.missingTrackCount === 1 ? 'track' : 'tracks'}.</p>}
          </div>
          {picking ? <footer className="focused-playlist-footer">
            <span aria-live="polite">{chosenSongs.size} tracks selected{chosen.length > 0 ? ` · ${totalTime(chosen)}` : ''}</span>
            <button className="quiet-button" type="button" onClick={closePicker} disabled={busy}>Cancel</button>
            <button className="accent-button" type="button" onClick={() => void save()} disabled={busy || (creating ? name.trim().length === 0 : chosenSongs.size === 0)}>
              {busy ? 'Saving…' : creating ? 'Create playlist' : 'Add tracks'}
            </button>
          </footer> : <footer className="focused-playlist-note">{selectedPlaylist?.kind === 'smart' ? 'Tracks update automatically when they match the playlist rules.' : 'Drag tracks to change the play order.'}</footer>}
        </>}
    </section>
  );
};
