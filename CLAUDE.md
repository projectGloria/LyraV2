# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # electron .  — run the app
npm run build      # electron-builder — NSIS installer on Windows, AppImage on Linux
```

There is no test suite, linter, or bundler. All source is plain ES2022 loaded directly by Electron — no build step for development, so a restart of `npm start` is the full edit-test loop.

## Naming

The product is inconsistently named across layers and this is intentional/historical, not a bug to "fix":
- npm package: `sona-music-player`, `productName: "Sona"`, `appId: com.lyra.sona`
- User-facing UI, diagnostics, cache filenames, and playlist sidecar files: **Lyra**
- The preload bridge is exposed on `window.spotfck` (an older name). Every renderer→main call goes through it.

## Architecture

Four files carry everything:

| File | Role |
| --- | --- |
| `main.cjs` (~1200 lines) | Electron main: library scanning, all caching, file watching, IPC handlers, window/tray lifecycle |
| `preload.cjs` | The entire IPC surface, as `window.spotfck` (contextIsolation on, nodeIntegration off, sandbox off) |
| `renderer.js` (~2400 lines) | Single-module UI: one `state` object, `render()` fan-out, playback engine, event delegation |
| `styles.css` | All styling; theme is driven by CSS custom properties on `:root` |
| `window-bounds.js` | Pure, dependency-free multi-monitor bounds fitting, required by `main.cjs` |

### Library model

The music folder *is* the data model. There is no database:
- Each subdirectory containing audio becomes a **playlist** (recursive discovery).
- Audio files directly in the root become **Liked Songs**.
- Per-folder overrides (custom name, description, manual track order, artwork) live in a `.lyra-playlist.json` sidecar written into the music folder itself; custom covers are copied in as `.lyra-cover.*`.
- Track/folder IDs are `sha1(absolutePath).slice(0,16)` — stable across scans, but **any path change is a new identity**. Renaming the library root is handled in the renderer by `remapLocalPath` / `remapLocalUrl`.

### Three-layer cache (all in `app.getPath('userData')`)

Understand these before touching scan code; each has its own version constant in `main.cjs` and bumping a constant orphans the old file.

1. **`track-metadata-cache-v<N>.json` + `.journal`** (`TRACK_CACHE_VERSION`) — per-file parsed metadata keyed by lowercased forward-slashed absolute path. Writes go to the append-only journal (`writeTrackMetadataCacheDelta`); when the journal exceeds `TRACK_CACHE_COMPACTION_BYTES` it is folded back into the main file by `compactTrackMetadataCache`, which also garbage-collects unreferenced files in `artwork-cache/`. Reads replay journal over base. Validity is `(size, mtimeMs)` of the audio file **and** of its sidecar artwork file.
2. **`library-snapshot.json`** (`LIBRARY_SNAPSHOT_VERSION`) — the whole assembled library result. Read at startup by `library:cache-read` so the UI paints instantly, then a full scan runs in the background and replaces it.
3. **`directory-index-cache.json`** (`DIRECTORY_CACHE_VERSION`) — directory listings, to skip re-reading unchanged directories during discovery.

Embedded cover art is extracted once and written to `artwork-cache/<sha1-of-bytes>.<ext>`, deduped by content hash across the whole library.

### Scan pipeline (`scanLibrary` in `main.cjs`)

`validate → folders → index → metadata → artwork → finalize → complete`, with each stage reporting through `onProgress` (throttled to ~80ms in the IPC handler; the stages `validate/folders/index/finalize/complete/error` bypass throttling).

Only one scan runs at a time. A new `library:scan` sets `activeScanToken.cancelled = true` on the previous one; workers call `assertScanActive(scanToken)`, which throws `ScanCancelledError`. **Any new long loop added to the scan must call `assertScanActive`** or cancellation will hang. Concurrency is capped at 2–4 workers via `mapWithConcurrency`.

Artwork resolution is deliberately ordered and the ordering is load-bearing (see the comment in `scanLibrary`): per-track sidecar image → embedded picture → album-level cover within the folder → album-level cover globally. Folder/album art must never overwrite a track that has its own identity.

### Incremental refresh

`fs.watch(root, { recursive: true })` debounces changes for 120ms and pushes `library:changed` to the renderer, which calls `library:refresh-changes`. `refreshLibraryChanges` patches the snapshot in place for audio-file adds/removes only — it **returns `null` (forcing a full rescan) whenever a `.lyra-playlist.json` or any image file changed**, and whenever a changed path escapes the root (`isPathInside`).

### Renderer conventions

- One mutable `state` object at the top of `renderer.js`. Mutate it, then call `render()` (full) or a targeted `renderLibrary()` / `renderContent()` / `renderPlayerDock()` / `renderNowPlaying()`.
- Markup is template literals assigned to `innerHTML`. Every interpolated value must go through `escapeHtml()`. Interaction is delegated: buttons carry `data-action="..."` and are dispatched from the delegated handlers in `bindEvents()`.
- Track lists are **virtualized** (`TRACK_ROW_HEIGHT = 62`, overscan 12) — rows are recycled on scroll by `renderVirtualTrackRows`, so never assume all rows exist in the DOM.
- Playback session (current track, position, queue, shuffle/repeat, history) is persisted to `localStorage` under `lyra-sona-playback-session-v1` as **paths**, remapped to live track objects on restore. Volume lives separately under `lyra-volume`.
- `state.basePlaybackList` is the unshuffled order; `state.playbackList` is what actually plays. Toggling shuffle rebuilds `playbackList` from the base list, keeping the current track first.

### Diagnostics

`logDiagnostic()` writes JSONL to `userData/reports/lyra-diagnostics.jsonl`, rotating at 5MB with 5 archives. Renderer code logs via `reportEvent()` → `reports:log`. Values are passed through `redactDiagnosticString` / `sanitizeDiagnosticValue` before writing — keep new fields going through `logDiagnostic` rather than raw `fs` writes so redaction applies. Main-process errors are surfaced to the UI via the `app:error` channel.

### Window / chrome

Frameless window (`frame: false`) — minimize/maximize/close are custom buttons calling `window:*` IPC, and draggable regions are the `.app-drag` / `.no-drag` classes. Saved bounds are validated against the current display layout by `fitBoundsToDisplays`, which also re-runs on `display-removed` and `display-metrics-changed` so the window cannot strand off-screen. `closeToTray` hides to a tray icon instead of quitting.

### Security posture

`index.html` sets a strict CSP (`script-src 'self'`, no remote origins) and the renderer runs with `contextIsolation: true` / `nodeIntegration: false`. Keep new native capability behind a named IPC handler in `preload.cjs` — do not widen the CSP or relax `webPreferences`. `media://` is registered as a file protocol in `app.whenReady`, but audio and artwork are actually loaded through `file://` URLs built by `fileUrl()`.
