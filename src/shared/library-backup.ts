export type BackupConnection = Readonly<{
  id: string;
  directory: string;
  manifestPath: string | null;
  includeMusic: boolean;
  state: 'ready' | 'saving' | 'error';
  lastSavedAt: string | null;
  message: string | null;
}>;

export type BackupConfiguration =
  | Readonly<{ kind: 'connect'; includeMusic: boolean }>
  | Readonly<{ kind: 'update'; id: string; includeMusic: boolean }>;
