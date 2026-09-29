export const MUSIC_ORGANIZATION_OPTIONS = [
  { value: 'none', label: 'All music in one folder', example: 'Music/Track.mp3' },
  { value: 'artist', label: 'Artist', example: 'Music/Artist/Track.mp3' },
  { value: 'album', label: 'Album', example: 'Music/Album/Track.mp3' },
  { value: 'artist-album', label: 'Artist and album', example: 'Music/Artist/Album/Track.mp3' },
  { value: 'genre', label: 'Genre', example: 'Music/Genre/Track.mp3' },
  { value: 'label', label: 'Label', example: 'Music/Label/Track.mp3' },
] as const;

export type MusicOrganization = (typeof MUSIC_ORGANIZATION_OPTIONS)[number]['value'];

export const readMusicOrganization = (value: unknown): MusicOrganization => {
  if (value === undefined) return 'artist';
  const option = MUSIC_ORGANIZATION_OPTIONS.find((candidate) => candidate.value === value);
  if (option === undefined) throw new Error('Choose how to organize the music folder.');
  return option.value;
};

export type BackupConnection = Readonly<{
  id: string;
  directory: string;
  manifestPath: string | null;
  includeMusic: boolean;
  musicOrganization: MusicOrganization;
  state: 'ready' | 'saving' | 'error';
  lastSavedAt: string | null;
  message: string | null;
}>;

export type BackupConfiguration =
  | Readonly<{ kind: 'connect'; includeMusic: boolean; musicOrganization: MusicOrganization }>
  | Readonly<{ kind: 'update'; id: string; includeMusic: boolean; musicOrganization: MusicOrganization }>;
