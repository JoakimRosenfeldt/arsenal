# Arsenal library and backup formats

## Local library

Arsenal owns its primary library in `libraries/arsenal.json` inside the application's data directory. It remains available when DJ connections are disconnected or unavailable. The local document uses UTF-8 JSON:

```json
{
	"format": "arsenal-library",
	"version": 1,
	"library": {
		"tracks": [],
		"playlists": []
	}
}
```

Tracks store their entry path, optional separate media location, metadata, and performance data. Playlists store their path, kind, ordered track references, and smart rules. Arsenal smart definitions are saved directly, including nested rules, sorting, and limits. Temporary artwork and playback URLs are excluded.

Local saves validate the model and atomically replace the JSON file after flushing it to disk. They do not hash, copy, or search music files. Invalid documents and unsupported versions produce an error without resetting the library. The local JSON limit is 128 MiB.

The first launch with this storage migrates the previous primary library once. Subsequent launches read Arsenal's JSON. A failed migration keeps the original files. `libraries/arsenal.xml` is a disposable adapter for existing editing and display code; Arsenal recreates it from its JSON when it starts.

Arsenal always owns the primary library. Connections shows connected DJ libraries, imported backups, and backup folders. Importing or refreshing a DJ connection merges its collection into Arsenal while preserving existing Arsenal smart definitions. DJ libraries remain sources for import and destinations for sync. Removing a connection does not remove Arsenal's collection.

## Portable backups

Arsenal backs up its owned collection to one UTF-8 JSON file named `Arsenal Library.json` in the selected folder. The file uses `format: "dj-library"` and `version: 2`. It does not require a DJ application or its database.

Included music lives in a sibling `Music` folder. For example, Artist organization produces:

```text
My library/
  Arsenal Library.json
  Music/
    Artist/
      Artist - Track [content-hash].mp3
```

Each folder connection has an **Include music files** setting and a music organization choice:

| Organization | Music location |
| --- | --- |
| All music in one folder | `Music/` |
| Artist, the default | `Music/<artist>/` |
| Album | `Music/<album>/` |
| Artist and album | `Music/<artist>/<album>/` |
| Genre | `Music/<genre>/` |
| Label | `Music/<label>/` |

Missing metadata uses names such as `Unknown Artist` and `Unknown Genre`. Arsenal replaces characters that cannot be used in portable filenames and limits name lengths. Music filenames contain the artist, title, and a content hash to distinguish different files with the same metadata. Identical music files share a copy within each save.

The JSON references bundled music by relative path. Transfer the JSON and its `Music` folder together when music is included. A backup without music needs only the JSON file; import can locate audio in a chosen music folder.

Arsenal checks for backup changes after library operations and every 30 seconds while it is open. Changed data replaces the same JSON file after music copies finish and pass verification. Unchanged data reuses the existing file. Each connection remembers its organization setting across restarts.

A temporary file and atomic replacement protect the previous JSON during saving. Arsenal checks the existing file's fingerprint before writing and again before replacement. An outside change stops the backup and requires import before another save. An existing `Arsenal Library.json` cannot be overwritten by connecting its folder as a new backup. Open that file to import it, or choose another destination.

Opening a backup folder uses `Arsenal Library.json`. The file can also be opened directly. An unreadable fixed file produces an error instead of restoring an older snapshot. Bundled music needs no manual relinking once the full folder has arrived.

Importing bundled music creates independent local working copies so DJ sync cannot change backup audio. Arsenal uses copy-on-write clones where supported and verifies each new copy. Initial transfer time depends on the collection size and storage speed. Imported connections reuse their working copies for later imports.

Version 1 backups remain readable, including timestamped snapshots and their lower-case `media` folders. Existing folder connections retain their destination directories and switch to the fixed JSON filename. Old snapshots and copied music are kept. Changing organization or excluding music affects new saves; it does not delete earlier copies or unrelated files. Disconnecting stops automatic backups and keeps saved files.

## Changes between sessions

When Arsenal opens, it checks connected DJ libraries and imported backup sources for changes since their last accepted import or save. Existing connections without a saved comparison establish one on their first launch after this feature is installed.

For imported backups, Arsenal remembers the library file and music search folders. It checks the fixed file for changes. Legacy snapshot connections discover the fixed file when available, or continue checking for newer legacy snapshots. Startup checks read library data and file information; music fingerprints are verified during import. Backups imported before source tracking was available need to be imported again to enable these checks.

Arsenal also checks its connected backup destinations for outside changes. It lists changed libraries and asks before importing them into its collection. Approval also runs the saved sync settings when destinations are configured and available. Otherwise, Arsenal only imports the changes. Choosing **Not now** leaves the changes pending for the next launch and keeps automatic backups from overwriting a changed destination.

If an imported library or Serato workspace also has unsynced local edits, Arsenal asks which version to keep. Importing the external version saves a backup of the local XML first. Keeping local edits, an unavailable source, or an import failure defers automatic sync. Missing music uses the existing import and sync recovery flow.

## Ongoing sync and app edits

Connections offers **Ongoing** and **One time** sync. Ongoing sync runs when you start it and after library edits made in Arsenal. The selected destinations and categories apply to each run. One-time sync runs once and stops any ongoing sync. **Stop ongoing sync** stops future runs. Arsenal remembers this choice across launches and still asks before importing changes found at startup.

Library edits always save to Arsenal's JSON first, including when ongoing sync is off. A failed local save rejects the edit. DJ connections are optional, so an unavailable destination does not prevent local editing. Serato must be closed before Arsenal can write its native library.

When ongoing sync is active, app edits also update the selected destinations for the enabled categories. If a destination cannot be updated, the Arsenal edit stays saved and ongoing sync pauses. Review the message on Connections before resuming. Merge may retain destination entries that are absent from Arsenal; overwrite replaces the selected categories with Arsenal's collection.

## Document

An empty library is valid:

```json
{
	"format": "dj-library",
	"version": 2,
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
	"relativePath": "Music/Artist/Artist - Example [0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef].mp3"
}
```

`originalPath` is a location hint. `sizeBytes` and `sha256` identify the file's exact bytes, including tags. Both backup modes calculate the fingerprint for available music.

`relativePath` is `null` when music is excluded or unavailable. Version 2 paths use forward slashes and stay under `Music/`. Absolute paths, parent-directory segments, empty segments, and unsafe filename characters are rejected. Version 1 paths retain the `media/<sha256>` form with an optional lowercase alphanumeric extension. `sha256` is `null` when the original file cannot be read. Its size can also be `null`.

The importer makes independent working copies of bundled music and verifies their sizes and hashes. It checks original paths for tracks without a usable bundled copy. It searches a selected music folder recursively for unresolved tracks. File sizes narrow the search before hashing. A different filename does not prevent an exact match. Search does not follow symbolic links in the selected music folders.

Bundled paths cannot escape the backup directory, including through symbolic links. Files with missing or mismatched fingerprints remain unresolved. Choosing to import without them creates unavailable references, so an unrelated file at an old path cannot play. Re-importing the library file allows another search after the music becomes available.

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
