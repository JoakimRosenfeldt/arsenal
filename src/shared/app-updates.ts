export const APP_UPDATE_CHANNELS = Object.freeze({
  status: 'app-updates:status',
  changed: 'app-updates:changed',
  check: 'app-updates:check',
  download: 'app-updates:download',
  install: 'app-updates:install',
});

export type UpdatePhase =
  | Readonly<{ kind: 'disabled'; message: string }>
  | Readonly<{ kind: 'idle' | 'checking' | 'current' | 'unpublished' }>
  | Readonly<{ kind: 'available' | 'downloaded'; version: string }>
  | Readonly<{ kind: 'downloading'; version: string; percent: number }>
  | Readonly<{ kind: 'error'; message: string }>;

export type UpdateStatus = UpdatePhase & Readonly<{ currentVersion: string }>;

export type AppUpdatesApi = Readonly<{
  status: () => Promise<UpdateStatus>;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  onChange: (listener: (status: UpdateStatus) => void) => () => void;
}>;
