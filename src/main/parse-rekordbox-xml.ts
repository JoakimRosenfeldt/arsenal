import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SaxesParser } from 'saxes';

import type { SongRow } from '../shared/dj-library';

export type ParsedTrack = Readonly<{
  song: SongRow;
  mediaPath: string | null;
  rekordboxId: string | null;
  rawLocation: string | null;
}>;

export type PlaylistReferenceKind =
  | 'track-id'
  | 'location'
  | 'unsupported';

export type ParsedPlaylist = Readonly<{
  id: string;
  name: string;
  kind: 'regular' | 'smart';
  folderPath: readonly string[];
  referenceKind: PlaylistReferenceKind;
  keys: readonly string[];
}>;

export type ParsedRekordboxLibrary = Readonly<{
  tracks: readonly ParsedTrack[];
  playlists: readonly ParsedPlaylist[];
  fingerprint: string;
}>;

export type RekordboxXmlFailure = 'malformed-xml' | 'not-rekordbox-xml';

export class RekordboxXmlError extends Error {
  override readonly name = 'RekordboxXmlError';

  constructor(readonly reason: RekordboxXmlFailure, message: string) {
    super(message);
  }
}

const cleanText = (value: string | undefined): string | null => {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
};

const parseNumber = ({
  value,
  allowZero,
}: Readonly<{
  value: string | undefined;
  allowZero: boolean;
}>): number | null => {
  const cleaned = value?.trim().replace(',', '.');
  if (!cleaned || !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) {
    return null;
  }

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) {
    return null;
  }

  return parsed;
};

const parseMediaPath = (value: string | undefined): string | null => {
  const location = cleanText(value);
  if (location === null) {
    return null;
  }

  try {
    const url = new URL(location);
    return url.protocol === 'file:' ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
};

const makeSong = ({
  attributes,
  rowNumber,
}: Readonly<{
  attributes: Readonly<Record<string, string>>;
  rowNumber: number;
}>): ParsedTrack => {
  return {
    song: {
      id: String(rowNumber),
      title: cleanText(attributes.Name) ?? 'Untitled track',
      artist: cleanText(attributes.Artist),
      composer: cleanText(attributes.Composer),
      remixer: cleanText(attributes.Remixer),
      album: cleanText(attributes.Album),
      mixName: cleanText(attributes.Mix),
      label: cleanText(attributes.Label),
      genre: cleanText(attributes.Genre),
      year: parseNumber({ value: attributes.Year, allowZero: false }),
      bpm: parseNumber({ value: attributes.AverageBpm, allowZero: false }),
      musicalKey: cleanText(attributes.Tonality),
      durationSeconds: parseNumber({
        value: attributes.TotalTime,
        allowZero: true,
      }),
      fileKind: cleanText(attributes.Kind),
      fileSizeBytes: parseNumber({ value: attributes.Size, allowZero: false }),
      bitRateKbps: parseNumber({ value: attributes.BitRate, allowZero: false }),
      sampleRateHz: parseNumber({
        value: attributes.SampleRate,
        allowZero: false,
      }),
      trackNumber: parseNumber({
        value: attributes.TrackNumber,
        allowZero: false,
      }),
      discNumber: parseNumber({
        value: attributes.DiscNumber,
        allowZero: false,
      }),
      playCount: parseNumber({ value: attributes.PlayCount, allowZero: true }),
      rating: parseNumber({ value: attributes.Rating, allowZero: true }),
      dateAdded: cleanText(attributes.DateAdded),
      comments: cleanText(attributes.Comments),
      artworkUrl: null,
      audioUrl: null,
    },
    mediaPath: parseMediaPath(attributes.Location),
    rekordboxId: cleanText(attributes.TrackID),
    rawLocation: cleanText(attributes.Location),
  };
};

type MutablePlaylist = {
  id: string;
  name: string;
  kind: 'regular' | 'smart';
  folderPath: string[];
  referenceKind: PlaylistReferenceKind;
  keys: string[];
};

type OpenPlaylistNode =
  | Readonly<{ kind: 'folder'; name: string }>
  | Readonly<{ kind: 'playlist'; playlist: MutablePlaylist }>;

const referenceKindFor = (keyType: string | undefined): PlaylistReferenceKind => {
  if (keyType === '0') {
    return 'track-id';
  }
  if (keyType === '1') {
    return 'location';
  }
  return 'unsupported';
};

const isEnabledMarker = (value: string | undefined): boolean => {
  const normalized = cleanText(value)?.toLocaleLowerCase();
  return normalized !== undefined &&
    normalized !== null &&
    normalized !== '0' &&
    normalized !== 'false' &&
    normalized !== 'no';
};

const isSmartPlaylistNode = (
  attributes: Readonly<Record<string, string>>,
): boolean =>
  attributes.Type === '2' ||
  attributes.LogicalOperator !== undefined ||
  isEnabledMarker(
    attributes.SmartList ??
      attributes.SmartPlaylist ??
      attributes.Intelligent ??
      attributes.IsSmart,
  );

export const parseRekordboxXml = async (
  filePath: string,
): Promise<ParsedRekordboxLibrary> => {
  const tracks: ParsedTrack[] = [];
  const playlists: MutablePlaylist[] = [];
  const playlistNodeStack: OpenPlaylistNode[] = [];
  const elementStack: string[] = [];
  const fingerprint = createHash('sha256');
  let rootSeen = false;
  let collectionSeen = false;

  const parser = new SaxesParser({ xmlns: false });

  parser.on('error', (error) => {
    throw new RekordboxXmlError('malformed-xml', error.message);
  });

  parser.on('xmldecl', (declaration) => {
    const encoding = declaration.encoding?.toLowerCase();
    if (encoding && encoding !== 'utf-8' && encoding !== 'utf8') {
      throw new RekordboxXmlError(
        'not-rekordbox-xml',
        'Only UTF-8 Rekordbox exports are accepted',
      );
    }
  });

  parser.on('doctype', () => {
    throw new RekordboxXmlError(
      'not-rekordbox-xml',
      'Document type declarations are not accepted',
    );
  });

  parser.on('opentag', (tag) => {
    if (!rootSeen) {
      if (tag.name !== 'DJ_PLAYLISTS') {
        throw new RekordboxXmlError(
          'not-rekordbox-xml',
          'Expected a DJ_PLAYLISTS root element',
        );
      }
      rootSeen = true;
    }

    const isCollection =
      tag.name === 'COLLECTION' &&
      elementStack.length === 1 &&
      elementStack[0] === 'DJ_PLAYLISTS';

    if (isCollection && collectionSeen) {
      throw new RekordboxXmlError(
        'not-rekordbox-xml',
        'Expected exactly one Rekordbox Collection',
      );
    }

    if (isCollection) {
      collectionSeen = true;
    }

    const isCollectionTrack =
      tag.name === 'TRACK' &&
      elementStack.length === 2 &&
      elementStack[0] === 'DJ_PLAYLISTS' &&
      elementStack[1] === 'COLLECTION';

    if (isCollectionTrack) {
      tracks.push(
        makeSong({
          attributes: tag.attributes,
          rowNumber: tracks.length + 1,
        }),
      );
    }

    const isPlaylistNode =
      tag.name === 'NODE' &&
      elementStack.length >= 2 &&
      elementStack[0] === 'DJ_PLAYLISTS' &&
      elementStack[1] === 'PLAYLISTS' &&
      elementStack.slice(2).every((name) => name === 'NODE');

    if (isPlaylistNode) {
      const name = cleanText(tag.attributes.Name) ?? 'Untitled playlist';
      const smart = isSmartPlaylistNode(tag.attributes);
      if (tag.attributes.Type === '1' || smart) {
        const folders = playlistNodeStack
          .filter((node): node is Extract<OpenPlaylistNode, { kind: 'folder' }> =>
            node.kind === 'folder',
          )
          .map((node) => node.name);
        const playlist: MutablePlaylist = {
          id: `playlist-${playlists.length + 1}`,
          name,
          kind: smart ? 'smart' : 'regular',
          folderPath: folders.slice(1),
          referenceKind: referenceKindFor(tag.attributes.KeyType),
          keys: [],
        };
        playlists.push(playlist);
        playlistNodeStack.push({ kind: 'playlist', playlist });
      } else {
        playlistNodeStack.push({ kind: 'folder', name });
      }
    }

    const currentPlaylistNode = playlistNodeStack.at(-1);
    if (
      currentPlaylistNode?.kind === 'playlist' &&
      (tag.name === 'CONDITION' || tag.name === 'SMARTLIST')
    ) {
      currentPlaylistNode.playlist.kind = 'smart';
    }
    const isPlaylistTrack =
      tag.name === 'TRACK' &&
      elementStack.at(-1) === 'NODE' &&
      currentPlaylistNode?.kind === 'playlist';
    if (isPlaylistTrack) {
      const key = cleanText(tag.attributes.Key);
      if (key !== null) {
        currentPlaylistNode.playlist.keys.push(key);
      }
    }

    elementStack.push(tag.name);
  });

  parser.on('closetag', (tag) => {
    const opened = elementStack.pop();
    if (opened !== tag.name) {
      throw new RekordboxXmlError(
        'malformed-xml',
        'The XML element order is invalid',
      );
    }
    if (tag.name === 'NODE') {
      playlistNodeStack.pop();
    }
  });

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  for await (const rawChunk of stream) {
    const chunk: unknown = rawChunk;
    if (typeof chunk !== 'string') {
      throw new RekordboxXmlError(
        'malformed-xml',
        'Expected UTF-8 text input',
      );
    }
    fingerprint.update(chunk, 'utf8');
    parser.write(chunk);
  }
  parser.close();

  if (!rootSeen || !collectionSeen) {
    throw new RekordboxXmlError(
      'not-rekordbox-xml',
      'The XML does not contain a Rekordbox Collection',
    );
  }

  return {
    tracks,
    playlists,
    fingerprint: fingerprint.digest('hex'),
  };
};
