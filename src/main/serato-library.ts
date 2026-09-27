import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { SyncLibrary } from './library-sync-model';
import { readSeratoLegacy, writeSeratoLegacy } from './serato-legacy';
import { readSeratoSqlite, writeSeratoSqlite } from './serato-sqlite';

export type SeratoSource = Readonly<{ kind: 'legacy' | 'sqlite'; path: string }>;

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

export const writeSeratoLibrary = async (source: SeratoSource, incoming: SyncLibrary, options: Readonly<{ metadata: boolean }>) => {
  await assertSeratoClosed();
  return source.kind === 'sqlite' ? writeSeratoSqlite(source.path, incoming, options) : writeSeratoLegacy(source.path, incoming, options);
};
