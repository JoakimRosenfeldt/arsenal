import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';

import { isSupportedAudioPath } from './track-artwork';

export type LibraryFileBackup = Readonly<{ path: string; backupPath: string; expectedHash: string | null; databaseHashes?: readonly string[]; expectedHashes?: readonly string[] }>;
export type LibraryRepairOptions = Readonly<{
  mode?: 'reorganize';
  forceBackup?: boolean;
  onBackup?: (backup: LibraryFileBackup) => Promise<void>;
}>;
export type LibraryFileRepairResult = Readonly<{ backupPaths: string[]; backups: LibraryFileBackup[]; warnings: string[] }>;
export type MissingFileRepair = Readonly<{ missingPath: string; replacementPath: string | null }>;
// Repairs that could not be applied; the rest of the batch is still saved.
export type LibraryFilesRepairResult = LibraryFileRepairResult & Readonly<{ failures: { path: string; message: string }[] }>;

export const libraryFileHash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const currentLibraryFileHash = async (path: string): Promise<string | null> => {
  try { return libraryFileHash(await readFile(path)); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
};

export const databaseContentHash = (query: (sql: string) => Iterable<Record<string, unknown>>): string => {
  const hash = createHash('sha256');
  const encode = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
    // Keep safe integers compatible with hashes saved in earlier recovery journals.
    if (typeof item === 'bigint') return Number.isSafeInteger(Number(item)) ? Number(item) : String(item);
    return item instanceof Uint8Array ? Buffer.from(item).toString('base64') : item;
  });
  const schema = [...query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")];
  hash.update(encode(schema));
  for (const row of schema) {
    if (row.type !== 'table' || typeof row.name !== 'string') continue;
    const rows = [...query(`SELECT * FROM "${row.name.replaceAll('"', '""')}"`)]
      .map((row) => libraryFileHash(Buffer.from(encode(row)))).sort();
    hash.update(encode(rows));
  }
  return hash.digest('hex');
};

export const assertLibraryFileBackup = async (path: string, backupPath: string, expectedHash: string | null = null, expectedHashes: readonly string[] = []): Promise<string | null> => {
  const original = libraryFileHash(await readFile(backupPath));
  const current = await currentLibraryFileHash(path);
  if (current !== null && !expectedHashes.includes(current) && current !== original && (expectedHash === null || current !== expectedHash)) {
    throw new Error(`The library has later or unverified edits. Kept it unchanged. Backup: ${backupPath}`);
  }
  return current;
};

export const restoreLibraryFileBackup = async (path: string, backupPath: string, expectedHash: string | null = null,
  database = false, expectedHashes: readonly string[] = []): Promise<void> => {
  const current = await assertLibraryFileBackup(path, backupPath, expectedHash, expectedHashes);
  const temporary = `${path}.arsenal-${randomUUID()}.restore`;
  try {
    await copyFile(backupPath, temporary);
    const mode = (await stat(backupPath)).mode & 0o777;
    await chmod(temporary, mode | 0o200);
    const file = await open(temporary, 'r+');
    try { await file.chmod(mode); await file.sync(); } finally { await file.close(); }
    if (await currentLibraryFileHash(path) !== current) throw new Error(`The library changed during recovery: ${path}`);
    if (database) {
      await rm(`${path}-wal`, { force: true });
      await rm(`${path}-shm`, { force: true });
    }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
};

export const assertMissingFileRepair = async (missingPath: string, replacementPath: string | null, options: LibraryRepairOptions = {}): Promise<void> => {
  for (const path of [missingPath, replacementPath]) {
    if (path !== null && (path.includes('\0') || !isAbsolute(path) && !win32.isAbsolute(path))) {
      throw new Error('Choose an absolute audio file path.');
    }
  }
  let exists = false;
  try { exists = (await stat(missingPath)).isFile(); } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
  }
  if (exists && options.mode !== 'reorganize') throw new Error(`This location is no longer missing. Scan the library again: ${missingPath}`);
  if (replacementPath !== null && (!isSupportedAudioPath(replacementPath) || !(await stat(replacementPath)).isFile())) {
    throw new Error('Choose an existing, supported audio file.');
  }
};

export const saveRepairedLibraryFiles = async (
  updates: readonly Readonly<{ path: string; before: Buffer; after: Buffer }>[],
  validate: () => Promise<void>, options: LibraryRepairOptions = {},
): Promise<LibraryFileRepairResult> => {
  const suffix = `.arsenal-${Date.now()}-${randomUUID()}`;
  const staged: string[] = [];
  const committed: LibraryFileBackup[] = [];
  const backups: LibraryFileBackup[] = [];
  try {
    for (const update of updates) {
      const temporary = `${update.path}${suffix}.tmp`;
      const file = await open(temporary, 'wx', (await stat(update.path)).mode & 0o777);
      staged.push(temporary);
      try { await file.writeFile(update.after); await file.sync(); } finally { await file.close(); }
    }
    await validate();
    for (const update of updates) {
      if (!(await readFile(update.path)).equals(update.before)) throw new Error('The library changed. Scan it again before repairing files.');
      const backup = { path: update.path, backupPath: `${update.path}${suffix}.bak`, expectedHash: libraryFileHash(update.after) };
      const file = await open(backup.backupPath, 'wx', (await stat(update.path)).mode & 0o777);
      try { await file.writeFile(update.before); await file.sync(); } finally { await file.close(); }
      backups.push(backup);
      await options.onBackup?.(backup);
    }
    await validate();
    for (const [index, update] of updates.entries()) {
      if (!(await readFile(update.path)).equals(update.before)) throw new Error('The library changed during repair.');
      await rename(`${update.path}${suffix}.tmp`, update.path);
      const backup = backups[index];
      if (backup !== undefined) committed.push(backup);
    }
    return { backupPaths: backups.map((backup) => backup.backupPath), backups, warnings: [] };
  } catch (error) {
    const failures: string[] = [];
    for (const backup of committed.reverse()) {
      try { await restoreLibraryFileBackup(backup.path, backup.backupPath, backup.expectedHash); }
      catch (restoreError) { failures.push(restoreError instanceof Error ? restoreError.message : backup.path); }
    }
    if (failures.length) throw new Error(`${error instanceof Error ? error.message : 'Library repair failed.'} Recovery needs attention. ${failures.join(' ')}`);
    throw error;
  } finally {
    await Promise.all(staged.map((path) => rm(path, { force: true })));
  }
};
