import { useEffect, useState, type JSX } from 'react';

import type { PlaybackController } from './CueboxPlayer';
import { HelpTooltip } from './HelpTooltip';
import './SmartPlaylistEditor.css';
import { SONG_SOURCE_LABELS, type PlaylistFolder, type SmartPlaylistPreview } from './shared/dj-library';
import {
  SMART_FIELDS, SMART_OPERATORS, newSmartCondition, newSmartDefinition, operatorsFor, smartDefinitionError,
  type SmartCondition, type SmartGroup, type SmartPlaylistDefinition, type SmartRule,
} from './shared/smart-playlists';

export const PlaylistDestination = ({ folders, value, onChange, disabled }: Readonly<{
  folders: readonly PlaylistFolder[];
  value: string | null;
  onChange: (folderId: string | null) => void;
  disabled: boolean;
}>): JSX.Element => (
  <label className="playlist-name-field">
    <span>Folder</span>
    <select value={value ?? ''} onChange={(event) => onChange(event.currentTarget.value || null)} disabled={disabled}>
      <option value="">Playlists</option>
      {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.folderPath.join(' / ')}</option>)}
    </select>
  </label>
);

export const PlaylistIdentity = ({ name, parentFolderId, folders, onNameChange, onParentFolderChange, disabled, folderDisabled = false }: Readonly<{
  name: string;
  parentFolderId: string | null;
  folders: readonly PlaylistFolder[];
  onNameChange: (name: string) => void;
  onParentFolderChange: (folderId: string | null) => void;
  disabled: boolean;
  folderDisabled?: boolean;
}>): JSX.Element => (
  <div className="focused-playlist-identity">
    <label className="playlist-name-field"><span>Name</span><input value={name} placeholder="Playlist name"
      onChange={(event) => onNameChange(event.currentTarget.value)} maxLength={100} disabled={disabled} autoFocus required /></label>
    <PlaylistDestination folders={folders} value={parentFolderId} onChange={onParentFolderChange} disabled={disabled || folderDisabled} />
  </div>
);

const ConditionEditor = ({ rule, onChange }: Readonly<{ rule: SmartCondition; onChange: (rule: SmartCondition) => void }>): JSX.Element => {
  const field = SMART_FIELDS.find((candidate) => candidate.key === rule.field) ?? SMART_FIELDS[0];
  const relative = rule.operator === 'inLast' || rule.operator === 'olderThan';
  const noValue = rule.operator === 'empty' || rule.operator === 'present';
  const inputType = relative || field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : 'text';
  return (
    <>
      <select aria-label="Rule field" value={rule.field} onChange={(event) => {
        const next = SMART_FIELDS.find((candidate) => candidate.key === event.currentTarget.value);
        if (next) onChange({ ...rule, field: next.key, operator: operatorsFor(next.kind)[0] ?? 'is', value: '', valueTo: '' });
      }}>
        {SMART_FIELDS.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
      </select>
      <select aria-label={`${field.label} comparison`} value={rule.operator} onChange={(event) => {
        const operator = operatorsFor(field.kind).find((candidate) => candidate === event.currentTarget.value);
        if (operator) onChange({ ...rule, operator });
      }}>
        {operatorsFor(field.kind).map((operator) => <option key={operator} value={operator}>{SMART_OPERATORS[operator]}</option>)}
      </select>
      {!noValue && (
        <div className="smart-rule-values">
          {field.key === 'source' ? (
            <select aria-label="Source value" value={rule.value} onChange={(event) => onChange({ ...rule, value: event.currentTarget.value })}>
              <option value="">Choose source</option>
              {Object.entries(SONG_SOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          ) : (
            <input aria-label={`${field.label} value`} type={inputType} value={rule.value} step={relative ? 1 : 'any'} min={inputType === 'number' ? 0 : undefined}
              maxLength={500} placeholder={relative ? 'Days' : 'Value'} onChange={(event) => onChange({ ...rule, value: event.currentTarget.value })} />
          )}
          {rule.operator === 'between' && <>
            <span>and</span>
            <input aria-label={`${field.label} upper value`} type={inputType} value={rule.valueTo} step="any" min={inputType === 'number' ? 0 : undefined}
              maxLength={500} placeholder="Upper value" onChange={(event) => onChange({ ...rule, valueTo: event.currentTarget.value })} />
          </>}
          {relative && <span>days</span>}
        </div>
      )}
    </>
  );
};

const RuleGroupEditor = ({ group, onChange, depth = 0 }: Readonly<{
  group: SmartGroup; onChange: (group: SmartGroup) => void; depth?: number;
}>): JSX.Element => {
  const replace = (index: number, rule: SmartRule): void => onChange({ ...group, rules: group.rules.map((current, i) => i === index ? rule : current) });
  return (
    <div className="smart-rule-group">
      <div className="smart-group-heading">
        <label>Match <select aria-label={depth === 0 ? 'Match rules' : 'Match group rules'} value={group.match} onChange={(event) => {
          const match = event.currentTarget.value;
          if (match === 'all' || match === 'any' || match === 'none') onChange({ ...group, match });
        }}>
          <option value="all">All</option><option value="any">Any</option><option value="none">None</option>
        </select> of these rules</label>
        <div className="smart-group-actions">
          {depth > 0 && <button type="button" className="quiet-button" disabled={depth >= 5} onClick={() => onChange({ ...group, rules: [...group.rules, { kind: 'group', match: 'any', rules: [newSmartCondition()] }] })}>+ Add group</button>}
          <button type="button" className="quiet-button" onClick={() => onChange({ ...group, rules: [...group.rules, newSmartCondition()] })}>+ Add rule</button>
        </div>
      </div>
      <div className="smart-group-rules">
        {group.rules.map((rule, index) => (
          <div className={rule.kind === 'group' ? 'smart-rule-row is-group' : 'smart-rule-row'} key={index}>
            {rule.kind === 'group'
              ? <RuleGroupEditor group={rule} depth={depth + 1} onChange={(next) => replace(index, next)} />
              : <ConditionEditor rule={rule} onChange={(next) => replace(index, next)} />}
            <button type="button" className="smart-remove" aria-label={rule.kind === 'group' ? 'Remove rule group' : 'Remove rule'}
              onClick={() => onChange({ ...group, rules: group.rules.filter((_, i) => i !== index) })}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
};

export const FolderCreator = ({ busy, folders, initialParentFolderId, onCancel, onCreate }: Readonly<{
  busy: boolean; folders: readonly PlaylistFolder[]; initialParentFolderId: string | null;
  onCancel: () => void; onCreate: (name: string, parentFolderId: string | null) => Promise<boolean>;
}>): JSX.Element => {
  const [name, setName] = useState('');
  const [parentFolderId, setParentFolderId] = useState(initialParentFolderId);
  return (
    <section className="workspace-page playlists-page" aria-labelledby="folder-title">
      <header className="page-header"><div className="page-title-line"><h1 id="folder-title">New folder</h1></div></header>
      <div className="playlists-body"><div className="playlist-detail">
        <form className="playlist-creator folder-creator" onSubmit={(event) => { event.preventDefault(); if (!busy && name.trim()) void onCreate(name, parentFolderId); }}>
          <label className="playlist-name-field"><span>Folder name</span><input autoFocus value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={100} required disabled={busy} /></label>
          <PlaylistDestination folders={folders} value={parentFolderId} onChange={setParentFolderId} disabled={busy} />
          <div className="playlist-create-actions">
            <button className="quiet-button" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
            <button className="accent-button compact" type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving' : 'Create folder'}</button>
          </div>
        </form>
      </div></div>
    </section>
  );
};

export const SmartPlaylistEditor = ({ busy, folders, initialParentFolderId, initialName = '', initialDefinition, editing = false, revision, minimumSongLengthSeconds, playback, onCancel, onManual, onSave }: Readonly<{
  busy: boolean; folders: readonly PlaylistFolder[]; initialParentFolderId: string | null; initialName?: string;
  initialDefinition?: SmartPlaylistDefinition; editing?: boolean; revision: string; minimumSongLengthSeconds: number; playback: PlaybackController;
  onCancel: () => void;
  onManual?: (name: string, parentFolderId: string | null, definition: SmartPlaylistDefinition) => void;
  onSave: (name: string, parentFolderId: string | null, definition: SmartPlaylistDefinition) => Promise<boolean>;
}>): JSX.Element => {
  const [name, setName] = useState(initialName);
  const [parentFolderId, setParentFolderId] = useState(initialParentFolderId);
  const [definition, setDefinition] = useState(initialDefinition ?? newSmartDefinition);
  const [preview, setPreview] = useState<Readonly<{ definition: SmartPlaylistDefinition; revision: string; minimumSongLengthSeconds: number; result: SmartPlaylistPreview }> | null>(null);
  const [previewError, setPreviewError] = useState<Readonly<{ definition: SmartPlaylistDefinition; revision: string; minimumSongLengthSeconds: number }> | null>(null);
  const validation = smartDefinitionError(definition);
  const currentPreview = preview?.definition === definition && preview.revision === revision && preview.minimumSongLengthSeconds === minimumSongLengthSeconds ? preview.result : null;
  const failed = previewError?.definition === definition && previewError.revision === revision && previewError.minimumSongLengthSeconds === minimumSongLengthSeconds;
  const canSave = !busy && name.trim() !== '' && validation === null && currentPreview !== null;

  useEffect(() => {
    if (validation !== null) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void window.djLibrary.previewSmartPlaylist({ revision, definition }).then(
        (result) => { if (active) setPreview({ definition, revision, minimumSongLengthSeconds, result }); },
        () => { if (active) setPreviewError({ definition, revision, minimumSongLengthSeconds }); },
      );
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [definition, revision, validation, minimumSongLengthSeconds]);

  return (
    <section className="workspace-page focused-playlist-editor" aria-labelledby="smart-title">
      <header className="page-header">
        <div className="page-title-line"><h1 id="smart-title">{editing ? 'Edit smart playlist' : 'New playlist'}</h1></div>
      </header>
      <form className="focused-smart-form smart-playlist-editor" onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void onSave(name, parentFolderId, definition);
      }}>
        <div className="focused-smart-content">
          <fieldset disabled={busy} className="smart-editor-fields">
            <PlaylistIdentity name={name} parentFolderId={parentFolderId} folders={folders}
              onNameChange={setName} onParentFolderChange={setParentFolderId} disabled={busy} folderDisabled={editing} />
            <div className="focused-playlist-type" role="group" aria-label="Playlist type">
              <button type="button" aria-pressed={false} disabled={editing || onManual === undefined} onClick={() => onManual?.(name, parentFolderId, definition)}>Manual</button>
              <button type="button" aria-pressed={true}>Smart</button>
              <span>Tracks update automatically when your library changes.</span>
            </div>
            <RuleGroupEditor group={definition.rules} onChange={(rules) => setDefinition({ ...definition, rules })} />
            <details className="smart-advanced-options">
              <summary>Advanced options</summary>
              <div className="smart-output-controls">
                <label>Sort by<select value={definition.sort.field} onChange={(event) => {
                  const value = event.currentTarget.value;
                  const field = value === 'collection' ? 'collection' : SMART_FIELDS.find((candidate) => candidate.key === value)?.key;
                  if (field) setDefinition({ ...definition, sort: { ...definition.sort, field } });
                }}>
                  <option value="collection">Collection order</option>
                  {SMART_FIELDS.map((field) => <option value={field.key} key={field.key}>{field.label}</option>)}
                </select></label>
                <label>Order<select value={definition.sort.direction} disabled={definition.sort.field === 'collection'} onChange={(event) => {
                  const direction = event.currentTarget.value;
                  if (direction === 'asc' || direction === 'desc') setDefinition({ ...definition, sort: { ...definition.sort, direction } });
                }}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
                <label>Track limit<input type="number" min={1} max={100000} step={1} placeholder="No limit" value={definition.limit ?? ''}
                  onChange={(event) => setDefinition({ ...definition, limit: event.currentTarget.value === '' ? null : Number(event.currentTarget.value) })} /></label>
              </div>
              <button type="button" className="quiet-button" onClick={() => setDefinition({ ...definition, rules: { ...definition.rules, rules: [...definition.rules.rules, { kind: 'group', match: 'any', rules: [newSmartCondition()] }] } })}>+ Add rule group</button>
            </details>
          </fieldset>
          <section className="smart-preview" aria-label="Matching tracks" aria-busy={validation === null && !failed && currentPreview === null}>
            <table className="smart-preview-table">
              <thead><tr><th scope="col">Track</th><th scope="col">BPM</th><th scope="col">KEY</th><th scope="col">Time</th><th scope="col">Genre</th><th scope="col">Album</th></tr></thead>
              <tbody>
                {currentPreview?.tracks.map((song) => (
                  <tr key={song.id} className={playback.song?.id === song.id && playback.playing ? 'is-playing' : undefined}>
                    <td><button type="button" className="smart-preview-play track-identity" disabled={song.audioUrl === null} onClick={() => playback.play(song)} aria-label={`${playback.song?.id === song.id && playback.playing ? 'Pause' : 'Play'} ${song.title}`}>
                      <strong>{song.title}</strong><small>{song.artist ?? 'Unknown artist'}</small>
                    </button></td>
                    <td className="numeric">{song.bpm?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? ''}</td>
                    <td className="numeric">{song.musicalKey ?? ''}</td>
                    <td className="numeric">{song.durationSeconds === null ? '' : `${Math.floor(song.durationSeconds / 60)}:${String(Math.floor(song.durationSeconds % 60)).padStart(2, '0')}`}</td>
                    <td title={song.genre ?? undefined}>{song.genre ?? ''}</td><td title={song.album ?? undefined}>{song.album ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {currentPreview?.tracks.length === 0 && <p className="smart-preview-empty">No tracks match these rules.</p>}
            {currentPreview === null && <p className="smart-preview-empty">{validation !== null ? 'Matching tracks will appear here.' : failed ? 'Could not load matching tracks.' : 'Finding matches…'}</p>}
          </section>
        </div>
        <footer className="focused-playlist-footer">
          <div className="smart-preview-status">
            <span role="status">{validation ?? (failed ? 'Could not load matches. Try again.' : currentPreview === null ? 'Finding matches…' : `${currentPreview.matchingCount.toLocaleString()} matching ${currentPreview.matchingCount === 1 ? 'track' : 'tracks'}${currentPreview.total !== currentPreview.matchingCount ? ` · ${currentPreview.total.toLocaleString()} in playlist` : ''} · Updates automatically`)}</span>
            {currentPreview !== null && currentPreview.total > currentPreview.tracks.length && <HelpTooltip label="Preview">{`Showing the first ${currentPreview.tracks.length} tracks.`}</HelpTooltip>}
            {failed && <button className="quiet-button" type="button" onClick={() => setDefinition({ ...definition })}>Retry</button>}
          </div>
          <button className="quiet-button" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="accent-button compact" type="submit" disabled={!canSave}>{busy ? 'Saving' : editing ? 'Save rules' : 'Create smart playlist'}</button>
        </footer>
      </form>
    </section>
  );
};
