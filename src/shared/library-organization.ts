import type { SongRow } from './dj-library';

export const ORGANIZATION_FIELDS = [
  { value: 'artist', label: 'Artist' }, { value: 'album', label: 'Album' },
  { value: 'genre', label: 'Genre' }, { value: 'year', label: 'Release year' },
  { value: 'label', label: 'Label' }, { value: 'title', label: 'Title' },
  { value: 'trackNumber', label: 'Track number' }, { value: 'discNumber', label: 'Disc number' },
  { value: 'bpm', label: 'BPM' }, { value: 'musicalKey', label: 'Key' },
  { value: 'dateAddedYear', label: 'Date added: year' }, { value: 'dateAddedMonth', label: 'Date added: month' },
] as const;
export type OrganizationField = (typeof ORGANIZATION_FIELDS)[number]['value'];
export const ARTIST_SEPARATORS = [
  { value: 'featured', label: 'feat. / ft. / featuring', pattern: '\\s+(?:feat\\.?|ft\\.?|featuring)\\s+' },
  { value: 'semicolon', label: 'Semicolon ;', pattern: ';\\s*' },
  { value: 'comma', label: 'Comma ,', pattern: ',\\s*' },
  { value: 'ampersand', label: 'Spaced ampersand &', pattern: '\\s+&\\s+' },
  { value: 'x', label: 'Spaced x', pattern: '\\s+x\\s+' },
  { value: 'slash', label: 'Spaced slash /', pattern: '\\s+/\\s+' },
] as const;
export type ArtistSeparator = (typeof ARTIST_SEPARATORS)[number]['value'];
export const FILENAME_SEPARATORS = [' - ', '_', ' ', '.'] as const;
export type LibraryOrganizationLayout = Readonly<{
  folders: readonly OrganizationField[];
  filename: Readonly<{ kind: 'original' }> | Readonly<{ kind: 'fields'; fields: readonly OrganizationField[]; separator: (typeof FILENAME_SEPARATORS)[number] }>;
  artists: Readonly<{ kind: 'all' }> | Readonly<{ kind: 'main'; separators: readonly ArtistSeparator[] }>;
}>;

export const readOrganizationLayout = (value: unknown): LibraryOrganizationLayout => {
  const invalid = () => new Error('Choose up to eight folder levels, filename fields, and valid artist options.');
  const choices = <T extends string>(raw: unknown, allowed: readonly T[], minimum = 0): T[] => {
    if (!Array.isArray(raw) || raw.length < minimum || raw.length > 8) throw invalid();
    return raw.map((item: unknown) => {
      const found = allowed.find((option) => option === item);
      if (found === undefined) throw invalid();
      return found;
    });
  };
  if (typeof value !== 'object' || value === null || !('folders' in value) || !('filename' in value) || !('artists' in value)) throw invalid();
  const folders = choices(value.folders, ORGANIZATION_FIELDS.map((field) => field.value));
  const rawFilename = value.filename;
  if (typeof rawFilename !== 'object' || rawFilename === null || !('kind' in rawFilename)) throw invalid();
  let filename: LibraryOrganizationLayout['filename'];
  if (rawFilename.kind === 'original') filename = { kind: 'original' };
  else if (rawFilename.kind === 'fields' && 'fields' in rawFilename && 'separator' in rawFilename) {
    const separator = FILENAME_SEPARATORS.find((separator) => separator === rawFilename.separator);
    if (separator === undefined) throw invalid();
    filename = { kind: 'fields', fields: choices(rawFilename.fields, ORGANIZATION_FIELDS.map((field) => field.value), 1), separator };
  } else throw invalid();
  const artists = value.artists;
  if (typeof artists !== 'object' || artists === null || !('kind' in artists)) throw invalid();
  if (artists.kind === 'all') return { folders, filename, artists: { kind: 'all' } };
  if (artists.kind === 'main' && 'separators' in artists) return { folders, filename,
    artists: { kind: 'main', separators: choices(artists.separators, ARTIST_SEPARATORS.map((separator) => separator.value)) } };
  throw invalid();
};

export const organizationArtist = (artist: string | null, rule: LibraryOrganizationLayout['artists']): string => {
  const credit = artist?.trim() || 'Unknown Artist';
  if (rule.kind === 'all') return credit;
  const patterns = ARTIST_SEPARATORS.filter((separator) => rule.separators.includes(separator.value)).map((separator) => separator.pattern);
  return patterns.length ? credit.split(new RegExp(patterns.join('|'), 'i'))[0]?.trim() || credit : credit;
};

type OrganizationMetadata = Pick<SongRow, 'artist' | 'album' | 'genre' | 'year' | 'label' | 'title' | 'trackNumber' | 'discNumber' | 'bpm' | 'musicalKey' | 'dateAdded'>;

export const organizationFieldValue = (song: OrganizationMetadata, field: OrganizationField, artists: LibraryOrganizationLayout['artists']): string => {
  switch (field) {
    case 'artist': return organizationArtist(song.artist, artists);
    case 'album': return song.album?.trim() || 'Unknown Album';
    case 'genre': return song.genre?.trim() || 'Unknown Genre';
    case 'label': return song.label?.trim() || 'Unknown Label';
    case 'title': return song.title.trim() || 'Unknown Title';
    case 'musicalKey': return song.musicalKey?.trim() || 'Unknown Key';
    case 'year': return song.year ? String(song.year) : 'Unknown Year';
    case 'bpm': return song.bpm ? String(song.bpm) : 'Unknown BPM';
    case 'trackNumber': return song.trackNumber ? String(song.trackNumber).padStart(2, '0') : 'Unknown Track';
    case 'discNumber': return song.discNumber ? String(song.discNumber).padStart(2, '0') : 'Unknown Disc';
    case 'dateAddedYear':
    case 'dateAddedMonth': {
      const date = song.dateAdded === null ? NaN : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(song.dateAdded) ? `${song.dateAdded}T00:00:00` : song.dateAdded);
      return Number.isFinite(date) ? field === 'dateAddedYear' ? String(new Date(date).getFullYear()) : String(new Date(date).getMonth() + 1).padStart(2, '0')
        : field === 'dateAddedYear' ? 'Unknown Year' : 'Unknown Month';
    }
    default: { const unexpected: never = field; throw new Error(`Unknown path field: ${unexpected}`); }
  }
};
