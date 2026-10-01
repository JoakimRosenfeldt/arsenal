import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';

import { isSupportedAudioPath } from './track-artwork';

export type LibraryFileRepairResult = Readonly<{ backupPaths: string[]; warnings: string[] }>;
export type MissingFileRepair = Readonly<{ missingPath: string; replacementPath: string | null }>;
// Repairs that could not be applied; the rest of the batch is still saved.
export type LibraryFilesRepairResult = LibraryFileRepairResult & Readonly<{ failures: { path: string; message: string }[] }>;

export const assertMissingFileRepair = async (missingPath: string, replacementPath: string | null): Promise<void> => {
  for (const path of [missingPath, replacementPath]) {
    if (path !== null && (path.includes('\0') || !isAbsolute(path) && !win32.isAbsolute(path))) {
      throw new Error('Choose an absolute audio file path.');
    }
  }
  let exists = false;
  try { exists = (await stat(missingPath)).isFile(); } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
  }
  if (exists) throw new Error(`This location is no longer missing. Scan the library again: ${missingPath}`);
  if (replacementPath !== null && (!isSupportedAudioPath(replacementPath) || !(await stat(replacementPath)).isFile())) {
    throw new Error('Choose an existing, supported audio file.');
  }
};

export const saveRepairedLibraryFiles = async (
  updates: readonly Readonly<{ path: string; before: Buffer; after: Buffer }>[],
  validate: () => Promise<void>,
): Promise<LibraryFileRepairResult> => {
  const suffix = `.arsenal-${Date.now()}-${randomUUID()}`;
  const staged: string[] = [];
  const committed: typeof updates[number][] = [];
  const backupPaths: string[] = [];
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
      const backupPath = `${update.path}${suffix}.bak`;
      await writeFile(backupPath, update.before, { flag: 'wx' });
      backupPaths.push(backupPath);
    }
    await validate();
    for (const update of updates) {
      if (!(await readFile(update.path)).equals(update.before)) throw new Error('The library changed during repair.');
      await rename(`${update.path}${suffix}.tmp`, update.path);
      committed.push(update);
    }
    return { backupPaths, warnings: [] };
  } catch (error) {
    for (const update of committed.reverse()) {
      const temporary = `${update.path}${suffix}.restore`;
      await writeFile(temporary, update.before, { flag: 'wx', mode: (await stat(update.path)).mode & 0o777 });
      await rename(temporary, update.path);
    }
    throw error;
  } finally {
    await Promise.all(staged.map((path) => rm(path, { force: true })));
  }
};
