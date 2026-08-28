import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

import { dialog, type BrowserWindow } from 'electron';

import type {
  DuplicateMatchMode,
  DuplicateScan,
  ImportResult,
  LibraryStatus,
  PageRequest,
  SongPage,
  SongRow,
} from '../shared/dj-library';
import { findDuplicateScan } from './find-duplicates';
import {
  parseRekordboxXml,
  RekordboxXmlError,
} from './parse-rekordbox-xml';
import {
  TrackArtworkStore,
  type ArtworkAsset,
} from './track-artwork';

type CurrentCatalog = Readonly<{
  sourceName: string;
  importedAt: string;
  songs: readonly SongRow[];
  duplicateScans: Map<DuplicateMatchMode, DuplicateScan>;
  artwork: TrackArtworkStore;
}>;

type RememberedLibrary = Readonly<{
  rekordboxXmlPath: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readRememberedPath = async (
  stateFilePath: string,
): Promise<string | null> => {
  try {
    const serialized = await readFile(stateFilePath, 'utf8');
    const stored: unknown = JSON.parse(serialized);
    if (!isRecord(stored)) {
      return null;
    }

    const rememberedPath = stored.rekordboxXmlPath;
    return typeof rememberedPath === 'string' &&
      rememberedPath.length > 0 &&
      isAbsolute(rememberedPath)
      ? rememberedPath
      : null;
  } catch {
    return null;
  }
};

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

const compareSongs = (left: SongRow, right: SongRow): number => {
  if (left.artist === null && right.artist !== null) {
    return 1;
  }
  if (left.artist !== null && right.artist === null) {
    return -1;
  }

  return (
    collator.compare(left.artist ?? '', right.artist ?? '') ||
    collator.compare(left.title, right.title)
  );
};

export class RekordboxLibrary {
  private catalog: CurrentCatalog | null = null;

  private activeImport: Promise<ImportResult> | null = null;

  private stateFilePath: string | null = null;

  private rememberedPath: string | null = null;

  async initialize(stateFilePath: string): Promise<void> {
    this.stateFilePath = stateFilePath;
    this.rememberedPath = await readRememberedPath(stateFilePath);
    if (this.rememberedPath === null) {
      return;
    }

    try {
      this.catalog = await this.catalogFor(this.rememberedPath);
    } catch {
      this.catalog = null;
    }
  }

  status(): LibraryStatus {
    if (this.catalog === null) {
      return { kind: 'empty' };
    }

    return {
      kind: 'ready',
      library: {
        sourceName: this.catalog.sourceName,
        importedAt: this.catalog.importedAt,
        songCount: this.catalog.songs.length,
      },
    };
  }

  listSongs({ offset, limit }: PageRequest): SongPage {
    if (this.catalog === null) {
      throw new Error('No Rekordbox export is open');
    }

    const items = this.catalog.songs.slice(offset, offset + limit);
    const total = this.catalog.songs.length;

    return {
      items,
      offset,
      limit,
      total,
      hasNext: offset + items.length < total,
    };
  }

  findDuplicates(mode: DuplicateMatchMode): DuplicateScan {
    if (this.catalog === null) {
      throw new Error('No Rekordbox export is open');
    }

    const cached = this.catalog.duplicateScans.get(mode);
    if (cached !== undefined) {
      return cached;
    }

    const scan = findDuplicateScan(this.catalog.songs, mode);
    this.catalog.duplicateScans.set(mode, scan);
    return scan;
  }

  async openArtwork(requestUrl: string): Promise<ArtworkAsset | null> {
    return this.catalog?.artwork.open(requestUrl) ?? null;
  }

  async importExport(owner: BrowserWindow): Promise<ImportResult> {
    if (this.activeImport !== null) {
      return this.activeImport;
    }

    const importTask = this.chooseAndImport(owner);
    this.activeImport = importTask;

    try {
      return await importTask;
    } finally {
      if (this.activeImport === importTask) {
        this.activeImport = null;
      }
    }
  }

  private async chooseAndImport(owner: BrowserWindow): Promise<ImportResult> {
    const selection = await dialog.showOpenDialog(owner, {
      title: 'Choose a Rekordbox XML export',
      buttonLabel: 'Open library',
      ...(this.rememberedPath === null
        ? {}
        : { defaultPath: this.rememberedPath }),
      properties: ['openFile'],
      filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }],
    });

    if (selection.canceled || selection.filePaths.length === 0) {
      return { kind: 'cancelled' };
    }

    const selectedPath = selection.filePaths[0];
    if (selectedPath === undefined) {
      return { kind: 'cancelled' };
    }

    try {
      const nextCatalog = await this.catalogFor(selectedPath);
      this.catalog = nextCatalog;
      this.rememberedPath = selectedPath;
      await this.remember(selectedPath);
      return {
        kind: 'imported',
        library: {
          sourceName: nextCatalog.sourceName,
          importedAt: nextCatalog.importedAt,
          songCount: nextCatalog.songs.length,
        },
      };
    } catch (error: unknown) {
      if (error instanceof RekordboxXmlError) {
        return { kind: 'rejected', reason: error.reason };
      }

      return { kind: 'rejected', reason: 'cannot-read' };
    }
  }

  private async catalogFor(filePath: string): Promise<CurrentCatalog> {
    const parsed = await parseRekordboxXml(filePath);
    const mediaPathBySongId = new Map<string, string>();
    for (const track of parsed) {
      if (track.mediaPath !== null) {
        mediaPathBySongId.set(track.song.id, track.mediaPath);
      }
    }

    const artwork = new TrackArtworkStore(randomUUID(), mediaPathBySongId);
    const songs = parsed
      .map((track) => ({
        ...track.song,
        artworkUrl: artwork.urlFor(track.song.id),
      }))
      .sort(compareSongs);

    return {
      sourceName: basename(filePath),
      importedAt: new Date().toISOString(),
      songs,
      duplicateScans: new Map(),
      artwork,
    };
  }

  private async remember(rekordboxXmlPath: string): Promise<void> {
    if (this.stateFilePath === null) {
      return;
    }

    const state: RememberedLibrary = { rekordboxXmlPath };
    try {
      await writeFile(
        this.stateFilePath,
        `${JSON.stringify(state)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch {
      return;
    }
  }
}
