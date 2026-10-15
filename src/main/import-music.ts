import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

// The package uses conditional ESM exports that this project's ESLint resolver misses.
// eslint-disable-next-line import/no-unresolved
import { parseFile } from 'music-metadata';
import type { SongRow } from '../shared/dj-library';
import { organizationFileStamp } from './reorganize-library';

export const readMusicFile = async (path: string) => {
  const stamp = await organizationFileStamp(path);
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Choose an audio file.');
  const { common, format } = await parseFile(path, { skipCovers: true, duration: true });
  if (!format.codec && !format.container) throw new Error('The file does not contain supported audio.');
  if (stamp !== await organizationFileStamp(path)) throw new Error('The file changed while reading its tags. Try again.');
  const text = (value: string | undefined): string | null => value?.trim() || null;
  const positive = (value: number | undefined | null): number | null => value !== undefined && value !== null && Number.isFinite(value) && value > 0 ? value : null;
  const song: SongRow = {
    id: createHash('sha256').update(path).digest('hex'), title: text(common.title) ?? basename(path, extname(path)),
    artist: text(common.artists?.length ? [...new Set(common.artists)].join(', ') : common.artist),
    composer: text(common.composer?.join(', ')), remixer: text(common.remixer?.join(', ')), album: text(common.album),
    mixName: null, label: text(common.label?.join(', ')), genre: text(common.genre?.join(', ')), year: positive(common.year),
    bpm: positive(common.bpm), musicalKey: text(common.key), durationSeconds: positive(format.duration),
    fileKind: extname(path).slice(1).toUpperCase(), fileSizeBytes: info.size,
    bitRateKbps: format.bitrate ? positive(format.bitrate / 1000) : null, sampleRateHz: positive(format.sampleRate),
    trackNumber: positive(common.track.no), discNumber: positive(common.disk.no), playCount: 0,
    rating: common.rating?.[0]?.rating === undefined ? null : Math.round(common.rating[0].rating * 5),
    dateAdded: new Date().toISOString(), comments: text(common.comment?.map((comment) => comment.text).join('\n')),
    artworkUrl: null, audioUrl: null, source: 'local', cuePointCount: 0, hotCueCount: 0,
  };
  return { track: { path, song }, stamp };
};
