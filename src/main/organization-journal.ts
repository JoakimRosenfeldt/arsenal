import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { fingerprint } from './portable-library';
import { installMusicFile, moveMusicFile, organizationFileStamp, removeOrganizationDirectories, syncOrganizationDirectory, unlinkMusicFile } from './reorganize-library';
import { assertLibraryFileBackup, type LibraryFileBackup, restoreLibraryFileBackup } from './repair-library-files';
import { assertRekordboxClosed, assertRekordboxDatabaseBackup, isRekordboxDatabasePath, restoreRekordboxDatabaseBackup, RekordboxRunningError } from './rekordbox-database-connection';
import { assertSeratoSqliteBackup, restoreSeratoSqliteBackup } from './serato-sqlite';
import { assertSeratoClosed } from './serato-library';

export type OrganizationRestore = LibraryFileBackup & Readonly<{ kind: 'rekordbox-database' | 'xml' | 'sqlite' | 'legacy' | 'portable' | 'arsenal' }>;
export type OrganizationJournal = {
  moves: { from: string; to: string; temporary: string; sha256: string | null; stamp: string | null; destinationStamp: string | null; rollbackStamp: string | null; completed: boolean }[];
  restores: OrganizationRestore[];
  createdDirectories: string[];
  replacements?: readonly (readonly [string, string])[];
};

export const writeOrganizationJournal = async (path: string, journal: OrganizationJournal): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(journal)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    await syncOrganizationDirectory(dirname(path));
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
    const optionalStamp = (value: unknown): string | null => {
      if (value === undefined || value === null) return null;
      if (typeof value === 'string') return value;
      throw invalid();
    };
    journal.moves.push({ stamp: optionalStamp('stamp' in move ? move.stamp : null),
      destinationStamp: optionalStamp('destinationStamp' in move ? move.destinationStamp : null),
      rollbackStamp: optionalStamp('rollbackStamp' in move ? move.rollbackStamp : null), from: move.from, to: move.to, temporary: move.temporary, sha256: move.sha256, completed: move.completed });
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
  if ('replacements' in value) {
    if (!Array.isArray(value.replacements)) throw invalid();
    const replacements: [string, string][] = [];
    for (const pair of value.replacements) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') throw invalid();
      replacements.push([pair[0], pair[1]]);
    }
    journal.replacements = replacements;
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
  let replacements: OrganizationJournal['replacements'];
  for (const line of lines) {
    const update = parseOrganizationJournal(line, path);
    replacements = update.replacements ?? replacements;
    for (const move of update.moves) moves.set(move.from, move);
    for (const restore of update.restores) restores.set(restore.path, restore);
    for (const directory of update.createdDirectories) createdDirectories.add(directory);
  }
  return { ...(replacements === undefined ? {} : { replacements }), moves: [...moves.values()], restores: [...restores.values()], createdDirectories: [...createdDirectories] };
};

const exactStamp = async (path: string, exact: boolean): Promise<string | null> => {
  try {
    if (exact && !(await readdir(dirname(path))).includes(basename(path))) return null;
    return await organizationFileStamp(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
};

const sameInode = (left: string | null, right: string | null): boolean =>
  left !== null && right !== null && left.split(':').slice(0, 2).join(':') === right.split(':').slice(0, 2).join(':');

export const organizationMoveState = async (move: OrganizationJournal['moves'][number]) => {
  const matches = async (path: string, stamp: string | null): Promise<boolean> => stamp !== null &&
    (stamp === move.stamp || move.sha256 !== null && (await fingerprint(path)).sha256 === move.sha256);
  const caseOnly = move.from.normalize('NFC').toLowerCase() === move.to.normalize('NFC').toLowerCase();
  const fromStamp = await exactStamp(move.from, caseOnly);
  const toStamp = await exactStamp(move.to, caseOnly);
  const temporaryStamp = await exactStamp(move.temporary, false);
  const alias = caseOnly && fromStamp === null && toStamp !== null && await exactStamp(move.from, false) === toStamp;
  const from = move.stamp === null && move.sha256 === null ? fromStamp !== null : await matches(move.from, fromStamp);
  const to = await matches(move.to, toStamp);
  const temporary = await matches(move.temporary, temporaryStamp);
  if (fromStamp !== null && !from && !sameInode(fromStamp, move.rollbackStamp)) throw new Error(`The original audio changed: ${move.from}`);
  const destinationOwned = to || !move.completed && sameInode(toStamp, move.destinationStamp) && (from || temporary);
  if (toStamp !== null && !to && (move.completed || !from && !temporary)) throw new Error(`The destination changed: ${move.to}`);
  if (!from && !to && !temporary && (move.stamp !== null || move.sha256 !== null)) throw new Error(`The audio is unavailable: ${move.from}, ${move.to}`);
  return { from, to, temporary, alias, destinationOwned, fromStamp, toStamp, temporaryStamp };
};

export const undoOrganization = async (journal: OrganizationJournal, progress: (completed: number, total: number) => void = () => undefined,
  persistMove: (move: OrganizationJournal['moves'][number]) => Promise<void> = async () => undefined): Promise<string[]> => {
  await assertRekordboxClosed();
  await assertSeratoClosed();
  const restores = [...journal.restores].reverse();
  for (const restore of restores) {
    if (restore.kind === 'rekordbox-database' && isRekordboxDatabasePath(restore.path)) await assertRekordboxDatabaseBackup(restore);
    else if (restore.kind === 'sqlite') await assertSeratoSqliteBackup(restore);
    else await assertLibraryFileBackup(restore.path, restore.backupPath, restore.expectedHash, restore.expectedHashes);
  }
  for (const move of journal.moves) await organizationMoveState(move);
  // Keep the new audio paths until every library has been restored successfully.
  for (const move of [...journal.moves].reverse()) {
    const state = await organizationMoveState(move);
    if (state.from || state.alias || move.stamp === null && move.sha256 === null) continue;
    if (state.fromStamp !== null) await unlinkMusicFile(move.from);
    const source = state.to ? move.to : move.temporary;
    const temporary = join(dirname(move.from), `${basename(move.temporary)}.undo`);
    await rm(temporary, { force: true });
    try {
      await installMusicFile(source, move.from, temporary, { onCopy: async (sha256) => {
        move.sha256 = sha256;
        await persistMove(move);
      }, onDestination: async (stamp) => {
        move.rollbackStamp = stamp;
        await persistMove(move);
      } });
    } catch (error) {
      throw new Error(`Could not make the original audio available at ${move.from}. Audio is kept at ${source}; no library backups were restored. ${error instanceof Error ? error.message : ''}`);
    }
  }
  const warnings: string[] = [];
  let completed = 0;
  const total = restores.length + journal.moves.length;
  for (const restore of restores) {
    try {
      if (restore.kind === 'rekordbox-database' && isRekordboxDatabasePath(restore.path)) await restoreRekordboxDatabaseBackup(restore);
      else if (restore.kind === 'sqlite') await restoreSeratoSqliteBackup(restore);
      else await restoreLibraryFileBackup(restore.path, restore.backupPath, restore.expectedHash, false, restore.expectedHashes);
    } catch (error) {
      throw new Error(`Could not restore ${restore.path}. Audio is available at both original and current locations; the journal is kept for retry. ${error instanceof RekordboxRunningError ? 'Close Rekordbox and try again.' : error instanceof Error ? error.message : ''}`);
    }
    progress(++completed, total);
  }
  for (const move of [...journal.moves].reverse()) {
    let state = await organizationMoveState(move);
    if (state.alias) {
      if (state.temporaryStamp !== null) await unlinkMusicFile(move.temporary);
      await rm(`${move.temporary}.copy`, { force: true });
      await moveMusicFile(move.to, move.from, move.temporary, {
        onCopy: async (sha256) => { move.sha256 = sha256; await persistMove(move); },
        onDestination: async (stamp) => { move.rollbackStamp = stamp; await persistMove(move); },
      });
      state = await organizationMoveState(move);
    }
    if (!state.from && (move.stamp !== null || move.sha256 !== null)) throw new Error(`The original audio is unavailable: ${move.from}`);
    if (state.toStamp !== null && move.to !== move.from) {
      if (state.destinationOwned) await unlinkMusicFile(move.to);
      else warnings.push(`Kept an unverified file at the interrupted destination: ${move.to}`);
    }
    if (state.temporaryStamp !== null) await unlinkMusicFile(move.temporary);
    await rm(`${move.temporary}.copy`, { force: true });
    await rm(join(dirname(move.from), `${basename(move.temporary)}.undo`), { force: true });
    progress(++completed, total);
  }
  await removeOrganizationDirectories(journal.createdDirectories);
  return warnings;
};
