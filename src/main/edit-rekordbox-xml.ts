import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { SaxesParser, type SaxesTagPlain } from 'saxes';
import type { SmartPlaylistDefinition } from '../shared/smart-playlists';
import { isSmartPlaylistNode } from './parse-rekordbox-xml';

export type RekordboxXmlEdit =
  | Readonly<{
      kind: 'remove-tracks';
      tracks: readonly Readonly<{
        trackId: string | null;
        rawLocation: string | null;
      }>[];
    }>
  | Readonly<{
      kind: 'create-playlist';
      name: string;
      trackIds: readonly string[];
      parentFolderId: string | null;
      smartDefinition: SmartPlaylistDefinition | null;
    }>
  | Readonly<{
      kind: 'create-folder';
      name: string;
      parentFolderId: string | null;
    }>
  | Readonly<{
      kind: 'set-playlist-tracks';
      playlistId: string;
      tracks: readonly Readonly<{
        trackId: string | null;
        rawLocation: string | null;
      }>[];
    }>
  | Readonly<{
      kind: 'update-smart-playlist';
      playlistId: string;
      name: string;
      trackIds: readonly string[];
      smartDefinition: SmartPlaylistDefinition;
    }>;

export type RekordboxWriteFailure =
  | 'source-changed'
  | 'target-not-found'
  | 'invalid-document'
  | 'cannot-write';

export class RekordboxWriteError extends Error {
  override readonly name = 'RekordboxWriteError';

  constructor(readonly reason: RekordboxWriteFailure, message: string) {
    super(message);
  }
}

type ElementSpan = {
  kind: 'element';
  name: string;
  attributes: Readonly<Record<string, string>>;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  selfClosing: boolean;
};

type PlaylistNodeSpan = Omit<ElementSpan, 'kind'> & {
  kind: 'playlist-node';
  id: string;
  nodeType: string | null;
  keyType: string | null;
  childNodeCount: number;
  trackReferences: ElementSpan[];
};

type XmlSpan = ElementSpan | PlaylistNodeSpan;

type XmlIndex = Readonly<{
  collection: ElementSpan;
  collectionTracks: readonly ElementSpan[];
  playlists: ElementSpan;
  playlistNodes: readonly PlaylistNodeSpan[];
  rootPlaylistNode: PlaylistNodeSpan;
}>;

type Replacement = Readonly<{
  start: number;
  end: number;
  text: string;
}>;

const requireElement = (
  span: ElementSpan | null,
  label: string,
): ElementSpan => {
  if (span === null) {
    throw new RekordboxWriteError('invalid-document', `Missing ${label}`);
  }
  return span;
};

const requirePlaylistNode = (
  span: PlaylistNodeSpan | null,
): PlaylistNodeSpan => {
  if (span === null) {
    throw new RekordboxWriteError(
      'invalid-document',
      'Missing playlist root',
    );
  }
  return span;
};

const fingerprintFor = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const isPlaylistNodePath = (stack: readonly XmlSpan[]): boolean =>
  stack.length >= 2 &&
  stack[0]?.name === 'DJ_PLAYLISTS' &&
  stack[1]?.name === 'PLAYLISTS' &&
  stack.slice(2).every((span) => span.name === 'NODE');

const scanXml = (source: string): XmlIndex => {
  const parser = new SaxesParser({ xmlns: false });
  const stack: XmlSpan[] = [];
  const collectionTracks: ElementSpan[] = [];
  const playlistNodes: PlaylistNodeSpan[] = [];
  let pendingStart = 0;
  let collection: ElementSpan | null = null;
  let playlists: ElementSpan | null = null;
  let rootPlaylistNode: PlaylistNodeSpan | null = null;
  let parseError: Error | null = null;
  let folderCount = 0;
  let playlistCount = 0;

  parser.on('error', (error) => {
    parseError = error;
  });

  parser.on('opentagstart', (tag) => {
    pendingStart = parser.position - tag.name.length - 2;
  });

  parser.on('opentag', (tag: SaxesTagPlain) => {
    const parent = stack.at(-1);
    const common = {
      name: tag.name,
      attributes: tag.attributes,
      start: pendingStart,
      openEnd: parser.position,
      closeStart: parser.position,
      end: parser.position,
      selfClosing: tag.isSelfClosing,
    };
    const span: XmlSpan =
      tag.name === 'NODE' && isPlaylistNodePath(stack)
        ? {
            kind: 'playlist-node',
            id: tag.attributes.Type === '1' || isSmartPlaylistNode(tag.attributes)
              ? `playlist-${++playlistCount}`
              : parent === playlists ? 'root' : `folder-${++folderCount}`,
            ...common,
            nodeType: tag.attributes.Type ?? null,
            keyType: tag.attributes.KeyType ?? null,
            childNodeCount: 0,
            trackReferences: [],
          }
        : { kind: 'element', ...common };

    if (
      span.kind === 'element' &&
      span.name === 'COLLECTION' &&
      stack.length === 1 &&
      stack[0]?.name === 'DJ_PLAYLISTS'
    ) {
      collection = span;
    }
    if (
      span.kind === 'element' &&
      span.name === 'PLAYLISTS' &&
      stack.length === 1 &&
      stack[0]?.name === 'DJ_PLAYLISTS'
    ) {
      playlists = span;
    }
    if (
      span.kind === 'element' &&
      span.name === 'TRACK' &&
      parent === collection
    ) {
      collectionTracks.push(span);
    }
    if (span.kind === 'playlist-node') {
      playlistNodes.push(span);
      if (parent?.kind === 'playlist-node') {
        parent.childNodeCount += 1;
      }
      if (
        parent === playlists &&
        span.nodeType === '0' &&
        rootPlaylistNode === null
      ) {
        rootPlaylistNode = span;
      }
    }
    if (
      span.kind === 'element' &&
      span.name === 'TRACK' &&
      parent?.kind === 'playlist-node'
    ) {
      parent.trackReferences.push(span);
    }

    stack.push(span);
  });

  parser.on('closetag', (tag) => {
    const span = stack.pop();
    if (span === undefined || span.name !== tag.name) {
      parseError = new Error('Mismatched XML element');
      return;
    }

    span.end = parser.position;
    span.closeStart = tag.isSelfClosing
      ? Math.max(span.start, span.end - 2)
      : source.lastIndexOf('</', span.end - 1);
  });

  try {
    parser.write(source).close();
  } catch (error: unknown) {
    parseError = error instanceof Error ? error : new Error('Invalid XML');
  }

  if (parseError !== null) {
    throw new RekordboxWriteError('invalid-document', parseError.message);
  }
  const foundCollection = requireElement(collection, 'Collection');
  const foundPlaylists = requireElement(playlists, 'playlists');
  const foundRootPlaylistNode = requirePlaylistNode(rootPlaylistNode);
  if (
    foundCollection.end <= foundCollection.start ||
    foundPlaylists.end <= foundPlaylists.start ||
    foundRootPlaylistNode.end <= foundRootPlaylistNode.start ||
    (!foundRootPlaylistNode.selfClosing &&
      foundRootPlaylistNode.closeStart < foundRootPlaylistNode.openEnd)
  ) {
    throw new RekordboxWriteError(
      'invalid-document',
      'The XML is missing its Collection or playlist root',
    );
  }

  return {
    collection: foundCollection,
    collectionTracks,
    playlists: foundPlaylists,
    playlistNodes,
    rootPlaylistNode: foundRootPlaylistNode,
  };
};

const escapeXmlAttribute = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const replaceAttribute = (
  source: string,
  name: string,
  value: string,
): string => {
  const attribute = new RegExp(`(\\s${name}\\s*=\\s*)(["'])(.*?)\\2`, 's');
  const match = attribute.exec(source);
  const escaped = escapeXmlAttribute(value);
  if (match !== null) {
    const prefix = match[1];
    const quote = match[2];
    const previousValue = match[3];
    if (prefix !== undefined && quote !== undefined && previousValue !== undefined) {
      const valueStart = match.index + prefix.length + quote.length;
      return `${source.slice(0, valueStart)}${escaped}${source.slice(
        valueStart + previousValue.length,
      )}`;
    }
  }

  const closeIndex = source.lastIndexOf(source.trimEnd().endsWith('/>') ? '/>' : '>');
  if (closeIndex < 0) {
    throw new RekordboxWriteError('invalid-document', 'Invalid opening tag');
  }
  return `${source.slice(0, closeIndex)} ${name}="${escaped}"${source.slice(closeIndex)}`;
};

const openingReplacement = (
  source: string,
  span: XmlSpan,
  name: string,
  value: string,
): Replacement => ({
  start: span.start,
  end: span.openEnd,
  text: replaceAttribute(source.slice(span.start, span.openEnd), name, value),
});

const removalReplacement = (
  source: string,
  span: ElementSpan,
): Replacement => {
  const lineStart = source.lastIndexOf('\n', span.start - 1) + 1;
  const prefix = source.slice(lineStart, span.start);
  const start = /^[\t ]*$/.test(prefix) ? lineStart : span.start;
  let end = span.end;
  if (source.startsWith('\r\n', end)) {
    end += 2;
  } else if (source[end] === '\n') {
    end += 1;
  }
  return { start, end, text: '' };
};

const applyReplacements = (
  source: string,
  replacements: readonly Replacement[],
): string => {
  const ordered = [...replacements].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.start < previous.end
    ) {
      throw new RekordboxWriteError(
        'invalid-document',
        'Overlapping XML edits were rejected',
      );
    }
  }

  return ordered
    .reverse()
    .reduce(
      (result, replacement) =>
        `${result.slice(0, replacement.start)}${replacement.text}${result.slice(
          replacement.end,
        )}`,
      source,
    );
};

const removeTracks = (
  source: string,
  index: XmlIndex,
  edit: Extract<RekordboxXmlEdit, { kind: 'remove-tracks' }>,
): string => {
  const targets = new Set<ElementSpan>();
  for (const selected of edit.tracks) {
    const matchingTracks = index.collectionTracks.filter((track) =>
      selected.trackId !== null
        ? track.attributes.TrackID === selected.trackId
        : selected.rawLocation !== null && track.attributes.Location === selected.rawLocation,
    );
    const target = matchingTracks[0];
    if (matchingTracks.length !== 1 || target === undefined || targets.has(target)) {
      throw new RekordboxWriteError(
        'target-not-found',
        'A selected track no longer has one exact XML match',
      );
    }
    targets.add(target);
  }
  if (targets.size === 0) {
    throw new RekordboxWriteError(
      'target-not-found',
      'No tracks were selected',
    );
  }

  const replacements: Replacement[] = [
    ...[...targets].map((target) => removalReplacement(source, target)),
    openingReplacement(
      source,
      index.collection,
      'Entries',
      String(index.collectionTracks.length - targets.size),
    ),
  ];

  for (const playlist of index.playlistNodes) {
    const keys = new Set(edit.tracks.flatMap((track) => {
      const key = playlist.keyType === '0'
        ? track.trackId
        : playlist.keyType === '1'
          ? track.rawLocation
          : null;
      return key === null ? [] : [key];
    }));
    const references = playlist.trackReferences.filter(
      (track) => keys.has(track.attributes.Key ?? ''),
    );
    if (references.length === 0) {
      continue;
    }
    replacements.push(
      ...references.map((reference) => removalReplacement(source, reference)),
      openingReplacement(
        source,
        playlist,
        'Entries',
        String(playlist.trackReferences.length - references.length),
      ),
    );
  }

  return applyReplacements(source, replacements);
};

const lineIndentAt = (source: string, position: number): string => {
  const lineStart = source.lastIndexOf('\n', position - 1) + 1;
  const indent = source.slice(lineStart, position);
  return /^[\t ]*$/.test(indent) ? indent : '';
};

const playlistMarkup = ({
  indent,
  name,
  newline,
  trackIds,
  smartDefinition,
}: Readonly<{
  indent: string;
  name: string;
  newline: string;
  trackIds: readonly string[];
  smartDefinition: SmartPlaylistDefinition | null;
}>): string => {
  const opening = `<NODE Name="${escapeXmlAttribute(name)}" Type="1" KeyType="0" Entries="${trackIds.length}">`;
  if (trackIds.length === 0 && smartDefinition === null) {
    return opening.replace(/>$/, '/>');
  }
  const trackIndent = `${indent}  `;
  const tracks = trackIds
    .map((trackId) => `${trackIndent}<TRACK Key="${escapeXmlAttribute(trackId)}"/>`)
    .join(newline);
  const rules = smartDefinition === null ? '' : `${trackIndent}<!--arsenal-smart-playlist:${Buffer.from(JSON.stringify(smartDefinition)).toString('base64')}-->${newline}`;
  return `${opening}${newline}${rules}${tracks}${newline}${indent}</NODE>`;
};

const createNode = (
  source: string,
  index: XmlIndex,
  edit: Extract<RekordboxXmlEdit, { kind: 'create-playlist' | 'create-folder' }>,
): string => {
  const root = edit.parentFolderId === null ? index.rootPlaylistNode : index.playlistNodes.find((node) => node.id === edit.parentFolderId && node.id.startsWith('folder-'));
  if (root === undefined) throw new RekordboxWriteError('target-not-found', 'The destination folder no longer exists');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const rootIndent = lineIndentAt(source, root.start);
  const childIndent = `${rootIndent}  `;
  const markup = edit.kind === 'create-folder' ? `<NODE Name="${escapeXmlAttribute(edit.name)}" Type="0" Count="0"/>` : playlistMarkup({
    indent: childIndent,
    name: edit.name,
    newline,
    trackIds: edit.trackIds,
    smartDefinition: edit.smartDefinition,
  });
  const nextCount = String(root.childNodeCount + 1);

  if (root.selfClosing) {
    const opening = replaceAttribute(
      source.slice(root.start, root.openEnd),
      'Count',
      nextCount,
    ).replace(/\/\s*>$/, '>');
    return applyReplacements(source, [
      {
        start: root.start,
        end: root.end,
        text: `${opening}${newline}${childIndent}${markup}${newline}${rootIndent}</NODE>`,
      },
    ]);
  }

  let whitespaceStart = root.closeStart;
  while (
    whitespaceStart > root.openEnd &&
    /\s/.test(source[whitespaceStart - 1] ?? '')
  ) {
    whitespaceStart -= 1;
  }

  return applyReplacements(source, [
    openingReplacement(source, root, 'Count', nextCount),
    {
      start: whitespaceStart,
      end: root.closeStart,
      text: `${newline}${childIndent}${markup}${newline}${rootIndent}`,
    },
  ]);
};

const setPlaylistTracks = (
  source: string,
  index: XmlIndex,
  edit: Extract<RekordboxXmlEdit, { kind: 'set-playlist-tracks' }>,
): string => {
  const node = index.playlistNodes.find((candidate) => candidate.id === edit.playlistId);
  if (node === undefined || node.nodeType !== '1' || isSmartPlaylistNode(node.attributes) ||
    (node.keyType !== '0' && node.keyType !== '1')) {
    throw new RekordboxWriteError('target-not-found', 'The regular playlist no longer exists');
  }
  const collectionKeys = new Map<string, number>();
  for (const track of index.collectionTracks) {
    const key = (node.keyType === '0' ? track.attributes.TrackID : track.attributes.Location)?.trim();
    if (key) collectionKeys.set(key, (collectionKeys.get(key) ?? 0) + 1);
  }
  const keys: string[] = [];
  for (const track of edit.tracks) {
    const key = node.keyType === '0' ? track.trackId : track.rawLocation;
    if (key === null || collectionKeys.get(key) !== 1) {
      throw new RekordboxWriteError('target-not-found', 'A track does not have one exact collection reference');
    }
    keys.push(key);
  }
  const keySet = new Set(keys);
  if (keySet.size !== keys.length || keys.length > 10_000) {
    throw new RekordboxWriteError('target-not-found', 'Invalid playlist track selection');
  }

  const referencesByKey = new Map<string, ElementSpan[]>();
  const editableReferences = node.trackReferences.filter((reference) => {
    const key = reference.attributes.Key?.trim() ?? '';
    if (!keySet.has(key)) return false;
    const references = referencesByKey.get(key) ?? [];
    references.push(reference);
    referencesByKey.set(key, references);
    return true;
  });
  const orderedMarkup = keys.flatMap((key) => {
    const references = referencesByKey.get(key);
    return references === undefined
      ? [`<TRACK Key="${escapeXmlAttribute(key)}"/>`]
      : references.map((reference) => source.slice(reference.start, reference.end));
  });
  const count = node.trackReferences.length + orderedMarkup.length - editableReferences.length;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const indent = lineIndentAt(source, node.start);
  const trackIndent = `${indent}  `;
  if (node.selfClosing && orderedMarkup.length > 0) {
    const opening = replaceAttribute(source.slice(node.start, node.openEnd), 'Entries', String(count)).replace(/\/\s*>$/, '>');
    return applyReplacements(source, [{
      start: node.start,
      end: node.end,
      text: `${opening}${newline}${trackIndent}${orderedMarkup.join(`${newline}${trackIndent}`)}${newline}${indent}</NODE>`,
    }]);
  }

  const replacements: Replacement[] = [openingReplacement(source, node, 'Entries', String(count))];
  // Only replace visible references, keeping hidden tracks and unknown XML children in place.
  for (const [position, reference] of editableReferences.entries()) {
    const markup = orderedMarkup[position];
    if (markup !== undefined) replacements.push({ start: reference.start, end: reference.end, text: markup });
  }
  const extraMarkup = orderedMarkup.slice(editableReferences.length);
  if (extraMarkup.length > 0) {
    const lastReference = editableReferences.at(-1);
    let start = lastReference?.end ?? node.closeStart;
    const end = start;
    if (lastReference === undefined) {
      while (start > node.openEnd && /\s/.test(source[start - 1] ?? '')) start -= 1;
    }
    replacements.push({
      start,
      end,
      text: `${newline}${trackIndent}${extraMarkup.join(`${newline}${trackIndent}`)}${lastReference === undefined ? `${newline}${indent}` : ''}`,
    });
  }
  return applyReplacements(source, replacements);
};

const editedXml = (source: string, edit: RekordboxXmlEdit): string => {
  const index = scanXml(source);
  let edited: string;
  if (edit.kind === 'remove-tracks') {
    edited = removeTracks(source, index, edit);
  } else if (edit.kind === 'set-playlist-tracks') {
    edited = setPlaylistTracks(source, index, edit);
  } else if (edit.kind === 'update-smart-playlist') {
    const node = index.playlistNodes.find((candidate) => candidate.id === edit.playlistId);
    if (node === undefined) throw new RekordboxWriteError('target-not-found', 'The playlist no longer exists');
    edited = applyReplacements(source, [{ start: node.start, end: node.end, text: playlistMarkup({
      indent: lineIndentAt(source, node.start), name: edit.name, newline: source.includes('\r\n') ? '\r\n' : '\n',
      trackIds: edit.trackIds, smartDefinition: edit.smartDefinition,
    }) }]);
  } else {
    edited = createNode(source, index, edit);
  }
  scanXml(edited);
  return edited;
};

export const editRekordboxXml = async ({
  edit,
  expectedFingerprint,
  filePath,
}: Readonly<{
  edit: RekordboxXmlEdit;
  expectedFingerprint: string;
  filePath: string;
}>): Promise<void> => {
  let tempPath: string | null = null;
  try {
    const bytes = await readFile(filePath);
    if (fingerprintFor(bytes) !== expectedFingerprint) {
      throw new RekordboxWriteError(
        'source-changed',
        'The Rekordbox XML changed outside Arsenal',
      );
    }

    const source = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const nextSource = editedXml(source, edit);
    const sourceStat = await stat(filePath);
    tempPath = join(
      dirname(filePath),
      `.${basename(filePath)}.${randomUUID()}.tmp`,
    );
    const temp = await open(tempPath, 'wx', sourceStat.mode & 0o777);
    try {
      await temp.writeFile(nextSource, 'utf8');
      await temp.sync();
    } finally {
      await temp.close();
    }

    const latestBytes = await readFile(filePath);
    if (fingerprintFor(latestBytes) !== expectedFingerprint) {
      throw new RekordboxWriteError(
        'source-changed',
        'The Rekordbox XML changed while Arsenal was saving',
      );
    }
    await rename(tempPath, filePath);
    tempPath = null;
  } catch (error: unknown) {
    if (error instanceof RekordboxWriteError) {
      throw error;
    }
    throw new RekordboxWriteError(
      'cannot-write',
      error instanceof Error ? error.message : 'Could not write the XML',
    );
  } finally {
    if (tempPath !== null) {
      try {
        await unlink(tempPath);
      } catch {
        // The exact temporary file may already have been moved or removed.
      }
    }
  }
};
