import { extname } from 'node:path';

// Rekordbox Cloud Library Sync stores tracks under a virtual "/contents_<id>/<artist>/<album>/<file>" path whose file name is
// lowercased and cut to about 44 characters. Its recorded file size goes stale when tags are rewritten, so a cloud track
// matches a local file by name and length instead.
export const isCloudPath = (path: string): boolean => /^\/contents_\d+\//.test(path.replaceAll('\\', '/'));

const nameParts = (name: string): { stem: string; ext: string } => {
  const lower = name.normalize('NFC').toLowerCase();
  const ext = extname(lower);
  return { stem: lower.slice(0, lower.length - ext.length), ext };
};

const indexKey = (name: string): string => {
  const { stem, ext } = nameParts(name);
  return `${ext}:${stem.slice(0, 20)}`;
};

const sameName = (cloudName: string, localName: string): boolean => {
  const cloud = nameParts(cloudName);
  const local = nameParts(localName);
  return cloud.ext === local.ext && (local.stem === cloud.stem || cloud.stem.length >= 40 && local.stem.startsWith(cloud.stem));
};

// Returns a lookup over entries that are all cloud tracks (or all local files), answering the one value matching the other kind.
export const cloudMatcher = <T>(entries: readonly Readonly<{ name: string; length: number | null; value: T }>[], entriesAreCloud: boolean) => {
  const index = new Map<string, (typeof entries)[number][]>();
  for (const entry of entries) index.set(indexKey(entry.name), [...index.get(indexKey(entry.name)) ?? [], entry]);
  return (name: string, length: number | null): T | undefined => {
    const values = new Set((index.get(indexKey(name)) ?? []).filter((entry) =>
      (entriesAreCloud ? sameName(entry.name, name) : sameName(name, entry.name)) &&
      (entry.length === null || length === null || Math.abs(entry.length - length) <= 1)).map((entry) => entry.value));
    // Several different matches are ambiguous.
    return values.size === 1 ? values.values().next().value : undefined;
  };
};
