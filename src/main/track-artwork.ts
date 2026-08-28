import { stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { nativeImage } from 'electron';
// The package uses conditional ESM exports that this project's ESLint resolver misses.
// eslint-disable-next-line import/no-unresolved
import { parseFile, selectCover } from 'music-metadata';

export const TRACK_ARTWORK_SCHEME = 'cuebox-art';
export const TRACK_MEDIA_SCHEME = 'cuebox-media';

export type ArtworkAsset = Readonly<{
  bytes: ArrayBuffer;
  contentType: 'image/jpeg';
}>;

const allowedAudioExtensions = new Set([
  '.aac',
  '.aif',
  '.aifc',
  '.aiff',
  '.flac',
  '.m4a',
  '.mp2',
  '.mp3',
  '.mp4',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
  '.wv',
]);

const MAX_ACTIVE_READS = 3;
type ArtworkSize = 'thumbnail' | 'overview';

const MAX_CACHE_ENTRIES = 128;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const artworkLimits: Readonly<
  Record<ArtworkSize, Readonly<{ edge: number; bytes: number; quality: number }>>
> = {
  thumbnail: { edge: 128, bytes: 256 * 1024, quality: 82 },
  overview: { edge: 800, bytes: 2 * 1024 * 1024, quality: 88 },
};

export const isSupportedAudioPath = (filePath: string): boolean =>
  allowedAudioExtensions.has(extname(filePath).toLocaleLowerCase());

export class TrackArtworkStore {
  private readonly cache = new Map<
    string,
    Promise<ArtworkAsset | null>
  >();

  private readonly waiting: Array<() => void> = [];

  private activeReads = 0;

  constructor(
    private readonly revision: string,
    private readonly mediaPathBySongId: ReadonlyMap<string, string>,
  ) {}

  urlFor(songId: string): string | null {
    return this.mediaPathBySongId.has(songId)
      ? `${TRACK_ARTWORK_SCHEME}://cover/${this.revision}/${encodeURIComponent(songId)}`
      : null;
  }

  mediaUrlFor(songId: string): string | null {
    const mediaPath = this.mediaPathBySongId.get(songId);
    return mediaPath !== undefined && isSupportedAudioPath(mediaPath)
      ? `${TRACK_MEDIA_SCHEME}://audio/${this.revision}/${encodeURIComponent(songId)}`
      : null;
  }

  mediaPathFor(requestUrl: string): string | null {
    const songId = this.songIdFromMediaUrl(requestUrl);
    if (songId === null) {
      return null;
    }
    const mediaPath = this.mediaPathBySongId.get(songId) ?? null;
    return mediaPath !== null && isSupportedAudioPath(mediaPath)
      ? mediaPath
      : null;
  }

  async open(requestUrl: string): Promise<ArtworkAsset | null> {
    const request = this.artworkRequestFrom(requestUrl);
    if (request === null) {
      return null;
    }

    const mediaPath = this.mediaPathBySongId.get(request.songId);
    if (mediaPath === undefined) {
      return null;
    }

    const cacheKey = `${request.songId}:${request.size}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached;
    }

    const result = this.enqueue(() => this.readCover(mediaPath, request.size));
    this.cache.set(cacheKey, result);
    this.trimCache();
    return result;
  }

  private artworkRequestFrom(
    requestUrl: string,
  ): Readonly<{ songId: string; size: ArtworkSize }> | null {
    try {
      const url = new URL(requestUrl);
      if (
        url.protocol !== `${TRACK_ARTWORK_SCHEME}:` ||
        url.hostname !== 'cover' ||
        url.username ||
        url.password ||
        url.port ||
        url.hash
      ) {
        return null;
      }

      const size = url.searchParams.get('size') ?? 'thumbnail';
      if (
        (size !== 'thumbnail' && size !== 'overview') ||
        [...url.searchParams.keys()].some((key) => key !== 'size')
      ) {
        return null;
      }

      const parts = url.pathname.split('/').filter(Boolean);
      const revision = parts[0];
      const encodedSongId = parts[1];
      if (
        parts.length !== 2 ||
        revision !== this.revision ||
        encodedSongId === undefined
      ) {
        return null;
      }

      return { songId: decodeURIComponent(encodedSongId), size };
    } catch {
      return null;
    }
  }

  private songIdFromMediaUrl(requestUrl: string): string | null {
    try {
      const url = new URL(requestUrl);
      if (
        url.protocol !== `${TRACK_MEDIA_SCHEME}:` ||
        url.hostname !== 'audio' ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash
      ) {
        return null;
      }
      const parts = url.pathname.split('/').filter(Boolean);
      const encodedSongId = parts[1];
      if (
        parts.length !== 2 ||
        parts[0] !== this.revision ||
        encodedSongId === undefined
      ) {
        return null;
      }
      return decodeURIComponent(encodedSongId);
    } catch {
      return null;
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        this.activeReads += 1;
        void work()
          .then(resolve, reject)
          .finally(() => {
            this.activeReads -= 1;
            this.waiting.shift()?.();
          });
      };

      if (this.activeReads < MAX_ACTIVE_READS) {
        run();
      } else {
        this.waiting.push(run);
      }
    });
  }

  private async readCover(
    mediaPath: string,
    size: ArtworkSize,
  ): Promise<ArtworkAsset | null> {
    try {
      if (!isSupportedAudioPath(mediaPath)) {
        return null;
      }

      const file = await stat(mediaPath);
      if (!file.isFile()) {
        return null;
      }

      const metadata = await parseFile(mediaPath, { skipCovers: false });
      const picture = selectCover(metadata.common.picture);
      if (
        picture === null ||
        picture.data.byteLength === 0 ||
        picture.data.byteLength > MAX_SOURCE_BYTES
      ) {
        return null;
      }

      const source = nativeImage.createFromBuffer(Buffer.from(picture.data));
      if (source.isEmpty()) {
        return null;
      }

      const imageSize = source.getSize();
      const longestEdge = Math.max(imageSize.width, imageSize.height);
      if (longestEdge <= 0) {
        return null;
      }

      const limit = artworkLimits[size];
      const scale = Math.min(1, limit.edge / longestEdge);
      const normalized =
        scale < 1
          ? source.resize({
              width: Math.max(1, Math.round(imageSize.width * scale)),
              height: Math.max(1, Math.round(imageSize.height * scale)),
              quality: 'good',
            })
          : source;
      const jpeg = normalized.toJPEG(limit.quality);
      if (jpeg.byteLength === 0 || jpeg.byteLength > limit.bytes) {
        return null;
      }

      const bytes = new Uint8Array(jpeg.byteLength);
      bytes.set(jpeg);
      return { bytes: bytes.buffer, contentType: 'image/jpeg' };
    } catch {
      return null;
    }
  }

  private trimCache(): void {
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.cache.delete(oldestKey);
    }
  }
}
