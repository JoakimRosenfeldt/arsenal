export const AI_PROVIDERS = ['ollama', 'openai', 'openrouter'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export type RemoteAiProvider = Exclude<AiProvider, 'ollama'>;

export const AI_PROVIDER_LABELS: Readonly<Record<AiProvider, string>> = {
  ollama: 'Ollama', openai: 'OpenAI', openrouter: 'OpenRouter',
};
export const DEFAULT_MODELS: Readonly<Record<AiProvider, string>> = {
  ollama: 'qwen3.5:2b', openai: 'gpt-4.1-mini', openrouter: 'openai/gpt-4.1-mini',
};

export type AiSettings = Readonly<{
  provider: AiProvider;
  models: Readonly<Record<AiProvider, string>>;
  hasApiKey: Readonly<Record<RemoteAiProvider, boolean>>;
  keyStorage: 'encrypted' | 'session';
}>;

export type AiSettingsChange =
  | Readonly<{ kind: 'provider'; provider: AiProvider }>
  | Readonly<{ kind: 'model'; provider: AiProvider; model: string }>
  | Readonly<{ kind: 'api-key'; provider: RemoteAiProvider; apiKey: string }>;

export type AiModel = Readonly<{ id: string; name: string; detail: string }>;
export type AiResult<T> =
  | Readonly<{ kind: 'ready'; value: T }>
  | Readonly<{ kind: 'error'; message: string }>;

export type ModelDownload =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'downloading'; model: string; status: string; completed: number; total: number }>
  | Readonly<{ kind: 'complete'; model: string }>
  | Readonly<{ kind: 'cancelled'; model: string }>
  | Readonly<{ kind: 'error'; model: string; message: string }>;

export const AI_MODEL_CHANNELS = Object.freeze({
  settings: 'ai-models:settings', update: 'ai-models:update', list: 'ai-models:list',
  searchOllama: 'ai-models:search-ollama', variants: 'ai-models:variants',
  download: 'ai-models:download', downloadStatus: 'ai-models:download-status',
  cancelDownload: 'ai-models:cancel-download',
});

export type AiModelsApi = Readonly<{
  settings(): Promise<AiSettings>;
  update(change: AiSettingsChange): Promise<AiResult<AiSettings>>;
  list(provider: AiProvider): Promise<AiResult<readonly AiModel[]>>;
  searchOllama(query: string): Promise<AiResult<readonly AiModel[]>>;
  variants(family: string): Promise<AiResult<readonly AiModel[]>>;
  download(model: string): Promise<AiResult<ModelDownload>>;
  downloadStatus(): Promise<ModelDownload>;
  cancelDownload(): Promise<ModelDownload>;
}>;
