import { useEffect, useState, type JSX } from 'react';
import {
  AI_PROVIDERS, AI_PROVIDER_LABELS,
  type AiModel, type AiProvider, type AiSettings, type AiSettingsChange, type ModelDownload,
} from './shared/ai-models';

type ModelList =
  | { kind: 'loading' }
  | { kind: 'ready'; provider: AiProvider; items: readonly AiModel[] }
  | { kind: 'error'; provider: AiProvider; message: string };

export const AiModelPicker = (): JSX.Element => {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelList>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const [apiKey, setApiKey] = useState('');
  const [filter, setFilter] = useState('');
  const [modelName, setModelName] = useState('');
  const [catalogQuery, setCatalogQuery] = useState('qwen3.5');
  const [catalog, setCatalog] = useState<readonly AiModel[] | null>(null);
  const [variants, setVariants] = useState<readonly AiModel[] | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [download, setDownload] = useState<ModelDownload>({ kind: 'idle' });
  const provider = settings?.provider;
  const hasApiKey = settings !== null && settings.provider !== 'ollama' && settings.hasApiKey[settings.provider];

  useEffect(() => {
    let active = true;
    void window.aiModels.settings().then((value) => {
      if (active) {
        setSettings(value);
        setModelName(value.models[value.provider]);
      }
    }).catch(() => { if (active) setError('Could not load AI settings. Reopen Preferences to try again.'); });
    void window.aiModels.downloadStatus().then((value) => { if (active) setDownload(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (provider === undefined) return;
    let active = true;
    void window.aiModels.list(provider).then((result) => {
      if (active) {
        setModels(result.kind === 'ready' ? { kind: 'ready', provider, items: result.value } : { kind: 'error', provider, message: result.message });
      }
    }).catch(() => { if (active) setModels({ kind: 'error', provider, message: 'Could not load models. Try refreshing the list.' }); });
    return () => { active = false; };
  }, [provider, hasApiKey, reload]);

  const downloadModel = download.kind === 'idle' ? '' : download.model;
  useEffect(() => {
    if (download.kind !== 'downloading') return;
    let active = true;
    const timer = window.setInterval(() => {
      void window.aiModels.downloadStatus().then((value) => {
        if (active) {
          setDownload(value);
          if (value.kind === 'complete') setReload((current) => current + 1);
        }
      }).catch(() => {
        if (active) setDownload({ kind: 'error', model: downloadModel, message: 'Could not read download progress. Reopen model settings to reconnect.' });
      });
    }, 1_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [download.kind, downloadModel]);

  const update = async (change: AiSettingsChange): Promise<void> => {
    if (saving || settings === null) return;
    setSaving(true);
    setError(null);
    try {
      const result = await window.aiModels.update(change);
      if (result.kind === 'error') {
        setError(result.message);
      } else {
        setSettings(result.value);
        setModelName(result.value.models[result.value.provider]);
        if (change.kind === 'api-key') {
          setApiKey('');
          setReload((current) => current + 1);
        }
        if (settings.provider !== result.value.provider) {
          setApiKey('');
          setFilter('');
          setCatalog(null);
          setVariants(null);
        }
      }
    } catch {
      setError('Could not save the AI settings. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const searchCatalog = async (): Promise<void> => {
    if (catalogBusy) return;
    setCatalogBusy(true);
    setError(null);
    setVariants(null);
    try {
      const result = await window.aiModels.searchOllama(catalogQuery);
      if (result.kind === 'ready') setCatalog(result.value);
      else setError(result.message);
    } catch { setError('Could not search the Ollama catalog. Try again.'); }
    finally { setCatalogBusy(false); }
  };

  const loadVariants = async (family: string): Promise<void> => {
    if (catalogBusy) return;
    setCatalogBusy(true);
    setError(null);
    setVariants(null);
    try {
      const result = await window.aiModels.variants(family);
      if (result.kind === 'ready') setVariants(result.value);
      else setError(result.message);
    } catch { setError('Could not load model sizes. Try again.'); }
    finally { setCatalogBusy(false); }
  };

  const startDownload = async (model: string): Promise<void> => {
    setError(null);
    try {
      const result = await window.aiModels.download(model);
      if (result.kind === 'ready') setDownload(result.value);
      else setError(result.message);
    } catch { setError('Could not start the download. Make sure Ollama is running.'); }
  };

  if (settings === null) {
    return <p role={error === null ? 'status' : 'alert'}>{error ?? 'Loading model settings...'}</p>;
  }
  const selectedProvider = settings.provider;
  const selectedModel = settings.models[selectedProvider];
  const available = models.kind === 'ready' && models.provider === selectedProvider ? models.items : [];
  const filtered = available.filter((model) => `${model.name} ${model.id}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const loadingModels = models.kind === 'loading' || models.provider !== selectedProvider;
  const locked = saving;

  return (
    <div className="ai-model-picker">
      <fieldset disabled={locked}>
        <legend className="visually-hidden">AI model settings</legend>
        <div className="ai-model-fields">
          <label>Provider
            <select value={selectedProvider} onChange={(event) => {
              const next = AI_PROVIDERS.find((item) => item === event.currentTarget.value);
              if (next !== undefined) void update({ kind: 'provider', provider: next });
            }}>
              {AI_PROVIDERS.map((item) => <option value={item} key={item}>{AI_PROVIDER_LABELS[item]}{item === 'ollama' ? ' · local' : ' · API'}</option>)}
            </select>
          </label>
          <label>Model
            <select value={selectedModel} onChange={(event) => void update({ kind: 'model', provider: selectedProvider, model: event.currentTarget.value })}>
              {!filtered.some((item) => item.id === selectedModel) && <option value={selectedModel}>{selectedModel}</option>}
              {filtered.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.detail}</option>)}
            </select>
          </label>
        </div>
        <p className="ai-data-notice">
          {selectedProvider === 'ollama'
            ? 'Install Ollama from ollama.com and keep it running to use local models.'
            : `Usage is billed to your ${AI_PROVIDER_LABELS[selectedProvider]} account.`}
        </p>
        <div className="ai-model-management">
          {selectedProvider !== 'ollama' && (
            <form className="ai-key-form" onSubmit={(event) => {
              event.preventDefault();
              if (apiKey.trim()) void update({ kind: 'api-key', provider: selectedProvider, apiKey });
            }}>
              <label htmlFor="playlist-api-key">{AI_PROVIDER_LABELS[selectedProvider]} API key</label>
              <div className="ai-input-action">
                <input id="playlist-api-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.currentTarget.value)} placeholder={hasApiKey ? 'Key saved. Enter a replacement.' : 'Paste your API key'} maxLength={4_096} />
                <button className="quiet-button" type="submit" disabled={!apiKey.trim()}>Save key</button>
                {hasApiKey && <button className="quiet-button" type="button" onClick={() => void update({ kind: 'api-key', provider: selectedProvider, apiKey: '' })}>Remove key</button>}
              </div>
              <p>{settings.keyStorage === 'encrypted' ? 'Keys are encrypted by your operating system and kept out of the page after saving.' : 'Secure storage is unavailable. Keys are kept only until you quit the app.'}</p>
            </form>
          )}
          <div className="ai-input-action">
            <input type="search" aria-label="Filter available models" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder="Filter the model dropdown" />
            <button className="quiet-button" type="button" disabled={loadingModels} onClick={() => { setModels({ kind: 'loading' }); setReload((value) => value + 1); }}>Refresh models</button>
          </div>
          {loadingModels ? <p role="status">Loading models...</p>
            : models.kind === 'error' ? <p className="playlist-search-error" role="alert">{models.message}</p>
              : <p>{available.length} {selectedProvider === 'ollama' ? 'downloaded models' : 'available models'}. {selectedProvider === 'openrouter' ? 'Only models with structured output support are listed.' : ''}</p>}
          <form className="ai-custom-model" onSubmit={(event) => {
            event.preventDefault();
            if (modelName.trim()) void update({ kind: 'model', provider: selectedProvider, model: modelName.trim() });
          }}>
            <label htmlFor="playlist-model-name">Or enter a model name</label>
            <div className="ai-input-action">
              <input id="playlist-model-name" value={modelName} onChange={(event) => setModelName(event.currentTarget.value)} maxLength={160} spellCheck={false} />
              <button className="quiet-button" type="submit" disabled={!modelName.trim() || modelName.trim() === selectedModel}>Use model</button>
              {selectedProvider === 'ollama' && <button className="quiet-button" type="button" disabled={!modelName.trim() || download.kind === 'downloading'} onClick={() => void startDownload(modelName.trim())}>Download</button>}
            </div>
          </form>
          {selectedProvider === 'ollama' && (
            <div className="ollama-catalog">
              <h4>Find a local model</h4>
              <p>Search the Ollama catalog, choose a size, then download it here. Smaller models need less disk space and memory.</p>
              <form className="ai-input-action" onSubmit={(event) => { event.preventDefault(); void searchCatalog(); }}>
                <input type="search" aria-label="Search Ollama catalog" value={catalogQuery} onChange={(event) => setCatalogQuery(event.currentTarget.value)} maxLength={100} placeholder="Qwen, Gemma, Llama..." />
                <button className="quiet-button" type="submit" disabled={catalogBusy}>Search catalog</button>
              </form>
              {catalogBusy && <p role="status">Loading catalog...</p>}
              {variants !== null ? (
                <>
                  <button className="quiet-button" type="button" onClick={() => setVariants(null)}>Back to models</button>
                  <ul className="ai-model-results" aria-label="Downloadable model sizes">
                    {variants.map((item) => <li key={item.id}>
                      <div><strong>{item.name}</strong><small>{item.detail}</small></div>
                      <button className="quiet-button" type="button" aria-label={`Download ${item.name}`} disabled={download.kind === 'downloading'} onClick={() => void startDownload(item.id)}>Download</button>
                    </li>)}
                  </ul>
                </>
              ) : catalog !== null && (
                catalog.length === 0 ? <p>No models found. Try another name.</p> :
                  <ul className="ai-model-results" aria-label="Ollama catalog models">
                    {catalog.map((item) => <li key={item.id}>
                      <div><strong>{item.name}</strong><small>{item.detail}</small></div>
                      <button className="quiet-button" type="button" aria-label={`Choose size for ${item.name}`} disabled={catalogBusy} onClick={() => void loadVariants(item.id)}>Choose size</button>
                    </li>)}
                  </ul>
              )}
            </div>
          )}
        </div>
      </fieldset>
      {download.kind !== 'idle' && (
        <div className="ai-download" aria-live="polite">
          {download.kind === 'downloading' ? <>
            <p>Downloading {download.model}</p>
            <progress aria-label={`Download progress for ${download.model}`} max={download.total || 1} value={download.total > 0 ? download.completed : undefined} />
            <div className="playlist-helper-actions"><span>{download.status}{download.total > 0 ? ` · ${Math.round(download.completed / download.total * 100)}% of current file` : ''}</span>
              <button className="quiet-button" type="button" onClick={() => void window.aiModels.cancelDownload().then(setDownload).catch(() => setError('Could not cancel the download. Try again.'))}>Cancel download</button>
            </div>
          </> : download.kind === 'complete' ? <div className="playlist-helper-actions"><span>{download.model} is downloaded.</span><button className="quiet-button" type="button" disabled={locked} onClick={() => void update({ kind: 'model', provider: 'ollama', model: download.model })}>Use in Ollama</button></div>
            : download.kind === 'cancelled' ? <p>Download cancelled. Download {download.model} again to resume.</p>
              : <p role="alert">{download.message}</p>}
        </div>
      )}
      {error !== null && <p className="playlist-search-error" role="alert">{error}</p>}
    </div>
  );
};
