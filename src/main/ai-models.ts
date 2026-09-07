import { readFile, rename, writeFile } from 'node:fs/promises';
import { safeStorage } from 'electron';

import {
  AI_PROVIDERS, DEFAULT_MODELS,
  type AiModel, type AiProvider, type AiSettings, type ModelDownload, type RemoteAiProvider,
} from '../shared/ai-models';
import { fetchModelApi, isRecord, MODEL_ENDPOINTS, ModelError, type ModelConnection } from './ai-client';

export const readAiProvider = (value: unknown): AiProvider => {
  const provider = AI_PROVIDERS.find((candidate) => candidate === value);
  if (provider === undefined) {
    throw new ModelError('failed', 'Choose a valid AI provider.');
  }
  return provider;
};

const readModelName = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 160 || !/^[a-z0-9][a-z0-9_.:/-]*$/iu.test(value) || value.includes('..')) {
    throw new ModelError('failed', 'Enter a valid model name.');
  }
  return value;
};

const canEncryptKeys = (): boolean => safeStorage.isEncryptionAvailable() &&
  !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');

const plainText = (html: string): string => html.replace(/<[^>]*>/gu, ' ')
  .replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/gu, (entity) => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ',
  })[entity] ?? entity).replace(/\s+/gu, ' ').trim();

const libraryLinks = (html: string): ReadonlyArray<{ id: string; html: string }> => {
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*href="\/library\/([a-z0-9_.:/-]+)"[^>]*>([\s\S]*?)<\/a>/giu)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      links.push({ id: match[1], html: match[2] });
    }
  }
  return links;
};

export class AiModels {
  private provider: AiProvider = 'ollama';
  private models = { ...DEFAULT_MODELS };
  private keys: Record<RemoteAiProvider, string> = { openai: '', openrouter: '' };
  private encryptedKeys: Record<RemoteAiProvider, string> = { openai: '', openrouter: '' };
  private statePath = '';
  private saveTail: Promise<void> = Promise.resolve();
  private downloadController: AbortController | null = null;
  private downloadState: ModelDownload = { kind: 'idle' };
  private remoteContexts = new Map<string, number>();

  async initialize(statePath: string): Promise<void> {
    this.statePath = statePath;
    try {
      const stored: unknown = JSON.parse(await readFile(statePath, 'utf8'));
      if (!isRecord(stored) || !isRecord(stored.models)) {
        return;
      }
      this.provider = readAiProvider(stored.provider);
      for (const provider of AI_PROVIDERS) {
        if (typeof stored.models[provider] === 'string') {
          this.models[provider] = readModelName(stored.models[provider]);
        }
      }
      if (isRecord(stored.keys)) {
        for (const provider of ['openai', 'openrouter'] as const) {
          const encrypted = stored.keys[provider];
          if (typeof encrypted === 'string') {
            this.encryptedKeys[provider] = encrypted;
            if (encrypted && canEncryptKeys()) {
              try {
                this.keys[provider] = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
              } catch {
                this.keys[provider] = '';
              }
            }
          }
        }
      }
    } catch {
      // Missing or unreadable preferences leave the local default available.
    }
  }

  settings(): AiSettings {
    return {
      provider: this.provider, models: { ...this.models },
      hasApiKey: { openai: Boolean(this.keys.openai), openrouter: Boolean(this.keys.openrouter) },
      keyStorage: canEncryptKeys() ? 'encrypted' : 'session',
    };
  }

  update(value: unknown): Promise<AiSettings> {
    const task = this.saveTail.then(async () => {
      if (!isRecord(value)) {
        throw new ModelError('failed', 'Invalid model settings.');
      }
      const provider = readAiProvider(value.provider);
      const models = { ...this.models };
      const keys = { ...this.keys };
      const encryptedKeys = { ...this.encryptedKeys };
      let selectedProvider = this.provider;
      switch (value.kind) {
        case 'provider': selectedProvider = provider; break;
        case 'model': models[provider] = readModelName(value.model); selectedProvider = provider; break;
        case 'api-key': {
          if (provider === 'ollama' || typeof value.apiKey !== 'string' || value.apiKey.length > 4_096 || /[\r\n]/u.test(value.apiKey)) {
            throw new ModelError('failed', 'Enter a valid API key.');
          }
          keys[provider] = value.apiKey.trim();
          encryptedKeys[provider] = keys[provider] && canEncryptKeys()
            ? safeStorage.encryptString(keys[provider]).toString('base64') : '';
          break;
        }
        default: throw new ModelError('failed', 'Invalid model settings.');
      }
      try {
        await writeFile(`${this.statePath}.tmp`, JSON.stringify({ provider: selectedProvider, models, keys: encryptedKeys }), { mode: 0o600 });
        await rename(`${this.statePath}.tmp`, this.statePath);
      } catch {
        throw new ModelError('failed', 'Could not save the AI settings.');
      }
      this.provider = selectedProvider;
      this.models = models;
      this.keys = keys;
      this.encryptedKeys = encryptedKeys;
      return this.settings();
    });
    this.saveTail = task.then(() => undefined, () => undefined);
    return task;
  }

  async list(value: unknown): Promise<readonly AiModel[]> {
    const provider = readAiProvider(value);
    if (provider !== 'ollama' && provider !== 'openrouter' && !this.keys[provider]) {
      throw new ModelError('unauthorized', 'Save your OpenAI API key to load available models.');
    }
    const response = await fetchModelApi(`${MODEL_ENDPOINTS[provider]}${provider === 'ollama' ? '/api/tags' : '/models'}`, {
      headers: provider === 'ollama' || !this.keys[provider] ? {} : { Authorization: `Bearer ${this.keys[provider]}` },
    });
    const body: unknown = await response.json();
    const items: unknown = isRecord(body) ? body[provider === 'ollama' ? 'models' : 'data'] : null;
    if (!Array.isArray(items)) {
      throw new ModelError('invalid-response', 'The provider returned an unreadable model list.');
    }
    const models: AiModel[] = [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const id = provider === 'ollama' ? item.name : item.id;
      if (typeof id !== 'string' || id.length > 160) continue;
      if (provider === 'ollama' && (id.includes('cloud') || typeof item.remote_model === 'string')) continue;
      if (provider === 'openai' && (!/^(gpt-(?:4\.1|4o|5|6)|o[34])(?:[.-]|$)/u.test(id) || /audio|realtime|transcribe|search|image|codex|chat-latest/u.test(id))) continue;
      if (provider === 'openrouter' && (!Array.isArray(item.supported_parameters) || !item.supported_parameters.includes('structured_outputs'))) continue;
      if (typeof item.context_length === 'number' && Number.isSafeInteger(item.context_length)) {
        this.remoteContexts.set(id, item.context_length);
      }
      models.push({
        id, name: typeof item.name === 'string' ? item.name : id,
        detail: provider === 'ollama' && typeof item.size === 'number'
          ? `${(item.size / 1_000_000_000).toFixed(1)} GB on disk`
          : typeof item.context_length === 'number' ? `${item.context_length.toLocaleString()} token context` : 'Text generation',
      });
    }
    return models.sort((a, b) => a.name.localeCompare(b.name));
  }

  async connection(signal: AbortSignal): Promise<ModelConnection> {
    const provider = this.provider;
    const model = this.models[provider];
    if (provider !== 'ollama') {
      const apiKey = this.keys[provider];
      if (!apiKey) throw new ModelError('unauthorized', 'Save an API key for the selected provider.');
      return { provider, model, apiKey, contextTokens: Math.min(65_536, this.remoteContexts.get(model) ?? 32_768), thinking: false };
    }
    const response = await fetchModelApi(`${MODEL_ENDPOINTS.ollama}/api/show`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal,
    });
    const info: unknown = await response.json();
    if (!isRecord(info) || typeof info.remote_model === 'string' || model.includes('cloud')) {
      throw new ModelError('model-missing', 'Choose a downloaded local Ollama model.');
    }
    if (Array.isArray(info.capabilities) && !info.capabilities.includes('completion')) {
      throw new ModelError('failed', 'This model cannot generate text. Choose a text generation model.');
    }
    const context = isRecord(info.model_info)
      ? Object.entries(info.model_info).find(([key, value]) => key.endsWith('.context_length') && typeof value === 'number')?.[1]
      : null;
    return {
      provider, model, apiKey: '',
      contextTokens: typeof context === 'number' && context > 0 ? Math.min(context, 16_384) : 8_192,
      thinking: Array.isArray(info.capabilities) && info.capabilities.includes('thinking'),
    };
  }

  async searchOllama(value: unknown): Promise<readonly AiModel[]> {
    if (typeof value !== 'string' || value.length > 100) {
      throw new ModelError('failed', 'Keep the model search under 100 characters.');
    }
    const query = value.trim().split(':')[0] ?? '';
    const response = await fetchModelApi(`https://ollama.com/search?q=${encodeURIComponent(query)}`);
    const html = await response.text();
    const models = new Map<string, AiModel>();
    for (const link of libraryLinks(html)) {
      if (!link.id.includes(':') && !link.id.includes('/') && /<h2\b/u.test(link.html)) {
        models.set(link.id, { id: link.id, name: link.id, detail: plainText(/<p\b[^>]*>([\s\S]*?)<\/p>/u.exec(link.html)?.[1] ?? '').slice(0, 260) });
      }
    }
    if (models.size === 0 && !/no (?:models|results)/iu.test(plainText(html))) {
      throw new ModelError('invalid-response', 'Could not read the Ollama catalog. Try another search or enter a model name directly.');
    }
    return [...models.values()].slice(0, 30);
  }

  async variants(value: unknown): Promise<readonly AiModel[]> {
    const family = readModelName(value);
    if (family.includes('/') || family.includes(':')) {
      throw new ModelError('failed', 'Choose a model family from the catalog.');
    }
    const response = await fetchModelApi(`https://ollama.com/library/${encodeURIComponent(family)}/tags`);
    const models = new Map<string, AiModel>();
    for (const link of libraryLinks(await response.text())) {
      if (!link.id.startsWith(`${family}:`) || link.id.includes('cloud') || models.has(link.id)) continue;
      const text = plainText(link.html);
      const size = /\b\d+(?:\.\d+)?\s*[KMGT]B\b/u.exec(text)?.[0];
      if (size !== undefined) {
        models.set(link.id, { id: link.id, name: link.id, detail: `${size} download` });
      }
    }
    if (models.size === 0) throw new ModelError('invalid-response', 'No downloadable sizes were found for this model.');
    return [...models.values()];
  }

  downloadStatus(): ModelDownload { return this.downloadState; }

  startDownload(value: unknown): ModelDownload {
    const model = readModelName(value);
    if (model.includes('cloud')) throw new ModelError('failed', 'Choose a local model to download.');
    if (this.downloadController !== null) throw new ModelError('failed', 'Finish or cancel the current download first.');
    const controller = new AbortController();
    this.downloadController = controller;
    this.downloadState = { kind: 'downloading', model, status: 'Connecting to Ollama', completed: 0, total: 0 };
    void this.pullModel(model, controller);
    return this.downloadState;
  }

  cancelDownload(): ModelDownload {
    this.downloadController?.abort();
    if (this.downloadState.kind === 'downloading') {
      this.downloadState = { kind: 'cancelled', model: this.downloadState.model };
    }
    return this.downloadState;
  }

  private async pullModel(model: string, controller: AbortController): Promise<void> {
    const timeout = AbortSignal.timeout(3_600_000);
    try {
      const response = await fetchModelApi(`${MODEL_ENDPOINTS.ollama}/api/pull`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }), signal: AbortSignal.any([controller.signal, timeout]),
      });
      if (response.body === null) throw new ModelError('invalid-response', 'Ollama did not return download progress.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let complete = false;
      const progress = (line: string): void => {
        if (!line.trim()) return;
        const item: unknown = JSON.parse(line);
        if (!isRecord(item) || typeof item.error === 'string' || typeof item.status !== 'string') {
          throw new ModelError('failed', 'Ollama could not download this model. Check the model name, disk space, and connection.');
        }
        if (item.status === 'success') complete = true;
        const total = typeof item.total === 'number' && Number.isFinite(item.total) ? Math.max(0, item.total) : 0;
        const completed = typeof item.completed === 'number' && Number.isFinite(item.completed) ? Math.max(0, Math.min(item.completed, total)) : 0;
        if (!controller.signal.aborted) {
          this.downloadState = { kind: 'downloading', model, status: item.status.slice(0, 180), total, completed };
        }
      };
      try {
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          pending += decoder.decode(chunk.value, { stream: !chunk.done });
          if (pending.length > 1_000_000) throw new ModelError('invalid-response', 'Ollama returned unreadable download progress.');
          let newline: number;
          while ((newline = pending.indexOf('\n')) !== -1) {
            progress(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
          if (chunk.done) break;
        }
        progress(pending);
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (!complete) throw new ModelError('failed', 'The model download ended before it completed. Try downloading again to resume it.');
      if (!controller.signal.aborted) this.downloadState = { kind: 'complete', model };
    } catch (error: unknown) {
      this.downloadState = controller.signal.aborted ? { kind: 'cancelled', model }
        : { kind: 'error', model, message: timeout.aborted ? 'The download timed out. Download again to resume it.' : error instanceof ModelError ? error.message : 'The model download failed. Try again to resume it.' };
    } finally {
      if (this.downloadController === controller) this.downloadController = null;
    }
  }
}
