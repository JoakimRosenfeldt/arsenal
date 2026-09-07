import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type JSX,
} from 'react';

import type { DuplicateViewState } from './App';
import { TrackWaveform } from './TrackWaveform';
import { PlaylistSuggestions } from './PlaylistSuggestions';
import {
  TrackArtwork,
  type PlaybackController,
} from './CueboxPlayer';
import {
  DUPLICATE_MATCH_MODES,
  SONG_PAGE_SIZE,
  SONG_SOURCE_LABELS,
  type DuplicateCandidate,
  type DuplicateGroup,
  type DuplicateMatchMode,
  type DuplicateScan,
  type LibrarySummary,
  type RekordboxPlaylist,
  type SongPage,
  type SongRow,
  type SongSearchRequest,
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
    <small>Nothing is uploaded. Arsenal works with the chosen file on this Mac.</small>
  </section>
);

export const LibraryPage = ({
  busy,
  onImport,
  onPage,
  playback,
  query,
  searching,
  view,
}: CommonPageProps &
  Readonly<{
    onPage: (offset: number) => void;
    query: string;
    searching: boolean;
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
  const visibleSongs = view.page.items;
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
          <span className="filter-chip is-accent"><b>Search</b>{query}</span>
        )}
        <span className="result-count">
          {searching ? 'Searching collection' : `${view.page.total.toLocaleString()} results · page ${pageNumber} of ${pageCount}`}
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
          <div className="track-table-body" role="rowgroup" aria-busy={busy || searching}>
            {searching ? (
              <div className="inline-empty" role="status">Searching collection…</div>
            ) : visibleSongs.length === 0 ? (
              <div className="inline-empty">
                <strong>No tracks match "{query}".</strong>
                <span>Clear the search to show the collection.</span>
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
                      <SongLabels song={song} />
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
              <p>Playback and waveform analysis stay on this Mac.</p>
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
          <button type="button" onClick={() => onPage(view.page.offset - view.page.limit)} disabled={busy || searching || view.page.offset === 0}>
            ← Previous
          </button>
          <button type="button" onClick={() => onPage(view.page.offset + view.page.limit)} disabled={busy || searching || !view.page.hasNext}>
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
  smart: {
    label: 'Smart',
    description: 'Matching title, artist, duration, mix, and remixer metadata. Keep local tracks first, then tracks with hot cues.',
    emptyTitle: 'No smart matches found.',
    emptyDescription: 'No tracks share the required metadata and a known duration. Audio files are not fingerprinted.',
  },
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
  { label: 'Source', value: SONG_SOURCE_LABELS[song.source] },
  { label: 'Cue points', value: formatCues(song) },
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
  const tooltipId = useId();
  const disabledReason = busy
    ? 'Wait until the current action finishes.'
    : !songs.some((song) => song.audioUrl !== null)
      ? songs.length === 1
        ? 'The XML does not link this track to a supported local audio file.'
        : 'None of the selected tracks are linked to a supported local audio file in the XML.'
      : null;

  return (
    <label
      className="file-removal-option"
      tabIndex={disabledReason === null ? undefined : 0}
      aria-describedby={disabledReason === null ? undefined : tooltipId}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        disabled={disabledReason !== null}
        aria-describedby={disabledReason === null ? undefined : tooltipId}
      />
      {songs.length === 1
        ? 'Also move the local audio file to Trash'
        : 'Also move the linked local audio files to Trash'}
      {disabledReason !== null && (
        <span className="file-removal-tooltip" id={tooltipId} role="tooltip">
          {disabledReason}
        </span>
      )}
    </label>
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
          <strong>Remove {songs.length} selected {songs.length === 1 ? 'track' : 'tracks'} from the XML?</strong>
          <p>References to these tracks will also be removed from playlists.</p>
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
          {songs.length} selected{songs.length > 10_000 ? ' · Select at most 10,000 tracks per removal' : ''}
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

const DuplicateSong = ({
  busy,
  candidate,
  onRemove,
  onSelect,
  playback,
  recommendation,
  selected,
}: Readonly<{
  busy: boolean;
  candidate: DuplicateCandidate;
  onRemove: RemoveSongs;
  onSelect: (selected: boolean) => void;
  playback: PlaybackController;
  recommendation: 'keep' | 'remove' | null;
  selected: boolean;
}>): JSX.Element => {
  const [confirming, setConfirming] = useState(false);
  const [removeLocalFile, setRemoveLocalFile] = useState(false);
  const song = candidate.song;
  const isPlaying = playback.song?.id === song.id && playback.playing;

  return (
    <div className={selected ? 'duplicate-song-shell is-selected' : 'duplicate-song-shell'}>
      <input
        className="duplicate-select"
        type="checkbox"
        checked={selected}
        onChange={(event) => onSelect(event.currentTarget.checked)}
        disabled={busy}
        aria-label={`Select ${song.title} by ${song.artist ?? 'Unknown artist'} for removal`}
      />
      <button
        className={isPlaying ? 'track-play duplicate-play is-playing' : 'track-play duplicate-play'}
        type="button"
        onClick={() => playback.play(song)}
        disabled={song.audioUrl === null}
        aria-label={isPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
        title={song.audioUrl === null ? 'Local audio file unavailable' : isPlaying ? 'Pause' : 'Play'}
      >
        <TrackArtwork song={song} size="medium" />
        <span aria-hidden>{isPlaying ? 'Ⅱ' : '▶'}</span>
      </button>
      <details className="duplicate-song">
        <summary>
          <span aria-hidden />
          <span aria-hidden />
          <span className="duplicate-song-identity">
            <strong>{song.title}</strong>
            <small>{song.artist ?? 'Unknown artist'} · {candidate.variantLabel}</small>
            <SongLabels song={song} />
            {recommendation !== null && (
              <span className={`duplicate-recommendation is-${recommendation}`}>
                {recommendation === 'keep' ? 'Suggested keeper' : 'Suggested duplicate'}
              </span>
            )}
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
                  <FileRemovalOption
                    busy={busy}
                    checked={removeLocalFile}
                    onChange={setRemoveLocalFile}
                    songs={[song]}
                  />
                </div>
                <span>
                  <button type="button" className="quiet-button" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => {
                      void onRemove([song.id], removeLocalFile).then((removed) => {
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
              <button type="button" className="danger-text-button" onClick={() => setConfirming(true)} disabled={busy}>
                Remove duplicate
              </button>
            )}
          </div>
        </div>
      </details>
    </div>
  );
};

export const DuplicatesPage = ({
  busy,
  mode,
  onIgnore,
  onImport,
  onModeChange,
  onRemove,
  playback,
  state,
  view,
}: CommonPageProps &
  Readonly<{
    mode: DuplicateMatchMode;
    onIgnore: (groupKey: string) => Promise<boolean>;
    onModeChange: (mode: DuplicateMatchMode) => void;
    onRemove: RemoveSongs;
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
        eyebrow="Collection / Duplicates"
        title="Open a library before comparing tracks."
        description="Arsenal scans the full collection for exact matches, alternate versions, DJ edits, and remixes."
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
    ? 'No groups left to review.'
    : copy.emptyTitle;
  const emptyDescription = (scan?.ignoredGroupCount ?? 0) > 0
    ? 'Ignored groups return when a new matching track is imported.'
    : copy.emptyDescription;

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
                onClick={() => {
                  setSelection({ key: null, index: 0, groups: [] });
                  onModeChange(option);
                }}
                disabled={busy}
                aria-pressed={option === mode}
                key={option}
              >
                {duplicateModeCopy[option].label}
              </button>
            ))}
          </div>
          <p>{copy.description}</p>
        </div>
        {mode === 'smart' && (
          <div className="duplicate-smart-actions">
            <button
              className="quiet-button"
              type="button"
              disabled={busy || scanning || suggestedIds.length === 0}
              onClick={() => setChosenIds(new Set(suggestedIds.slice(0, 10_000)))}
            >
              Select suggested duplicates
            </button>
            <span>
              {suggestedIds.length} suggested across all groups.
              {suggestedIds.length > 10_000 ? ' Selects the first 10,000. Remove those, then select the remaining suggestions.' : ' Review before removal.'}
              {' '}Audio files are not fingerprinted.
            </span>
          </div>
        )}
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
              <strong>{emptyTitle}</strong>
              <p>{emptyDescription}</p>
            </div>
          ) : (
            groups.map((group, index) => {
              const isActive = group.key === selectedGroup?.key;
              return (
                <button
                  className={isActive ? 'duplicate-group is-active' : 'duplicate-group'}
                  type="button"
                  onClick={() => setSelection({ key: group.key, index, groups })}
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
              <p>This scan uses imported track metadata. Audio files are not fingerprinted.</p>
            </div>
          ) : scanFailed ? (
            <div className="detail-empty" role="alert">
              <span className="empty-scan" aria-hidden />
              <p className="mono-label">Scan unavailable</p>
              <h2>Arsenal could not compare this library.</h2>
              <p>Import the Rekordbox XML again. Your music files have not been changed.</p>
            </div>
          ) : selectedGroup === null ? (
            <div className="detail-empty">
              <span className="empty-scan" aria-hidden />
              <p className="mono-label">Full library scan complete</p>
              <h2>{emptyTitle}</h2>
              <p>{emptyDescription}</p>
            </div>
          ) : (
            <>
              <div className="duplicate-list-heading">
                <div>
                  <span className="accent-tag">{selectedGroup.candidates.length} tracks</span>
                  <p>{selectedGroup.matchReason}</p>
                  <button
                    className="quiet-button duplicate-ignore"
                    type="button"
                    disabled={busy}
                    title={`Hide this group in ${copy.label} until a new matching track is imported`}
                    onClick={() => void onIgnore(selectedGroup.key)}
                  >
                    Ignore group
                  </button>
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
                    onSelect={(selected) => {
                      setChosenIds((previous) => {
                        const next = new Set(previous);
                        if (selected) {
                          next.add(candidate.song.id);
                        } else {
                          next.delete(candidate.song.id);
                        }
                        return next;
                      });
                    }}
                    playback={playback}
                    recommendation={selectedGroup.recommendedKeepSongId === null
                      ? null
                      : selectedGroup.recommendedKeepSongId === candidate.song.id ? 'keep' : 'remove'}
                    selected={chosenIds.has(candidate.song.id)}
                    key={`${view.library.revision}-${candidate.song.id}`}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {chosenSongs.length > 0 ? (
        <DuplicateSelectionActions
          busy={busy}
          onClear={() => setChosenIds(new Set())}
          onRemove={onRemove}
          songs={chosenSongs}
          key={JSON.stringify([currentSelectionVersion, chosenSongs.map((song) => song.id)])}
        />
      ) : (
        <footer className="action-rail">
          <span>Select tracks to remove them together</span>
          <strong>{copy.label} · full library</strong>
        </footer>
      )}
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
  const [results, setResults] = useState<SongPage | null>(null);
  const [searchRequest, setSearchRequest] = useState<SongSearchRequest>({
    query: '', offset: 0, limit: SONG_PAGE_SIZE,
  });
  const [chosenSongs, setChosenSongs] = useState<ReadonlyMap<string, SongRow>>(() => new Map());
  const [loadingSongs, setLoadingSongs] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);

  useEffect(() => {
    if (!creating) {
      return;
    }
    let active = true;
    void window.djLibrary.searchSongs(searchRequest).then(
      (songs) => {
        if (active) {
          setResults(songs);
          setLoadingSongs(false);
          setSearchFailed(false);
        }
      },
      () => {
        if (active) {
          setResults(null);
          setLoadingSongs(false);
          setSearchFailed(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [creating, searchRequest]);

  if (view === null) {
    return (
      <NoLibrary
        busy={busy}
        eyebrow="Collection / Playlists"
        title="Open a library to view playlists."
        description="Arsenal reads the playlist tree from the Rekordbox XML and can add root playlists."
        onImport={onImport}
      />
    );
  }

  const selectedPlaylist =
    playlists?.find((playlist) => playlist.id === selectedPlaylistId) ?? null;

  const search = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setLoadingSongs(true);
    setSearchFailed(false);
    setSearchRequest({ query, offset: 0, limit: SONG_PAGE_SIZE });
  };

  const toggleSong = (song: SongRow): void => {
    setChosenSongs((current) => {
      const next = new Map(current);
      if (next.has(song.id)) {
        next.delete(song.id);
      } else {
        next.set(song.id, song);
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
            setName('');
            setQuery('');
            setChosenSongs(new Map());
            setResults(null);
            setSearchFailed(false);
            setSearchRequest({ query: '', offset: 0, limit: SONG_PAGE_SIZE });
            setLoadingSongs(true);
            setCreating(true);
          }} disabled={busy || creating}>
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
                <p>Pick tracks yourself or get suggestions from your library. Tracks keep the order you add them.</p>
              </div>
              <label className="playlist-name-field">
                <span>Playlist name</span>
                <input value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={100} disabled={busy} autoFocus />
              </label>
              <PlaylistSuggestions
                busy={busy}
                chosenSongs={chosenSongs}
                onAdd={(song) => setChosenSongs((current) => new Map(current).set(song.id, song))}
                playback={playback}
                revision={view.library.revision}
              />
              <form className="playlist-search" onSubmit={search}>
                <label htmlFor="playlist-track-search">Find tracks in the full collection</label>
                <div>
                  <input id="playlist-track-search" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} maxLength={200} placeholder="Title, artist, album, genre, or key" />
                  <button className="quiet-button" type="submit" disabled={loadingSongs}>{loadingSongs ? 'Searching' : 'Search'}</button>
                </div>
              </form>
              {searchFailed && (
                <p className="playlist-search-error" role="alert">Arsenal could not search this collection.</p>
              )}
              <div className="playlist-track-options" aria-label="Tracks to add" aria-busy={loadingSongs}>
                {loadingSongs ? (
                  <div className="inline-empty" role="status">Searching collection…</div>
                ) : results?.total === 0 ? (
                  <div className="inline-empty"><strong>No tracks found.</strong></div>
                ) : results?.items.map((song) => (
                  <label className="playlist-track-option" key={song.id}>
                    <input type="checkbox" checked={chosenSongs.has(song.id)} onChange={() => toggleSong(song)} disabled={busy} />
                    <span className="custom-check" aria-hidden>{chosenSongs.has(song.id) ? '✓' : ''}</span>
                    <TrackArtwork song={song} />
                    <span className="track-identity"><strong>{song.title}</strong><small>{song.artist ?? 'Unknown artist'}</small></span>
                    <span className="numeric">{formatBpm(song.bpm)}</span>
                    <span className="numeric is-muted">{song.musicalKey ?? '—'}</span>
                  </label>
                ))}
              </div>
              {results !== null && (
                <nav className="page-pagination playlist-pagination" aria-label="Track search pages">
                  <p aria-live="polite">
                    {results.total === 0 ? '0' : `${results.offset + 1}-${results.offset + results.items.length}`} of {results.total.toLocaleString()} results
                  </p>
                  <div>
                    <button type="button" disabled={loadingSongs || results.offset === 0} onClick={() => {
                      setLoadingSongs(true);
                      setSearchRequest({ ...searchRequest, offset: results.offset - results.limit });
                    }}>Previous results</button>
                    <button type="button" disabled={loadingSongs || !results.hasNext} onClick={() => {
                      setLoadingSongs(true);
                      setSearchRequest({ ...searchRequest, offset: results.offset + results.limit });
                    }}>Next results</button>
                  </div>
                </nav>
              )}
              {chosenSongs.size > 0 && (
                <section className="playlist-draft" aria-labelledby="playlist-draft-title">
                  <h3 id="playlist-draft-title">In your playlist <span>{chosenSongs.size}</span></h3>
                  <ol>
                    {[...chosenSongs.values()].map((song) => (
                      <li key={song.id}>
                        <span className="track-identity"><strong>{song.title}</strong><small>{song.artist ?? 'Unknown artist'}</small></span>
                        <button className="quiet-button" type="button" onClick={() => toggleSong(song)} disabled={busy} aria-label={`Remove ${song.title} from playlist`}>Remove</button>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <div className="playlist-create-actions">
                <span aria-live="polite">{chosenSongs.size} tracks selected</span>
                <button className="quiet-button" type="button" onClick={() => setCreating(false)} disabled={busy}>Cancel</button>
                <button
                  className="accent-button compact"
                  type="button"
                  onClick={() => void onCreate(name, [...chosenSongs.keys()])}
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
              {selectedPlaylist.smartRules !== null && (
                <div className="playlist-rules">
                  <p role={selectedPlaylist.smartRules.kind === 'unavailable' ? 'status' : undefined}>
                    {selectedPlaylist.smartRules.message}
                  </p>
                  {selectedPlaylist.smartRules.conditions.length > 0 && (
                    <details>
                      <summary>Smart playlist rules</summary>
                      <ul>
                        {selectedPlaylist.smartRules.conditions.map((condition, index) => (
                          <li key={index}>{condition}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
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
