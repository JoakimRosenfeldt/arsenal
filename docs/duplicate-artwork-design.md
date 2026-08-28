# Duplicate families and embedded artwork

## Decision

Arsenal will scan duplicates in Electron main, where the complete imported catalog already lives. The renderer requests one of four fixed modes: `exact`, `versions`, `dj-edits`, or `remixes`. It receives typed, read-only groups containing every candidate in each family.

Embedded artwork stays behind the main-process boundary. Rekordbox `Location` values are converted to private local paths during XML parsing. Public song rows receive only a revision-scoped `cuebox-art:` URL. An `<img>` request resolves that opaque URL to the current catalog, extracts the embedded cover lazily, normalizes it to a small JPEG, and falls back cleanly when the file or cover is unavailable.

## Matching rules

- `exact` keeps the existing case-insensitive, trimmed artist-and-title identity.
- Family modes require the same normalized artist and canonical base title.
- Canonicalization removes only recognized leading or terminal qualifiers. It does not strip arbitrary parentheses, dash clauses, or `feat.` credits.
- `versions` requires at least two distinct full titles and at least one recognized qualifier.
- `dj-edits` additionally requires an intro, outro, extended, radio, clean, dirty, instrumental, acapella, club, dub, or edit marker.
- `remixes` additionally requires a remix, rework, bootleg, mashup, VIP, or flip marker.
- Remasters and named versions are alternates, not DJ edits. `Original Mix` remains an original.
- There is no edit distance, confidence score, BPM inference, audio fingerprinting, or cross-artist matching in this version.

## Ownership

- `parse-rekordbox-xml.ts`: XML rules and safe `file:` URL conversion.
- `find-duplicates.ts`: title parsing, qualifier vocabulary, grouping, and ordering.
- `track-artwork.ts`: opaque URL validation, media parsing, resizing, concurrency, and bounded caching.
- `RekordboxLibrary`: current catalog, revision, private paths, and per-mode result cache.
- `main.ts` and `preload.ts`: trusted transport adapters only.
- `App.tsx`: selected mode and asynchronous report shared by the page and sidebar.
- `CueboxPages.tsx`: mode controls, family selection, one fixed reference, and one comparison selector.

Both main-side operations keep short call chains: duplicate IPC to catalog to matcher; image request to catalog to artwork store. No renderer API accepts a path, and no filesystem path crosses IPC.

## Resource limits and failure behavior

Artwork extraction uses `music-metadata` and Electron `nativeImage`. Only allowlisted audio extensions are opened. Source pictures are capped, output is resized to 256 px and capped, extraction concurrency is limited to three, and the per-catalog result cache is bounded. Missing files, disconnected volumes, malformed tags, absent covers, and invalid images produce the existing `CB` placeholder; they never fail XML import.

Every successful import creates a new catalog revision. Old artwork URLs therefore cannot resolve against reused row IDs, and all duplicate and artwork caches are replaced atomically with the catalog.

## Alternatives rejected

- Renderer-side scans cannot see matches across 100-song page boundaries.
- General fuzzy title matching creates unexplained false positives for a cleanup tool.
- Eagerly importing every cover makes library opening scale with the full music collection.
- Returning file paths breaks the existing sandbox boundary.
- Base64 artwork over IPC adds payload inflation and React-managed request/cache state.
- Two independently editable comparison selectors add interaction rules that the requested workflow does not need.

## Verification

Typecheck, lint, and package the app. Manually verify cross-page families, positive and negative qualifier fixtures, groups with three or more candidates, MP3/M4A/FLAC embedded covers, no-cover and missing-file fallbacks, and stale artwork URLs after reimport. Check both development and packaged CSP behavior.
