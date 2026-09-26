# Music recommendations

Arsenal uses the English [Laya model](https://huggingface.co/convaiinnovations/laya) locally on the CPU. If the model is already bundled or downloaded, recommendations work offline without an API key, account, or Python installation. Descriptions and track metadata stay on the computer. Old OpenRouter credentials are no longer read or used.

If the model is missing, click **Download Laya** in Preferences or the playlist suggestions panel. Arsenal downloads about 810 MiB directly from Hugging Face, then converts the model locally. Allow at least 2.5 GiB of free disk space during installation. Progress shows the download and conversion phases. You can cancel or retry, and continue using Arsenal during setup. Arsenal verifies the downloaded and converted files before installing them in the app's user data folder. It removes the original checkpoint after conversion. Later requests reuse the converted model offline. Partial or failed installations are never used for inference.

Describe a mood, select starting tracks, or use both. English descriptions work best with this checkpoint. Laya scores title, artist, genre, album, mix, remixer, BPM, key, and year metadata. It does not listen to audio or generate track names. Sparse metadata can produce weak matches. Streaming tracks and tracks with unavailable audio can still be suggested.

Preferences > Library sets the minimum track length, which defaults to 30 seconds. Tracks below that length are excluded from the library and recommendations.

## Scoring and limits

Each candidate is scored independently with the description and all selected starting tracks. The five score levels range from an unrelated style and opposite mood to an exact match. Arsenal maps Laya's fractional score from 0–4 to 1–100 with `1 + 99 * score / 4`, then excludes matches below 67.

The ranking score is `1 + (matchScore - 1) * confidence`. Laya's score confidence measures how concentrated its answer probabilities are, using `1 - normalized entropy`. It is not the probability that a listener will like a track. This differs from Jev's confidence scale, so results can change with the model replacement. The bundled model has not been calibrated or evaluated specifically for music recommendations.

The English model accepts 512 tokens per question, including the question, score criteria, description, starting tracks, and candidate. Arsenal shortens metadata fields and checks the complete token count before inference. If a candidate cannot fit with all starting tracks, the request fails with an instruction to shorten the description or select fewer starting tracks. It does not silently discard a candidate or starting track. All eligible candidates are scored unless the request fails or is cancelled.

Suggestions include up to 12 tracks, exclude selected tracks, and allow at most two tracks per artist. Full-precision weighted scores determine the order. Equal scores use higher confidence, then track ID as a stable tie-breaker. Tempo and key labels describe matches calculated locally and do not change the ranking.

Explicit BPM ranges use Rekordbox metadata. `124-128 BPM` includes both endpoints. `Under 128 BPM` excludes 128, while `at most 128 BPM` includes it. A target such as `128 BPM` allows three BPM on either side. Tracks without BPM metadata cannot pass a BPM filter. Valid tempos are 30 to 300 BPM.

## Local runtime

Arsenal loads the model in a separate process for each request and releases it when the request ends. Progress shows model loading and the number of scored tracks. Stop, library replacement, window closure, and app shutdown terminate active inference. Requests time out after two minutes without progress or 30 minutes in total. Errors discard partial results.

The model occupies about 1.6 GiB on disk and needs additional RAM during inference. Loading time and scoring speed depend on the computer. Missing or incomplete model files enable the in-app download. Downloads use a pinned Hugging Face revision, independent of the Arsenal version. Local conversion uses the bundled Node runtime and requires no Python installation. Developers can regenerate the bundle with `npm run prepare:laya`, as described in [the build instructions](releases.md).

The build pins the model and SDK revisions, verifies the ONNX export against PyTorch, and includes model provenance, checksums, and Apache 2.0 license files. Model preparation needs an internet connection. Installed recommendations do not.
