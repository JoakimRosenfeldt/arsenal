import { useState, type JSX } from 'react';

import type { DuplicateViewState } from './App';
import {
  DUPLICATE_MATCH_MODES,
  type DuplicateGroup,
  type DuplicateMatchMode,
  type DuplicateScan,
  type LibrarySummary,
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
  view: LibraryView | null;
}>;

const formatDuration = (durationSeconds: number | null): string => {
  if (durationSeconds === null) {
    return 'Not set';
  }

  const rounded = Math.max(0, Math.floor(durationSeconds));
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
    ? '—'
    : bpm.toLocaleString(undefined, { maximumFractionDigits: 2 });

type ComparisonRow = Readonly<{
  label: string;
  first: string;
  second: string;
  wrap?: boolean;
}>;

const formatFileSize = (bytes: number | null): string | null => {
  if (bytes === null) {
    return null;
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

const formatRating = (rating: number | null): string | null => {
  if (rating === null) {
    return null;
  }

  const stars = Math.max(
    0,
    Math.min(5, Math.round(rating > 5 ? rating / 51 : rating)),
  );
  return `${stars} / 5`;
};

const comparisonRowsFor = (
  firstTrack: SongRow,
  secondTrack: SongRow,
): readonly ComparisonRow[] => {
  const rows: ComparisonRow[] = [
    { label: 'Title', first: firstTrack.title, second: secondTrack.title },
    {
      label: 'Artist',
      first: firstTrack.artist ?? 'Not set',
      second: secondTrack.artist ?? 'Not set',
    },
    {
      label: 'Album',
      first: firstTrack.album ?? 'Not set',
      second: secondTrack.album ?? 'Not set',
    },
    {
      label: 'Genre',
      first: firstTrack.genre ?? 'Not set',
      second: secondTrack.genre ?? 'Not set',
    },
    {
      label: 'BPM',
      first: formatBpm(firstTrack.bpm),
      second: formatBpm(secondTrack.bpm),
    },
    {
      label: 'Key',
      first: firstTrack.musicalKey ?? 'Not set',
      second: secondTrack.musicalKey ?? 'Not set',
    },
    {
      label: 'Duration',
      first: formatDuration(firstTrack.durationSeconds),
      second: formatDuration(secondTrack.durationSeconds),
    },
  ];
  const addOptional = ({
    first,
    label,
    second,
    wrap,
  }: Readonly<{
    first: string | null;
    label: string;
    second: string | null;
    wrap?: boolean;
  }>): void => {
    if (first === null && second === null) {
      return;
    }

    rows.push({
      label,
      first: first ?? 'Not set',
      second: second ?? 'Not set',
      ...(wrap === undefined ? {} : { wrap }),
    });
  };
  const formatNumber = (value: number | null): string | null =>
    value?.toLocaleString() ?? null;

  addOptional({
    label: 'Mix',
    first: firstTrack.mixName,
    second: secondTrack.mixName,
  });
  addOptional({
    label: 'Remixer',
    first: firstTrack.remixer,
    second: secondTrack.remixer,
  });
  addOptional({
    label: 'Composer',
    first: firstTrack.composer,
    second: secondTrack.composer,
  });
  addOptional({
    label: 'Label',
    first: firstTrack.label,
    second: secondTrack.label,
  });
  addOptional({
    label: 'Year',
    first: firstTrack.year === null ? null : String(firstTrack.year),
    second: secondTrack.year === null ? null : String(secondTrack.year),
  });
  addOptional({
    label: 'Format',
    first: firstTrack.fileKind,
    second: secondTrack.fileKind,
  });
  addOptional({
    label: 'Bitrate',
    first:
      firstTrack.bitRateKbps === null
        ? null
        : `${formatNumber(firstTrack.bitRateKbps)} kbps`,
    second:
      secondTrack.bitRateKbps === null
        ? null
        : `${formatNumber(secondTrack.bitRateKbps)} kbps`,
  });
  addOptional({
    label: 'Sample rate',
    first:
      firstTrack.sampleRateHz === null
        ? null
        : `${formatNumber(firstTrack.sampleRateHz)} Hz`,
    second:
      secondTrack.sampleRateHz === null
        ? null
        : `${formatNumber(secondTrack.sampleRateHz)} Hz`,
  });
  addOptional({
    label: 'File size',
    first: formatFileSize(firstTrack.fileSizeBytes),
    second: formatFileSize(secondTrack.fileSizeBytes),
  });
  addOptional({
    label: 'Track no.',
    first: formatNumber(firstTrack.trackNumber),
    second: formatNumber(secondTrack.trackNumber),
  });
  addOptional({
    label: 'Disc no.',
    first: formatNumber(firstTrack.discNumber),
    second: formatNumber(secondTrack.discNumber),
  });
  addOptional({
    label: 'Rating',
    first: formatRating(firstTrack.rating),
    second: formatRating(secondTrack.rating),
  });
  addOptional({
    label: 'Play count',
    first: formatNumber(firstTrack.playCount),
    second: formatNumber(secondTrack.playCount),
  });
  addOptional({
    label: 'Added',
    first: firstTrack.dateAdded,
    second: secondTrack.dateAdded,
  });
  addOptional({
    label: 'Comments',
    first: firstTrack.comments,
    second: secondTrack.comments,
    wrap: true,
  });

  return rows;
};

const formatImportedAt = (importedAt: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(importedAt));

const formatRowNumber = (offset: number, index: number): string =>
  String(offset + index + 1).padStart(3, '0');

const normalize = (value: string | null): string =>
  value?.trim().toLocaleLowerCase() ?? '';

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

const statusForSong = (song: SongRow): Readonly<{ label: string; tone: string }> => {
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
    <small>Nothing is uploaded. Cuebox remembers this XML location on this Mac.</small>
  </section>
);

const WaveBars = ({ song }: Readonly<{ song: SongRow }>): JSX.Element => {
  const seed = [...`${song.id}${song.title}`].reduce(
    (total, character) => total + character.charCodeAt(0),
    0,
  );
  const bars = Array.from({ length: 54 }, (_, index) => {
    const first = Math.abs(Math.sin((index + seed) * 0.43));
    const second = Math.abs(Math.sin((index + seed) * 0.17));
    return 18 + Math.round((first * 0.68 + second * 0.32) * 78);
  });

  return (
    <div className="track-profile-bars" aria-hidden>
      {bars.map((height, index) => (
        <span
          className={index < 14 ? 'is-accent' : ''}
          style={{ height: `${height}%` }}
          key={`${height}-${index}`}
        />
      ))}
    </div>
  );
};

const TrackArtwork = ({
  loadEagerly = false,
  size = 'small',
  song,
}: Readonly<{
  loadEagerly?: boolean;
  size?: 'small' | 'medium' | 'large';
  song: SongRow;
}>): JSX.Element => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showArtwork =
    song.artworkUrl !== null && song.artworkUrl !== failedUrl;

  return (
    <span className={`track-artwork is-${size}`} aria-hidden>
      <span>CB</span>
      {showArtwork && (
        <img
          src={song.artworkUrl ?? undefined}
          alt=""
          loading={loadEagerly ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setFailedUrl(song.artworkUrl)}
        />
      )}
    </span>
  );
};

export const LibraryPage = ({
  busy,
  onImport,
  onPage,
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
        description="Open a Rekordbox Collection XML file to browse its tracks in Cuebox."
        onImport={onImport}
      />
    );
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSongs = normalizedQuery.length === 0
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
          <span className="status-pill"><i aria-hidden />Read only</span>
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
            <span role="columnheader"><span className="visually-hidden">Artwork</span></span>
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
                return (
                  <button
                    className={isSelected ? 'track-row is-selected' : 'track-row'}
                    type="button"
                    role="row"
                    aria-selected={isSelected}
                    onClick={() => {
                      setSelectedId(song.id);
                      setInspectorOpen(true);
                    }}
                    title={`${song.title} by ${song.artist ?? 'Unknown artist'}`}
                    key={song.id}
                  >
                    <span className={`track-status is-${status.tone}`} role="cell">
                      <span className="visually-hidden">{status.label}</span>
                    </span>
                    <span className="track-index" role="cell">{formatRowNumber(view.page.offset, index)}</span>
                    <span role="cell"><TrackArtwork song={song} /></span>
                    <span className="track-identity" role="cell">
                      <strong>{song.title}</strong>
                      <small>{song.artist ?? 'Unknown artist'}</small>
                    </span>
                    <span className="numeric" role="cell">{formatBpm(song.bpm)}</span>
                    <span className="numeric is-muted" role="cell">{song.musicalKey ?? '—'}</span>
                    <span className="numeric is-muted" role="cell">{formatDuration(song.durationSeconds)}</span>
                    <span className="truncate is-muted" role="cell">{song.genre ?? 'Not set'}</span>
                    <span className="truncate is-muted" role="cell">{song.album ?? 'Not set'}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {selectedSong !== null && (
          <aside className={inspectorOpen ? 'library-inspector is-open' : 'library-inspector'} aria-label="Selected track inspector">
            <button className="inspector-close" type="button" onClick={() => setInspectorOpen(false)} aria-label="Close inspector">×</button>
            <div className="inspector-title">
              <TrackArtwork song={selectedSong} size="large" />
              <div>
                <h2>{selectedSong.title}</h2>
                <p>{selectedSong.artist ?? 'Unknown artist'}</p>
                <small>REKORDBOX XML METADATA</small>
              </div>
            </div>
            <div className="inspector-profile">
              <div className="section-label-row">
                <span>Track profile</span>
                <span>{formatDuration(selectedSong.durationSeconds)}</span>
              </div>
              <WaveBars song={selectedSong} />
              <p>Audio and waveform data are not loaded by the XML viewer.</p>
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
              <span className="mono-label">Local and read-only</span>
              <p>Cuebox remembers this XML location on this Mac. It does not edit the track or the Rekordbox export.</p>
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

type DuplicateModeCopy = Readonly<{
  description: string;
  emptyDescription: string;
  emptyTitle: string;
  label: string;
}>;

const duplicateModeCopy: Readonly<
  Record<DuplicateMatchMode, DuplicateModeCopy>
> = {
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

export const DuplicatesPage = ({
  busy,
  mode,
  onImport,
  onModeChange,
  state,
  view,
}: CommonPageProps &
  Readonly<{
    mode: DuplicateMatchMode;
    onModeChange: (mode: DuplicateMatchMode) => void;
    state: DuplicateViewState;
  }>): JSX.Element => {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [comparisonId, setComparisonId] = useState<string | null>(null);

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
    state.libraryVersion === view.library.importedAt &&
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
    state.libraryVersion !== view.library.importedAt ||
    stateMode !== mode;
  const scanFailed =
    state.kind === 'error' &&
    state.libraryVersion === view.library.importedAt &&
    state.mode === mode;
  const groups = scan?.groups ?? [];
  const selectedGroup =
    groups.find((group) => group.key === selectedKey) ?? groups[0] ?? null;
  const reference = selectedGroup?.candidates[0] ?? null;
  const comparisonChoices = selectedGroup?.candidates.slice(1) ?? [];
  const modeDefaultComparison =
    mode === 'remixes'
      ? comparisonChoices.find((candidate) =>
          candidate.variantKinds.includes('remix'),
        )
      : mode === 'dj-edits'
        ? comparisonChoices.find((candidate) =>
            candidate.variantKinds.includes('dj-edit'),
          )
        : undefined;
  const comparison =
    comparisonChoices.find((candidate) => candidate.song.id === comparisonId) ??
    modeDefaultComparison ??
    comparisonChoices[0] ??
    null;
  const firstTrack = reference?.song ?? null;
  const secondTrack = comparison?.song ?? null;
  const copy = duplicateModeCopy[mode];
  const comparisons =
    firstTrack !== null && secondTrack !== null
      ? comparisonRowsFor(firstTrack, secondTrack)
      : [];

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
          <span className="status-pill is-warning"><i aria-hidden />Review only</span>
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
          <p>{copy.description} · no files changed</p>
        </div>
      </header>

      <div className="duplicates-body">
        <aside className="duplicate-groups" aria-label="Matched track groups">
          <div className="panel-heading"><span>Groups</span><span>Variants</span></div>
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
                  onClick={() => {
                    setSelectedKey(group.key);
                    setComparisonId(null);
                  }}
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
          ) : selectedGroup === null || reference === null || comparison === null ? (
            <div className="detail-empty">
              <span className="empty-scan" aria-hidden />
              <p className="mono-label">Full library scan complete</p>
              <h2>{copy.emptyTitle}</h2>
              <p>{copy.emptyDescription} Cuebox uses explicit metadata rules rather than fuzzy confidence scores.</p>
            </div>
          ) : (
            <>
              <div className="duplicate-detail-title">
                <TrackArtwork
                  loadEagerly
                  song={reference.song}
                  size="large"
                />
                <div className="duplicate-detail-copy">
                  <div className="duplicate-detail-meta">
                    <span className="accent-tag">Group {groups.indexOf(selectedGroup) + 1} of {groups.length}</span>
                    <p>{selectedGroup.matchReason}</p>
                  </div>
                  <h2>{selectedGroup.title}</h2>
                  <span>{selectedGroup.artist}</span>
                </div>
              </div>

              <div className="version-picker">
                <span className="mono-label">Compare reference with</span>
                <div>
                  {comparisonChoices.map((candidate) => (
                    <button
                      className={candidate.song.id === comparison.song.id ? 'is-active' : ''}
                      type="button"
                      onClick={() => setComparisonId(candidate.song.id)}
                      aria-pressed={candidate.song.id === comparison.song.id}
                      title={candidate.song.title}
                      key={candidate.song.id}
                    >
                      <b>{candidate.variantLabel}</b>
                      <small>{candidate.song.title}</small>
                    </button>
                  ))}
                </div>
              </div>

              <div className="comparison-grid">
                <div className="comparison-head label-cell">Attribute</div>
                <div className="comparison-head candidate is-selected">
                  <TrackArtwork
                    loadEagerly
                    song={reference.song}
                    size="medium"
                  />
                  <span><b>Reference</b><small>{reference.variantLabel}</small></span>
                </div>
                <div className="comparison-head candidate">
                  <TrackArtwork
                    loadEagerly
                    song={comparison.song}
                    size="medium"
                  />
                  <span><b>Compare</b><small>{comparison.variantLabel}</small></span>
                </div>
                {comparisons.map((item) => (
                  <div className="comparison-row" key={item.label}>
                    <span className="label-cell">{item.label}</span>
                    <span className={`comparison-value is-selected${item.wrap ? ' is-wrapped' : ''}`}>{item.first}</span>
                    <span className={`comparison-value${item.wrap ? ' is-wrapped' : ''}`}>{item.second}</span>
                  </div>
                ))}
              </div>
              <div className="read-only-callout">
                <span className="lock-glyph" aria-hidden>◇</span>
                <div>
                  <strong>Comparison only</strong>
                  <p>Cuebox reads metadata and embedded cover art. It will not remove, merge, move, or edit either track.</p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <footer className="action-rail">
        <span>READ-ONLY METADATA REVIEW</span>
        <strong>{copy.label} · full library</strong>
      </footer>
    </section>
  );
};

const isCrateMatch = (song: SongRow): boolean => {
  const genre = normalize(song.genre);
  return (
    song.bpm !== null &&
    song.bpm >= 124 &&
    song.bpm <= 128 &&
    (genre.includes('house') || genre.includes('techno'))
  );
};

const exclusionReason = (song: SongRow): string => {
  if (song.bpm === null) {
    return 'BPM not set';
  }
  if (song.bpm < 124 || song.bpm > 128) {
    return `${formatBpm(song.bpm)} BPM`;
  }
  if (!/house|techno/i.test(song.genre ?? '')) {
    return song.genre === null ? 'Genre not set' : `Genre: ${song.genre}`;
  }
  return 'Included';
};

const bpmHistogram = (songs: readonly SongRow[]): readonly Readonly<{ label: string; count: number }>[] => {
  const starts = [116, 118, 120, 122, 124, 126, 128, 130, 132, 134];
  return starts.map((start) => ({
    label: String(start),
    count: songs.filter((song) => song.bpm !== null && song.bpm >= start && song.bpm < start + 2).length,
  }));
};

export const CrateBuilderPage = ({ busy, onImport, view }: CommonPageProps): JSX.Element => {
  const songs = view?.page.items ?? [];
  const matches = songs.filter(isCrateMatch);
  const [excludedIds, setExcludedIds] = useState<ReadonlySet<string>>(() => new Set());

  if (view === null) {
    return (
      <NoLibrary
        busy={busy}
        eyebrow="Curation / Crate builder"
        title="A crate needs tracks to work with."
        description="Import a Rekordbox XML export to preview a local BPM and genre rule against the visible page."
        onImport={onImport}
      />
    );
  }

  const included = matches.filter((song) => !excludedIds.has(song.id));
  const excluded = songs.filter((song) => !isCrateMatch(song));
  const histogram = bpmHistogram(songs);
  const histogramPeak = Math.max(1, ...histogram.map((bin) => bin.count));
  const keyCounts = new Map<string, number>();
  for (const song of matches) {
    const key = song.musicalKey ?? 'Not set';
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const keys = [...keyCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);

  return (
    <section className="workspace-page crate-page" aria-labelledby="crate-title">
      <div className="split-page-main">
        <header className="crate-prompt">
          <p className="mono-label">Local rule preview</p>
          <div className="prompt-box">
            <h1 id="crate-title">House and techno, 124 to 128 BPM, from this page</h1>
            <div>
              <button className="accent-button compact" type="button" onClick={() => setExcludedIds(new Set())}>Reset preview</button>
              <span>Uses 3 explicit local rules</span>
            </div>
          </div>
        </header>

        <div className="rule-section">
          <div className="section-label-row"><span>Rules in this preview</span><span>Match all</span></div>
          <div className="rule-chips">
            <span><b>Genre</b>House or techno</span>
            <span><b>BPM</b>124-128</span>
            <span><b>Scope</b>Current page</span>
          </div>
        </div>

        <div className="crate-summary">
          <strong>{included.length}</strong>
          <span>tracks included<br />{formatDuration(included.reduce((total, song) => total + (song.durationSeconds ?? 0), 0))}</span>
          <p>{excluded.length} excluded by the shown rules</p>
        </div>

        <div className="crate-track-list" aria-label="Crate preview tracks">
          {matches.length === 0 ? (
            <div className="inline-empty">
              <strong>No tracks match all three rules.</strong>
              <span>The preview uses the current 100-track page only.</span>
            </div>
          ) : (
            matches.map((song) => {
              const isIncluded = !excludedIds.has(song.id);
              return (
                <label className={isIncluded ? 'crate-track is-included' : 'crate-track'} key={song.id}>
                  <input
                    type="checkbox"
                    checked={isIncluded}
                    onChange={() => {
                      setExcludedIds((current) => {
                        const next = new Set(current);
                        if (next.has(song.id)) {
                          next.delete(song.id);
                        } else {
                          next.add(song.id);
                        }
                        return next;
                      });
                    }}
                  />
                  <span className="custom-check" aria-hidden>{isIncluded ? '✓' : ''}</span>
                  <TrackArtwork song={song} />
                  <span className="track-identity">
                    <strong>{song.title}</strong>
                    <small>{song.artist ?? 'Unknown artist'}</small>
                  </span>
                  <span className="numeric">{formatBpm(song.bpm)}</span>
                  <span className="numeric is-muted">{song.musicalKey ?? '—'}</span>
                  <span className="rule-reason">BPM + GENRE MATCH</span>
                </label>
              );
            })
          )}
        </div>
      </div>

      <aside className="analytics-rail" aria-label="Crate analysis">
        <section>
          <p className="mono-label">BPM spread · current page</p>
          <div className="histogram" aria-hidden>
            {histogram.map((bin) => (
              <span
                className={Number(bin.label) >= 124 && Number(bin.label) <= 128 ? 'is-accent' : ''}
                style={{ height: `${Math.max(8, (bin.count / histogramPeak) * 100)}%` }}
                key={bin.label}
              />
            ))}
          </div>
          <div className="histogram-labels"><span>116</span><span>124</span><span>128</span><span>134</span></div>
        </section>
        <section>
          <p className="mono-label">Keys in matches</p>
          <div className="key-bars">
            {keys.length === 0 ? <p>No key data in matching tracks.</p> : keys.map(([key, count]) => (
              <div key={key}>
                <span>{key}</span>
                <i><b style={{ width: `${(count / Math.max(1, matches.length)) * 100}%` }} /></i>
                <small>{count}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="excluded-list">
          <div className="section-label-row"><span>Excluded</span><span>{excluded.length}</span></div>
          {excluded.slice(0, 5).map((song) => (
            <div key={song.id}><span>{song.title}</span><small>{exclusionReason(song)}</small></div>
          ))}
          {excluded.length === 0 && <p>Every track on this page matches.</p>}
        </section>
        <section className="write-panel">
          <p className="mono-label">Write back to Rekordbox</p>
          <div className="disabled-field">Local crate preview</div>
          <button type="button" disabled>Create playlist · unavailable</button>
          <p>Cuebox remains read-only. This page does not write playlists or move files.</p>
        </section>
      </aside>
    </section>
  );
};

type DraftTrack = Readonly<{
  song: SongRow;
  startSeconds: number;
}>;

const buildDraft = (songs: readonly SongRow[]): readonly DraftTrack[] => {
  let startSeconds = 0;
  return songs.slice(0, 9).map((song) => {
    const draftTrack = { song, startSeconds };
    startSeconds += song.durationSeconds ?? 360;
    return draftTrack;
  });
};

const averageBpm = (songs: readonly SongRow[]): number | null => {
  const bpms = songs
    .map((song) => song.bpm)
    .filter((bpm): bpm is number => bpm !== null);
  if (bpms.length === 0) {
    return null;
  }
  return bpms.reduce((total, bpm) => total + bpm, 0) / bpms.length;
};

type BpmGap = Readonly<{
  delta: number;
  from: SongRow;
  index: number;
  to: SongRow;
}>;

const largestBpmGap = (songs: readonly SongRow[]): BpmGap | null => {
  let largest: BpmGap | null = null;
  for (let index = 0; index < songs.length - 1; index += 1) {
    const from = songs[index];
    const to = songs[index + 1];
    if (from?.bpm === null || from?.bpm === undefined || to?.bpm === null || to?.bpm === undefined) {
      continue;
    }
    const delta = Math.abs(to.bpm - from.bpm);
    if (largest === null || delta > largest.delta) {
      largest = { delta, from, index, to };
    }
  }
  return largest;
};

export const GigPrepPage = ({ busy, onImport, view }: CommonPageProps): JSX.Element => {
  if (view === null) {
    return (
      <NoLibrary
        busy={busy}
        eyebrow="Curation / Gig prep"
        title="Build the draft from your library."
        description="Import a Rekordbox XML export to preview a read-only running order from the first tracks on the visible page."
        onImport={onImport}
      />
    );
  }

  const draft = buildDraft(view.page.items);
  const draftSongs = draft.map((item) => item.song);
  const totalSeconds = draftSongs.reduce((total, song) => total + (song.durationSeconds ?? 360), 0);
  const bpmAverage = averageBpm(draftSongs);
  const gap = largestBpmGap(draftSongs);
  const knownKeys = draftSongs.filter((song) => song.musicalKey !== null).length;
  const targetBpm = gap !== null && gap.from.bpm !== null && gap.to.bpm !== null
    ? (gap.from.bpm + gap.to.bpm) / 2
    : bpmAverage;
  const bridgeSuggestions = view.page.items
    .filter((song) => !draftSongs.some((draftSong) => draftSong.id === song.id) && song.bpm !== null && targetBpm !== null)
    .sort((left, right) => Math.abs((left.bpm ?? targetBpm ?? 0) - (targetBpm ?? 0)) - Math.abs((right.bpm ?? targetBpm ?? 0) - (targetBpm ?? 0)))
    .slice(0, 4);

  return (
    <section className="workspace-page gig-page" aria-labelledby="gig-title">
      <div className="split-page-main">
        <header className="page-header gig-header">
          <div className="page-title-line">
            <h1 id="gig-title">Local set draft</h1>
            <p>FIRST {draft.length} TRACKS · CURRENT PAGE · READ ONLY</p>
          </div>
          <dl className="gig-metrics">
            <div><dt>Planned</dt><dd>{draft.length} / {formatDuration(totalSeconds)}</dd></div>
            <div><dt>Avg BPM</dt><dd>{bpmAverage === null ? '—' : bpmAverage.toFixed(1)}</dd></div>
            <div><dt>Keys</dt><dd>{knownKeys} / {draft.length}</dd></div>
          </dl>
        </header>

        <section className="energy-curve">
          <div className="section-label-row"><span>BPM curve</span><span>Derived from imported metadata</span></div>
          <div className="curve-bars" aria-hidden>
            {draft.map(({ song }, index) => {
              const height = song.bpm === null ? 24 : Math.min(100, Math.max(18, ((song.bpm - 110) / 30) * 100));
              return <span className={index >= Math.floor(draft.length * 0.55) ? 'is-accent' : ''} style={{ height: `${height}%` }} key={song.id} />;
            })}
          </div>
          <div className="curve-phases"><span>00:00 · OPEN</span><span>BUILD</span><span>PEAK</span><span>{formatDuration(totalSeconds)} · CLOSE</span></div>
        </section>

        <div className="set-list" aria-label="Draft set order">
          {draft.length === 0 ? (
            <div className="inline-empty"><strong>This collection has no tracks.</strong></div>
          ) : draft.map(({ song, startSeconds }, index) => {
            const nextSong = draft[index + 1]?.song;
            const transition = song.bpm !== null && nextSong?.bpm !== null && nextSong?.bpm !== undefined
              ? `${nextSong.bpm - song.bpm >= 0 ? '+' : ''}${(nextSong.bpm - song.bpm).toFixed(1)} BPM into next track`
              : 'Transition BPM unavailable';
            const isGap = gap?.index === index && gap.delta >= 4;
            return (
              <div className={isGap ? 'set-track has-gap' : 'set-track'} key={song.id}>
                <div className="set-track-main">
                  <span className="numeric is-muted">{formatDuration(startSeconds)}</span>
                  <span className="numeric is-muted">{index + 1}</span>
                  <span className="track-identity"><strong>{song.title}</strong><small>{song.artist ?? 'Unknown artist'}</small></span>
                  <span className="numeric">{formatBpm(song.bpm)}</span>
                  <span className="numeric is-muted">{song.musicalKey ?? '—'}</span>
                  <span className="numeric is-muted">{formatDuration(song.durationSeconds)}</span>
                </div>
                {nextSong !== undefined && <p className={isGap ? 'transition-note is-warning' : 'transition-note'}>{transition}</p>}
              </div>
            );
          })}
        </div>
      </div>

      <aside className="analytics-rail gig-rail" aria-label="Set analysis">
        <section>
          <div className={gap !== null && gap.delta >= 4 ? 'gap-callout' : 'gap-callout is-clear'}>
            <p className="mono-label">{gap !== null && gap.delta >= 4 ? `BPM jump after track ${gap.index + 1}` : 'BPM order looks even'}</p>
            <strong>
              {gap === null
                ? 'Not enough BPM metadata to compare transitions.'
                : `${gap.from.title} to ${gap.to.title} changes ${gap.delta.toFixed(1)} BPM.`}
            </strong>
            <small>Analysis uses BPM only. Cuebox does not inspect audio or beatgrids.</small>
          </div>
        </section>
        <section>
          <p className="mono-label">Draft phases</p>
          <div className="phase-list">
            <div><b>Open</b><span>Tracks 1-{Math.max(1, Math.ceil(draft.length * 0.25))}</span><small>25%</small></div>
            <div><b>Build</b><span>Middle section</span><small>35%</small></div>
            <div className="is-accent"><b>Peak</b><span>Highest BPM area</span><small>25%</small></div>
            <div><b>Close</b><span>Final tracks</span><small>15%</small></div>
          </div>
        </section>
        <section className="bridge-list">
          <div className="section-label-row"><span>Nearby BPM options</span><span>BPM only</span></div>
          {bridgeSuggestions.length === 0 ? (
            <p>No unused tracks with BPM metadata on this page.</p>
          ) : bridgeSuggestions.map((song) => (
            <div key={song.id}>
              <TrackArtwork song={song} />
              <span><strong>{song.title}</strong><small>{formatBpm(song.bpm)} BPM · {song.musicalKey ?? 'KEY NOT SET'}</small></span>
              <button type="button" disabled aria-label={`Adding ${song.title} is not available`}>+</button>
            </div>
          ))}
        </section>
        <section className="write-panel">
          <button type="button" disabled>Write playlist to Rekordbox</button>
          <div className="two-actions"><button type="button" disabled>Export to USB</button><button type="button" disabled>Print setlist</button></div>
          <p>This screen is a local preview. Cuebox does not save the order or change Rekordbox.</p>
        </section>
      </aside>
    </section>
  );
};
