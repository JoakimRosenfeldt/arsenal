import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, mkdtemp, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import {
  ByteVector,
  File,
  Id3v2AttachmentFrame,
  Id3v2FrameClassType,
  Id3v2FrameIdentifiers,
  Id3v2Tag,
  Mpeg4AppleTag,
  Mpeg4BoxType,
  PictureType,
  ReadStyle,
  StringType,
  TagTypes,
  XiphComment,
} from 'node-taglib-sharp';
import type { Tag } from 'node-taglib-sharp';
import type { SongRow } from '../shared/dj-library';

const wrappedFields = [
  { name: 'Serato Analysis', flac: 'SERATO_ANALYSIS', mp4: 'analysisVersion' },
  { name: 'Serato Autotags', flac: 'SERATO_AUTOGAIN', mp4: 'autgain' },
  { name: 'Serato BeatGrid', flac: 'SERATO_BEATGRID', mp4: 'beatgrid' },
  { name: 'Serato Markers_', flac: null, mp4: 'markers' },
  { name: 'Serato Markers2', flac: 'SERATO_MARKERS_V2', mp4: 'markersv2' },
  { name: 'Serato Overview', flac: 'SERATO_OVERVIEW', mp4: 'overview' },
  { name: 'Serato RelVol', flac: 'SERATO_RELVOL', mp4: 'relvol' },
  { name: 'Serato VideoAssoc', flac: 'SERATO_VIDEO_ASSOC', mp4: 'videoassociation' },
];
const wrapperPrefix = Buffer.from('application/octet-stream\0\0', 'ascii');
const bpmFrame = Id3v2FrameIdentifiers.TBPM;
if (!bpmFrame) throw new Error('The audio tag library does not support BPM frames.');

const tagTypeFor = (filePath: string): TagTypes => {
  switch (extname(filePath).toLowerCase()) {
    case '.mp3': case '.aif': case '.aiff': case '.wav': return TagTypes.Id3v2;
    case '.flac': return TagTypes.Xiph;
    case '.m4a': case '.mp4': return TagTypes.Apple;
    default: throw new Error(`Serato audio tags are not supported for ${extname(filePath) || 'this file type'}: ${filePath}`);
  }
};

const decodeWrapper = (value: string): readonly [string, Buffer] => {
  let encoded = value.replace(/\s/g, '').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]+$/.test(encoded)) throw new Error('Invalid Serato tag encoding');
  // Serato sometimes truncates the final base64 sextet, whose missing bits are zero.
  if (encoded.length % 4 === 1) encoded += 'A';
  const decoded = Buffer.from(encoded, 'base64');
  const nameEnd = decoded.indexOf(0, wrapperPrefix.length);
  if (!decoded.subarray(0, wrapperPrefix.length).equals(wrapperPrefix) || nameEnd < 0) {
    throw new Error('Invalid Serato tag wrapper');
  }
  const name = decoded.toString('utf8', wrapperPrefix.length, nameEnd);
  if (!name.startsWith('Serato ')) throw new Error('Invalid Serato tag name');
  return [name, decoded.subarray(nameEnd + 1)];
};

const encodeWrapper = (name: string, data: Buffer, lineBreaks: boolean): string => {
  const encoded = Buffer.concat([wrapperPrefix, Buffer.from(`${name}\0`, 'utf8'), data])
    .toString('base64').replace(/=+$/, '');
  return lineBreaks ? encoded.match(/.{1,72}/g)?.join('\n') ?? '' : encoded;
};

export const readSeratoTags = async (filePath: string): Promise<ReadonlyMap<string, Buffer>> => {
  const tagType = tagTypeFor(filePath);
  const file = File.createFromPath(filePath, undefined, ReadStyle.None);
  try {
    const tag = file.getTag(tagType, false);
    const result = new Map<string, Buffer>();
    if (tag instanceof Id3v2Tag) {
      for (const frame of tag.getFramesByClassType<Id3v2AttachmentFrame>(Id3v2FrameClassType.AttachmentFrame)) {
        if (frame.type === PictureType.NotAPicture && frame.description.startsWith('Serato ')) {
          result.set(frame.description, Buffer.from(frame.data.toByteArray()));
        }
      }
    } else if (tag instanceof XiphComment) {
      // Serato also writes plain-text fields such as SERATO_PLAYCOUNT; only the wrapped binary fields are read.
      const known = new Set(wrappedFields.flatMap((field) => field.flac ?? []));
      for (const name of tag.fieldNames.filter((field) => known.has(field.toUpperCase()))) {
        const value = tag.getFieldFirstValue(name);
        if (value) {
          const [field, data] = decodeWrapper(value);
          result.set(field, data);
        }
      }
    } else if (tag instanceof Mpeg4AppleTag) {
      for (const field of wrappedFields) {
        const value = tag.getFirstItunesString('com.serato.dj', field.mp4);
        if (value) {
          const [name, data] = decodeWrapper(value);
          result.set(name, data);
        }
      }
      for (const value of tag.getQuickTimeData(Mpeg4BoxType.ITUNES_TAG_BOX)) {
        const encoded = Buffer.from(value.toByteArray()).toString('utf8');
        if (encoded.startsWith('YXBwbGljYXRpb24vb2N0ZXQtc3RyZWFt')) {
          const [name, data] = decodeWrapper(encoded);
          result.set(name, data);
        }
      }
    }
    return result;
  } finally {
    file.dispose();
  }
};

const standardMetadata = (song: SongRow) => ({
  title: song.title || null,
  performers: song.artist ? [song.artist] : null,
  album: song.album || null,
  genres: song.genre ? [song.genre] : null,
  comment: song.comments || null,
  composers: song.composer ? [song.composer] : null,
  remixedBy: song.remixer || null,
  publisher: song.label || null,
  initialKey: song.musicalKey || null,
  year: song.year,
  track: song.trackNumber,
  disc: song.discNumber,
});
const standardFields = ['title', 'performers', 'album', 'genres', 'comment', 'composers', 'remixedBy', 'publisher', 'initialKey', 'year', 'track', 'disc'] satisfies readonly (keyof Tag)[];

const readBpm = (tag: Tag): number => {
  if (tag instanceof Id3v2Tag) return Number(tag.getTextAsString(bpmFrame));
  if (tag instanceof XiphComment) return Number(tag.getFieldFirstValue('TEMPO') || tag.getFieldFirstValue('BPM'));
  return tag.beatsPerMinute;
};

const metadataMatches = (filePath: string, song: SongRow): boolean => {
  const file = File.createFromPath(filePath, undefined, ReadStyle.None);
  try {
    const tag = file.getTag(tagTypeFor(filePath), false);
    if (!tag) return false;
    const expected = standardMetadata(song);
    return standardFields.every((key) => expected[key] === null || JSON.stringify(expected[key]) === JSON.stringify(tag[key])) &&
      (song.bpm === null || readBpm(tag) === (tag instanceof Mpeg4AppleTag ? Math.round(song.bpm) : song.bpm));
  } finally {
    file.dispose();
  }
};

const updateTags = (filePath: string, tags: ReadonlyMap<string, Buffer>, song?: SongRow): void => {
  const file = File.createFromPath(filePath, undefined, ReadStyle.None);
  try {
    const tag = file.getTag(tagTypeFor(filePath), true);
    if (!tag) throw new Error(`Cannot create audio metadata in ${filePath}`);
    if (song) {
      Object.assign(tag, Object.fromEntries(Object.entries(standardMetadata(song)).filter(([, value]) => value !== null)));
      if (song.bpm !== null) {
        if (!Number.isFinite(song.bpm) || song.bpm <= 0 || song.bpm > 65535) throw new Error('Invalid BPM for audio metadata.');
        if (tag instanceof Id3v2Tag) tag.setTextFrame(bpmFrame, String(song.bpm));
        else if (tag instanceof XiphComment) {
          tag.setFieldAsStrings('BPM', String(song.bpm));
          if (tag.getFieldFirstValue('TEMPO')) tag.setFieldAsStrings('TEMPO', String(song.bpm));
        } else tag.beatsPerMinute = Math.round(song.bpm);
      }
    }
    for (const [name, data] of tags) {
      if (!name.startsWith('Serato ')) throw new Error(`Invalid Serato tag name: ${name}`);
      if (tag instanceof Id3v2Tag) {
        for (const frame of tag.getFramesByClassType<Id3v2AttachmentFrame>(Id3v2FrameClassType.AttachmentFrame)) {
          if (frame.type === PictureType.NotAPicture && frame.description === name) tag.removeFrame(frame);
        }
        const frame = Id3v2AttachmentFrame.fromPicture({
          description: name, filename: '', mimeType: 'application/octet-stream',
          type: PictureType.NotAPicture, data: ByteVector.fromByteArray(data),
        });
        frame.textEncoding = StringType.Latin1;
        tag.addFrame(frame);
      } else {
        const field = wrappedFields.find((candidate) => candidate.name === name);
        if (tag instanceof XiphComment && field?.flac) {
          tag.setFieldAsStrings(field.flac, encodeWrapper(name, data, true));
        } else if (tag instanceof Mpeg4AppleTag && field) {
          tag.setItunesStrings('com.serato.dj', field.mp4, encodeWrapper(name, data, field.mp4.startsWith('markers')));
        } else {
          throw new Error(`Cannot store ${name} in ${extname(filePath)} files`);
        }
      }
    }
    file.save();
  } finally {
    file.dispose();
  }
};

const fingerprintFor = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const data of createReadStream(filePath)) hash.update(data);
  return hash.digest('hex');
};

export const writeSeratoTags = async (
  filePath: string,
  tags: ReadonlyMap<string, Buffer>,
  song?: SongRow,
): Promise<Readonly<{ backupPaths: readonly string[] }>> => {
  if (tags.size === 0 && !song) return { backupPaths: [] };
  tagTypeFor(filePath);
  const target = await realpath(filePath);
  const original = await readSeratoTags(target);
  const updates = new Map(tags);
  const autotags = updates.get('Serato Autotags') ?? original.get('Serato Autotags');
  if (song?.bpm !== null && song?.bpm !== undefined && autotags) {
    const bpmEnd = autotags.indexOf(0, 2);
    if (autotags[0] !== 1 || autotags[1] !== 1 || bpmEnd < 2) throw new Error('Unsupported Serato Autotags data.');
    updates.set('Serato Autotags', Buffer.concat([autotags.subarray(0, 2), Buffer.from(`${song.bpm.toFixed(2)}\0`, 'ascii'), autotags.subarray(bpmEnd + 1)]));
  }
  if ([...updates].every(([name, data]) => original.get(name)?.equals(data)) && (!song || metadataMatches(target, song))) return { backupPaths: [] };
  if (!(await stat(target)).isFile()) throw new Error(`Not an audio file: ${filePath}`);
  const expectedFingerprint = await fingerprintFor(target);
  const temporaryDirectory = await mkdtemp(join(dirname(target), '.arsenal-tags-'));
  const temporaryPath = join(temporaryDirectory, basename(target));
  try {
    await copyFile(target, temporaryPath, constants.COPYFILE_EXCL);
    if (await fingerprintFor(temporaryPath) !== expectedFingerprint) throw new Error(`Audio file changed before saving: ${filePath}`);
    updateTags(temporaryPath, updates, song);
    const written = await readSeratoTags(temporaryPath);
    if (![...updates].every(([name, data]) => written.get(name)?.equals(data)) || song && !metadataMatches(temporaryPath, song)) throw new Error(`Could not verify saved audio tags: ${filePath}`);
    const temporaryFile = await open(temporaryPath, 'r+');
    try { await temporaryFile.sync(); } finally { await temporaryFile.close(); }
    const backupPath = `${target}.arsenal-backup-${Date.now()}-${randomUUID()}`;
    await copyFile(target, backupPath, constants.COPYFILE_EXCL);
    if (await fingerprintFor(backupPath) !== expectedFingerprint || await fingerprintFor(target) !== expectedFingerprint) {
      throw new Error(`Audio file changed while saving: ${filePath}`);
    }
    await rename(temporaryPath, target);
    return { backupPaths: [backupPath] };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};
