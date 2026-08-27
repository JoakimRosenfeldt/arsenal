import { basename } from 'node:path';

import { dialog, type BrowserWindow } from 'electron';

import type {
  ImportResult,
  LibraryStatus,
  PageRequest,
  SongPage,
  SongRow,
} from '../shared/dj-library';
import {
  parseRekordboxXml,
  RekordboxXmlError,
} from './parse-rekordbox-xml';

type CurrentCatalog = Readonly<{
  sourceName: string;
  importedAt: string;
  songs: readonly SongRow[];
}>;

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
      const parsed = await parseRekordboxXml(selectedPath);
      const songs = [...parsed].sort(compareSongs);
      const nextCatalog: CurrentCatalog = {
        sourceName: basename(selectedPath),
        importedAt: new Date().toISOString(),
        songs,
      };

      this.catalog = nextCatalog;
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
}
