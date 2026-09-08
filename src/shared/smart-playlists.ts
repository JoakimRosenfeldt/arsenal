import type { SongRow } from './dj-library';

export const SMART_FIELDS = [
  { key: 'title', label: 'Title', kind: 'text' },
  { key: 'artist', label: 'Artist', kind: 'text' },
  { key: 'album', label: 'Album', kind: 'text' },
  { key: 'genre', label: 'Genre', kind: 'text' },
  { key: 'musicalKey', label: 'Key', kind: 'text' },
  { key: 'label', label: 'Label', kind: 'text' },
  { key: 'comments', label: 'Comments', kind: 'text' },
  { key: 'composer', label: 'Composer', kind: 'text' },
  { key: 'remixer', label: 'Remixer', kind: 'text' },
  { key: 'mixName', label: 'Mix name', kind: 'text' },
  { key: 'fileKind', label: 'File type', kind: 'text' },
  { key: 'source', label: 'Source', kind: 'text' },
  { key: 'bpm', label: 'BPM', kind: 'number' },
  { key: 'rating', label: 'Rating, 0 to 5', kind: 'number' },
  { key: 'year', label: 'Year', kind: 'number' },
  { key: 'durationSeconds', label: 'Duration, seconds', kind: 'number' },
  { key: 'playCount', label: 'Play count', kind: 'number' },
  { key: 'cuePointCount', label: 'Cue points', kind: 'number' },
  { key: 'hotCueCount', label: 'Hot cues', kind: 'number' },
  { key: 'bitRateKbps', label: 'Bit rate, kbps', kind: 'number' },
  { key: 'sampleRateHz', label: 'Sample rate, Hz', kind: 'number' },
  { key: 'dateAdded', label: 'Date added', kind: 'date' },
] as const;

export type SmartField = typeof SMART_FIELDS[number];
export const SMART_OPERATORS = {
  is: 'is', isNot: 'is not', contains: 'contains', notContains: 'does not contain',
  startsWith: 'starts with', endsWith: 'ends with',
  gt: 'is greater than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
  between: 'is between', inLast: 'is in the last', olderThan: 'is older than',
  empty: 'is missing', present: 'is present',
} as const;
export type SmartOperator = keyof typeof SMART_OPERATORS;
export type SmartCondition = Readonly<{
  kind: 'condition'; field: SmartField['key']; operator: SmartOperator; value: string; valueTo: string;
}>;
export type SmartGroup = Readonly<{
  kind: 'group'; match: 'all' | 'any' | 'none'; rules: readonly SmartRule[];
}>;
export type SmartRule = SmartCondition | SmartGroup;
export type SmartPlaylistDefinition = Readonly<{
  version: 1;
  rules: SmartGroup;
  sort: Readonly<{ field: SmartField['key'] | 'collection'; direction: 'asc' | 'desc' }>;
  limit: number | null;
}>;

export const operatorsFor = (kind: SmartField['kind']): readonly SmartOperator[] => {
  switch (kind) {
    case 'text': return ['contains', 'notContains', 'is', 'isNot', 'startsWith', 'endsWith', 'empty', 'present'];
    case 'number': return ['is', 'isNot', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'present'];
    case 'date': return ['is', 'isNot', 'gt', 'gte', 'lt', 'lte', 'between', 'inLast', 'olderThan', 'empty', 'present'];
  }
};

export const newSmartCondition = (): SmartCondition => ({ kind: 'condition', field: 'genre', operator: 'contains', value: '', valueTo: '' });
export const newSmartDefinition = (): SmartPlaylistDefinition => ({
  version: 1, rules: { kind: 'group', match: 'all', rules: [newSmartCondition()] },
  sort: { field: 'collection', direction: 'asc' }, limit: null,
});

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const dateNumber = (value: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : NaN;
};

export const smartDefinitionError = (definition: SmartPlaylistDefinition): string | null => {
  let count = 0;
  const check = (rule: SmartRule, depth: number): string | null => {
    count += 1;
    if (depth > 6 || count > 100) return 'Use at most 100 rules and six levels of groups.';
    if (rule.kind === 'group') {
      if (rule.rules.length === 0) return 'Add a rule to each group.';
      for (const child of rule.rules) {
        const error = check(child, depth + 1);
        if (error !== null) return error;
      }
      return null;
    }
    const field = SMART_FIELDS.find((candidate) => candidate.key === rule.field);
    if (field === undefined || !operatorsFor(field.kind).includes(rule.operator)) return 'Choose a valid field and comparison.';
    if (rule.operator === 'empty' || rule.operator === 'present') return null;
    if (rule.value.trim() === '' || rule.value.length > 500 || rule.valueTo.length > 500) return `Enter a value for ${field.label}.`;
    if (field.kind === 'text') return null;
    const relative = rule.operator === 'inLast' || rule.operator === 'olderThan';
    const parse = field.kind === 'date' && !relative ? dateNumber : Number;
    const left = parse(rule.value);
    if (!Number.isFinite(left) || ((field.kind === 'number' || relative) && left < 0) || (relative && !Number.isSafeInteger(left))) return `Enter a valid ${relative ? 'number of days' : field.label.toLowerCase()}.`;
    if (rule.operator === 'between') {
      const right = parse(rule.valueTo);
      if (rule.valueTo.trim() === '' || !Number.isFinite(right) || right < left) return `The upper ${field.label.toLowerCase()} value must be at least the lower value.`;
    }
    if (field.key === 'rating' && (left > 5 || (rule.operator === 'between' && Number(rule.valueTo) > 5))) return 'Ratings range from 0 to 5.';
    return null;
  };
  if (definition.limit !== null && (!Number.isSafeInteger(definition.limit) || definition.limit < 1 || definition.limit > 100_000)) return 'Track limit must be between 1 and 100,000.';
  return check(definition.rules, 0);
};

export const readSmartDefinition = (value: unknown): SmartPlaylistDefinition | null => {
  let count = 0;
  const readRule = (raw: unknown, depth: number): SmartRule | null => {
    if (!record(raw) || ++count > 100 || depth > 6) return null;
    if (raw.kind === 'group') {
      if (!['all', 'any', 'none'].includes(String(raw.match)) || !Array.isArray(raw.rules) || raw.rules.length > 100) return null;
      const match = raw.match;
      if (match !== 'all' && match !== 'any' && match !== 'none') return null;
      const rules: SmartRule[] = [];
      for (const child of raw.rules) {
        const rule = readRule(child, depth + 1);
        if (rule === null) return null;
        rules.push(rule);
      }
      return { kind: 'group', match, rules };
    }
    const field = SMART_FIELDS.find((candidate) => candidate.key === raw.field);
    const operator = field && operatorsFor(field.kind).find((candidate) => candidate === raw.operator);
    if (raw.kind !== 'condition' || !field || !operator || typeof raw.value !== 'string' || typeof raw.valueTo !== 'string') return null;
    return { kind: 'condition', field: field.key, operator, value: raw.value, valueTo: raw.valueTo };
  };
  if (!record(value) || value.version !== 1 || !record(value.sort)) return null;
  const rules = readRule(value.rules, 0);
  const sortField = value.sort.field;
  const field = sortField === 'collection' ? 'collection' : SMART_FIELDS.find((candidate) => candidate.key === sortField)?.key;
  const direction = value.sort.direction;
  if (rules?.kind !== 'group' || field === undefined || (direction !== 'asc' && direction !== 'desc') || (value.limit !== null && typeof value.limit !== 'number')) return null;
  const definition: SmartPlaylistDefinition = { version: 1, rules, sort: { field, direction }, limit: value.limit };
  return smartDefinitionError(definition) === null ? definition : null;
};

const fieldValue = (song: SongRow, field: SmartField['key']): string | number | null => {
  const value = song[field];
  return field === 'rating' && typeof value === 'number' && value > 5 ? Math.round(value / 51) : value;
};

export const evaluateArsenalSmartPlaylist = (definition: SmartPlaylistDefinition, songs: readonly SongRow[], now = new Date()): Readonly<{ tracks: readonly SongRow[]; matchingCount: number }> => {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const matches = (song: SongRow, rule: SmartRule): boolean => {
    if (rule.kind === 'group') {
      switch (rule.match) {
        case 'all': return rule.rules.every((child) => matches(song, child));
        case 'any': return rule.rules.some((child) => matches(song, child));
        case 'none': return !rule.rules.some((child) => matches(song, child));
      }
    }
    const raw = fieldValue(song, rule.field);
    const missing = raw === null || raw === '' || (rule.field === 'dateAdded' && !Number.isFinite(dateNumber(String(raw))));
    if (rule.operator === 'empty') return missing;
    if (rule.operator === 'present') return !missing;
    if (missing) return false;
    const value = rule.field === 'dateAdded' ? dateNumber(String(raw)) : typeof raw === 'string' ? raw.toLocaleLowerCase() : raw;
    const left = rule.field === 'dateAdded' ? dateNumber(rule.value) : typeof value === 'number' ? Number(rule.value) : rule.value.toLocaleLowerCase();
    const right = rule.field === 'dateAdded' ? dateNumber(rule.valueTo) : Number(rule.valueTo);
    switch (rule.operator) {
      case 'is': return value === left;
      case 'isNot': return value !== left;
      case 'contains': return String(value).includes(String(left));
      case 'notContains': return !String(value).includes(String(left));
      case 'startsWith': return String(value).startsWith(String(left));
      case 'endsWith': return String(value).endsWith(String(left));
      case 'gt': return value > left;
      case 'gte': return value >= left;
      case 'lt': return value < left;
      case 'lte': return value <= left;
      case 'between': return value >= left && Number(value) <= right;
      case 'inLast': return Number(value) >= today - Number(rule.value) * 86_400_000 && Number(value) <= today;
      case 'olderThan': return Number(value) < today - Number(rule.value) * 86_400_000;
    }
  };
  const tracks = songs.filter((song) => matches(song, definition.rules));
  const { field, direction } = definition.sort;
  if (field !== 'collection') {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    tracks.sort((a, b) => {
      const left = fieldValue(a, field);
      const right = fieldValue(b, field);
      if (left === null || left === '') return right === null || right === '' ? 0 : 1;
      if (right === null || right === '') return -1;
      const order = typeof left === 'number' && typeof right === 'number' ? left - right : collator.compare(String(left), String(right));
      return direction === 'asc' ? order : -order;
    });
  }
  return { matchingCount: tracks.length, tracks: definition.limit === null ? tracks : tracks.slice(0, definition.limit) };
};

export const describeSmartRules = (rule: SmartRule): string => {
  if (rule.kind === 'group') return `${rule.match === 'all' ? 'All' : rule.match === 'any' ? 'Any' : 'None'} of [${rule.rules.map(describeSmartRules).join('; ')}]`;
  const label = SMART_FIELDS.find((field) => field.key === rule.field)?.label ?? rule.field;
  const noValue = rule.operator === 'empty' || rule.operator === 'present';
  return `${label} ${SMART_OPERATORS[rule.operator]}${noValue ? '' : ` ${rule.value}`}${rule.operator === 'between' ? ` to ${rule.valueTo}` : ''}${rule.operator === 'inLast' || rule.operator === 'olderThan' ? ' days' : ''}`;
};
