# Music recommendations

Arsenal matches a short description, selected starting tracks, or both against audio in the imported Rekordbox library. Analysis runs locally in an Electron utility process. Audio and descriptions stay on the computer.

The model is [Xenova/larger_clap_music_and_speech](https://huggingface.co/Xenova/larger_clap_music_and_speech), pinned to revision `e9fd5ac1dbf3280936a7fc3ec8a020453ff184db`. Transformers.js runs its quantized audio and text encoders on the CPU. First use downloads about 210 MB from Hugging Face. Later requests work offline once the required models are cached.

Each track contributes up to three 10-second excerpts from different parts of the recording. Arsenal converts them to mono at 48 kHz and averages their normalized CLAP embeddings. Track analysis is cached under Electron's `userData/clap` directory. A changed file size, modification time, or model revision invalidates the cache. Stopping a request preserves completed entries.

Text similarity determines the match. Starting tracks contribute 20% of the score when a description is also present. Seed-only requests use audio similarity. The playlist contains up to 12 suggestions, excludes selected tracks, and limits each artist to two suggestions. Existing Rekordbox BPM and key values help order nearby matches.

Descriptions work best in English and should describe audible qualities, such as instruments, genre, energy, and mood. CLAP accepts at most 77 tokens. Longer descriptions return an error. It does not interpret arbitrary instructions or look up songs outside the library.

Explicit BPM ranges use Rekordbox metadata. `124-128 BPM` includes both endpoints. `Under 128 BPM` excludes 128, while `at most 128 BPM` includes it. A single target such as `128 BPM` allows three BPM on either side. Tracks without BPM metadata cannot pass a BPM filter. Valid tempos are 30 to 300 BPM.

The decoder accepts WAV, MP3, FLAC, AIFF, AAC, M4A, Ogg Vorbis, Opus, and WMA extensions. Codec support varies within containers. Streaming entries, missing files, and decoder failures are skipped. Every starting track must have readable audio. Initial analysis of a large library can take substantially longer than later cached requests.

`clap-worker.ts` owns inference and caching. `rank-playlist.ts` owns scoring and ordering. The main process validates requests and stops the worker on cancellation, library replacement, window closure, or five minutes without progress. Webpack stages the traced runtime dependencies and their license files beside the worker. Native ONNX libraries are unpacked from ASAR. Builds use the target operating system and architecture.

The upstream [LAION model](https://huggingface.co/laion/larger_clap_music_and_speech) declares Apache-2.0. Decoder licenses are separate. In particular, `@audio/decode-aac` declares GPL-2.0 because it includes FAAD2. The `@audio/decode-wma` package has conflicting declarations: its package metadata says GPL-2.0-or-later and its LICENSE file says LGPL-2.1-or-later. Including these packages requires a licensing decision before distributing an MIT-only application. The build copies the installed license files without changing those declarations.
