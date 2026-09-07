# Performance

The three caching layers are well thought out, and the scan pipeline is properly bounded, cancellable, and concurrency-limited. The findings below are places where that design is defeated by a specific gap.

### [High] Every track without artwork is fully re-parsed on every single scan

**Where:** `main.cjs:729-735` and `main.cjs:289` (`extractEmbeddedArtwork`)
**Trigger:** Any scan — including the automatic one at every app start (`renderer.js:2405`).
**Detail:** The artwork phase collects every track whose `artworkUrl` is empty and calls `extractEmbeddedArtwork`, which runs a second full `mm.parseFile(filePath, { skipCovers: false })`:

```js
for (const track of folderTracks) {
  if (track.artworkUrl) continue;
  embeddedArtworkJobs.push(track);
}
```

When a picture *is* found, the result is written back into the track cache (`main.cjs:750-755`), so that track is skipped next time. When no picture is found, **nothing is recorded** — the cached track keeps `artworkUrl: ''`, so on the next scan `readTrack` returns it from cache, it is queued again, and the file is fully re-parsed. There is no "already checked, has no cover" state.

**Impact:** For a library where a meaningful share of files have no embedded art (loose WAV/FLAC rips are the common case), those files are parsed from disk on every launch, forever, at a concurrency of 2. The metadata cache makes the first phase instant while the second phase still does the expensive work, which is exactly the shape that reads as "the cache isn't helping". Tracks that *do* have art also get parsed twice on the first scan.
**Fix:** Store an `artworkChecked` / `embeddedArtworkMissing` flag in the cache entry alongside the signature, and skip the artwork job when the signature still matches. Ideally have `readTrack` parse once with `skipCovers: false` and materialize the picture inline, removing the second pass entirely.
**Confidence:** Verified

---

### [High] Session persistence is O(history × library) and runs every 2 seconds during playback

**Where:** `renderer.js:1213`
**Trigger:** Any playback with a large library.
**Detail:**

```js
historyPaths: playbackHistory.map((id) => getAllTracks().find((track) => track.id === id)?.path).filter(Boolean),
```

`getAllTracks()` (`renderer.js:351`) is not a cheap accessor — it spreads every collection into a new array, builds a `Map` over all of it for de-duplication, and spreads the values into another array. It is called **inside** the `map`, so it is rebuilt once per history entry (up to 100), each followed by a linear `find`.

`persistPlaybackSession` is triggered from the `timeupdate` handler (`renderer.js:2328`), debounced to 2 seconds, so this runs continuously while a track plays.

**Impact:** With a 20k-track library that is ~100 full array copies plus ~2M `Map` insertions and up to 2M comparisons every 2 seconds, on the UI thread, purely to serialize a history list. It presents as periodic stutter during playback that scales with library size — and it happens whether or not the user has ever used the history view.
**Fix:** Hoist `getAllTracks()` out of the loop and index it by id once; better, cache the id→track index and invalidate it in `normalizeLibrary`, which already walks every track.
**Confidence:** Verified

---

### [Medium] Reordering or renaming a playlist forces a full library rescan

**Where:** `main.cjs:905-906`, `renderer.js:1947-1969`
**Trigger:** Drag a song to a new position, or rename/re-cover a playlist.
**Detail:** Both operations write `.lyra-playlist.json` into the watched music folder. The watcher fires, the renderer calls `library:refresh-changes`, and the incremental path immediately bails:

```js
const hasCollectionMetadataChange = changedPaths.some((changedPath) =>
  path.basename(changedPath).toLowerCase() === PLAYLIST_METADATA_FILE || IMAGE_EXTENSIONS.includes(...));
if (hasCollectionMetadataChange) return null;
```

`null` makes the renderer fall through to `scanLibrary({ preservePlayback: true, background: true })` — a complete rescan of every folder and file.

A rename is worse: the folder's new path changes the `cacheKey` of every track inside it, so the metadata cache misses for all of them and each file is re-parsed from disk.

**Impact:** A single drag-reorder — the most repeated action in a music player — costs a full library walk, a "Library updated" toast, and a full re-render that discards scroll position and selection. On a large library the UI is disrupted for seconds after every drag.
**Fix:** The app knows it just wrote that sidecar. Suppress the watcher event for writes it originated (compare against a recently-written set), or handle metadata-only changes by re-reading just that folder's sidecar and re-applying `applyTrackOrder`.
**Confidence:** Verified

---

### [Medium] Diagnostic logging does three synchronous filesystem calls per log line

**Where:** `main.cjs:119-134` (`logDiagnostic`), `main.cjs:105` (`rotateDiagnosticLogs`)
**Trigger:** Any logged event; renderer console warnings and errors are forwarded here too (`main.cjs:1036`).
**Detail:** Every call runs `fs.mkdirSync`, then `rotateDiagnosticLogs()` which does `fs.existsSync` + `fs.statSync`, then `fs.appendFileSync`. All synchronous, all on the main process's event loop.
**Impact:** The main process blocks on disk I/O in the middle of scan orchestration and IPC handling. A renderer that starts producing console warnings in a loop turns each one into a stat plus an append. The mkdir and the size check are also pure repetition — neither needs to run more than once per rotation interval.
**Fix:** Keep a write stream open, track the byte count in memory, and only stat on rotation.
**Confidence:** Verified

---

### [Medium] Every watcher batch re-parses the entire metadata cache

**Where:** `main.cjs:911` → `main.cjs:154` (`readTrackMetadataCache`)
**Trigger:** Any file change in the library folder.
**Detail:** `refreshLibraryChanges` calls `readTrackMetadataCache()`, which reads and `JSON.parse`s the base cache file and then replays the entire journal line by line — regardless of how few files changed. For a large library the base file is tens of megabytes.
**Impact:** Copying a handful of new songs into the folder (each triggering a 120 ms-debounced batch) re-parses the whole cache per batch. The incremental path, whose purpose is to avoid a full scan, does a full cache deserialization instead.
**Fix:** Keep the parsed cache in main-process memory across calls, invalidated by file signature.
**Confidence:** Verified

---

### [Medium] Two full copies of the playlist are serialized to `localStorage` every 2 seconds

**Where:** `renderer.js:1205-1218`
**Trigger:** Playback from any large playlist.
**Detail:** `playbackPaths` and `basePlaybackPaths` each hold every absolute path in the active playback list. `JSON.stringify` over both, plus the synchronous `localStorage.setItem`, runs on the 2-second debounce driven by `timeupdate`.
**Impact:** Hundreds of kilobytes to megabytes of string building and a synchronous storage write on the UI thread, twice a minute, for data that changes only when the playlist or shuffle order changes. See also the quota crash in `01-bugs.md`.
**Fix:** Persist the collection id and the shuffle seed/order as indices rather than paths, and only rewrite the list portion when it actually changes.
**Confidence:** Verified

---

### [Low] Queue modal repeats the same O(history × library) pattern

**Where:** `renderer.js:917`
**Detail:** `renderQueueModal` correctly hoists `getAllTracks()` out of the loop, but still does a linear `allTracks.find` per history entry. Bounded at 100 × library size, and only while the modal is open.
**Fix:** Reuse the shared id index suggested above.
**Confidence:** Verified

---

### [Low] `syncOverlayTheme` forces a style recalculation on every render

**Where:** `renderer.js:161-170`, called from `applyTheme` in `render()`
**Detail:** `getComputedStyle(shell)` followed by 18 `getPropertyValue` reads forces a synchronous style flush, on every full `render()` — including renders triggered by library refreshes and navigation. The values only change when the theme or accent changes.
**Fix:** Call it from `setTheme`/`setAccentColor` rather than from `applyTheme` on every render.
**Confidence:** Verified

---

### [Low] Spectrum animation loop runs while playback is paused

**Where:** `renderer.js:1880` (`drawSpectrum`)
**Detail:** With the spectrum enabled, the ~30 fps `requestAnimationFrame` loop keeps running while paused, drawing a synthetic sine animation (`0.22 + Math.abs(Math.sin(...))`) instead of idling.
**Impact:** Continuous canvas repaint and wakeups on a paused, possibly backgrounded app.
**Fix:** Stop the loop on `pause` and restart it on `play`, or draw the idle state once.
**Confidence:** Verified
