import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SyncFields, SyncRequest, SyncResult } from '../shared/dj-library';
import { mergeLibraries, normalizePath, type SyncLibrary, type SyncTrack } from './library-sync-model';
import { parseRekordboxXml } from './parse-rekordbox-xml';
import { mergeRekordboxXml, rekordboxSyncLibrary } from './sync-rekordbox-xml';
import { assertSeratoClosed, readSeratoLibrary, writeSeratoLibrary, type SeratoSource } from './serato-library';
import { readSeratoPerformance, writeSeratoPerformance } from './serato-performance';
import { resolveSeratoLibraryPaths, seratoMediaPathKey } from './serato-paths';

export const readSeratoWithPerformance = async (source: SeratoSource, includePerformance = true) => {
  const library = await readSeratoLibrary(source);
  const warnings: string[] = [];
  const tracks: SyncTrack[] = [];
  for (const track of library.tracks) {
    if (!includePerformance || track.song.source !== 'local') {
      tracks.push(track);
      continue;
    }
    try {
      tracks.push({ ...track, performance: await readSeratoPerformance(track.path) });
    } catch (error) {
      tracks.push(track);
      warnings.push(`${basename(track.path)}: ${error instanceof Error ? error.message : 'Could not read performance data.'}`);
    }
  }
  return { library: { ...library, tracks }, warnings };
};

export const saveLibraryXml = async (path: string, xml: string, expected: string | null, backup = true): Promise<string | null> => {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let backupPath: string | null = null;
  try {
    const mode = expected === null ? 0o600 : (await stat(path)).mode & 0o777;
    const file = await open(temporary, 'wx', mode);
    try { await file.writeFile(xml, 'utf8'); await file.sync(); } finally { await file.close(); }
    await parseRekordboxXml(temporary);
    let current: string | null = null;
    try { current = await readFile(path, 'utf8'); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (current !== expected) throw new Error('The Rekordbox XML changed during sync. Import it again and retry.');
    if (backup && expected !== null) {
      const directory = join(dirname(path), 'arsenal-backups', `${Date.now()}-${randomUUID()}`);
      await mkdir(directory, { recursive: true });
      backupPath = join(directory, basename(path));
      await copyFile(path, backupPath);
    }
    await rename(temporary, path);
    return backupPath;
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    });
  }
};

const selectedSource = (source: SyncLibrary, target: SyncLibrary, fields: SyncFields): SyncLibrary => {
  const existing = new Map(target.tracks.map((track) => [normalizePath(track.path), track]));
  const tracks = source.tracks.flatMap((track): SyncTrack[] => {
    const previous = existing.get(normalizePath(track.path));
    if (!fields.tracks && !previous) return [];
    const performance = track.performance;
    return [{ ...track,
      song: fields.metadata || !previous ? track.song : previous.song,
      ...(performance ? { performance: {
        hotCues: fields.hotCues ? performance.hotCues : previous?.performance?.hotCues ?? [],
        loops: fields.loops ? performance.loops : previous?.performance?.loops ?? [],
        beatgrids: fields.beatgrids ? performance.beatgrids : previous?.performance?.beatgrids ?? [],
      } } : {}),
    }];
  });
  const available = new Set([...tracks, ...target.tracks].map((track) => normalizePath(track.path)));
  return { tracks, playlists: fields.playlists ? source.playlists.map((playlist) => ({ ...playlist,
    trackPaths: playlist.trackPaths.filter((path) => available.has(normalizePath(path))),
  })) : [] };
};

const shiftPerformance = (library: SyncLibrary, seconds: number, fields: SyncFields): SyncLibrary => {
  if (seconds === 0) return library;
  const shift = (time: number, allowNegative = false): number => {
    const value = Math.round((time + seconds) * 1_000_000) / 1_000_000;
    if ((!allowNegative && value < 0) || !Number.isFinite(value)) throw new Error('The timing correction moves a cue or loop before the track starts. Choose a smaller correction.');
    return value;
  };
  return { ...library, tracks: library.tracks.map((track) => track.performance ? { ...track, performance: {
    hotCues: fields.hotCues ? track.performance.hotCues.map((cue) => ({ ...cue, start: shift(cue.start) })) : track.performance.hotCues,
    loops: fields.loops ? track.performance.loops.map((loop) => ({ ...loop, start: shift(loop.start), end: shift(loop.end) })) : track.performance.loops,
    beatgrids: fields.beatgrids ? track.performance.beatgrids.map((grid) => ({ ...grid, start: shift(grid.start, true) })) : track.performance.beatgrids,
  } } : track) };
};

export const syncLibraryFiles = async ({ rekordboxPath, serato, request, workspace }: Readonly<{
  rekordboxPath: string;
  serato: SeratoSource;
  request: SyncRequest;
  workspace: SyncLibrary | null;
}>): Promise<SyncResult> => {
  const backupPaths: string[] = [];
  let wroteLibrary = false;
  try {
    if (request.mode === 'replace' && request.direction === 'both') throw new Error('Overwrite is only available for one-way sync.');
    await assertSeratoClosed();
    let xml: string | null = null;
    try { xml = await readFile(rekordboxPath, 'utf8'); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT') || request.direction !== 'serato-to-rekordbox') throw error;
    }
    const parsed = xml === null ? null : await parseRekordboxXml(rekordboxPath);
    const originalRekordbox = parsed === null ? { tracks: [], playlists: [] } : rekordboxSyncLibrary(parsed);
    const hasPerformance = request.fields.hotCues || request.fields.loops || request.fields.beatgrids;
    const read = await readSeratoWithPerformance(serato, hasPerformance && request.direction !== 'rekordbox-to-serato');
    if (workspace !== null) workspace = await resolveSeratoLibraryPaths(workspace, read.library);
    const native = workspace === null ? read.library : mergeLibraries(
      { ...read.library, playlists: workspace.playlists }, { ...workspace, playlists: read.library.playlists },
    );
    const rekordbox = await resolveSeratoLibraryPaths(originalRekordbox, native);
    const canonicalPaths = new Map(await Promise.all(rekordbox.tracks.map(async (track) =>
      [await seratoMediaPathKey(track.path), normalizePath(track.path)] as const)));
    const resolvedPaths = new Map(await Promise.all(originalRekordbox.tracks.map(async (track) =>
      [normalizePath(track.path), canonicalPaths.get(await seratoMediaPathKey(track.path)) ?? normalizePath(track.path)] as const)));
    const warnings = [...read.warnings];
    const localSerato = shiftPerformance({ ...native, tracks: native.tracks.filter((track) => track.song.source === 'local') }, -(request.timingOffsetMs ?? 0) / 1000, request.fields);
    const source = request.direction === 'both'
      ? request.conflictSource === 'rekordbox' ? mergeLibraries(rekordbox, localSerato) : mergeLibraries(localSerato, rekordbox)
      : request.direction === 'rekordbox-to-serato' ? rekordbox : localSerato;
    const toRekordbox = selectedSource(source, rekordbox, request.fields);
    const toSerato = shiftPerformance(selectedSource(source, localSerato, request.fields), (request.timingOffsetMs ?? 0) / 1000, request.fields);
    const nextXml = request.direction === 'rekordbox-to-serato' ? null : mergeRekordboxXml(toRekordbox, xml ?? undefined, request.fields, resolvedPaths, request.mode === 'replace');
    if (request.direction !== 'serato-to-rekordbox') {
      if (request.fields.tracks || request.fields.metadata || request.fields.playlists) {
        const result = await writeSeratoLibrary(serato, toSerato, {
          metadata: request.fields.metadata,
          replaceTracks: request.mode === 'replace' && request.fields.tracks,
          replacePlaylists: request.mode === 'replace' && request.fields.playlists,
        });
        backupPaths.push(...result.backupPaths);
        warnings.push(...result.warnings);
        wroteLibrary = true;
      }
      if (hasPerformance || request.fields.metadata) {
        for (const track of toSerato.tracks) {
          if (!track.performance && !request.fields.metadata) continue;
          try {
            const backup = await writeSeratoPerformance(track.path,
              track.performance ?? { hotCues: [], loops: [], beatgrids: [] }, {
                hotCues: track.performance !== undefined && request.fields.hotCues,
                loops: track.performance !== undefined && request.fields.loops,
                beatgrids: track.performance !== undefined && request.fields.beatgrids,
              }, request.fields.metadata ? track.song : undefined);
            if (backup !== null) { backupPaths.push(backup); wroteLibrary = true; }
          } catch (error) {
            warnings.push(`${basename(track.path)}: ${error instanceof Error ? error.message : 'Could not write audio tags.'}`);
          }
        }
      }
    }
    if (nextXml !== null) {
      const backup = await saveLibraryXml(rekordboxPath, nextXml, xml);
      if (backup !== null) backupPaths.push(backup);
      wroteLibrary = true;
    }
    const sourceCount = source.tracks.length;
    const selectedCount = request.direction === 'serato-to-rekordbox' ? toRekordbox.tracks.length : toSerato.tracks.length;
    const nonlocalCount = (parsed?.tracks.length ?? 0) - rekordbox.tracks.length + native.tracks.length - localSerato.tracks.length;
    const skippedTrackCount = Math.max(0, nonlocalCount + sourceCount - selectedCount);
    const playlistCount = request.fields.playlists ? source.playlists.length : 0;
    const message = [
      `Synced ${selectedCount} tracks and ${playlistCount} playlists/crates.`,
      request.mode === 'replace' ? 'Replaced the selected destination library data. Audio files were kept.' : '',
      nextXml === null ? 'Reopen Serato to load the changes.' : `Rekordbox XML saved to ${rekordboxPath}. Import its tracks and playlists into Rekordbox.`,
      skippedTrackCount ? `${skippedTrackCount} tracks were skipped because they are not local files or adding tracks was disabled.` : '',
      warnings.length ? `${warnings.length} sync warnings. ${warnings.slice(0, 3).join(' ')}${warnings.length > 3 ? ' See the sync report for the rest.' : ''}` : '',
    ].filter(Boolean).join(' ');
    const reportPath = `${rekordboxPath}.arsenal-sync-report.json`;
    const report = { completedAt: new Date().toISOString(), direction: request.direction, mode: request.mode ?? 'merge', fields: request.fields, timingOffsetMs: request.timingOffsetMs, backupPaths, warnings, skippedTrackCount };
    try {
      const reportFile = await open(reportPath, 'w', 0o600);
      try { await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n'); } finally { await reportFile.close(); }
    } catch {
      return { kind: 'synced', trackCount: selectedCount, playlistCount, skippedTrackCount, backupPaths, warnings: [...warnings, 'Could not save the sync report.'],
        message: `${message} Could not save the sync report. Backups: ${backupPaths.join(', ') || 'No files changed.'}` };
    }
    return { kind: 'synced', trackCount: selectedCount, playlistCount, skippedTrackCount, backupPaths, warnings, message: `${message} Report and backup locations: ${reportPath}` };
  } catch (error) {
    return { kind: 'rejected', message: `${error instanceof Error ? error.message : 'Could not sync the libraries.'}${wroteLibrary ? ` Some files were already updated. Backups: ${backupPaths.join(', ')}` : ''}` };
  }
};
