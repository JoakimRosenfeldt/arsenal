import { pathToFileURL } from 'node:url';
import { SaxesParser } from 'saxes';
import type { SongRow, SyncFields } from '../shared/dj-library';
import { isSmartPlaylistNode, type ParsedRekordboxLibrary } from './parse-rekordbox-xml';
import { normalizePath, type SyncLibrary, type SyncPlaylist, type SyncTrack } from './library-sync-model';

type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  parts: (XmlNode | string)[];
};

const escapeXml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;');

const children = (node: XmlNode, name: string): XmlNode[] =>
  node.parts.filter((part): part is XmlNode => typeof part !== 'string' && part.name === name);

const render = (node: XmlNode): string => {
  const attributes = Object.entries(node.attributes).map(([name, value]) => ` ${name}="${escapeXml(value)}"`).join('');
  return node.parts.length === 0 ? `<${node.name}${attributes}/>`
    : `<${node.name}${attributes}>${node.parts.map((part) => typeof part === 'string' ? part : render(part)).join('')}</${node.name}>`;
};

const parseXml = (source: string): { root: XmlNode; prefix: string; suffix: string } => {
  const parser = new SaxesParser({ xmlns: false });
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let pendingStart = 0;
  let cursor = 0;
  let prefix = '';
  parser.on('error', (error) => { throw error; });
  parser.on('doctype', () => { throw new Error('XML document type declarations are not supported.'); });
  parser.on('opentagstart', (tag) => { pendingStart = parser.position - tag.name.length - 2; });
  parser.on('opentag', (tag) => {
    const node: XmlNode = { name: tag.name, attributes: { ...tag.attributes }, parts: [] };
    const parent = stack.at(-1);
    if (parent) {
      parent.parts.push(source.slice(cursor, pendingStart), node);
    } else {
      root = node;
      prefix = source.slice(0, pendingStart);
    }
    cursor = parser.position;
    stack.push(node);
  });
  parser.on('closetag', (tag) => {
    const node = stack.pop();
    if (!node) throw new Error('Invalid XML nesting.');
    if (!tag.isSelfClosing) node.parts.push(source.slice(cursor, source.lastIndexOf('</', parser.position - 1)));
    cursor = parser.position;
  });
  parser.write(source).close();
  if (root === null) throw new Error('The XML has no root element.');
  return { root, prefix, suffix: source.slice(cursor) };
};

export const pathFromLocation = (location: string | null): string | null => {
  if (!location) return null;
  try {
    const url = new URL(location);
    if (url.protocol !== 'file:') return null;
    let path = decodeURIComponent(url.pathname);
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    if (url.hostname && url.hostname !== 'localhost') path = `//${url.hostname}${path}`;
    // Streaming references can be wrapped in a file://localhost URL by Rekordbox.
    if (/^\/?(?:tidal|beatport|beatsource|soundcloud|spotify|applemusic):/i.test(path)) return null;
    return path;
  } catch {
    return null;
  }
};

const locationFor = (path: string): string => {
  if (/^[a-z]:[\\/]/i.test(path)) {
    return `file://localhost/${path.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/').replace('%3A', ':')}`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  if (path.startsWith('//') || path.startsWith('\\\\')) {
    const [host, ...parts] = path.replaceAll('\\', '/').slice(2).split('/');
    return `file://${host}/${parts.map(encodeURIComponent).join('/')}`;
  }
  return pathToFileURL(path).href.replace('file:///', 'file://localhost/');
};

export const rekordboxSyncLibrary = (parsed: ParsedRekordboxLibrary): SyncLibrary => {
  const byId = new Map<string, string>();
  const byLocation = new Map<string, string>();
  const tracks: SyncTrack[] = [];
  for (const track of parsed.tracks) {
    const path = pathFromLocation(track.rawLocation);
    if (path === null) continue;
    tracks.push({ path, song: track.song, performance: track.performance });
    if (track.rekordboxId !== null) byId.set(track.rekordboxId, path);
    if (track.rawLocation !== null) byLocation.set(track.rawLocation, path);
  }
  const cratesWithTracks = new Set(parsed.playlists.filter((playlist) => playlist.seratoCrateTracks && playlist.folderPath.length > 0)
    .map((playlist) => JSON.stringify(playlist.folderPath)));
  return {
    tracks,
    playlists: [
      ...parsed.folders.filter((folder) => !cratesWithTracks.has(JSON.stringify(folder.folderPath)))
        .map((folder): SyncPlaylist => ({ path: folder.folderPath, trackPaths: [], kind: 'folder' })),
      ...parsed.playlists.map((playlist) => ({
        path: playlist.seratoCrateTracks && playlist.folderPath.length > 0 ? playlist.folderPath : [...playlist.folderPath, playlist.name],
        trackPaths: playlist.keys.flatMap((key) => {
          const path = playlist.referenceKind === 'track-id' ? byId.get(key) : byLocation.get(key);
          return path === undefined ? [] : [path];
        }),
      })),
    ],
  };
};

const metadataFields = {
  title: 'Name', artist: 'Artist', composer: 'Composer', remixer: 'Remixer', album: 'Album',
  mixName: 'Mix', label: 'Label', genre: 'Genre', year: 'Year', bpm: 'AverageBpm',
  musicalKey: 'Tonality', durationSeconds: 'TotalTime', fileKind: 'Kind', fileSizeBytes: 'Size',
  bitRateKbps: 'BitRate', sampleRateHz: 'SampleRate', trackNumber: 'TrackNumber', discNumber: 'DiscNumber',
  playCount: 'PlayCount', rating: 'Rating', dateAdded: 'DateAdded', comments: 'Comments',
} satisfies Partial<Record<keyof SongRow, string>>;

const blankXml = '<?xml version="1.0" encoding="UTF-8"?>\n<DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="Arsenal" Version="1.0" Company="Arsenal"/><COLLECTION Entries="0"/><PLAYLISTS><NODE Type="0" Name="ROOT" Count="0"/></PLAYLISTS></DJ_PLAYLISTS>\n';

export const mergeRekordboxXml = (incoming: SyncLibrary, source = blankXml, fields?: SyncFields): string => {
  const document = parseXml(source);
  const collection = children(document.root, 'COLLECTION')[0];
  const playlists = children(document.root, 'PLAYLISTS')[0];
  const playlistRoot = playlists && children(playlists, 'NODE')[0];
  if (document.root.name !== 'DJ_PLAYLISTS' || !collection || !playlistRoot) {
    throw new Error('Expected a Rekordbox Collection and playlist root.');
  }
  const tracks = children(collection, 'TRACK');
  const ids = new Set(tracks.map((node) => node.attributes.TrackID));
  const byPath = new Map<string, XmlNode>();
  for (const node of tracks) {
    const path = pathFromLocation(node.attributes.Location ?? null);
    if (path === null) continue;
    const key = normalizePath(path);
    if (byPath.has(key)) throw new Error(`Rekordbox contains multiple tracks for ${path}. Resolve this duplicate before syncing.`);
    byPath.set(key, node);
  }
  let nextId = 1;
  for (const track of incoming.tracks) {
    const key = normalizePath(track.path);
    let node = byPath.get(key);
    if (!node) {
      node = { name: 'TRACK', attributes: { Location: locationFor(track.path) }, parts: [] };
      collection.parts.push('\n', node);
      byPath.set(key, node);
    }
    if (!node.attributes.TrackID) {
      while (ids.has(String(nextId))) nextId++;
      node.attributes.TrackID = String(nextId++);
      ids.add(node.attributes.TrackID);
    }
    for (const field of Object.keys(metadataFields)) {
      if (!(field in metadataFields)) continue;
      const key = field as keyof typeof metadataFields;
      const value = track.song[key];
      if ((fields?.metadata !== false || !node.attributes.Name) && value !== null && value !== '') node.attributes[metadataFields[key]] = String(value);
    }
    if (track.performance) {
      node.parts = node.parts.filter((part) => typeof part === 'string' ||
        (!(part.name === 'TEMPO' && fields?.beatgrids !== false) && (part.name !== 'POSITION_MARK' ||
          !(part.attributes.Type === '4' && fields?.loops !== false) &&
          !(part.attributes.Type === '0' && Number(part.attributes.Num) >= 0 && fields?.hotCues !== false))));
      for (const cue of fields?.hotCues === false ? [] : track.performance.hotCues) node.parts.push({ name: 'POSITION_MARK', parts: [], attributes: {
        Name: cue.name, Type: '0', Num: String(cue.index), Start: String(cue.start),
        Red: String(cue.color[0]), Green: String(cue.color[1]), Blue: String(cue.color[2]),
      } });
      for (const loop of fields?.loops === false ? [] : track.performance.loops) node.parts.push({ name: 'POSITION_MARK', parts: [], attributes: {
        Name: loop.name, Type: '4', Num: String(loop.hotCue ? loop.index : -1), Start: String(loop.start), End: String(loop.end),
        Red: String(loop.color[0]), Green: String(loop.color[1]), Blue: String(loop.color[2]),
      } });
      for (const grid of fields?.beatgrids === false ? [] : track.performance.beatgrids) node.parts.push({ name: 'TEMPO', parts: [], attributes: {
        Inizio: String(grid.start), Bpm: String(grid.bpm), Metro: grid.meter ?? '4/4', Battito: String(grid.beat),
      } });
      const slots = new Set<number>();
      for (const mark of children(node, 'POSITION_MARK')) {
        const slot = Number(mark.attributes.Num);
        if (slot < 0 || !Number.isInteger(slot)) continue;
        if (slots.has(slot)) throw new Error(`Hot cue ${slot + 1} conflicts with a retained hot loop in ${track.song.title}. Sync both hot cues and loops, or free that slot first.`);
        slots.add(slot);
      }
    }
  }
  collection.attributes.Entries = String(children(collection, 'TRACK').length);

  const folderPaths = new Set(incoming.playlists.flatMap((playlist) =>
    playlist.path.slice(0, -1).map((_, index) => JSON.stringify(playlist.path.slice(0, index + 1)))));
  for (const playlist of incoming.playlists) {
    if (playlist.kind === 'folder') folderPaths.add(JSON.stringify(playlist.path));
  }
  const collectFolders = (parent: XmlNode, path: readonly string[]): void => {
    for (const node of children(parent, 'NODE')) {
      const childPath = [...path, node.attributes.Name ?? ''];
      if (node.attributes.Type === '0') {
        folderPaths.add(JSON.stringify(childPath));
        collectFolders(node, childPath);
      }
    }
  };
  collectFolders(playlistRoot, []);
  const incomingPaths = new Set(incoming.playlists.map((playlist) => JSON.stringify(playlist.path)));
  const crateTrackNode = (folder: XmlNode, path: readonly string[]): XmlNode => {
    const matches = children(folder, 'NODE').filter((node) => node.attributes.ArsenalSeratoCrateTracks === '1');
    if (matches.length > 1) throw new Error(`The crate ${path.join(' / ')} has multiple track containers.`);
    let node = matches[0];
    const taken = (name: string): boolean => incomingPaths.has(JSON.stringify([...path, name])) ||
      children(folder, 'NODE').some((child) => child !== node && child.attributes.Name === name);
    let name = node?.attributes.Name ?? '(crate tracks)';
    for (let suffix = 2; taken(name); suffix++) name = `(crate tracks) ${suffix}`;
    if (node) node.attributes.Name = name;
    else {
      node = { name: 'NODE', attributes: {
        Name: name, Type: '1', KeyType: '0', Entries: '0', ArsenalSeratoCrateTracks: '1',
      }, parts: [] };
      folder.parts.push('\n', node);
    }
    return node;
  };
  const isRegular = (node: XmlNode): boolean => node.attributes.Type === '1' && !isSmartPlaylistNode(node.attributes) &&
    !node.parts.some((part) => typeof part === 'string' && part.includes('arsenal-smart-playlist:'));
  for (const playlist of incoming.playlists) {
    if (playlist.path.length === 0 || playlist.path.some((name) => !name || [...name].some((character) => character.charCodeAt(0) < 32))) {
      throw new Error('A crate has an invalid name.');
    }
    let parent = playlistRoot;
    for (const [index, name] of playlist.path.entries()) {
      const last = index === playlist.path.length - 1;
      const currentPath = playlist.path.slice(0, index + 1);
      const folder = !last || folderPaths.has(JSON.stringify(playlist.path));
      const matches = children(parent, 'NODE').filter((node) => node.attributes.Name === name);
      if (matches.length > 1) throw new Error(`Multiple Rekordbox playlists share the path ${playlist.path.join(' / ')}.`);
      let node = matches[0];
      if (!node) {
        node = { name: 'NODE', attributes: folder ? { Name: name, Type: '0', Count: '0' }
          : { Name: name, Type: '1', KeyType: '0', Entries: '0' }, parts: [] };
        parent.parts.push('\n', node);
      }
      if (folder) {
        if (node.attributes.Type !== '0') {
          if (!isRegular(node)) throw new Error(`A smart playlist blocks the folder ${currentPath.join(' / ')}.`);
          const existing = { ...node, attributes: { ...node.attributes } };
          node.attributes = { Name: name, Type: '0', Count: '1' };
          node.parts = [];
          const memberNode = crateTrackNode(node, currentPath);
          memberNode.attributes = { ...existing.attributes, Name: memberNode.attributes.Name ?? '(crate tracks)', ArsenalSeratoCrateTracks: '1' };
          memberNode.parts = existing.parts;
        }
        if (children(node, 'NODE').some((child) => child.attributes.ArsenalSeratoCrateTracks === '1')) crateTrackNode(node, currentPath);
        parent = node;
        if (!last || playlist.trackPaths.length === 0) continue;
        node = crateTrackNode(node, currentPath);
      }
      if (node.attributes.Type === '0' && playlist.trackPaths.length === 0) continue;
      if (!isRegular(node)) {
        throw new Error(`The crate ${playlist.path.join(' / ')} conflicts with a Rekordbox folder or smart playlist.`);
      }
      if (node.attributes.KeyType !== '0' && node.attributes.KeyType !== '1') throw new Error('Unsupported Rekordbox playlist reference type.');
      const references = new Map<string, XmlNode>();
      for (const path of playlist.trackPaths) {
        const track = byPath.get(normalizePath(path));
        const key = node.attributes.KeyType === '1' ? track?.attributes.Location : track?.attributes.TrackID;
        if (key === undefined) throw new Error(`The crate references a track outside the collection: ${path}`);
        references.set(key, { name: 'TRACK', attributes: { Key: key }, parts: [] });
      }
      for (const reference of children(node, 'TRACK')) {
        const key = reference.attributes.Key;
        if (key !== undefined) references.set(key, reference);
      }
      node.parts = node.parts.filter((part) => typeof part === 'string' || part.name !== 'TRACK');
      node.parts.push(...[...references.values()].flatMap((reference) => ['\n', reference]));
      node.attributes.Entries = String(references.size);
    }
  }
  const updateCounts = (node: XmlNode): void => {
    if (node.attributes.Type === '0') node.attributes.Count = String(children(node, 'NODE').length);
    children(node, 'NODE').forEach(updateCounts);
  };
  updateCounts(playlistRoot);
  return document.prefix + render(document.root) + document.suffix;
};
