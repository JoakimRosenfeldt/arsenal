export type BackupStatus = Readonly<{
  connectionId: string | null;
  directory: string | null;
  manifestPath: string | null;
  includeMusic: boolean;
  state: 'off' | 'ready' | 'saving' | 'error';
  lastSavedAt: string | null;
  message: string | null;
}>;
