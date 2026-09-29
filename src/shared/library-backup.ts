export type BackupConnection = Readonly<{
  id: string;
  sourceConnectionId: string;
  directory: string;
  manifestPath: string | null;
  includeMusic: boolean;
  state: 'ready' | 'saving' | 'error';
  lastSavedAt: string | null;
  message: string | null;
}>;

export type BackupConfiguration =
  | Readonly<{ kind: 'connect'; sourceConnectionId: string; includeMusic: boolean }>
  | Readonly<{ kind: 'update'; id: string; sourceConnectionId: string; includeMusic: boolean }>;
