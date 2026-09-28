# Portable DJ library format

Arsenal saves a library as UTF-8 JSON with optional music files. The format does not require a DJ application or its database. Each JSON file is a complete snapshot. Files use `format: "dj-library"` and `version: 1`.

A backup directory contains immutable snapshots and a shared music folder:

```text
My library/
  2026-09-28T10-30-00.000Z-<uuid>.json
  2026-09-28T11-30-00.000Z-<uuid>.json
  media/
    <sha256>.mp3
    <sha256>.flac
```

Each snapshot references music relative to its own directory. Copying the entire backup directory preserves those references. Cloud services can synchronize the directory as ordinary files. JSON snapshots are published after their music copies finish. Previous snapshots and music files remain available.

Arsenal remembers the backup folder and music option for each connection. It checks for changes after library operations and every 30 seconds while the app is open. Unchanged libraries reuse the previous snapshot. Each setup creates a separate output directory, so different computers do not overwrite one another's snapshots. Imports are explicit and create separate local libraries.

Snapshots and media are retained without automatic deletion. Identical music files share a copy within each backup directory. Stopping automatic backup keeps the files already saved.

## Document

An empty library is valid:

```json
{
	"format": "dj-library",
	"version": 1,
	"name": "My library",
	"savedAt": "2026-09-28T10:30:00.000Z",
	"includeMusic": false,
	"tracks": [],
	"playlists": []
}
```

`name` identifies the library. `savedAt` is the save date in ISO 8601 format. `includeMusic` records the chosen backup option. A missing or unreadable original file has no bundled copy, even when that option is enabled. Arsenal reports these files when saving.

Readers reject unsupported versions, malformed fields, duplicate IDs, and playlist references to unknown track IDs. Arsenal limits JSON imports to 128 MiB.

## Tracks

Each track has an `id`, `metadata`, `media`, and optional `performance`. IDs identify library entries. They do not identify audio content. Distinct entries can refer to the same file or identical audio bytes without losing their metadata or playlist membership.

Arsenal generates stable track IDs from the library's entry reference. Renaming or relocating that reference can change the generated ID. Playlist references use these IDs within a snapshot.

`metadata` contains these fields:

| Fields | Type and units |
| --- | --- |
| `title` | String |
| `artist`, `composer`, `remixer`, `album`, `mixName`, `label`, `genre`, `musicalKey`, `fileKind`, `dateAdded`, `comments` | String or `null` |
| `year`, `trackNumber`, `discNumber`, `playCount`, `rating` | Nonnegative number or `null` |
| `bpm` | Beats per minute or `null` |
| `durationSeconds` | Seconds or `null` |
| `fileSizeBytes` | Integer bytes or `null` |
| `bitRateKbps` | Kilobits per second or `null` |
| `sampleRateHz` | Hertz or `null` |
| `source` | `local`, `tidal`, `beatport`, `beatsource`, `soundcloud`, `spotify`, `apple-music`, `streaming`, or `unknown` |
| `cuePointCount`, `hotCueCount` | Nonnegative integers |

Metadata preserves the source library's rating scale. In particular, Rekordbox exports can use values from 0 to 255. Temporary playback URLs, artwork URLs, and application row IDs are excluded. Artwork embedded in copied music remains in that file.

### Local music

```json
{
	"kind": "local",
	"originalPath": "/Users/dj/Music/Example.mp3",
	"sizeBytes": 1234567,
	"sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	"relativePath": "media/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.mp3"
}
```

`originalPath` is a location hint. `sizeBytes` and `sha256` identify the file's exact bytes, including tags. Both backup modes calculate the fingerprint for available music.

`relativePath` is `null` when music is excluded or unavailable. A present path must have the form `media/<sha256>` with an optional lowercase alphanumeric extension. `sha256` is `null` when the original file cannot be read. Its size can also be `null`.

The importer verifies the size and hash of bundled music, then checks original paths. It searches a selected music folder recursively for unresolved tracks. File sizes narrow the search before hashing. A different filename does not prevent an exact match. Search does not follow symbolic links in the selected music folders.

Bundled paths cannot escape the backup directory, including through symbolic links. Files with missing or mismatched fingerprints remain unresolved. Choosing to import without them creates unavailable references, so an unrelated file at an old path cannot play. Re-importing the original snapshot allows another search after the music becomes available.

Changes to audio tags change the file hash. A file with edited tags does not count as an exact match, even if its audio sounds identical.

### Other sources

```json
{
	"kind": "reference",
	"uri": "tidal:track:123456"
}
```

References preserve streaming identifiers and other source locations. A reference requires a nonlocal metadata source. The backup does not download streaming audio. Missing source locations use an unavailable reference.

## Performance

`performance` contains `hotCues`, `loops`, and `beatgrids`, plus optional `memoryCues`. An omitted performance object means that performance data was unavailable. Empty arrays mean that the corresponding markers are absent.

Cues contain `index`, `name`, `start`, and `color`. Hot cue indexes start at zero. Memory cue indexes are `-1`. `start` is a nonnegative time in seconds. `color` is an RGB array with three integer values from 0 to 255.

Loops have the same fields plus `end`, `locked`, and optional `hotCue`. `end` is in seconds and must be after `start`. An index of `-1` represents an unnumbered memory loop. `hotCue: true` identifies a hot loop in a hot cue slot. Other loops use separate saved-loop slots.

Beatgrid markers contain `start`, `bpm`, and `beat`, plus optional `meter`. The start time is in seconds and can be negative. BPM must be positive. Beat numbers start at one. A meter can be a string such as `"4/4"`.

## Playlists

Each playlist contains these fields:

| Field | Meaning |
| --- | --- |
| `id` | Unique playlist entry ID |
| `path` | Array of names, from the outermost folder to this entry |
| `kind` | `folder`, `playlist`, or `smart` |
| `trackIds` | Ordered references to track IDs |
| `smart` | Required for smart playlists and absent for other entries |

The playlist array preserves the order of entries. The track ID array preserves playlist order and repeated entries. Empty folders remain explicit entries. A playlist can both contain tracks and have child entries, as Serato crates can.

Smart playlists retain their ordered track membership even when another reader cannot evaluate their rules. The optional vendor-specific rule representation is one of:

- `{"kind":"arsenal","definition":...}` stores Arsenal's versioned rule definition.
- `{"kind":"rekordbox","rules":{"logicalOperator":...,"conditions":[...]}}` stores Rekordbox XML rule attributes.
- `{"kind":"serato","version":1,"rules":"..."}` stores Serato's rule string and version.

The rule string and attribute records are preserved without execution. Applications that do not support a rule representation can use the saved track membership.
