import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PlaylistNodeMove, SyncLibrary } from './library-sync-model';
import { moveSeratoLegacyNode, readSeratoLegacy, repairSeratoLegacyMissingFile, writeSeratoLegacy } from './serato-legacy';
import { moveSeratoSqliteNode, readSeratoSqlite, repairSeratoSqliteMissingFile, writeSeratoSqlite } from './serato-sqlite';

export type SeratoSource = Readonly<{ kind: 'legacy' | 'sqlite'; path: string }>;

export type SeratoLibraryWriteOptions = Readonly<{
  metadata: boolean;
  replaceTracks?: boolean;
  replacePlaylists?: boolean;
  removeTrackPaths?: readonly string[];
  removePlaylistTrackPaths?: readonly string[];
  replacePlaylistPaths?: readonly (readonly string[])[];
  removePlaylistPaths?: readonly (readonly string[])[];
}>;

const isFile = async (path: string): Promise<boolean> => {
  try { return (await stat(path)).isFile(); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

export const findSeratoSource = async (selected: string): Promise<SeratoSource> => {
  const file = await stat(selected);
  const directory = file.isDirectory() ? selected : dirname(selected);
  const sqliteFiles = ['root.sqlite', 'location.sqlite', 'Library/root.sqlite', 'Library/location.sqlite'];
  for (const name of sqliteFiles) {
    const path = join(directory, name);
    if (await isFile(path)) return { kind: 'sqlite', path };
  }
  if (resolve(directory) === join(homedir(), 'Music', '_Serato_')) {
    const modern = process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Serato', 'Library', 'root.sqlite')
      : join(homedir(), 'Library', 'Application Support', 'Serato', 'Library', 'root.sqlite');
    if (await isFile(modern)) return { kind: 'sqlite', path: modern };
  }
  if (await isFile(join(directory, 'database V2'))) return { kind: 'legacy', path: directory };
  if (file.isFile() && basename(selected).toLowerCase() === 'database v2') return { kind: 'legacy', path: directory };
  throw new Error('Choose a Serato Library folder containing root.sqlite or location.sqlite, or an _Serato_ folder containing database V2.');
};

export const assertSeratoClosed = async (): Promise<void> => {
  const execute = promisify(execFile);
  const result = process.platform === 'win32'
    ? await execute('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
    : await execute('ps', ['-A', '-o', 'comm='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  if (/serato\s*(dj|studio|itch|scratch)/i.test(result.stdout)) throw new Error('Close Serato before syncing its library or audio tags.');
};

export const readSeratoLibrary = (source: SeratoSource): Promise<SyncLibrary> =>
  source.kind === 'sqlite' ? readSeratoSqlite(source.path) : readSeratoLegacy(source.path);

export const moveSeratoNode = async (source: SeratoSource, move: PlaylistNodeMove): Promise<void> => {
  await assertSeratoClosed();
  if (source.kind === 'sqlite') await moveSeratoSqliteNode(source.path, move);
  else await moveSeratoLegacyNode(source.path, move);
};

export const repairSeratoMissingFile = (source: SeratoSource, missingPath: string, replacementPath: string | null) =>
  source.kind === 'sqlite' ? repairSeratoSqliteMissingFile(source.path, missingPath, replacementPath)
    : repairSeratoLegacyMissingFile(source.path, missingPath, replacementPath, assertSeratoClosed);

export const writeSeratoLibrary = async (source: SeratoSource, incoming: SyncLibrary, options: SeratoLibraryWriteOptions) => {
  await assertSeratoClosed();
  if (source.kind === 'sqlite') return writeSeratoSqlite(source.path, incoming, options);
  return { ...await writeSeratoLegacy(source.path, incoming, options), warnings: [] };
};
