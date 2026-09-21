export const PREFERENCES_CHANNELS = Object.freeze({
  open: 'preferences:open',
  openRouter: 'preferences:openrouter',
  saveOpenRouterKey: 'preferences:save-openrouter-key',
});

export type OpenRouterSettings = Readonly<{ hasApiKey: boolean; keyStorage: 'encrypted' | 'session' }>;

export type PreferencesApi = Readonly<{
  open(): Promise<void>;
  openRouter(): Promise<OpenRouterSettings>;
  saveOpenRouterKey(apiKey: string): Promise<OpenRouterSettings>;
}>;
