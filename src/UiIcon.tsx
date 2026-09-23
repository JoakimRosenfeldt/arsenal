import type { JSX } from 'react';

const paths = {
  filters: 'M4 7h16 M7 12h10 M10 17h4',
  columns: 'M3 4h18v16H3Z M9 4v16 M15 4v16',
  download: 'M12 3v12 m-4-4 4 4 4-4 M5 16v5h14v-5',
  upload: 'M12 16V4 m-4 4 4-4 4 4 M5 16v5h14v-5',
  refresh: 'M20 7a8 8 0 1 0 0 10 M20 3v5h-5',
  check: 'm5 12 4 4L19 6',
  'chevron-down': 'm6 9 6 6 6-6',
  grip: 'M9 5h.01 M9 12h.01 M9 19h.01 M15 5h.01 M15 12h.01 M15 19h.01',
  info: 'M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  plus: 'M12 5v14 M5 12h14',
  music: 'M9 18V5l12-2v13 M9 8l12-2 M9 18a3 3 0 1 1-3-3c1.66 0 3 1.34 3 3 M21 16a3 3 0 1 1-3-3c1.66 0 3 1.34 3 3',
  playlist: 'M3 6h12 M3 12h12 M3 18h6 M18 6v12 M18 12l3-1 M18 18a3 3 0 1 1-3-3c1.66 0 3 1.34 3 3',
  folder: 'M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z',
  'chevron-right': 'm9 18 6-6-6-6',
  settings: 'M4 6h4 M12 6h8 M4 18h8 M16 18h4 M8 3v6h4V3Z M12 15v6h4v-6Z',
  previous: 'M19 20 9 12l10-8v16Z M5 19V5',
  next: 'm5 4 10 8-10 8V4Z M19 5v14',
  play: 'm8 5 11 7-11 7V5Z',
  pause: 'M6 4h4v16H6Z M14 4h4v16h-4Z',
  volume: 'm11 5-6 4H2v6h3l6 4V5Z M15.5 8.5a5 5 0 0 1 0 7 M19 5a10 10 0 0 1 0 14',
  muted: 'm11 5-6 4H2v6h3l6 4V5Z m6 4 5 6 m0-6-5 6',
  close: 'm6 6 12 12 M6 18 18 6',
} satisfies Record<string, string>;

export const UiIcon = ({ name, size = 18 }: Readonly<{ name: keyof typeof paths; size?: number }>): JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[name]} />
  </svg>
);
