import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { fingerprint } from './portable-library';
import { moveMusicFile, removeOrganizationDirectories } from './reorganize-library';
import { type LibraryFileBackup, restoreLibraryFileBackup } from './repair-library-files';
import { assertRekordboxClosed, isRekordboxDatabasePath, restoreRekordboxDatabaseBackup } from './rekordbox-database-connection';
import { restoreSeratoSqliteBackup } from './serato-sqlite';
import { assertSeratoClosed } from './serato-library';

export type OrganizationRestore = LibraryFileBackup & Readonly<{ kind: 'rekordbox-database' | 'xml' | 'sqlite' | 'legacy' | 'portable' | 'arsenal' }>;
export type OrganizationJournal = {
  moves: { from: string; to: string; temporary: string; sha256: string | null; completed: boolean }[];
  restores: OrganizationRestore[];
  createdDirectories: string[];
};

export const writeOrganizationJournal = async (path: string, journal: OrganizationJournal): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(journal)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temporary, { force: true }); }
};

export const appendOrganizationJournal = async (path: string, update: OrganizationJournal): Promise<void> => {
  const file = await open(path, constants.O_APPEND | constants.O_WRONLY);
  try { await file.writeFile(`${JSON.stringify(update)}\n`); await file.sync(); } finally { await file.close(); }
};

const parseOrganizationJournal = (bytes: string, path: string): OrganizationJournal => {
  const value: unknown = JSON.parse(bytes);
  const invalid = () => new Error(`The reorganization journal is invalid. Keep it for manual recovery: ${path}`);
  if (typeof value !== 'object' || value === null || !('moves' in value) || !Array.isArray(value.moves) ||
      !('restores' in value) || !Array.isArray(value.restores) || !('createdDirectories' in value) || !Array.isArray(value.createdDirectories)) throw invalid();
  const journal: OrganizationJournal = { moves: [], restores: [], createdDirectories: [] };
  const rawMoves: unknown[] = value.moves;
  const rawRestores: unknown[] = value.restores;
  for (const move of rawMoves) {
    if (typeof move !== 'object' || move === null || !('from' in move) || typeof move.from !== 'string' ||
        !('to' in move) || typeof move.to !== 'string' || !('temporary' in move) || typeof move.temporary !== 'string' ||
        !('sha256' in move) || move.sha256 !== null && typeof move.sha256 !== 'string' || !('completed' in move) || typeof move.completed !== 'boolean') throw invalid();
    journal.moves.push({ from: move.from, to: move.to, temporary: move.temporary, sha256: move.sha256, completed: move.completed });
  }
  for (const restore of rawRestores) {
    if (typeof restore !== 'object' || restore === null || !('path' in restore) || typeof restore.path !== 'string' ||
        !('backupPath' in restore) || typeof restore.backupPath !== 'string' || !('expectedHash' in restore) ||
        restore.expectedHash !== null && typeof restore.expectedHash !== 'string' || !('kind' in restore) ||
        restore.kind !== 'rekordbox-database' && restore.kind !== 'xml' && restore.kind !== 'sqlite' && restore.kind !== 'legacy' && restore.kind !== 'portable' && restore.kind !== 'arsenal') throw invalid();
    const expectedHashes = 'expectedHashes' in restore ? restore.expectedHashes : undefined;
    if (expectedHashes !== undefined && (!Array.isArray(expectedHashes) || !expectedHashes.every((hash: unknown) => typeof hash === 'string'))) throw invalid();
    const databaseHashes = 'databaseHashes' in restore ? restore.databaseHashes : undefined;
    if (databaseHashes !== undefined && (!Array.isArray(databaseHashes) || !databaseHashes.every((hash: unknown) => typeof hash === 'string'))) throw invalid();
    journal.restores.push({ ...(Array.isArray(expectedHashes) ? { expectedHashes: expectedHashes.filter((hash): hash is string => typeof hash === 'string') } : {}), ...(Array.isArray(databaseHashes) ? { databaseHashes: databaseHashes.filter((hash): hash is string => typeof hash === 'string') } : {}), path: restore.path, backupPath: restore.backupPath, expectedHash: restore.expectedHash, kind: restore.kind });
  }
  for (const directory of value.createdDirectories) {
    if (typeof directory !== 'string') throw invalid();
    journal.createdDirectories.push(directory);
  }
  return journal;
};

export const readOrganizationJournal = async (path: string): Promise<OrganizationJournal | null> => {
  let bytes: string;
  try { bytes = await readFile(path, 'utf8'); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const lines = bytes.split('\n');
  // An interrupted append can leave one incomplete record at the end.
  lines.pop();
  if (!lines.length) throw new Error(`The recovery journal is incomplete: ${path}`);
  const moves = new Map<string, OrganizationJournal['moves'][number]>();
  const restores = new Map<string, OrganizationRestore>();
  const createdDirectories = new Set<string>();
  for (const line of lines) {
    const update = parseOrganizationJournal(line, path);
    for (const move of update.moves) moves.set(move.from, move);
    for (const restore of update.restores) restores.set(restore.path, restore);
    for (const directory of update.createdDirectories) createdDirectories.add(directory);
  }
  return { moves: [...moves.values()], restores: [...restores.values()], createdDirectories: [...createdDirectories] };
};

export const undoOrganization = async (journal: OrganizationJournal, progress: (completed: number, total: number) => void = () => undefined): Promise<void> => {
  const failures: string[] = [];
  let completed = 0;
  const total = journal.restores.length + journal.moves.length;
  for (const restore of [...journal.restores].reverse()) {
    try {
      if (restore.kind === 'rekordbox-database' && isRekordboxDatabasePath(restore.path)) await restoreRekordboxDatabaseBackup(restore);
      else if (restore.kind === 'sqlite') await restoreSeratoSqliteBackup(restore);
      else {
        if (restore.kind === 'legacy') await assertSeratoClosed();
        if (restore.kind === 'rekordbox-database') await assertRekordboxClosed();
        if (restore.kind === 'xml') { await assertRekordboxClosed(); await assertSeratoClosed(); }
        await restoreLibraryFileBackup(restore.path, restore.backupPath, restore.expectedHash, false, restore.expectedHashes);
      }
    } catch (error) { failures.push(`${restore.path}: ${error instanceof Error ? error.message : 'Could not restore backup.'}`); }
    progress(++completed, total);
  }
  if (failures.length) throw new Error(`Library recovery is incomplete. Audio remains at the planned locations. ${failures.join(' ')}`);
  const hash = async (path: string): Promise<string | null> => {
    try { return (await fingerprint(path)).sha256; } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const exactName = async (path: string): Promise<boolean> => {
    try { return (await readdir(dirname(path))).includes(basename(path)); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  };
  for (const move of [...journal.moves].reverse()) {
    try {
      if (move.sha256 !== null) {
        const sourceHash = await hash(move.from);
        const destinationHash = await hash(move.to);
        const temporaryHash = await hash(move.temporary);
        if (sourceHash === move.sha256 && await exactName(move.from)) {
          if (destinationHash === move.sha256 && move.from !== move.to && await exactName(move.to)) {
            if (!move.completed) throw new Error(`Both paths exist after an interrupted move. Kept both: ${move.from}, ${move.to}`);
            await rm(move.to);
          }
          else if (destinationHash !== null && destinationHash !== move.sha256) throw new Error(`Destination changed; kept it: ${move.to}`);
        } else {
          const source = destinationHash === move.sha256 ? move.to : temporaryHash === move.sha256 ? move.temporary : null;
          if (source === null || sourceHash !== null && sourceHash !== move.sha256) throw new Error('The audio file changed or is unavailable. Restore it manually.');
          if (source === move.to && temporaryHash === move.sha256) await rm(move.temporary);
          await moveMusicFile(source, move.from, move.temporary);
        }
        if (await hash(move.temporary) === move.sha256) await rm(move.temporary);
      }
    } catch (error) { failures.push(`${move.to} -> ${move.from}: ${error instanceof Error ? error.message : 'Could not restore audio.'}`); }
    progress(++completed, total);
  }
  await removeOrganizationDirectories(journal.createdDirectories);
  if (failures.length) throw new Error(`Audio recovery needs attention. ${failures.join(' ')}`);
};
