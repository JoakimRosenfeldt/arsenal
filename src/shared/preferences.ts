export const PREFERENCES_CHANNELS = Object.freeze({ open: 'preferences:open' });

export type PreferencesApi = Readonly<{
  open(): Promise<void>;
}>;
