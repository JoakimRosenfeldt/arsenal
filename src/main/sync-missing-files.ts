import { opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';

import type { LibrarySourceKind, SyncMissingFile } from '../shared/dj-library';
import { normalizePath, type SyncLibrary } from './library-sync-model';
import { seratoMediaPathKey } from './serato-paths';

export const findMissingSyncFiles = async (libraries: readonly Readonly<{
  kind: LibrarySourceKind; library: SyncLibrary;
}>[]): Promise<SyncMissingFile[]> => {
  const candidates = new Map<string, SyncMissingFile>();
  for (const { kind, library } of libraries) {
    for (const track of library.tracks) {
      if (track.song.source !== 'local') continue;
      const key = normalizePath(track.path);
      const previous = candidates.get(key);
      candidates.set(key, previous ? { ...previous, libraries: [...new Set([...previous.libraries, kind])] }
        : { path: track.path, title: track.song.title, artist: track.song.artist ?? '', libraries: [kind], candidates: [] });
    }
  }
  const allFiles = [...candidates.values()];
  const missing: SyncMissingFile[] = [];
  for (let offset = 0; offset < allFiles.length; offset += 32) {
    const checked = await Promise.all(allFiles.slice(offset, offset + 32).map(async (file) => {
      try {
        if ((await stat(file.path)).isFile()) return null;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
      }
      return file;
    }));
    missing.push(...checked.filter((file) => file !== null));
  }
  return missing;
};

export const automaticSyncSearchRoots = (libraries: readonly SyncLibrary[], libraryPaths: readonly string[]): string[] => {
  const roots = new Set([join(homedir(), 'Music'), ...libraryPaths.map(dirname)]);
  for (const library of libraries) for (const track of library.tracks) {
    if (track.song.source === 'local') {
      roots.add(dirname(track.path));
      roots.add(dirname(dirname(track.path)));
    }
  }
  return [...roots].filter((path) => {
    const absolute = resolve(path);
    return absolute !== parse(absolute).root && absolute !== homedir() && absolute !== dirname(homedir()) && absolute !== '/System' && absolute !== '/Volumes';
  });
};

export const searchSyncMissingFiles = async (files: readonly SyncMissingFile[], roots: readonly string[]) => {
  const byName = new Map<string, SyncMissingFile[]>();
  const nameKey = (name: string): string => name.normalize('NFC').toLocaleLowerCase('en-US');
  for (const file of files) {
    const key = nameKey(basename(file.path));
    byName.set(key, [...byName.get(key) ?? [], file]);
  }
  const candidates = new Map(files.map((file) => [file.path, [...file.candidates]]));
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  const queue = [...new Set(roots)].sort((left, right) => left.length - right.length);
  const warnings: string[] = [];
  let visited = 0;
  let inaccessible = 0;
  let truncated = false;
  let limitedCandidates = false;
  const started = Date.now();
  for (let index = 0; index < queue.length && !truncated; index += 1) {
    if (Date.now() - started > 8000) { truncated = true; break; }
    const directory = queue[index];
    if (!directory) continue;
    try {
      const canonical = await realpath(directory);
      if (seenDirectories.has(canonical)) continue;
      seenDirectories.add(canonical);
      const entries = await opendir(canonical);
      for await (const entry of entries) {
        visited += 1;
        if (visited > 100_000 || Date.now() - started > 8000) { truncated = true; break; }
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'arsenal-backups') continue;
        const path = join(canonical, entry.name);
        if (entry.isDirectory()) { queue.push(path); continue; }
        const matches = byName.get(nameKey(entry.name));
        if (!matches || !entry.isFile() && !entry.isSymbolicLink()) continue;
        let key: string;
        try {
          if (!(await stat(path)).isFile()) continue;
          key = `${nameKey(entry.name)}:${await seratoMediaPathKey(path)}`;
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) inaccessible += 1;
          continue;
        }
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        for (const file of matches) {
          const found = candidates.get(file.path);
          if (found && !found.includes(path)) {
            if (found.length < 10) found.push(path);
            else limitedCandidates = true;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) inaccessible += 1;
    }
  }
  if (truncated) warnings.push('The file search reached its time or 100,000-entry limit. Search a smaller folder to check the remaining files.');
  if (limitedCandidates) warnings.push('Only the first 10 matches per missing file are shown. Search a smaller folder or locate the file manually.');
  if (inaccessible) warnings.push(`The file search could not read ${inaccessible} folders or files. Check permissions or locate the audio file manually.`);
  return { files: files.map((file) => ({ ...file, candidates: candidates.get(file.path) ?? [] })), warnings };
};
