import { stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { nativeImage } from 'electron';
// The package uses conditional ESM exports that this project's ESLint resolver misses.
// eslint-disable-next-line import/no-unresolved
import { parseFile, selectCover } from 'music-metadata';

export const TRACK_ARTWORK_SCHEME = 'cuebox-art';

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
const MAX_CACHE_ENTRIES = 96;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_EDGE = 256;

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

  async open(requestUrl: string): Promise<ArtworkAsset | null> {
    const songId = this.songIdFrom(requestUrl);
    if (songId === null) {
      return null;
    }

    const mediaPath = this.mediaPathBySongId.get(songId);
    if (mediaPath === undefined) {
      return null;
    }

    const cached = this.cache.get(songId);
    if (cached !== undefined) {
      this.cache.delete(songId);
      this.cache.set(songId, cached);
      return cached;
    }

    const result = this.enqueue(() => this.readCover(mediaPath));
    this.cache.set(songId, result);
    this.trimCache();
    return result;
  }

  private songIdFrom(requestUrl: string): string | null {
    try {
      const url = new URL(requestUrl);
      if (
        url.protocol !== `${TRACK_ARTWORK_SCHEME}:` ||
        url.hostname !== 'cover' ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash
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

  private async readCover(mediaPath: string): Promise<ArtworkAsset | null> {
    try {
      if (!allowedAudioExtensions.has(extname(mediaPath).toLocaleLowerCase())) {
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

      const size = source.getSize();
      const longestEdge = Math.max(size.width, size.height);
      if (longestEdge <= 0) {
        return null;
      }

      const scale = Math.min(1, MAX_EDGE / longestEdge);
      const normalized =
        scale < 1
          ? source.resize({
              width: Math.max(1, Math.round(size.width * scale)),
              height: Math.max(1, Math.round(size.height * scale)),
              quality: 'good',
            })
          : source;
      const jpeg = normalized.toJPEG(82);
      if (jpeg.byteLength === 0 || jpeg.byteLength > MAX_OUTPUT_BYTES) {
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
