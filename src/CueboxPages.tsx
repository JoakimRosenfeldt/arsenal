import {
  useEffect,
  useState,
  type FormEvent,
  type JSX,
} from 'react';

import type { DuplicateViewState } from './App';
import {
  TrackArtwork,
  type PlaybackController,
} from './CueboxPlayer';
import {
  DUPLICATE_MATCH_MODES,
  type DuplicateCandidate,
  type DuplicateGroup,
  type DuplicateMatchMode,
  type DuplicateScan,
  type LibrarySummary,
  type RekordboxPlaylist,
  type SongPage,
  type SongRow,
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

const formatFileSize = (bytes: number | null): string => {
  if (bytes === null) {
    return 'Not set';
  }

  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  })} ${units[unitIndex]}`;
};

const formatRating = (rating: number | null): string => {
  if (rating === null) {
    return 'Not set';
  }
  const stars = Math.max(
    0,
    Math.min(5, Math.round(rating > 5 ? rating / 51 : rating)),
  );
  return `${stars} / 5`;
};

const formatImportedAt = (importedAt: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(importedAt));

const formatRowNumber = (offset: number, index: number): string =>
  String(offset + index + 1).padStart(3, '0');

const trackSearchText = (song: SongRow): string =>
  [song.title, song.artist, song.album, song.genre, song.musicalKey]
    .filter((value): value is string => value !== null)
    .join(' ')
    .toLocaleLowerCase();

const metadataGapCount = (song: SongRow): number =>
  [
    song.artist,
    song.album,
    song.genre,
    song.bpm,
    song.musicalKey,
    song.durationSeconds,
  ].filter((value) => value === null).length;

const statusForSong = (
  song: SongRow,
): Readonly<{ label: string; tone: string }> => {
  const gaps = metadataGapCount(song);
  if (gaps === 0) {
    return { label: 'Metadata complete', tone: 'complete' };
  }
  if (gaps <= 2) {
    return { label: `${gaps} metadata gaps`, tone: 'partial' };
  }
  return { label: `${gaps} metadata gaps`, tone: 'attention' };
};

const NoLibrary = ({
  busy,
  description,
  eyebrow,
  onImport,
  title,
}: Readonly<{
  busy: boolean;
  description: string;
  eyebrow: string;
  onImport: () => void;
  title: string;
}>): JSX.Element => (
  <section className="page-empty" aria-labelledby="empty-page-title">
    <div className="page-empty-mark" aria-hidden>
      <span />
      <span />
      <span />
    </div>
    <p className="mono-label">{eyebrow}</p>
    <h1 id="empty-page-title">{title}</h1>
    <p>{description}</p>
    <button className="accent-button" type="button" onClick={onImport} disabled={busy}>
      {busy ? 'Reading XML' : 'Choose Rekordbox XML'}
    </button>
    <small>Nothing is uploaded. Cuebox works with the chosen file on this Mac.</small>
  </section>
);

const waveformHeights = (song: SongRow, count: number): readonly number[] => {
  const seed = [...`${song.id}${song.title}`].reduce(
    (total, character) => total + character.charCodeAt(0),
    0,
  );
  return Array.from({ length: count }, (_, index) => {
    const first = Math.abs(Math.sin((index + seed) * 0.43));
    const second = Math.abs(Math.sin((index + seed) * 0.17));
    return 18 + Math.round((first * 0.68 + second * 0.32) * 78);
  });
};

const InteractiveWaveform = ({
  disabled,
  duration,
  onSeek,
  position,
  song,
}: Readonly<{
  disabled: boolean;
  duration: number;
  onSeek: (seconds: number) => void;
  position: number;
  song: SongRow;
}>): JSX.Element => {
  const bars = waveformHeights(song, 72);
  const progress = duration <= 0 ? 0 : position / duration;
  return (
    <div className="interactive-waveform">
      <div className="track-profile-bars" aria-hidden>
        {bars.map((height, index) => (
          <span
            className={index / bars.length <= progress ? 'is-accent' : ''}
            style={{ height: `${height}%` }}
            key={`${height}-${index}`}
          />
        ))}
      </div>
      <input
        type="range"
        min="0"
        max={Math.max(duration, 1)}
        step="0.1"
        value={Math.min(position, Math.max(duration, 1))}
        onChange={(event) => onSeek(event.currentTarget.valueAsNumber)}
        disabled={disabled}
        aria-label={`Seek in ${song.title}`}
      />
    </div>
  );
};

export const LibraryPage = ({
  busy,
  onImport,
  onPage,
  playback,
  query,
  view,
}: CommonPageProps &
  Readonly<{
    onPage: (offset: number) => void;
    query: string;
  }>): JSX.Element => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  if (view === null) {
    return (
      <NoLibrary
        busy={busy}
        eyebrow="Collection / Local XML"
        title="Your library starts with one export."
        description="Open a Rekordbox Collection XML file to browse and play local tracks."
        onImport={onImport}
      />
    );
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSongs =
    normalizedQuery.length === 0
      ? view.page.items
      : view.page.items.filter((song) =>
          trackSearchText(song).includes(normalizedQuery),
        );
  const selectedSong =
    visibleSongs.find((song) => song.id === selectedId) ??
    visibleSongs[0] ??
    null;
  const pageNumber = Math.floor(view.page.offset / view.page.limit) + 1;
  const pageCount = Math.max(1, Math.ceil(view.page.total / view.page.limit));
  const pageDuration = view.page.items.reduce(
    (total, song) => total + (song.durationSeconds ?? 0),
    0,
  );

  const selectedIsActive = selectedSong?.id === playback.song?.id;
  const displayedDuration = selectedIsActive && playback.duration > 0
    ? playback.duration
    : selectedSong?.durationSeconds ?? 0;
  const displayedPosition = selectedIsActive ? playback.position : 0;

  return (
    <section className="workspace-page library-page" aria-labelledby="library-title">
      <header className="page-header library-header">
        <div className="page-title-line">
          <h1 id="library-title">Library</h1>
          <p>
            {view.library.songCount.toLocaleString()} tracks
            <span aria-hidden>·</span>
            {Math.floor(pageDuration / 3600)}h {Math.floor((pageDuration % 3600) / 60)}m on this page
          </p>
        </div>
        <div className="header-actions">
          <span className="status-pill"><i aria-hidden />Local XML</span>
          <button className="quiet-button inspector-toggle" type="button" onClick={() => setInspectorOpen((open) => !open)} aria-expanded={inspectorOpen}>
            Inspector
          </button>
          <button className="quiet-button" type="button" onClick={onImport} disabled={busy}>
            {busy ? 'Reading XML' : 'Import XML'}
          </button>
        </div>
      </header>

      <div className="filter-bar">
        <span className="filter-chip"><b>Source</b>{view.library.sourceName}</span>
        <span className="filter-chip"><b>Opened</b>{formatImportedAt(view.library.importedAt)}</span>
        {normalizedQuery.length > 0 && (
          <span className="filter-chip is-accent"><b>Filter</b>{query}</span>
        )}
        <span className="result-count">
          {visibleSongs.length.toLocaleString()} shown · page {pageNumber} of {pageCount}
        </span>
      </div>

      <div className="library-body">
        <div className="track-table" role="table" aria-label="Songs in the Rekordbox Collection export">
          <div className="track-table-head" role="row">
            <span role="columnheader"><span className="visually-hidden">Status</span></span>
            <span role="columnheader">#</span>
            <span role="columnheader"><span className="visually-hidden">Play</span></span>
            <span role="columnheader">Title / artist</span>
            <span role="columnheader">BPM</span>
            <span role="columnheader">Key</span>
            <span role="columnheader">Time</span>
            <span role="columnheader">Genre</span>
            <span role="columnheader">Album</span>
          </div>
          <div className="track-table-body" role="rowgroup" aria-busy={busy}>
            {visibleSongs.length === 0 ? (
              <div className="inline-empty">
                <strong>No tracks match "{query}".</strong>
                <span>Clear the sidebar filter to show this page again.</span>
              </div>
            ) : (
              visibleSongs.map((song, index) => {
                const status = statusForSong(song);
                const isSelected = song.id === selectedSong?.id;
                const isPlaying = song.id === playback.song?.id && playback.playing;
                return (
                  <div
                    className={isSelected ? 'track-row is-selected' : 'track-row'}
                    role="row"
                    aria-selected={isSelected}
                    tabIndex={0}
                    onClick={() => {
                      setSelectedId(song.id);
                      setInspectorOpen(true);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.target === event.currentTarget &&
                        (event.key === 'Enter' || event.key === ' ')
                      ) {
                        event.preventDefault();
                        setSelectedId(song.id);
                        setInspectorOpen(true);
                      }
                    }}
                    title={`${song.title} by ${song.artist ?? 'Unknown artist'}`}
                    key={song.id}
                  >
                    <span className={`track-status is-${status.tone}`} role="cell">
                      <span className="visually-hidden">{status.label}</span>
                    </span>
                    <span className="track-index" role="cell">{formatRowNumber(view.page.offset, index)}</span>
                    <button
                      className={isPlaying ? 'track-play is-playing' : 'track-play'}
                      type="button"
                      role="cell"
                      onClick={(event) => {
                        event.stopPropagation();
                        playback.play(song);
                      }}
                      disabled={song.audioUrl === null}
                      aria-label={isPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
                    >
                      <TrackArtwork song={song} />
                      <span aria-hidden>{isPlaying ? 'Ⅱ' : '▶'}</span>
                    </button>
                    <span className="track-identity" role="cell">
                      <strong>{song.title}</strong>
                      <small>{song.artist ?? 'Unknown artist'}</small>
                    </span>
                    <span className="numeric" role="cell">{formatBpm(song.bpm)}</span>
                    <span className="numeric is-muted" role="cell">{song.musicalKey ?? '—'}</span>
                    <span className="numeric is-muted" role="cell">{formatDuration(song.durationSeconds)}</span>
                    <span className="truncate is-muted" role="cell">{song.genre ?? 'Not set'}</span>
                    <span className="truncate is-muted" role="cell">{song.album ?? 'Not set'}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {selectedSong !== null && (
          <aside className={inspectorOpen ? 'library-inspector is-open' : 'library-inspector'} aria-label="Selected track inspector">
            <button className="inspector-close" type="button" onClick={() => setInspectorOpen(false)} aria-label="Close inspector">×</button>
            <div className="inspector-title">
              <TrackArtwork loadEagerly song={selectedSong} size="large" />
              <div>
                <h2>{selectedSong.title}</h2>
                <p>{selectedSong.artist ?? 'Unknown artist'}</p>
                <small>LOCAL TRACK OVERVIEW</small>
              </div>
            </div>
            <div className="inspector-profile">
              <div className="section-label-row">
                <span>{formatDuration(displayedPosition)}</span>
                <span>{formatDuration(displayedDuration)}</span>
              </div>
              <InteractiveWaveform
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
                <span>
                  {selectedSong.audioUrl === null
                    ? 'Local audio unavailable'
                    : playback.failed && selectedIsActive
                      ? 'This audio format could not be played'
                      : selectedIsActive
                        ? 'Playing local file'
                        : 'Ready to play'}
                </span>
              </div>
            </div>
            <dl className="inspector-stats">
              <div><dt>BPM</dt><dd>{formatBpm(selectedSong.bpm)}</dd></div>
              <div><dt>Key</dt><dd>{selectedSong.musicalKey ?? '—'}</dd></div>
              <div><dt>Time</dt><dd>{formatDuration(selectedSong.durationSeconds)}</dd></div>
              <div><dt>Genre</dt><dd>{selectedSong.genre ?? 'Not set'}</dd></div>
              <div><dt>Album</dt><dd>{selectedSong.album ?? 'Not set'}</dd></div>
              <div><dt>Gaps</dt><dd>{metadataGapCount(selectedSong)}</dd></div>
            </dl>
            <div className="inspector-note">
              <span className="mono-label">Local file</span>
              <p>Playback stays on this Mac. Cuebox never sends the file or its path to the renderer.</p>
            </div>
          </aside>
        )}
      </div>

      <nav className="page-pagination" aria-label="Song pages">
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
          <button type="button" onClick={() => onPage(view.page.offset - view.page.limit)} disabled={busy || view.page.offset === 0}>
            ← Previous
          </button>
          <button type="button" onClick={() => onPage(view.page.offset + view.page.limit)} disabled={busy || !view.page.hasNext}>
            Next →
          </button>
        </div>
      </nav>
    </section>
  );
};

type DuplicateModeCopy = Readonly<{
  description: string;
  emptyDescription: string;
  emptyTitle: string;
  label: string;
}>;

const duplicateModeCopy: Readonly<Record<DuplicateMatchMode, DuplicateModeCopy>> = {
  exact: {
    label: 'Exact',
    description: 'Same title and artist metadata',
    emptyTitle: 'No exact matches found.',
    emptyDescription: 'No title and artist pair appears more than once.',
  },
  versions: {
    label: 'All versions',
    description: 'Same base title with recognized version tags',
    emptyTitle: 'No version families found.',
    emptyDescription: 'No tracks share a base title with a recognized version tag.',
  },
  'dj-edits': {
    label: 'DJ edits',
    description: 'Intro, extended, clean, dirty, radio, club, and other edits',
    emptyTitle: 'No DJ edit families found.',
    emptyDescription: 'No track family includes a recognized DJ edit tag.',
  },
  remixes: {
    label: 'Remixes',
    description: 'Remix, rework, bootleg, mashup, VIP, and flip tags',
    emptyTitle: 'No remix families found.',
    emptyDescription: 'No track family includes a recognized remix tag.',
  },
};

const variantSummaryFor = (group: DuplicateGroup): string => {
  const labels = [...new Set(
    group.candidates.map((candidate) => candidate.variantLabel),
  )];
  const visible = labels.slice(0, 3).join(' · ');
  return labels.length > 3 ? `${visible} +${labels.length - 3}` : visible;
};

type MetadataItem = Readonly<{
  label: string;
  value: string;
  wide?: boolean;
}>;

const importantMetadataFor = (song: SongRow): readonly MetadataItem[] => [
  { label: 'Album', value: song.album ?? 'Not set' },
  { label: 'Mix', value: song.mixName ?? 'Not set' },
  { label: 'BPM', value: formatBpm(song.bpm) },
  { label: 'Key', value: song.musicalKey ?? 'Not set' },
  { label: 'Duration', value: formatDuration(song.durationSeconds) },
  { label: 'Genre', value: song.genre ?? 'Not set' },
  { label: 'Format', value: song.fileKind ?? 'Not set' },
  {
    label: 'Bitrate',
    value: song.bitRateKbps === null ? 'Not set' : `${song.bitRateKbps.toLocaleString()} kbps`,
  },
  { label: 'File size', value: formatFileSize(song.fileSizeBytes) },
  { label: 'Added', value: song.dateAdded ?? 'Not set' },
  { label: 'Rating', value: formatRating(song.rating) },
  { label: 'Plays', value: song.playCount?.toLocaleString() ?? 'Not set' },
  ...(song.comments === null
    ? []
    : [{ label: 'Comments', value: song.comments, wide: true }]),
];

const DuplicateSong = ({
  busy,
  candidate,
  onRemove,
  playback,
}: Readonly<{
  busy: boolean;
  candidate: DuplicateCandidate;
  onRemove: (songId: string, removeLocalFile: boolean) => Promise<boolean>;
  playback: PlaybackController;
}>): JSX.Element => {
  const [confirming, setConfirming] = useState(false);
  const [removeLocalFile, setRemoveLocalFile] = useState(false);
  const song = candidate.song;
  const isPlaying = playback.song?.id === song.id && playback.playing;

  return (
    <details className="duplicate-song">
      <summary>
        <button
          className={isPlaying ? 'track-play duplicate-play is-playing' : 'track-play duplicate-play'}
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            playback.play(song);
          }}
          disabled={song.audioUrl === null}
          aria-label={isPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
        >
          <TrackArtwork song={song} size="medium" />
          <span aria-hidden>{isPlaying ? 'Ⅱ' : '▶'}</span>
        </button>
        <span className="duplicate-song-identity">
          <strong>{song.title}</strong>
          <small>{song.artist ?? 'Unknown artist'} · {candidate.variantLabel}</small>
        </span>
        <span className="duplicate-song-facts">
          <b>{formatBpm(song.bpm)}</b>
          <small>{song.musicalKey ?? 'No key'} · {formatDuration(song.durationSeconds)}</small>
        </span>
        <span className="details-glyph" aria-hidden>+</span>
      </summary>
      <div className="duplicate-song-body">
        <dl className="duplicate-metadata">
          {importantMetadataFor(song).map((item) => (
            <div className={item.wide ? 'is-wide' : ''} key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
        <div className="duplicate-remove">
          {confirming ? (
            <>
              <div>
                <strong>Remove this track from the XML?</strong>
                <p>References to it will also be removed from playlists.</p>
                <label>
                  <input
                    type="checkbox"
                    checked={removeLocalFile}
                    onChange={(event) => setRemoveLocalFile(event.currentTarget.checked)}
                    disabled={song.audioUrl === null || busy}
                  />
                  Also move the local audio file to Trash
                </label>
              </div>
              <span>
                <button type="button" className="quiet-button" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => {
                    void onRemove(song.id, removeLocalFile).then((removed) => {
                      if (removed) {
                        setConfirming(false);
                      }
                    });
                  }}
                  disabled={busy}
                >
                  {busy ? 'Removing' : 'Remove track'}
                </button>
              </span>
            </>
          ) : (
            <button type="button" className="danger-text-button" onClick={() => setConfirming(true)}>
              Remove duplicate
            </button>
          )}
        </div>
      </div>
    </details>
  );
};

export const DuplicatesPage = ({
  busy,
  mode,
  onImport,
  onModeChange,
  onRemove,
  playback,
  state,
  view,
}: CommonPageProps &
  Readonly<{
    mode: DuplicateMatchMode;
    onModeChange: (mode: DuplicateMatchMode) => void;
    onRemove: (songId: string, removeLocalFile: boolean) => Promise<boolean>;
    state: DuplicateViewState;
  }>): JSX.Element => {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  if (view === null) {
    return (
      <NoLibrary
        busy={busy}
        eyebrow="Collection / Duplicates"
        title="Open a library before comparing tracks."
        description="Cuebox scans the full collection for exact matches, alternate versions, DJ edits, and remixes."
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
  const selectedGroup =
    groups.find((group) => group.key === selectedKey) ?? groups[0] ?? null;
  const copy = duplicateModeCopy[mode];

  return (
    <section className="workspace-page duplicates-page" aria-labelledby="duplicates-title">
      <header className="page-header stacked-header">
        <div className="page-title-line">
          <h1 id="duplicates-title">Duplicates</h1>
          <p>
            {scanning
              ? 'Scanning full library'
              : scanFailed
                ? 'Scan unavailable'
                : `${groups.length} ${groups.length === 1 ? 'group' : 'groups'} · ${scan?.trackCount ?? 0} tracks · full library`}
          </p>
        </div>
        <div className="header-actions">
          <span className="status-pill is-warning"><i aria-hidden />XML cleanup</span>
          <button className="quiet-button" type="button" onClick={onImport} disabled={busy}>
            {busy ? 'Reading XML' : 'Import XML'}
          </button>
        </div>
        <div className="duplicate-controls">
          <div className="duplicate-mode-switch" role="group" aria-label="Duplicate match type">
            {DUPLICATE_MATCH_MODES.map((option) => (
              <button
                className={option === mode ? 'is-active' : ''}
                type="button"
                onClick={() => onModeChange(option)}
                aria-pressed={option === mode}
                key={option}
              >
                {duplicateModeCopy[option].label}
              </button>
            ))}
          </div>
          <p>{copy.description}</p>
        </div>
      </header>

      <div className="duplicates-body">
        <aside className="duplicate-groups" aria-label="Matched track groups">
          <div className="panel-heading"><span>Groups</span><span>Tracks</span></div>
          {scanning ? (
            <div className="panel-empty" role="status">
              <strong>Scanning the library</strong>
              <p>Checking every imported track, not only the visible page.</p>
            </div>
          ) : scanFailed ? (
            <div className="panel-empty" role="alert">
              <strong>Scan unavailable</strong>
              <p>Choose another mode or import the XML again.</p>
            </div>
          ) : groups.length === 0 ? (
            <div className="panel-empty">
              <strong>{copy.emptyTitle}</strong>
              <p>{copy.emptyDescription}</p>
            </div>
          ) : (
            groups.map((group, index) => {
              const isActive = group.key === selectedGroup?.key;
              return (
                <button
                  className={isActive ? 'duplicate-group is-active' : 'duplicate-group'}
                  type="button"
                  onClick={() => setSelectedKey(group.key)}
                  aria-current={isActive ? 'true' : undefined}
                  key={group.key}
                >
                  <strong>{group.title}</strong>
                  <span>{group.artist}</span>
                  <small>{group.candidates.length} tracks · {variantSummaryFor(group)} · group {index + 1}</small>
                </button>
              );
            })
          )}
        </aside>

        <div className="duplicate-detail">
          {scanning ? (
            <div className="detail-empty" role="status">
              <span className="loading-mark" aria-hidden />
              <p className="mono-label">Full library scan</p>
              <h2>Finding {copy.label.toLocaleLowerCase()}.</h2>
              <p>This scan uses imported artist and title metadata. Audio files are not fingerprinted.</p>
            </div>
          ) : scanFailed ? (
            <div className="detail-empty" role="alert">
              <span className="empty-scan" aria-hidden />
              <p className="mono-label">Scan unavailable</p>
              <h2>Cuebox could not compare this library.</h2>
              <p>Import the Rekordbox XML again. Your music files have not been changed.</p>
            </div>
          ) : selectedGroup === null ? (
            <div className="detail-empty">
              <span className="empty-scan" aria-hidden />
              <p className="mono-label">Full library scan complete</p>
              <h2>{copy.emptyTitle}</h2>
              <p>{copy.emptyDescription}</p>
            </div>
          ) : (
            <>
              <div className="duplicate-list-heading">
                <div>
                  <span className="accent-tag">{selectedGroup.candidates.length} tracks</span>
                  <p>{selectedGroup.matchReason}</p>
                </div>
                <h2>{selectedGroup.title}</h2>
                <span>{selectedGroup.artist}</span>
              </div>
              <div className="duplicate-song-list">
                {selectedGroup.candidates.map((candidate) => (
                  <DuplicateSong
                    busy={busy}
                    candidate={candidate}
                    onRemove={onRemove}
                    playback={playback}
                    key={candidate.song.id}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <footer className="action-rail">
        <span>REMOVAL ALSO CLEANS PLAYLIST REFERENCES</span>
        <strong>{copy.label} · full library</strong>
      </footer>
    </section>
  );
};

export const PlaylistsPage = ({
  busy,
  onCreate,
  onImport,
  playback,
  playlists,
  selectedPlaylistId,
  view,
}: CommonPageProps &
  Readonly<{
    onCreate: (name: string, songIds: readonly string[]) => Promise<boolean>;
    playlists: readonly RekordboxPlaylist[] | null;
    selectedPlaylistId: string | null;
  }>): JSX.Element => {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly SongRow[]>([]);
  const [chosenIds, setChosenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [loadingSongs, setLoadingSongs] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);

  useEffect(() => {
    if (!creating) {
      return;
    }
    let active = true;
    void window.djLibrary.searchSongs({ query: '' }).then(
      (songs) => {
        if (active) {
          setResults(songs);
          setLoadingSongs(false);
          setSearchFailed(false);
        }
      },
      () => {
        if (active) {
          setLoadingSongs(false);
          setSearchFailed(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [creating]);

  if (view === null) {
    return (
      <NoLibrary
        busy={busy}
        eyebrow="Collection / Playlists"
        title="Open a library to view playlists."
        description="Cuebox reads the playlist tree from the Rekordbox XML and can add root playlists."
        onImport={onImport}
      />
    );
  }

  const selectedPlaylist =
    playlists?.find((playlist) => playlist.id === selectedPlaylistId) ?? null;

  const search = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setLoadingSongs(true);
    setSearchFailed(false);
    try {
      setResults(await window.djLibrary.searchSongs({ query }));
    } catch {
      setSearchFailed(true);
    } finally {
      setLoadingSongs(false);
    }
  };

  const toggleSong = (songId: string): void => {
    setChosenIds((current) => {
      const next = new Set(current);
      if (next.has(songId)) {
        next.delete(songId);
      } else {
        next.add(songId);
      }
      return next;
    });
  };

  return (
    <section className="workspace-page playlists-page" aria-labelledby="playlists-title">
      <header className="page-header">
        <div className="page-title-line">
          <h1 id="playlists-title">Playlists</h1>
          <p>{view.library.playlistCount} in {view.library.sourceName}</p>
        </div>
        <div className="header-actions">
          <span className="status-pill"><i aria-hidden />Rekordbox XML</span>
          <button className="accent-button compact" type="button" onClick={() => {
            setLoadingSongs(true);
            setCreating(true);
          }} disabled={busy}>
            New playlist
          </button>
        </div>
      </header>

      <div className="playlists-body">
        <div className="playlist-detail">
          {creating ? (
            <div className="playlist-creator">
              <div className="playlist-creator-heading">
                <p className="mono-label">New root playlist</p>
                <h2>Choose a name and tracks.</h2>
                <p>The track order follows your selection order in the results below.</p>
              </div>
              <label className="playlist-name-field">
                <span>Playlist name</span>
                <input value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={100} autoFocus />
              </label>
              <form className="playlist-search" onSubmit={(event) => void search(event)}>
                <label htmlFor="playlist-track-search">Find tracks in the full collection</label>
                <div>
                  <input id="playlist-track-search" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Title, artist, album, genre, or key" />
                  <button className="quiet-button" type="submit" disabled={loadingSongs}>{loadingSongs ? 'Searching' : 'Search'}</button>
                </div>
              </form>
              {searchFailed && (
                <p className="playlist-search-error" role="alert">Cuebox could not search this collection.</p>
              )}
              <div className="playlist-track-options" aria-label="Tracks to add">
                {results.length === 0 && !loadingSongs ? (
                  <div className="inline-empty"><strong>No tracks found.</strong></div>
                ) : results.map((song) => (
                  <label className="playlist-track-option" key={song.id}>
                    <input type="checkbox" checked={chosenIds.has(song.id)} onChange={() => toggleSong(song.id)} />
                    <span className="custom-check" aria-hidden>{chosenIds.has(song.id) ? '✓' : ''}</span>
                    <TrackArtwork song={song} />
                    <span className="track-identity"><strong>{song.title}</strong><small>{song.artist ?? 'Unknown artist'}</small></span>
                    <span className="numeric">{formatBpm(song.bpm)}</span>
                    <span className="numeric is-muted">{song.musicalKey ?? '—'}</span>
                  </label>
                ))}
              </div>
              <div className="playlist-create-actions">
                <span>{chosenIds.size} tracks selected</span>
                <button className="quiet-button" type="button" onClick={() => setCreating(false)} disabled={busy}>Cancel</button>
                <button
                  className="accent-button compact"
                  type="button"
                  onClick={() => void onCreate(name, [...chosenIds])}
                  disabled={busy || name.trim().length === 0}
                >
                  {busy ? 'Writing XML' : 'Create playlist'}
                </button>
              </div>
            </div>
          ) : playlists === null ? (
            <div className="detail-empty" role="status">
              <span className="loading-mark" aria-hidden />
              <p className="mono-label">Playlist collection</p>
              <h2>Reading the Rekordbox tree.</h2>
            </div>
          ) : selectedPlaylist === null ? (
            <div className="detail-empty">
              <span className="empty-scan" aria-hidden />
              <p className="mono-label">Playlist collection</p>
              <h2>{playlists.length === 0 ? 'No playlists in this XML.' : 'Choose a playlist.'}</h2>
              <p>{playlists.length === 0 ? 'Create one from tracks in the collection.' : 'Use the Rekordbox folder tree in the sidebar.'}</p>
            </div>
          ) : (
            <>
              <div className="playlist-detail-heading">
                <div className="playlist-heading-meta">
                  <p className="mono-label">{selectedPlaylist.folderPath.length === 0 ? 'Root' : selectedPlaylist.folderPath.join(' / ')}</p>
                  {selectedPlaylist.kind === 'smart' && <span className="smart-playlist-mark">Smart</span>}
                </div>
                <h2>{selectedPlaylist.name}</h2>
                <span>{selectedPlaylist.tracks.length} tracks</span>
              </div>
              <div className="playlist-track-list">
                {selectedPlaylist.tracks.map((song, index) => {
                  const isPlaying = playback.song?.id === song.id && playback.playing;
                  return (
                    <div className="playlist-track" key={`${song.id}-${index}`}>
                      <span className="track-index">{String(index + 1).padStart(2, '0')}</span>
                      <button
                        className={isPlaying ? 'track-play is-playing' : 'track-play'}
                        type="button"
                        onClick={() => playback.play(song)}
                        disabled={song.audioUrl === null}
                        aria-label={isPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
                      >
                        <TrackArtwork song={song} />
                        <span aria-hidden>{isPlaying ? 'Ⅱ' : '▶'}</span>
                      </button>
                      <span className="track-identity"><strong>{song.title}</strong><small>{song.artist ?? 'Unknown artist'}</small></span>
                      <span className="numeric">{formatBpm(song.bpm)}</span>
                      <span className="numeric is-muted">{song.musicalKey ?? '—'}</span>
                      <span className="numeric is-muted">{formatDuration(song.durationSeconds)}</span>
                    </div>
                  );
                })}
                {selectedPlaylist.tracks.length === 0 && (
                  <div className="inline-empty"><strong>This playlist is empty.</strong></div>
                )}
                {selectedPlaylist.missingTrackCount > 0 && (
                  <p className="playlist-missing">{selectedPlaylist.missingTrackCount} XML references do not match a collection track.</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
};
