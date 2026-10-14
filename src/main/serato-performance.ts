import { extname } from 'node:path';

import type { SongRow, SyncFields } from '../shared/dj-library';
import type { SyncPerformance } from './library-sync-model';
import { decodeSeratoPerformance, encodeSeratoPerformance } from './serato-performance-codec';
import { readSeratoTags, writeSeratoTags } from './serato-tag-io';

export const readSeratoPerformance = async (path: string): Promise<SyncPerformance> => decodeSeratoPerformance(await readSeratoTags(path));

export const writeSeratoPerformance = async (
  path: string, performance: SyncPerformance, fields: Pick<SyncFields, 'hotCues' | 'loops'>,
  song?: SongRow,
): Promise<boolean> => {
  const tags = await readSeratoTags(path);
  const updates = fields.hotCues || fields.loops
    ? encodeSeratoPerformance(tags, performance, fields, extname(path).toLowerCase() !== '.flac') : new Map<string, Buffer>();
  if (updates.size === 0 && !song) return false;
  return writeSeratoTags(path, updates, song);
};
