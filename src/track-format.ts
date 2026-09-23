export const formatTrackDuration = (durationSeconds: number | null): string => {
  if (durationSeconds === null || !Number.isFinite(durationSeconds)) {
    return 'Not set';
  }

  const rounded = Math.max(0, Math.floor(durationSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = String(rounded % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
};

export const formatTrackBpm = (bpm: number | null): string =>
  bpm === null
    ? '—'
    : bpm.toLocaleString(undefined, { maximumFractionDigits: 2 });
