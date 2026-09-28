import { SMART_FIELDS, SMART_OPERATORS, type SmartCondition, type SmartGroup, type SmartOperator } from '../shared/smart-playlists';
import type { SyncPlaylist } from './library-sync-model';

type Condition = Omit<SmartCondition, 'field'> & Readonly<{ field: SmartCondition['field'] | 'fileName' }>;

const rekordboxFields: Readonly<Record<string, Condition['field']>> = {
  name: 'title', artist: 'artist', album: 'album', genre: 'genre', key: 'musicalKey',
  label: 'label', comments: 'comments', producer: 'composer', remixedBy: 'remixer',
  mixName: 'mixName', fileName: 'fileName', bpm: 'bpm', counter: 'playCount',
  duration: 'durationSeconds', year: 'year', rating: 'rating', stockDate: 'dateAdded',
};

const rekordboxOperators: Readonly<Record<string, SmartOperator>> = {
  '1': 'is', '2': 'isNot', '3': 'gt', '4': 'lt', '5': 'between', '6': 'inLast',
  '7': 'olderThan', '8': 'contains', '9': 'notContains', '10': 'startsWith', '11': 'endsWith',
};

export const smartCrateConditions = (playlist: SyncPlaylist): Readonly<{
  match: 'all' | 'any'; conditions: readonly Condition[];
}> => {
  const reject = (reason: string): never => {
    throw new Error(`Cannot sync smart playlist "${playlist.path.join(' / ')}" as a Serato smart crate. ${reason}`);
  };
  const smart = playlist.smart;
  if (smart === undefined) return reject('Its rules are missing from the source library.');
  if (smart.kind === 'serato') return reject('The native Serato rules cannot be converted to this format.');
  if (smart.kind === 'rekordbox') {
    if (smart.rules.logicalOperator !== '1' && smart.rules.logicalOperator !== '2') return reject('Its rule combination is unsupported.');
    if (!smart.rules.conditions.length) return reject('Its rules are missing from the Rekordbox XML.');
    return {
      match: smart.rules.logicalOperator === '1' ? 'all' : 'any',
      conditions: smart.rules.conditions.map((raw) => {
        const field = Object.hasOwn(rekordboxFields, raw.PropertyName ?? '') ? rekordboxFields[raw.PropertyName ?? ''] : undefined;
        const operator = Object.hasOwn(rekordboxOperators, raw.Operator ?? '') ? rekordboxOperators[raw.Operator ?? ''] : undefined;
        if (field === undefined || operator === undefined || raw.ValueLeft === undefined) return reject(`The ${raw.PropertyName ?? 'unknown'} rule is unsupported.`);
        if ((operator === 'inLast' || operator === 'olderThan') && raw.ValueUnit !== 'day') return reject('Relative date rules must use days.');
        return { kind: 'condition', field, operator, value: raw.ValueLeft, valueTo: raw.ValueRight ?? '' };
      }),
    };
  }
  if (smart.definition.limit !== null) return reject('Serato smart crates do not support track limits.');
  const top = smart.definition.rules;
  if (top.match === 'none') return reject('Serato smart crates do not support "none" rule groups.');
  const conditions: Condition[] = [];
  const flatten = (group: SmartGroup): void => {
    if (!group.rules.length) reject('A rule group is empty.');
    for (const rule of group.rules) {
      if (rule.kind === 'condition') conditions.push(rule);
      else if (rule.match !== 'none' && (rule.match === top.match || rule.rules.length === 1)) flatten(rule);
      else reject('Serato smart crates cannot combine nested "all", "any", or "none" rule groups.');
    }
  };
  flatten(top);
  return { match: top.match, conditions };
};

type NativeRule = Readonly<{
  type: 'STRING' | 'UINT32'; attribute: string; operation: string; version: 1; value: string | number;
}>;

// Serato DJ Pro 4.0's native SmartCrateRules serializer, version 1.
const textAttributes: Partial<Record<Condition['field'], string>> = {
  title: 'name', artist: 'artist', album: 'album', genre: 'genre', musicalKey: 'key',
  label: 'label', comments: 'comments', composer: 'composer', remixer: 'remixer',
  fileName: 'file_name', fileKind: 'format',
};
const integerAttributes: Partial<Record<Condition['field'], string>> = {
  bpm: 'bpm', playCount: 'dj_play_count', durationSeconds: 'length_ms',
  bitRateKbps: 'file_bit_rate', sampleRateHz: 'file_sample_rate', rating: 'rating',
};
const textOperations: Partial<Record<SmartOperator, string>> = {
  is: 'IS', isNot: 'IS_NOT', contains: 'CONTAINS', notContains: 'DOES_NOT_CONTAIN',
};

export const seratoSmartRules = (playlist: SyncPlaylist): Readonly<{
  version: number; rules: string; warnings?: readonly string[];
}> | null => {
  if (playlist.kind !== 'smart' && playlist.smart === undefined) return null;
  if (playlist.smart?.kind === 'serato') return playlist.smart;
  const source = smartCrateConditions(playlist);
  let match = source.match;
  const rules: NativeRule[] = [];
  const warnings = new Set<string>();
  const reject = (condition: Condition, reason: string): never => {
    const label = SMART_FIELDS.find((field) => field.key === condition.field)?.label ?? 'Filename';
    throw new Error(`Cannot sync smart playlist "${playlist.path.join(' / ')}" as a Serato smart crate. ${label} ${SMART_OPERATORS[condition.operator]}: ${reason}`);
  };
  const append = (condition: Condition, combination: 'all' | 'any', additions: readonly NativeRule[]): void => {
    if (additions.length > 1 && combination !== match) {
      if (source.conditions.length !== 1) reject(condition, 'This comparison needs a nested rule group, which Serato does not support.');
      match = combination;
    }
    rules.push(...additions);
  };
  for (const condition of source.conditions) {
    const { field, operator } = condition;
    const attribute = Object.hasOwn(textAttributes, field) ? textAttributes[field] : undefined;
    if (attribute !== undefined) {
      const operation = textOperations[operator];
      if (operation === undefined) return reject(condition, 'Serato supports is, is not, contains, and does not contain for this field.');
      rules.push({ type: 'STRING', attribute, operation, version: 1, value: condition.value });
      continue;
    }
    const numericAttribute = field === 'year' ? 'year' : Object.hasOwn(integerAttributes, field) ? integerAttributes[field] : undefined;
    if (numericAttribute === undefined) return reject(condition, 'Serato cannot represent this field as a smart crate rule.');
    const number = (raw: string): number => {
      const value = raw.trim() ? Number(raw) : NaN;
      if (!Number.isFinite(value) || value < 0) reject(condition, 'Enter a nonnegative numeric value.');
      if (field === 'rating' && (!Number.isInteger(value) || value > 5)) reject(condition, 'Serato ratings must be whole stars from 0 to 5.');
      return value * (field === 'durationSeconds' ? 1000 : 1);
    };
    const left = number(condition.value);
    const right = operator === 'between' ? number(condition.valueTo) : left;
    if (right < left) reject(condition, 'The upper value must be at least the lower value.');
    if ((field === 'bitRateKbps' || field === 'sampleRateHz') &&
      (!Number.isInteger(left) || !Number.isInteger(right) || operator === 'gt' || operator === 'lt' || operator === 'isNot')) {
      reject(condition, 'Serato supports whole-number is, at least, at most, and between comparisons for this field.');
    }
    if (field === 'bpm') warnings.add(`Smart crate "${playlist.path.join(' / ')}" uses Serato's rounded, whole-number BPM rules.`);
    if (field !== 'year' && field !== 'bpm' && (
      ((operator === 'is' || operator === 'between' || operator === 'gte') && left === 0) ||
      operator === 'lte' || (operator === 'lt' && left > 0) || (operator === 'isNot' && left > 0)
    )) warnings.add(`Smart crate "${playlist.path.join(' / ')}" treats missing numeric metadata as zero in Serato.`);
    const bound = (direction: 'lower' | 'upper', value: number): NativeRule => {
      if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) reject(condition, 'The numeric boundary is outside Serato\'s supported range.');
      if (field === 'year') return {
        type: 'STRING', attribute: numericAttribute, operation: direction === 'lower' ? 'AFTER' : 'BEFORE',
        version: 1, value: String(value + (direction === 'lower' ? -1 : 1)),
      };
      return {
        type: 'UINT32', attribute: numericAttribute,
        operation: direction === 'lower' ? 'GREATER_THAN_OR_EQUAL_TO' : 'LESS_THAN_OR_EQUAL_TO',
        version: 1, value: value * (field === 'rating' ? 20 : 1),
      };
    };
    switch (operator) {
      case 'gte': rules.push(bound('lower', Math.ceil(left))); break;
      case 'gt': rules.push(bound('lower', Math.floor(left) + 1)); break;
      case 'lte': rules.push(bound('upper', Math.floor(left))); break;
      case 'lt': rules.push(bound('upper', Math.ceil(left) - 1)); break;
      case 'is':
        if (!Number.isInteger(left)) reject(condition, 'Serato requires a whole-number value for this comparison.');
        if (field === 'year' || field === 'rating') rules.push({
          type: field === 'year' ? 'STRING' : 'UINT32', attribute: numericAttribute,
          operation: 'IS', version: 1, value: field === 'year' ? String(left) : left * 20,
        });
        else append(condition, 'all', [bound('lower', left), bound('upper', left)]);
        break;
      case 'between': append(condition, 'all', [bound('lower', Math.ceil(left)), bound('upper', Math.floor(right))]); break;
      case 'isNot':
        if (!Number.isInteger(left)) reject(condition, 'Serato requires a whole-number value for this comparison.');
        append(condition, 'any', [...(left > 0 ? [bound('upper', left - 1)] : []), bound('lower', left + 1)]);
        break;
      default: reject(condition, 'This comparison is not supported by Serato.');
    }
  }
  return {
    version: 1,
    rules: JSON.stringify({ spaces: ['Serato Library'], conjunction: match === 'all' ? 'AND' : 'OR', live_updates: true, rules }),
    warnings: [...warnings],
  };
};
