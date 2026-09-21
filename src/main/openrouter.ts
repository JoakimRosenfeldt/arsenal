import { readFile, rename, writeFile } from 'node:fs/promises';
import { safeStorage } from 'electron';

import type { OpenRouterSettings } from '../shared/preferences';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const canEncryptKeys = (): boolean => safeStorage.isEncryptionAvailable() &&
  !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');

export class OpenRouterConnection {
  apiKey = '';
  private statePath = '';
  private stored: Record<string, unknown> = {};
  private saveTail: Promise<void> = Promise.resolve();

  async initialize(statePath: string): Promise<void> {
    this.statePath = statePath;
    try {
      const stored: unknown = JSON.parse(await readFile(statePath, 'utf8'));
      if (!isRecord(stored)) return;
      this.stored = stored;
      const encrypted = isRecord(stored.keys) ? stored.keys.openrouter : undefined;
      if (typeof encrypted === 'string' && encrypted && canEncryptKeys()) {
        this.apiKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      }
    } catch {
      // Missing settings or an unavailable keychain require a key in Preferences.
    }
  }

  settings(): OpenRouterSettings {
    return { hasApiKey: Boolean(this.apiKey), keyStorage: canEncryptKeys() ? 'encrypted' : 'session' };
  }

  saveKey(value: unknown): Promise<OpenRouterSettings> {
    const task = this.saveTail.then(async () => {
      if (typeof value !== 'string' || value.length > 4_096 || /[^\x20-\x7e]/u.test(value)) {
        throw new Error('Enter a valid OpenRouter API key.');
      }
      const apiKey = value.trim();
      const stored = {
        ...this.stored,
        keys: {
          ...(isRecord(this.stored.keys) ? this.stored.keys : {}),
          openrouter: apiKey && canEncryptKeys() ? safeStorage.encryptString(apiKey).toString('base64') : '',
        },
      };
      await writeFile(`${this.statePath}.tmp`, JSON.stringify(stored), { mode: 0o600 });
      await rename(`${this.statePath}.tmp`, this.statePath);
      this.stored = stored;
      this.apiKey = apiKey;
      return this.settings();
    });
    this.saveTail = task.then(() => undefined, () => undefined);
    return task;
  }
}
