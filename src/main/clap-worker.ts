import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { availableParallelism } from 'node:os';

import decode from '@audio/decode';
import { resample } from 'wave-resampler';
import {
  AutoProcessor, AutoTokenizer, ClapAudioModelWithProjection, ClapTextModelWithProjection, env,
  type ProgressInfo,
} from '@huggingface/transformers';
// eslint-disable-next-line import/no-unresolved
import { parseFile } from 'music-metadata';

import { CLAP_MODEL, type PlaylistSuggestionProgress, type PlaylistSuggestionResult } from '../shared/playlist-suggestions';
import type { ClapWorkerMessage, ClapWorkerRequest } from './playlist-suggestions';
import { matchesTempo, normalizeEmbedding, rankPlaylist, tempoFromMood, type EmbeddedTrack } from './rank-playlist';

const MODEL_REVISION = 'e9fd5ac1dbf3280936a7fc3ec8a020453ff184db';
const CACHE_VERSION = `${MODEL_REVISION}-q8-sections-v1`;
const SAMPLE_RATE = 48_000;
const SECTION_SECONDS = 10;
const formats = {
  '.mp3': 'mp3', '.wav': 'wav', '.flac': 'flac', '.aif': 'aiff', '.aifc': 'aiff', '.aiff': 'aiff',
  '.m4a': 'm4a', '.mp4': 'm4a', '.aac': 'aac', '.ogg': 'oga', '.oga': 'oga', '.opus': 'opus', '.wma': 'wma',
} satisfies Record<string, Parameters<typeof decode>[1]>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isEmbedding = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length === 512 && value.every((item: unknown) => typeof item === 'number' && Number.isFinite(item));

const audioSections = async (mediaPath: string): Promise<Float32Array[]> => {
  const format = Object.entries(formats).find(([extension]) => extension === extname(mediaPath).toLowerCase())?.[1];
  if (!format) throw new Error('Unsupported audio format');
  const metadata = await parseFile(mediaPath, { duration: true, skipCovers: true });
  const duration = metadata.format.duration;
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) throw new Error('Unknown track duration');
  const offsets = duration <= SECTION_SECONDS ? [0] : [0.2, 0.5, 0.8].map((fraction) => (duration - SECTION_SECONDS) * fraction);
  const sections = offsets.map(() => ({ samples: new Float32Array(0), filled: 0 }));
  let framesRead = 0;
  let sampleRate = 0;
  const stream = createReadStream(mediaPath, { highWaterMark: 64 * 1024 });
  try {
    for await (const block of decode(stream, format)) {
      const frames = block.channelData[0]?.length ?? 0;
      if (frames === 0) continue;
      if (sampleRate === 0) {
        sampleRate = block.sampleRate;
        if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Invalid sample rate');
        for (const section of sections) section.samples = new Float32Array(Math.ceil(Math.min(duration, SECTION_SECONDS) * sampleRate));
      }
      if (block.sampleRate !== sampleRate) throw new Error('Changing sample rate');
      for (const [index, section] of sections.entries()) {
        const start = Math.floor((offsets[index] ?? 0) * sampleRate);
        const from = Math.max(start, framesRead);
        const to = Math.min(start + section.samples.length, framesRead + frames);
        for (let frame = from; frame < to; frame += 1) {
          let sample = 0;
          for (const channel of block.channelData) sample += channel[frame - framesRead] ?? 0;
          section.samples[frame - start] = sample / block.channelData.length;
          section.filled += 1;
        }
      }
      framesRead += frames;
      if (sections.every((section) => section.filled === section.samples.length)) break;
    }
  } finally {
    stream.destroy();
  }
  if (sampleRate === 0) throw new Error('No decodable audio');
  const audio = sections.filter((section) => section.filled > 0 && section.filled >= Math.min(sampleRate, section.samples.length)).map((section) => {
    const samples = section.samples.subarray(0, section.filled);
    return sampleRate === SAMPLE_RATE ? samples : Float32Array.from(resample(samples, sampleRate, SAMPLE_RATE, { method: 'sinc' }));
  });
  if (audio.length === 0) throw new Error('No decodable audio');
  return audio;
};

export const analyzePlaylist = async (
  { tracks, request, cacheDirectory }: ClapWorkerRequest,
  onProgress: (progress: PlaylistSuggestionProgress) => void,
): Promise<PlaylistSuggestionResult> => {
  const tempo = tempoFromMood(request.mood);
  if (tempo && (tempo.min < 30 || tempo.max > 300 || tempo.min > tempo.max)) return { kind: 'rejected', reason: 'invalid-tempo' };
  const seedIds = new Set(request.seedSongIds);
  const excludedIds = new Set([...request.excludedSongIds, ...request.seedSongIds]);
  const localTracks = tracks.filter((track) => track.mediaPath !== null);
  if (localTracks.length === 0) return { kind: 'rejected', reason: 'no-local-audio' };
  const selectedTracks = tracks.filter(({ song }) => seedIds.has(song.id));
  if (selectedTracks.some((track) => track.mediaPath === null)) return { kind: 'rejected', reason: 'seed-audio-unavailable' };
  const candidates = localTracks.filter(({ song }) => seedIds.has(song.id) || (!excludedIds.has(song.id) && matchesTempo(song, tempo)));
  env.allowLocalModels = false;
  env.cacheDir = join(cacheDirectory, 'models');
  env.useFSCache = true;
  const embeddingsDirectory = join(cacheDirectory, CACHE_VERSION);
  await mkdir(embeddingsDirectory, { recursive: true });
  const progress_callback = (info: ProgressInfo): void => {
    if (info.status === 'progress' && info.file.endsWith('.onnx')) {
      onProgress({ phase: 'model', percent: Math.floor(info.progress) });
    }
  };
  const modelOptions = {
    revision: MODEL_REVISION, dtype: 'q8', device: 'cpu', progress_callback,
    session_options: { intraOpNumThreads: Math.min(4, availableParallelism()), interOpNumThreads: 1 },
  } as const;
  let textEmbedding: number[] | null = null;
  if (request.mood.length > 0) {
    onProgress({ phase: 'model', percent: null });
    try {
      const tokenizer = await AutoTokenizer.from_pretrained(CLAP_MODEL, modelOptions);
      const inputs = await tokenizer(request.mood, { truncation: false });
      if (inputs.input_ids.size > 77) return { kind: 'rejected', reason: 'description-too-long' };
      const textModel = await ClapTextModelWithProjection.from_pretrained(CLAP_MODEL, modelOptions);
      try {
        const output = await textModel(inputs);
        textEmbedding = normalizeEmbedding(Array.from(output.text_embeds.data, Number));
      } finally { await textModel.dispose(); }
    } catch (error) {
      console.error('CLAP text model failed', error);
      return { kind: 'rejected', reason: 'model-unavailable' };
    }
  }
  let audioModel: Awaited<ReturnType<typeof ClapAudioModelWithProjection.from_pretrained>> | null = null;
  let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null;
  const embeddings: EmbeddedTrack[] = [];
  let cachedCount = 0;
  let failedCount = 0;
  try {
    for (const [index, track] of candidates.entries()) {
      onProgress({ phase: 'analyzing', completed: index, total: candidates.length, title: track.song.title });
      const mediaPath = track.mediaPath;
      if (mediaPath === null) continue;
      try {
        const fingerprint = await stat(mediaPath);
        if (!fingerprint.isFile()) throw new Error('Not an audio file');
        const cachePath = join(embeddingsDirectory, `${createHash('sha256').update(mediaPath).digest('hex')}.json`);
        let embedding: number[] | null = null;
        try {
          const cached: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
          if (isRecord(cached) && cached.size === fingerprint.size && cached.mtimeMs === fingerprint.mtimeMs && isEmbedding(cached.embedding)) {
            embedding = normalizeEmbedding(cached.embedding);
            cachedCount += 1;
          }
        } catch { /* A missing or damaged cache entry is rebuilt from audio. */ }
        if (embedding === null) {
          const sections = await audioSections(mediaPath);
          if (audioModel === null || processor === null) {
            onProgress({ phase: 'model', percent: null });
            try {
              processor = await AutoProcessor.from_pretrained(CLAP_MODEL, modelOptions);
              audioModel = await ClapAudioModelWithProjection.from_pretrained(CLAP_MODEL, modelOptions);
            } catch (error) {
              console.error('CLAP audio model failed', error);
              return { kind: 'rejected', reason: 'model-unavailable' };
            }
          }
          const sectionEmbeddings: number[][] = [];
          for (const audio of sections) {
            const inputs = await processor(audio);
            const output = await audioModel(inputs);
            sectionEmbeddings.push(normalizeEmbedding(Array.from(output.audio_embeds.data, Number)));
          }
          embedding = normalizeEmbedding(sectionEmbeddings[0]?.map((_, i) =>
            sectionEmbeddings.reduce((sum, section) => sum + (section[i] ?? 0), 0) / sectionEmbeddings.length,
          ) ?? []);
          const latest = await stat(mediaPath);
          if (latest.size !== fingerprint.size || latest.mtimeMs !== fingerprint.mtimeMs) throw new Error('Track changed during analysis');
          const temp = `${cachePath}.${process.pid}.tmp`;
          await writeFile(temp, JSON.stringify({ size: fingerprint.size, mtimeMs: fingerprint.mtimeMs, embedding }));
          await rename(temp, cachePath);
        }
        embeddings.push({ song: track.song, embedding });
      } catch (error) {
        console.error('Track analysis skipped', track.song.id, error instanceof Error ? error.message : String(error));
        failedCount += 1;
      }
    }
  } finally { await audioModel?.dispose(); }
  onProgress({ phase: 'ranking' });
  const byId = new Map(embeddings.map((track) => [track.song.id, track]));
  const seeds = request.seedSongIds.flatMap((id) => { const track = byId.get(id); return track ? [track] : []; });
  if (seeds.length !== seedIds.size) return { kind: 'rejected', reason: 'seed-audio-unavailable' };
  if (embeddings.length === 0 && candidates.length > 0) return { kind: 'rejected', reason: 'no-local-audio' };
  return {
    kind: 'ready', model: CLAP_MODEL,
    suggestions: rankPlaylist({ tracks: embeddings, seeds, textEmbedding, excludedIds, tempo }),
    candidateCount: embeddings.filter(({ song }) => !excludedIds.has(song.id)).length,
    librarySongCount: tracks.length, skippedCount: tracks.length - localTracks.length + failedCount, cachedCount,
  };
};

process.parentPort?.once('message', (event: { data: ClapWorkerRequest }) => {
  const send = (message: ClapWorkerMessage): void => process.parentPort.postMessage(message);
  void analyzePlaylist(event.data, (progress) => send({ kind: 'progress', progress }))
    .then((result) => send({ kind: 'result', result }))
    .catch((error: unknown) => {
      console.error('CLAP recommendation failed', error);
      send({ kind: 'result', result: { kind: 'rejected', reason: 'failed' } });
    });
});
