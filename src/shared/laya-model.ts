export const LAYA_MODEL_CHANNELS = Object.freeze({
  status: 'laya-model:status',
  download: 'laya-model:download',
  cancel: 'laya-model:cancel',
  changed: 'laya-model:changed',
});

export type LayaModelStatus =
  | Readonly<{ kind: 'checking' }>
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'downloading'; receivedBytes: number; totalBytes: number }>
  | Readonly<{ kind: 'converting'; completedBytes: number; totalBytes: number }>
  | Readonly<{ kind: 'failed'; message: string }>;

export type LayaModelApi = Readonly<{
  status(): Promise<LayaModelStatus>;
  download(): Promise<LayaModelStatus>;
  cancelDownload(): Promise<void>;
  onStatus(listener: (status: LayaModelStatus) => void): () => void;
}>;
