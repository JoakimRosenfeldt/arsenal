import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { readOrganizationOperation, type LibraryOrganizationOperation, type LibraryOrganizationRequest, type LibraryOrganizationSettings } from '../shared/dj-library';
import { fingerprint, readLibraryModel } from './portable-library';
import type { SyncLibrary } from './library-sync-model';
import { canonicalOrganizationPath, installMusicFile, moveMusicFile, organizationFileStamp, readOrganizationRequest, sameOrganizationFile, removeOrganizationDirectories, syncOrganizationDirectory, unlinkMusicFile } from './reorganize-library';
import { assertLibraryFileBackup, type LibraryFileBackup, restoreLibraryFileBackup } from './repair-library-files';
import { assertRekordboxClosed, assertRekordboxDatabaseBackup, isRekordboxDatabasePath, openRekordboxDatabase, restoreRekordboxDatabaseBackup, RekordboxRunningError } from './rekordbox-database-connection';
import { assertSeratoSqliteBackup, recoverSeratoSqlite, restoreSeratoSqliteBackup } from './serato-sqlite';
import { assertSeratoClosed } from './serato-library';

export type OrganizationRestore = LibraryFileBackup & Readonly<{ kind: 'rekordbox-database' | 'xml' | 'sqlite' | 'legacy' | 'portable' | 'arsenal'; libraryKind?: 'rekordbox' | 'serato' }>;
export type OrganizationJournal = {
  operation?: LibraryOrganizationOperation;
  request?: LibraryOrganizationRequest;
  previousOrganization?: LibraryOrganizationSettings;
  additions?: SyncLibrary;
  moves: { installed?: boolean; rollbackInstalled?: boolean; from: string; to: string; temporary: string; sha256: string | null; stamp: string | null; destinationStamp: string | null; rollbackStamp: string | null; completed: boolean }[];
  restores: OrganizationRestore[];
  createdDirectories: string[];
  preserveDestinations?: boolean;
  acceptedConnections?: readonly string[];
  targets?: readonly Readonly<{ path: string; paths: readonly string[]; manifestHash?: string }>[];
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
  if ('operation' in value) journal.operation = readOrganizationOperation(value.operation);
  if ('request' in value) journal.request = readOrganizationRequest(value.request);
  if ('previousOrganization' in value) {
    const previous = value.previousOrganization;
    if (typeof previous !== 'object' || previous === null || !('draft' in previous) || !('applied' in previous)) throw invalid();
    journal.previousOrganization = { draft: previous.draft === null ? null : readOrganizationRequest(previous.draft),
      applied: previous.applied === null ? null : readOrganizationRequest(previous.applied) };
  }
  if ('additions' in value) journal.additions = readLibraryModel(value.additions);
  if ('preserveDestinations' in value) {
    if (typeof value.preserveDestinations !== 'boolean') throw invalid();
    journal.preserveDestinations = value.preserveDestinations;
  }
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
    if ('installed' in move && typeof move.installed !== 'boolean' || 'rollbackInstalled' in move && typeof move.rollbackInstalled !== 'boolean') throw invalid();
    journal.moves.push({ ...('rollbackInstalled' in move && typeof move.rollbackInstalled === 'boolean' ? { rollbackInstalled: move.rollbackInstalled } : {}), ...('installed' in move && typeof move.installed === 'boolean' ? { installed: move.installed } : {}), stamp: optionalStamp('stamp' in move ? move.stamp : null),
      destinationStamp: optionalStamp('destinationStamp' in move ? move.destinationStamp : null),
      rollbackStamp: optionalStamp('rollbackStamp' in move ? move.rollbackStamp : null), from: move.from, to: move.to, temporary: move.temporary, sha256: move.sha256, completed: move.completed });
  }
  for (const restore of rawRestores) {
    if (typeof restore !== 'object' || restore === null || !('path' in restore) || typeof restore.path !== 'string' ||
        !('backupPath' in restore) || typeof restore.backupPath !== 'string' || !('expectedHash' in restore) ||
        restore.expectedHash !== null && typeof restore.expectedHash !== 'string' || !('kind' in restore) ||
        restore.kind !== 'rekordbox-database' && restore.kind !== 'xml' && restore.kind !== 'sqlite' && restore.kind !== 'legacy' && restore.kind !== 'portable' && restore.kind !== 'arsenal') throw invalid();
    if ('libraryKind' in restore && restore.libraryKind !== 'rekordbox' && restore.libraryKind !== 'serato') throw invalid();
    const libraryKind = 'libraryKind' in restore && (restore.libraryKind === 'rekordbox' || restore.libraryKind === 'serato') ? restore.libraryKind : undefined;
    const expectedHashes = 'expectedHashes' in restore ? restore.expectedHashes : undefined;
    if (expectedHashes !== undefined && (!Array.isArray(expectedHashes) || !expectedHashes.every((hash: unknown) => typeof hash === 'string'))) throw invalid();
    const databaseHashes = 'databaseHashes' in restore ? restore.databaseHashes : undefined;
    if (databaseHashes !== undefined && (!Array.isArray(databaseHashes) || !databaseHashes.every((hash: unknown) => typeof hash === 'string'))) throw invalid();
    journal.restores.push({ ...(libraryKind === undefined ? {} : { libraryKind }), ...(Array.isArray(expectedHashes) ? { expectedHashes: expectedHashes.filter((hash): hash is string => typeof hash === 'string') } : {}), ...(Array.isArray(databaseHashes) ? { databaseHashes: databaseHashes.filter((hash): hash is string => typeof hash === 'string') } : {}), path: restore.path, backupPath: restore.backupPath, expectedHash: restore.expectedHash, kind: restore.kind });
  }
  for (const directory of value.createdDirectories) {
    if (typeof directory !== 'string') throw invalid();
    journal.createdDirectories.push(directory);
  }
  if ('acceptedConnections' in value) {
    if (!Array.isArray(value.acceptedConnections) || !value.acceptedConnections.every((id: unknown) => typeof id === 'string')) throw invalid();
    journal.acceptedConnections = value.acceptedConnections.filter((id): id is string => typeof id === 'string');
  }
  if ('targets' in value) {
    if (!Array.isArray(value.targets)) throw invalid();
    const targets: NonNullable<OrganizationJournal['targets']>[number][] = [];
    const rawTargets: unknown[] = value.targets;
    for (const target of rawTargets) {
      if (typeof target !== 'object' || target === null || !('path' in target) || typeof target.path !== 'string' ||
          !('paths' in target) || !Array.isArray(target.paths) || !target.paths.every((path: unknown) => typeof path === 'string')) throw invalid();
      if ('manifestHash' in target && typeof target.manifestHash !== 'string') throw invalid();
      targets.push({ path: target.path, paths: target.paths.filter((path: unknown): path is string => typeof path === 'string'),
        ...('manifestHash' in target && typeof target.manifestHash === 'string' ? { manifestHash: target.manifestHash } : {}) });
    }
    journal.targets = targets;
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
  const tail = lines.pop();
  if (!lines.length) throw new Error(`The recovery journal is incomplete: ${path}`);
  const moves = new Map<string, OrganizationJournal['moves'][number]>();
  const restores = new Map<string, OrganizationRestore>();
  const createdDirectories = new Set<string>();
  let replacements: OrganizationJournal['replacements'];
  let acceptedConnections: OrganizationJournal['acceptedConnections'];
  let targets: OrganizationJournal['targets'];
  let preserveDestinations: OrganizationJournal['preserveDestinations'];
  let operation: OrganizationJournal['operation'];
  let request: OrganizationJournal['request'];
  let previousOrganization: OrganizationJournal['previousOrganization'];
  let additions: OrganizationJournal['additions'];
  for (const line of lines) {
    const update = parseOrganizationJournal(line, path);
    replacements = update.replacements ?? replacements;
    acceptedConnections = update.acceptedConnections ?? acceptedConnections;
    targets = update.targets ?? targets;
    preserveDestinations = update.preserveDestinations ?? preserveDestinations;
    operation = update.operation ?? operation;
    request = update.request ?? request;
    previousOrganization = update.previousOrganization ?? previousOrganization;
    additions = update.additions ?? additions;
    for (const move of update.moves) moves.set(move.from, move);
    for (const restore of update.restores) restores.set(restore.path, restore);
    for (const directory of update.createdDirectories) createdDirectories.add(directory);
  }
  const journal = { ...(previousOrganization === undefined ? {} : { previousOrganization }), ...(request === undefined ? {} : { request }), ...(additions === undefined ? {} : { additions }), ...(operation === undefined ? {} : { operation }), ...(preserveDestinations === undefined ? {} : { preserveDestinations }), ...(acceptedConnections === undefined ? {} : { acceptedConnections }), ...(targets === undefined ? {} : { targets }), ...(replacements === undefined ? {} : { replacements }), moves: [...moves.values()], restores: [...restores.values()], createdDirectories: [...createdDirectories] };
  if (tail) await writeOrganizationJournal(path, journal);
  return journal;
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

const sameFileStamp = (left: string | null, right: string | null): boolean => {
  if (left === null || right === null) return false;
  const [device, inode] = left.split(':');
  return left === right || device !== '0' && inode !== '0' && left.split(':').slice(0, 2).join(':') === right.split(':').slice(0, 2).join(':');
};

const incompleteCopyMatches = async (source: string, copy: string, stamp: string | null): Promise<boolean> => {
  if (stamp === null || !stamp.split(':').slice(0, 2).includes('0')) return false;
  const sourceStamp = await organizationFileStamp(source);
  const copyStamp = await organizationFileStamp(copy);
  const size = (await stat(copy)).size;
  if (!Number.isSafeInteger(size) || size > (await stat(source)).size) return false;
  const hash = createHash('sha256');
  if (size > 0) for await (const bytes of createReadStream(source, { end: size - 1 })) hash.update(bytes);
  return hash.digest('hex') === (await fingerprint(copy)).sha256 &&
    sourceStamp === await organizationFileStamp(source) && copyStamp === await organizationFileStamp(copy);
};

export const organizationMoveState = async (move: OrganizationJournal['moves'][number], independentCopy = false) => {
  const matches = async (path: string, stamp: string | null): Promise<boolean> => stamp !== null &&
    (sameFileStamp(stamp, move.stamp) || move.rollbackInstalled && sameFileStamp(stamp, move.rollbackStamp) ||
      move.sha256 !== null && (await fingerprint(path)).sha256 === move.sha256);
  const caseOnly = (await canonicalOrganizationPath(move.from)).normalize('NFC').toLowerCase() ===
    (await canonicalOrganizationPath(move.to)).normalize('NFC').toLowerCase();
  const fromStamp = await exactStamp(move.from, caseOnly);
  const toStamp = await exactStamp(move.to, caseOnly);
  const temporaryStamp = await exactStamp(move.temporary, false);
  const from = independentCopy || move.stamp === null && move.sha256 === null ? fromStamp !== null : await matches(move.from, fromStamp);
  const to = toStamp !== null && (move.installed ?? move.completed) && sameFileStamp(toStamp, move.destinationStamp) ||
    await matches(move.to, toStamp) || toStamp !== null && move.sha256 !== null && fromStamp === null && temporaryStamp === null;
  const alias = to && fromStamp === null && await sameOrganizationFile(move.from, move.to);
  const temporary = await matches(move.temporary, temporaryStamp);
  const rollbackOwned = sameFileStamp(fromStamp, move.rollbackStamp) || fromStamp !== null && move.rollbackInstalled === false && to &&
    await incompleteCopyMatches(move.to, move.from, move.rollbackStamp);
  if (fromStamp !== null && !from && !rollbackOwned) throw new Error(`The original audio changed: ${move.from}`);
  const destinationOwned = to || toStamp !== null && (from || temporary) &&
    (sameFileStamp(toStamp, move.destinationStamp) || move.installed === false &&
      await incompleteCopyMatches(from ? move.from : move.temporary, move.to, move.destinationStamp));
  if (toStamp !== null && !destinationOwned && (!from || move.destinationStamp !== null || move.installed !== undefined || move.completed)) {
    throw new Error(`The destination changed: ${move.to}`);
  }
  if (!from && !to && !temporary && (move.stamp !== null || move.sha256 !== null)) throw new Error(`The audio is unavailable: ${move.from}, ${move.to}`);
  const copies = [from && !independentCopy ? move.from : null, to ? move.to : null, temporary ? move.temporary : null].filter((path) => path !== null);
  const first = copies[0];
  if (first !== undefined) for (const path of copies.slice(1)) {
    if (!await sameOrganizationFile(first, path) && (await fingerprint(first)).sha256 !== (await fingerprint(path)).sha256) {
      throw new Error(`The audio copies differ. Kept both files unchanged: ${first}, ${path}`);
    }
  }
  return { from, to, temporary, alias, destinationOwned, fromStamp, toStamp, temporaryStamp };
};

export const clearIncompleteOrganizationDestination = async (move: OrganizationJournal['moves'][number]): Promise<void> => {
  const state = await organizationMoveState(move);
  if (!state.to && state.destinationOwned && state.toStamp !== null && await sameOrganizationFile(move.from, move.to)) {
    await rename(move.to, `${move.temporary}.copy`);
    await syncOrganizationDirectory(dirname(move.to));
    await unlinkMusicFile(`${move.temporary}.copy`);
  }
};

export const prepareOrganizationRecovery = async (journal: OrganizationJournal): Promise<void> => {
  if (journal.restores.some((restore) => restore.kind === 'rekordbox-database' || restore.kind === 'xml' && restore.libraryKind !== 'serato')) await assertRekordboxClosed();
  if (journal.restores.some((restore) => restore.kind === 'sqlite' || restore.kind === 'legacy' || restore.kind === 'xml' && restore.libraryKind !== 'rekordbox')) await assertSeratoClosed();
  for (const restore of journal.restores) {
    if (restore.kind !== 'sqlite' && (restore.kind !== 'rekordbox-database' || !isRekordboxDatabasePath(restore.path))) continue;
    try { await stat(restore.path); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (restore.kind === 'sqlite') await recoverSeratoSqlite(restore.path);
    else {
      const db = await openRekordboxDatabase(restore.path, { readonly: false });
      db.close();
    }
  }
};

export const assertOrganizationRestore = async (restore: OrganizationRestore): Promise<void> => {
  if (restore.kind === 'rekordbox-database' && isRekordboxDatabasePath(restore.path)) await assertRekordboxDatabaseBackup(restore);
  else if (restore.kind === 'sqlite') await assertSeratoSqliteBackup(restore);
  else await assertLibraryFileBackup(restore.path, restore.backupPath, restore.expectedHash, restore.expectedHashes);
};

export const undoOrganization = async (journal: OrganizationJournal, progress: (completed: number, total: number) => void = () => undefined,
  persistMove: (move: OrganizationJournal['moves'][number]) => Promise<void> = async () => undefined): Promise<string[]> => {
  await prepareOrganizationRecovery(journal);
  const restores = [...journal.restores].reverse();
  for (const restore of restores) await assertOrganizationRestore(restore);
  for (const move of journal.moves) await organizationMoveState(move);
  // Keep the new audio paths until every library has been restored successfully.
  for (const move of [...journal.moves].reverse()) {
    await clearIncompleteOrganizationDestination(move);
    const state = await organizationMoveState(move);
    if (journal.operation?.kind === 'copy' && !state.from) throw new Error(`The original audio is unavailable. Copies were kept: ${move.from}`);
    if (state.from || state.alias || move.stamp === null && move.sha256 === null) continue;
    const source = state.to ? move.to : move.temporary;
    try {
      if (state.fromStamp !== null && !await sameOrganizationFile(move.from, source)) await unlinkMusicFile(move.from);
      await installMusicFile(source, move.from, { onCopy: async (sha256) => {
        move.sha256 = sha256;
        await persistMove(move);
      }, onDestination: async (stamp, installed) => {
        move.rollbackInstalled = installed;
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
    if (journal.operation?.kind !== 'copy' && (!journal.preserveDestinations || !state.from) && (state.alias || state.toStamp !== null && await sameOrganizationFile(move.from, move.to))) {
      if (state.temporaryStamp !== null) await unlinkMusicFile(move.temporary);
      await rm(`${move.temporary}.copy`, { force: true });
      await moveMusicFile(move.to, move.from, move.temporary, {
        onCopy: async (sha256) => { move.sha256 = sha256; await persistMove(move); },
        onDestination: async (stamp, installed) => { move.rollbackInstalled = installed; move.rollbackStamp = stamp; await persistMove(move); },
      });
      state = await organizationMoveState(move);
    }
    if (!state.from && (move.stamp !== null || move.sha256 !== null)) throw new Error(`The original audio is unavailable: ${move.from}`);
    if (state.toStamp !== null && move.to !== move.from && !await sameOrganizationFile(move.from, move.to)) {
      if (journal.preserveDestinations) warnings.push(`Kept audio at ${move.to} because restored libraries may reference it.`);
      else if (state.destinationOwned) await unlinkMusicFile(move.to);
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
