import type { DuplicateCandidate, SongRow, SongSource } from './dj-library';

export const recommendedKeepSongIdFor = (
  candidates: readonly DuplicateCandidate[],
  preferredStreamingSource: SongSource | null = null,
): string | null => {
  let recommended: SongRow | null = null;

  for (const { song } of candidates) {
    if (recommended === null) {
      recommended = song;
      continue;
    }

    const localPriority =
      Number(song.source === 'local') - Number(recommended.source === 'local');
    const streamingPriority =
      Number(song.source === preferredStreamingSource) -
      Number(recommended.source === preferredStreamingSource);
    if (
      localPriority > 0 ||
      (localPriority === 0 &&
        (streamingPriority > 0 ||
          (streamingPriority === 0 &&
            song.hotCueCount > 0 &&
            recommended.hotCueCount === 0)))
    ) {
      recommended = song;
    }
  }

  return recommended?.id ?? null;
};
