import type { SyncFields } from '../shared/dj-library';
import type { SyncBeatgrid, SyncCue, SyncLoop, SyncPerformance } from './library-sync-model';

type Marker = Readonly<{ name: string; data: Buffer }>;
type PerformanceFields = Pick<SyncFields, 'hotCues' | 'loops' | 'beatgrids'>;

const MARKERS2 = 'Serato Markers2';
const MARKERS = 'Serato Markers_';
const BEATGRID = 'Serato BeatGrid';

const requireBytes = (condition: boolean, tag: string): void => {
  if (!condition) throw new Error(`Invalid or unsupported ${tag} data.`);
};

const readMarkers2 = (raw: Buffer | undefined): Marker[] => {
  if (!raw) return [];
  requireBytes(raw[0] === 1 && raw[1] === 1, MARKERS2);
  const end = raw.indexOf(0, 2);
  let encoded = raw.subarray(2, end < 0 ? raw.length : end).toString('ascii').replace(/\s/g, '');
  requireBytes(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded), MARKERS2);
  if (encoded.length % 4 === 1) encoded += 'A';
  const bytes = Buffer.from(encoded, 'base64');
  requireBytes(bytes[0] === 1 && bytes[1] === 1, MARKERS2);
  const markers: Marker[] = [];
  let offset = 2;
  while (offset < bytes.length && bytes[offset] !== 0) {
    const separator = bytes.indexOf(0, offset);
    requireBytes(separator > offset && separator + 5 <= bytes.length, MARKERS2);
    const length = bytes.readUInt32BE(separator + 1);
    const start = separator + 5;
    requireBytes(length > 0 && start + length <= bytes.length, MARKERS2);
    const name = bytes.toString('ascii', offset, separator);
    requireBytes(/^[A-Z0-9_]+$/.test(name), MARKERS2);
    markers.push({ name, data: bytes.subarray(start, start + length) });
    offset = start + length;
  }
  requireBytes(bytes.subarray(offset).every((value) => value === 0), MARKERS2);
  return markers;
};

const writeMarkers2 = (markers: readonly Marker[], minimumLength: number): Buffer => {
  const entries = markers.map(({ name, data }) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([Buffer.from(`${name}\0`, 'ascii'), length, data]);
  });
  const encoded = Buffer.concat([Buffer.from([1, 1]), ...entries, Buffer.from([0])]).toString('base64').replace(/=/g, 'A');
  const lines = encoded.match(/.{1,72}/g)?.join('\n') ?? '';
  const contents = Buffer.concat([Buffer.from([1, 1]), Buffer.from(lines, 'ascii'), Buffer.from([0])]);
  return Buffer.concat([contents, Buffer.alloc(Math.max(470, minimumLength, contents.length) - contents.length)]);
};

const markerName = (bytes: Buffer, offset: number): string => {
  const end = bytes.indexOf(0, offset);
  requireBytes(end >= offset, MARKERS2);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end));
};

const cueFromMarker = (marker: Marker): SyncCue => {
  const bytes = marker.data;
  requireBytes(bytes.length >= 13, MARKERS2);
  return { index: bytes.readUInt8(1), start: bytes.readUInt32BE(2) / 1000,
    color: [bytes.readUInt8(7), bytes.readUInt8(8), bytes.readUInt8(9)], name: markerName(bytes, 12) };
};

const loopFromMarker = (marker: Marker): SyncLoop => {
  const bytes = marker.data;
  requireBytes(bytes.length >= 21 && bytes.readUInt32BE(6) > bytes.readUInt32BE(2), MARKERS2);
  return { index: bytes.readUInt8(1), start: bytes.readUInt32BE(2) / 1000, end: bytes.readUInt32BE(6) / 1000,
    color: [bytes.readUInt8(15), bytes.readUInt8(16), bytes.readUInt8(17)], locked: bytes[19] !== 0, name: markerName(bytes, 20) };
};

const readLegacy = (raw: Buffer | undefined): Buffer[] => {
  if (!raw) return [];
  requireBytes(raw.length === 318 && raw[0] === 2 && raw[1] === 5 && raw.readUInt32BE(2) === 14, MARKERS);
  return Array.from({ length: 14 }, (_, index) => raw.subarray(6 + index * 22, 28 + index * 22));
};

const readSerato32 = (bytes: Buffer, offset: number): number =>
  ((bytes.readUInt8(offset) & 7) << 21) | ((bytes.readUInt8(offset + 1) & 127) << 14) | ((bytes.readUInt8(offset + 2) & 127) << 7) | (bytes.readUInt8(offset + 3) & 127);

const writeSerato32 = (bytes: Buffer, offset: number, value: number): void => {
  requireBytes(Number.isInteger(value) && value >= 0 && value <= 0xffffff, MARKERS);
  bytes.set([(value >>> 21) & 7, (value >>> 14) & 127, (value >>> 7) & 127, value & 127], offset);
};

const readBeatgrid = (raw: Buffer | undefined): SyncBeatgrid[] => {
  if (!raw) return [];
  requireBytes(raw.length >= 7 && raw[0] === 1 && raw[1] === 0, BEATGRID);
  const count = raw.readUInt32BE(2);
  // The one-byte footer is missing or followed by padding in some files, so only the markers must be present.
  requireBytes(count * 8 + 6 <= raw.length, BEATGRID);
  const grids: SyncBeatgrid[] = [];
  let beatCount = 0;
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 8;
    const start = raw.readFloatBE(offset);
    const beats = index < count - 1 ? raw.readUInt32BE(offset + 4) : 0;
    const bpm = index === count - 1 ? raw.readFloatBE(offset + 4) : beats * 60 / (raw.readFloatBE(offset + 8) - start);
    requireBytes(Number.isFinite(start) && Number.isFinite(bpm) && bpm > 0, BEATGRID);
    grids.push({ start, bpm, beat: (beatCount % 4) + 1 });
    beatCount += beats;
  }
  return grids;
};

export const decodeSeratoPerformance = (tags: ReadonlyMap<string, Buffer>): SyncPerformance => {
  const modern = readMarkers2(tags.get(MARKERS2));
  const hotCues = new Map(modern.filter((marker) => marker.name === 'CUE').map((marker) => {
    const cue = cueFromMarker(marker);
    return [cue.index, cue];
  }));
  const loops = new Map(modern.filter((marker) => marker.name === 'LOOP').map((marker) => {
    const loop = loopFromMarker(marker);
    return [loop.index, loop];
  }));
  const legacy = readLegacy(tags.get(MARKERS));
  // Serato lets legacy slots override Markers2, including slots that are unset.
  for (const [slot, bytes] of legacy.entries()) {
    const index = slot < 5 ? slot : slot - 5;
    const modernCue = hotCues.get(index);
    const modernLoop = loops.get(index);
    if (slot < 5) hotCues.delete(index); else loops.delete(index);
    requireBytes((bytes[0] === 0 || bytes[0] === 127) && (bytes[5] === 0 || bytes[5] === 127), MARKERS);
    if (bytes[0] !== 0) continue;
    const rgb = readSerato32(bytes, 16);
    const cue: SyncCue = { index, name: (slot < 5 ? modernCue?.name : modernLoop?.name) ?? '', start: readSerato32(bytes, 1) / 1000,
      color: [(rgb >>> 16) & 255, (rgb >>> 8) & 255, rgb & 255] };
    if (slot < 5 && bytes[20] === 1) hotCues.set(index, cue);
    else if (slot >= 5 && bytes[20] === 3 && bytes[5] === 0) {
      const end = readSerato32(bytes, 6) / 1000;
      requireBytes(end > cue.start, MARKERS);
      loops.set(index, { ...cue, end, locked: bytes[21] !== 0 });
    }
  }
  // An unreadable grid should not discard the track's cues and loops.
  let beatgrids: SyncBeatgrid[] = [];
  try { beatgrids = readBeatgrid(tags.get(BEATGRID)); } catch { /* Left empty; encodeSeratoPerformance keeps the original bytes. */ }
  return { hotCues: [...hotCues.values()].sort((a, b) => a.index - b.index), loops: [...loops.values()].sort((a, b) => a.index - b.index), beatgrids };
};

const validateMarkers = (cues: readonly SyncCue[], maxIndex: number, maxNameBytes: number): void => {
  const used = new Set<number>();
  for (const cue of cues) {
    if (!Number.isInteger(cue.index) || cue.index < 0 || cue.index > maxIndex || used.has(cue.index)) throw new Error(`Serato supports unique cue/loop slots 1 through ${maxIndex + 1}.`);
    used.add(cue.index);
    if (!Number.isFinite(cue.start) || cue.start < 0 || cue.start * 1000 > 0xffffffff) throw new Error('A cue or loop has an invalid position.');
    if (cue.name.includes('\0') || Buffer.byteLength(cue.name, 'utf8') > maxNameBytes) throw new Error('A cue or loop name exceeds the Serato limit.');
    if (cue.color.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) throw new Error('A cue or loop has an invalid color.');
  }
};

const cueMarker = (cue: SyncCue, existing: Marker | undefined): Marker => {
  const bytes = existing ? Buffer.from(existing.data.subarray(0, 12)) : Buffer.alloc(12);
  bytes[1] = cue.index;
  bytes.writeUInt32BE(Math.round(cue.start * 1000), 2);
  bytes.set(cue.color, 7);
  return { name: 'CUE', data: Buffer.concat([bytes, Buffer.from(`${cue.name}\0`, 'utf8')]) };
};

const loopMarker = (loop: SyncLoop, existing: Marker | undefined): Marker => {
  const bytes = existing ? Buffer.from(existing.data.subarray(0, 20)) : Buffer.alloc(20);
  if (!existing) bytes.fill(255, 10, 14);
  bytes[1] = loop.index;
  bytes.writeUInt32BE(Math.round(loop.start * 1000), 2);
  bytes.writeUInt32BE(Math.round(loop.end * 1000), 6);
  bytes.set(loop.color, 15);
  bytes[19] = loop.locked ? 1 : 0;
  return { name: 'LOOP', data: Buffer.concat([bytes, Buffer.from(`${loop.name}\0`, 'utf8')]) };
};

const legacyMarker = (cue: SyncCue | undefined, loop: SyncLoop | undefined, isLoop: boolean, existing: Buffer | undefined): Buffer => {
  const bytes = existing ? Buffer.from(existing) : Buffer.alloc(22);
  if (!existing) bytes.fill(127, 11, 16);
  bytes.fill(127, 0, 10);
  bytes[20] = isLoop ? 3 : 1;
  bytes[21] = loop?.locked ? 1 : 0;
  const marker = loop ?? cue;
  if (!marker) { bytes.fill(0, 16, 20); return bytes; }
  bytes[0] = 0;
  writeSerato32(bytes, 1, Math.round(marker.start * 1000));
  writeSerato32(bytes, 16, (marker.color[0] << 16) | (marker.color[1] << 8) | marker.color[2]);
  if (loop) { bytes[5] = 0; writeSerato32(bytes, 6, Math.round(loop.end * 1000)); }
  return bytes;
};

const writeLegacy = (raw: Buffer | undefined, performance: SyncPerformance, fields: PerformanceFields): Buffer => {
  const existing = readLegacy(raw);
  const records = Array.from({ length: 14 }, (_, slot) => {
    const index = slot < 5 ? slot : slot - 5;
    if (existing[slot] && !(slot < 5 ? fields.hotCues : fields.loops)) return existing[slot];
    return legacyMarker(performance.hotCues.find((cue) => slot < 5 && cue.index === index), performance.loops.find((loop) => slot >= 5 && loop.index === index), slot >= 5, existing[slot]);
  });
  const header = Buffer.from([2, 5, 0, 0, 0, 14]);
  const footer = raw?.subarray(314) ?? Buffer.from([7, 127, 127, 127]);
  return Buffer.concat([header, ...records, footer]);
};

const writeBeatgrid = (grids: readonly SyncBeatgrid[], existing: Buffer | undefined): Buffer => {
  const normalized = grids.map((grid) => ({ ...grid }));
  for (const grid of normalized) {
    if (grid.meter !== undefined && grid.meter !== '4/4') throw new Error(`Serato cannot represent a ${grid.meter} beatgrid without changing its bar markers.`);
    if (!Number.isFinite(grid.start) || !Number.isFinite(grid.bpm) || grid.bpm <= 0 || !Number.isInteger(grid.beat) || grid.beat < 1 || grid.beat > 4) throw new Error('A beatgrid marker has an invalid time, tempo, or beat number.');
  }
  const first = normalized[0];
  if (first && first.beat !== 1) {
    first.start -= (first.beat - 1) * 60 / first.bpm;
    first.beat = 1;
  }
  const bytes = Buffer.alloc(normalized.length * 8 + 7);
  bytes[0] = 1;
  bytes.writeUInt32BE(normalized.length, 2);
  let cumulativeBeats = 0;
  for (const [index, grid] of normalized.entries()) {
    const offset = 6 + index * 8;
    bytes.writeFloatBE(grid.start, offset);
    const next = normalized[index + 1];
    if (!next) { bytes.writeFloatBE(grid.bpm, offset + 4); continue; }
    // Nonterminal Serato markers store an integer beat count instead of BPM.
    const exactBeats = (next.start - grid.start) * grid.bpm / 60;
    const beats = Math.round(exactBeats);
    if (beats < 1 || beats > 0xffffffff || Math.abs(exactBeats - beats) > 0.02 || ((cumulativeBeats + beats) % 4) + 1 !== next.beat) {
      throw new Error('This beatgrid has tempo changes between beats that Serato cannot represent exactly.');
    }
    bytes.writeUInt32BE(beats, offset + 4);
    cumulativeBeats += beats;
  }
  bytes[bytes.length - 1] = existing?.at(-1) ?? 0;
  readBeatgrid(bytes);
  return bytes;
};

export const encodeSeratoPerformance = (
  existing: ReadonlyMap<string, Buffer>, incoming: SyncPerformance, fields: PerformanceFields, includeLegacy = true,
): Map<string, Buffer> => {
  const current = decodeSeratoPerformance(existing);
  const loops: SyncLoop[] = [];
  if (fields.loops) {
    if (incoming.loops.length > 8) throw new Error(`This track has ${incoming.loops.length} saved loops; Serato supports 8 saved loop slots.`);
    const reserved = new Set(incoming.loops.filter((loop) => Number.isInteger(loop.index) && loop.index >= 0 && loop.index < 8).map((loop) => loop.index));
    const assigned = new Set<number>();
    for (const loop of incoming.loops) {
      let index = loop.index;
      if (!Number.isInteger(index) || index < 0 || index >= 8 || assigned.has(index)) {
        index = Array.from({ length: 8 }, (_, slot) => slot).find((slot) => !reserved.has(slot) && !assigned.has(slot)) ?? -1;
      }
      assigned.add(index);
      loops.push({ ...loop, index });
    }
  }
  // Serato has 8 hot cue slots; extra cues in a taken or out-of-range slot are left out instead of failing the track.
  const slots = new Set<number>();
  const hotCues = incoming.hotCues.filter((cue) => Number.isInteger(cue.index) && cue.index >= 0 && cue.index <= 7 && !slots.has(cue.index) && slots.add(cue.index));
  const performance = { hotCues: fields.hotCues ? hotCues : current.hotCues, loops: fields.loops ? loops : current.loops, beatgrids: fields.beatgrids ? incoming.beatgrids : current.beatgrids };
  if (fields.hotCues) validateMarkers(performance.hotCues, 7, 50);
  if (fields.loops) {
    validateMarkers(performance.loops, 7, 32747);
    for (const loop of performance.loops) if (!Number.isFinite(loop.end) || Math.round(loop.end * 1000) <= Math.round(loop.start * 1000) || loop.end * 1000 > 0xffffffff) throw new Error('A saved loop has an invalid end position.');
  }
  const updates = new Map<string, Buffer>();
  if (fields.hotCues || fields.loops) {
    const markers = readMarkers2(existing.get(MARKERS2));
    const retained = markers.filter((marker) => !(fields.hotCues && marker.name === 'CUE') && !(fields.loops && marker.name === 'LOOP'));
    if (fields.hotCues) retained.push(...performance.hotCues.map((cue) => cueMarker(cue, markers.find((marker) => marker.name === 'CUE' && marker.data[1] === cue.index))));
    if (fields.loops) retained.push(...performance.loops.map((loop) => loopMarker(loop, markers.find((marker) => marker.name === 'LOOP' && marker.data[1] === loop.index))));
    updates.set(MARKERS2, writeMarkers2(retained, existing.get(MARKERS2)?.length ?? 0));
    if (includeLegacy) updates.set(MARKERS, writeLegacy(existing.get(MARKERS), performance, fields));
  }
  // Without an incoming grid, keep Serato's own grid instead of erasing it.
  if (fields.beatgrids && (performance.beatgrids.length || !existing.has(BEATGRID))) updates.set(BEATGRID, writeBeatgrid(performance.beatgrids, existing.get(BEATGRID)));
  for (const [name, bytes] of updates) if (existing.get(name)?.equals(bytes)) updates.delete(name);
  return updates;
};
