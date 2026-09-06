import type {
  DuplicateCandidate,
  DuplicateGroup,
  DuplicateMatchMode,
  DuplicateScan,
  DuplicateVariantKind,
  SongRow,
} from '../shared/dj-library';

type ParsedTitle = Readonly<{
  baseKey: string;
  baseTitle: string;
  candidate: DuplicateCandidate;
  fullKey: string;
  recognizedQualifier: boolean;
}>;

type Qualifier = Readonly<{
  kinds: readonly DuplicateVariantKind[];
  label: string;
}>;

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

const variantKindOrder: readonly DuplicateVariantKind[] = [
  'original',
  'alternate',
  'dj-edit',
  'remix',
];

const normalizeExact = (value: string | null): string =>
  value?.trim().toLocaleLowerCase() ?? '';

const normalizeFamily = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');

const orderedKinds = (
  kinds: ReadonlySet<DuplicateVariantKind>,
): readonly DuplicateVariantKind[] =>
  variantKindOrder.filter((kind) => kinds.has(kind));

const qualifierFor = (rawValue: string): Qualifier | null => {
  const label = rawValue.trim().replace(/\s+/gu, ' ');
  const normalized = normalizeFamily(label);
  if (!normalized) {
    return null;
  }

  if (/^original(?: mix| version)?$/u.test(normalized)) {
    return { kinds: ['original'], label };
  }

  const kinds = new Set<DuplicateVariantKind>();
  if (/\b(?:remix|rmx|rework|bootleg|mashup|vip|flip)\b/u.test(normalized)) {
    kinds.add('remix');
  }
  if (
    /\b(?:remaster(?:ed)?|version|anniversary edition|mono|stereo)\b/u.test(
      normalized,
    )
  ) {
    kinds.add('alternate');
  }
  if (
    /\b(?:intro|outro|extended|radio|clean|dirty|explicit|instrumental|acapella|a cappella|club mix|club edit|dub|re edit|edit)\b/u.test(
      normalized,
    )
  ) {
    kinds.add('dj-edit');
  }

  return kinds.size === 0 ? null : { kinds: orderedKinds(kinds), label };
};

const bareQualifierPattern =
  /^(.*\S)\s+(original(?: mix| version)?|extended(?: mix)?|radio(?: edit| mix| version)?|clean|dirty|explicit|instrumental|acapella|a cappella|club(?: mix| edit)|dub(?: mix)?|intro|outro|re[- ]edit|edit|remaster(?:ed)?(?: \d{4})?|album version|single version|live version|demo version|anniversary edition|mono version|stereo version|vip|flip)$/iu;

const trailingQualifier = (
  title: string,
): Readonly<{ base: string; qualifier: Qualifier }> | null => {
  const bracketed = title.match(/^(.*\S)\s*[([]\s*([^()[\]]+)\s*[)\]]\s*$/u);
  if (bracketed !== null) {
    const base = bracketed[1];
    const value = bracketed[2];
    if (base !== undefined && value !== undefined) {
      const qualifier = qualifierFor(value);
      if (qualifier !== null) {
        return { base: base.trim(), qualifier };
      }
    }
  }

  const separated =
    title.match(/^(.*\S)\s[-–—]\s(.+)$/u) ??
    title.match(/^(.*\S):\s+(.+)$/u);
  if (separated !== null) {
    const base = separated[1];
    const value = separated[2];
    if (base !== undefined && value !== undefined) {
      const qualifier = qualifierFor(value);
      if (qualifier !== null) {
        return { base: base.trim(), qualifier };
      }
    }
  }

  const bare = title.match(bareQualifierPattern);
  if (bare === null) {
    return null;
  }

  const base = bare[1];
  const value = bare[2];
  if (base === undefined || value === undefined) {
    return null;
  }

  const qualifier = qualifierFor(value);
  return qualifier === null ? null : { base: base.trim(), qualifier };
};

const parseTitle = (song: SongRow): ParsedTitle => {
  const fullTitle = song.title.trim();
  let baseTitle = fullTitle;
  const labels: string[] = [];
  const kinds = new Set<DuplicateVariantKind>();

  for (let index = 0; index < 6; index += 1) {
    const trailing = trailingQualifier(baseTitle);
    if (trailing === null || trailing.base.length === 0) {
      break;
    }

    baseTitle = trailing.base;
    labels.unshift(trailing.qualifier.label);
    for (const kind of trailing.qualifier.kinds) {
      kinds.add(kind);
    }
  }

  const leading = baseTitle.match(/^(intro|outro)\s*[-–—:]\s*(.+\S)$/iu);
  if (leading !== null) {
    const value = leading[1];
    const remainingTitle = leading[2];
    if (value !== undefined && remainingTitle !== undefined) {
      const qualifier = qualifierFor(value);
      if (qualifier !== null) {
        baseTitle = remainingTitle.trim();
        labels.unshift(qualifier.label);
        for (const kind of qualifier.kinds) {
          kinds.add(kind);
        }
      }
    }
  }

  const fullKey = normalizeFamily(fullTitle);
  const baseKey = normalizeFamily(baseTitle) || fullKey;
  const recognizedQualifier = labels.length > 0;
  if (!recognizedQualifier) {
    kinds.add('original');
  }

  return {
    baseKey,
    baseTitle: baseTitle || fullTitle,
    candidate: {
      song,
      variantLabel: recognizedQualifier ? labels.join(' · ') : 'Original',
      variantKinds: orderedKinds(kinds),
    },
    fullKey,
    recognizedQualifier,
  };
};

const candidateRank = (candidate: DuplicateCandidate): number => {
  if (candidate.variantKinds.includes('remix')) {
    return 3;
  }
  if (candidate.variantKinds.includes('dj-edit')) {
    return 2;
  }
  if (candidate.variantKinds.includes('alternate')) {
    return 1;
  }
  return 0;
};

const compareCandidates = (
  left: DuplicateCandidate,
  right: DuplicateCandidate,
): number =>
  candidateRank(left) - candidateRank(right) ||
  collator.compare(left.variantLabel, right.variantLabel) ||
  collator.compare(left.song.title, right.song.title) ||
  collator.compare(left.song.id, right.song.id);

const compareGroups = (left: DuplicateGroup, right: DuplicateGroup): number =>
  collator.compare(left.artist, right.artist) ||
  collator.compare(left.title, right.title);

const exactGroupsFor = (songs: readonly SongRow[]): readonly DuplicateGroup[] => {
  const byIdentity = new Map<string, SongRow[]>();

  for (const song of songs) {
    const key = JSON.stringify([
      normalizeExact(song.artist),
      normalizeExact(song.title),
    ]);
    const existing = byIdentity.get(key);
    if (existing === undefined) {
      byIdentity.set(key, [song]);
    } else {
      existing.push(song);
    }
  }

  return [...byIdentity.entries()]
    .filter((entry) => entry[1].length > 1)
    .map(([identity, tracks]) => {
      const candidates = tracks.map((song) => parseTitle(song).candidate);
      const first = candidates[0];
      if (first === undefined) {
        throw new Error('Duplicate group unexpectedly has no candidates');
      }

      return {
        key: JSON.stringify(['exact', identity]),
        title: first.song.title,
        artist: first.song.artist ?? 'Unknown artist',
        matchReason: 'Same title and artist metadata',
        candidates,
      };
    })
    .sort(compareGroups);
};

const familyReason: Readonly<
  Record<Exclude<DuplicateMatchMode, 'exact'>, string>
> = {
  versions: 'Same artist and base title with recognized version tags',
  'dj-edits': 'Same artist and base title with a DJ edit tag',
  remixes: 'Same artist and base title with a remix tag',
};

const familyGroupsFor = (
  songs: readonly SongRow[],
  mode: Exclude<DuplicateMatchMode, 'exact'>,
): readonly DuplicateGroup[] => {
  const byFamily = new Map<string, ParsedTitle[]>();

  for (const song of songs) {
    const artistKey = normalizeFamily(song.artist ?? '');
    if (!artistKey) {
      continue;
    }

    const parsed = parseTitle(song);
    const familyKey = JSON.stringify([artistKey, parsed.baseKey]);
    const existing = byFamily.get(familyKey);
    if (existing === undefined) {
      byFamily.set(familyKey, [parsed]);
    } else {
      existing.push(parsed);
    }
  }

  const groups: DuplicateGroup[] = [];
  for (const [familyKey, indexedCandidates] of byFamily) {
    const distinctTitles = new Set(
      indexedCandidates.map((candidate) => candidate.fullKey),
    );
    const hasRecognizedQualifier = indexedCandidates.some(
      (candidate) => candidate.recognizedQualifier,
    );
    const hasRequiredKind =
      mode === 'versions' ||
      indexedCandidates.some((candidate) =>
        candidate.candidate.variantKinds.includes(
          mode === 'dj-edits' ? 'dj-edit' : 'remix',
        ),
      );

    if (
      indexedCandidates.length < 2 ||
      distinctTitles.size < 2 ||
      !hasRecognizedQualifier ||
      !hasRequiredKind
    ) {
      continue;
    }

    const candidates = indexedCandidates
      .map((candidate) => candidate.candidate)
      .sort(compareCandidates);
    const firstIndexed = indexedCandidates[0];
    const firstCandidate = candidates[0];
    if (firstIndexed === undefined || firstCandidate === undefined) {
      continue;
    }

    const original = indexedCandidates.find(
      (candidate) => !candidate.recognizedQualifier,
    );
    groups.push({
      key: JSON.stringify([mode, familyKey]),
      title: original?.candidate.song.title ?? firstIndexed.baseTitle,
      artist: firstCandidate.song.artist ?? 'Unknown artist',
      matchReason: familyReason[mode],
      candidates,
    });
  }

  return groups.sort(compareGroups);
};

export const findDuplicateScan = (
  songs: readonly SongRow[],
  mode: DuplicateMatchMode,
): DuplicateScan => {
  const groups =
    mode === 'exact' ? exactGroupsFor(songs) : familyGroupsFor(songs, mode);

  return {
    mode,
    groups,
    ignoredGroupCount: 0,
    trackCount: groups.reduce(
      (total, group) => total + group.candidates.length,
      0,
    ),
  };
};
