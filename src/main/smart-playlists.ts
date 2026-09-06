import { basename } from 'node:path';

import type { SmartPlaylistStatus, SongRow } from '../shared/dj-library';
import type { ParsedTrack } from './parse-rekordbox-xml';

export type SmartPlaylistRules = Readonly<{
  logicalOperator: string | null;
  conditions: readonly Readonly<Record<string, string>>[];
}>;

type Field =
  | Readonly<{ kind: 'text'; label: string; read: (track: ParsedTrack) => string | null }>
  | Readonly<{ kind: 'number'; label: string; read: (track: ParsedTrack) => number | null }>
  | Readonly<{ kind: 'date'; label: string; read: (track: ParsedTrack) => string | null }>;

const fields: Readonly<Record<string, Field>> = {
  artist: { kind: 'text', label: 'Artist', read: ({ song }) => song.artist },
  album: { kind: 'text', label: 'Album', read: ({ song }) => song.album },
  producer: { kind: 'text', label: 'Composer', read: ({ song }) => song.composer },
  comments: { kind: 'text', label: 'Comments', read: ({ song }) => song.comments },
  genre: { kind: 'text', label: 'Genre', read: ({ song }) => song.genre },
  key: { kind: 'text', label: 'Key', read: ({ song }) => song.musicalKey },
  label: { kind: 'text', label: 'Label', read: ({ song }) => song.label },
  mixName: { kind: 'text', label: 'Mix', read: ({ song }) => song.mixName },
  remixedBy: { kind: 'text', label: 'Remixer', read: ({ song }) => song.remixer },
  name: { kind: 'text', label: 'Title', read: ({ song }) => song.title },
  fileName: { kind: 'text', label: 'Filename', read: ({ mediaPath }) => mediaPath === null ? null : basename(mediaPath) },
  bpm: { kind: 'number', label: 'BPM', read: ({ song }) => song.bpm },
  counter: { kind: 'number', label: 'Play count', read: ({ song }) => song.playCount },
  duration: { kind: 'number', label: 'Duration in seconds', read: ({ song }) => song.durationSeconds },
  year: { kind: 'number', label: 'Year', read: ({ song }) => song.year },
  rating: {
    kind: 'number', label: 'Rating', read: ({ song }) => song.rating === null
      ? null : Math.round(song.rating > 5 ? song.rating / 51 : song.rating),
  },
  stockDate: { kind: 'date', label: 'Date added', read: ({ song }) => song.dateAdded },
};

const operatorLabels: Readonly<Record<string, string>> = {
  '1': 'is', '2': 'is not', '3': 'is greater than', '4': 'is less than',
  '5': 'is between', '6': 'is in the last', '7': 'is not in the last',
  '8': 'contains', '9': 'does not contain', '10': 'starts with', '11': 'ends with',
};

type Condition =
  | Readonly<{ kind: 'ready'; description: string; matches: (track: ParsedTrack) => boolean }>
  | Readonly<{ kind: 'unsupported'; description: string; reason: string }>;

const dateValue = (value: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00`);
  return Number.isFinite(date.getTime()) &&
    date.getFullYear() === Number(value.slice(0, 4)) &&
    date.getMonth() + 1 === Number(value.slice(5, 7)) &&
    date.getDate() === Number(value.slice(8, 10))
    ? date.getTime() : null;
};

const numberValue = (value: string): number | null =>
  value.trim().length > 0 && Number.isFinite(Number(value)) ? Number(value) : null;

const compareNumber = (value: number, operator: string, left: number, right: number | null): boolean => {
  switch (operator) {
    case '1': return value === left;
    case '2': return value !== left;
    case '3': return value > left;
    case '4': return value < left;
    case '5': return right !== null && value >= left && value <= right;
    default: return false;
  }
};

const compileCondition = (attributes: Readonly<Record<string, string>>, now: Date): Condition => {
  const property = attributes.PropertyName ?? '';
  const field = Object.hasOwn(fields, property) ? fields[property] : undefined;
  const operator = attributes.Operator ?? '';
  const leftText = attributes.ValueLeft ?? '';
  const rightText = attributes.ValueRight ?? '';
  const unit = attributes.ValueUnit ?? '';
  const description = `${field?.label ?? property} ${operatorLabels[operator] ?? `operator ${operator}`} "${leftText}"${operator === '5' ? ` and "${rightText}"` : ''}${operator === '6' || operator === '7' ? ` ${unit}s` : ''}`;
  const unsupported = (reason: string): Condition => ({ kind: 'unsupported', description, reason });

  if (field === undefined) {
    return unsupported(`The XML does not provide a supported value for "${property || 'unknown field'}".`);
  }
  if (attributes.ValueLeft === undefined) {
    return unsupported(`The ${field.label} rule is missing its value.`);
  }

  if (field.kind === 'text') {
    if (!['1', '2', '8', '9', '10', '11'].includes(operator)) {
      return unsupported(`Unsupported comparison for ${field.label}.`);
    }
    const left = leftText.toLocaleLowerCase();
    return {
      kind: 'ready', description,
      matches: (track) => {
        const value = (field.read(track) ?? '').toLocaleLowerCase();
        switch (operator) {
          case '1': return value === left;
          case '2': return value !== left;
          case '8': return value.includes(left);
          case '9': return !value.includes(left);
          case '10': return value.startsWith(left);
          case '11': return value.endsWith(left);
          default: return false;
        }
      },
    };
  }

  if (field.kind === 'date' && (operator === '6' || operator === '7')) {
    const count = numberValue(leftText);
    if (count === null || !Number.isSafeInteger(count) || count < 0 || !['day', 'month'].includes(unit)) {
      return unsupported(`Invalid date interval for ${field.label}.`);
    }
    const threshold = new Date(now);
    threshold.setHours(0, 0, 0, 0);
    if (unit === 'day') {
      threshold.setDate(threshold.getDate() - count);
    } else {
      const day = threshold.getDate();
      threshold.setDate(1);
      threshold.setMonth(threshold.getMonth() - count);
      const monthEnd = new Date(threshold.getFullYear(), threshold.getMonth() + 1, 0).getDate();
      threshold.setDate(Math.min(day, monthEnd));
    }
    if (!Number.isFinite(threshold.getTime())) {
      return unsupported(`Invalid date interval for ${field.label}.`);
    }
    return {
      kind: 'ready', description,
      matches: (track) => {
        const value = dateValue(field.read(track) ?? '');
        return value !== null && (operator === '6'
          ? value >= threshold.getTime() && value <= now.getTime()
          : value < threshold.getTime());
      },
    };
  }

  if (!['1', '2', '3', '4', '5'].includes(operator)) {
    return unsupported(`Unsupported comparison for ${field.label}.`);
  }
  const left = field.kind === 'date' ? dateValue(leftText) : numberValue(leftText);
  const right = field.kind === 'date' ? dateValue(rightText) : numberValue(rightText);
  if (left === null || (operator === '5' && (right === null || right < left))) {
    return unsupported(`Invalid value for ${field.label}.`);
  }
  return {
    kind: 'ready', description,
    matches: (track) => {
      const value = field.kind === 'date' ? dateValue(field.read(track) ?? '') : field.read(track);
      return value !== null && compareNumber(value, operator, left, right);
    },
  };
};

export const evaluateSmartPlaylist = (
  rules: SmartPlaylistRules,
  tracks: readonly ParsedTrack[],
  exportedTracks: readonly SongRow[],
): Readonly<{ tracks: readonly SongRow[]; status: SmartPlaylistStatus }> => {
  const now = new Date();
  const conditions = rules.conditions.map((condition) => compileCondition(condition, now));
  const descriptions = conditions.map((condition) => condition.description);
  const unavailable = (message: string) => ({
    tracks: exportedTracks,
    status: { kind: 'unavailable', message: `${message} Showing exported tracks.`, conditions: descriptions } satisfies SmartPlaylistStatus,
  });
  if (conditions.length === 0) {
    return unavailable('This XML does not include the smart playlist rules.');
  }
  if (rules.logicalOperator !== '1' && rules.logicalOperator !== '2') {
    return unavailable('The rule combination is missing or unsupported.');
  }
  const unsupported = conditions.find((condition) => condition.kind === 'unsupported');
  if (unsupported?.kind === 'unsupported') {
    return unavailable(unsupported.reason);
  }
  const matches = (track: ParsedTrack, condition: Condition): boolean =>
    condition.kind === 'ready' && condition.matches(track);
  return {
    tracks: tracks.filter((track) => rules.logicalOperator === '1'
      ? conditions.every((condition) => matches(track, condition))
      : conditions.some((condition) => matches(track, condition))).map((track) => track.song),
    status: {
      kind: 'evaluated',
      message: `Matches ${rules.logicalOperator === '1' ? 'all' : 'any'} of these rules in the current collection.`,
      conditions: descriptions,
    },
  };
};
