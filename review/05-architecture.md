# Architecture and maintainability

### [Medium] No test suite, and the most defect-prone logic is pure and trivially testable

**Where:** repo-wide; `package.json` has no `test` script and no test dependency.
**Detail:** Two of the confirmed defects in this review — the reorder off-by-one (`renderer.js:1640`) and the separator bug in `remapLocalPath` (`renderer.js:1485`) — are in pure functions with no I/O and no DOM. I confirmed the reorder bug by pasting the logic into `node -e` and running four cases; that took under a minute. `window-bounds.js` is already extracted as a dependency-free module with an exported helper (`isWindowAccessible`) that nothing imports — it reads like it was factored out for testing that never happened.

Other pure candidates: `applyTrackOrder`, `sanitizePlaylistName`, `isPathInside`, `findArtwork`/`findTrackArtwork` precedence, `cacheKey`, `fileUrl`, `escapeHtml`, `fitBoundsToDisplays`.
**Impact:** Cross-platform path handling and ordering logic are exactly the areas where a bug is invisible on the developer's machine (Windows) and broken elsewhere. There is currently no mechanism that would have caught either bug.
**Fix:** Add `node --test` with a handful of cases over the functions above. No framework or build step needed, and the modules are already separable enough.

---

### [Medium] `renderer.js` is a single 2,400-line module with ~40 mutable file-scope globals

**Where:** `renderer.js:1-84`
**Detail:** One `state` object plus roughly forty loose `let` bindings — `spectrumGradient`, `draggedTrackIds`, `playbackTransitioning`, `restorePosition`, `isScrubbing`, `lastPlaybackUiKey`, six separate debounce timer handles, and so on. Rendering, playback, drag-and-drop, the Web Audio visualizer, settings, and the navigation stack all share this scope.

A concrete consequence: `state.basePlaybackList` is not declared in the `state` literal at all — it is introduced ad hoc in `init()` (`renderer.js:2385`) and read defensively elsewhere as `(state.basePlaybackList || [])`. That undeclared field is precisely the one that `invalidatePlayback` forgets to reset (see `01-bugs.md`), because there is no single place that enumerates what playback state consists of.

Two more symptoms of the same shape:
- `contentSearchTimer` is shared by the global search handler (`renderer.js:2131`) and the in-list search handler (`renderer.js:2241`), so typing in one cancels the other's pending render.
- Whether a re-render is full (`render()`) or targeted (`renderContent()`, `renderPlayerDock()`, …) is decided by hand at each of ~40 call sites, with no invariant tying state changes to the views that depend on them.

**Impact:** Every change requires holding the whole file in mind, and state-reset paths must be updated by memory. This is a maintainability trap rather than a live defect.
**Fix:** Split by concern — `playback.js`, `library-view.js`, `spectrum.js`, `session.js` — as ES modules (the CSP already permits `script-src 'self'`, and `<script type="module">` works from `file:`). Start by making all playback state fields of one object with a single `resetPlayback()`.

---

### [Medium] Album-artwork inheritance is implemented twice, in two processes

**Where:** `main.cjs:756-780` (`scanLibrary`) and `renderer.js:447-460` (`normalizeLibrary`)
**Detail:** The same rule — group a collection by lowercased album name, ignore the sentinel `'local library'`, let the first track with artwork donate its cover to the rest — is written out in full in both processes. The main-process version additionally does a second, global pass across all folders; the renderer's does not.
**Impact:** Two copies of a subtle rule that the code itself flags as load-bearing ("must never overwrite the identity of an unrelated song", `main.cjs:723`). Fixing an artwork-attribution bug in one place will not fix it in the other, and the two already differ in scope.
**Fix:** Do the derivation once in the main process and treat the snapshot as authoritative; the renderer should not re-derive artwork.

---

### [Low] Three cache layers with independent versions and no migration or cleanup

**Where:** `main.cjs:19-28`
**Detail:** `TRACK_CACHE_VERSION` (currently 7), `DIRECTORY_CACHE_VERSION`, and `LIBRARY_SNAPSHOT_VERSION` each gate their own file, and the track cache embeds its version in the *filename*. Bumping it — as has happened six times — starts a fresh `track-metadata-cache-v8.json` and orphans `v1`…`v7` in `userData` permanently; nothing deletes them. The other two are version-checked in content and silently discarded on mismatch, so the three layers behave differently on upgrade.
**Impact:** Unbounded accumulation of stale cache files across upgrades, and three different invalidation stories to keep in mind.
**Fix:** Keep the version inside the file for all three, and delete files matching the old pattern on startup.

---

### [Low] Dead code

Verified by `grep` across all source files:

| Symbol | Where | Status |
|---|---|---|
| `findNearestArtwork` | `main.cjs:474` | Defined, never called |
| `ARTWORK_CACHE_VERSION` | `main.cjs:22` | Defined, never read |
| `media://` protocol handler | `main.cjs:1086` | Registered, never used (see `03-security.md`) |
| `state.demoMode` | `renderer.js:15`, `:2382` | Assigned `false` twice, never read |
| `getArtworkFallbackForTrack` | `renderer.js:440` | `return ''` — called at 11 sites with arguments it ignores, so the entire artwork-fallback path in `artMarkup`/`bindArtworkFallbacks` is inert |
| `isWindowAccessible` export | `window-bounds.js:47` | Exported, never imported |

The `getArtworkFallbackForTrack` case is the notable one: it is not merely unused, it is a stub that makes a real mechanism (the `data-art-fallback` retry in `bindArtworkFallbacks`, `renderer.js:327`) silently do nothing while still appearing implemented at every call site.

---

### [Low] Product identity is inconsistent across four layers

**Where:** `package.json`, `preload.cjs:3`, UI strings, cache filenames
**Detail:** npm package `sona-music-player`; `productName: "Sona"`; `appId: com.lyra.sona`; every user-facing string, log file and sidecar filename says **Lyra**; the entire preload bridge is exposed as `window.spotfck`, a third name with no remaining referent; the project directory is `LyraV2`.
**Impact:** No functional effect, but `window.spotfck` in particular gives a new reader no signal about what the object is, and search across the codebase for "the IPC surface" turns up nothing under any of the product names.
**Fix:** Rename the bridge to `window.lyra` (a one-line change in `preload.cjs` plus a rename across `renderer.js`) and align `package.json` with the user-facing name. Documented as intentional in `CLAUDE.md` for now.

---

### [Low] Overlapping scan writes are guarded by cancellation checks rather than by locking

**Where:** `main.cjs:1163-1166` (cancellation), `main.cjs:214` / `main.cjs:497` (temp-file writes)
**Detail:** Cancellation is cooperative: a new scan sets `activeScanToken.cancelled` and workers throw at the next `assertScanActive`. Between an `assertScanActive` and the subsequent `await writeTrackMetadataCacheDelta(...)` / `writeDirectoryIndexCache(...)`, a superseding scan can start. Both scans then write to the same fixed temp paths (`${FILE}.tmp`) and rename.
**Impact:** A narrow race that could interleave two writers on one temp file. I could not construct a concrete failing sequence — the asserts are placed such that a cancelled scan almost always throws before reaching the writes — so this is flagged as a structural risk rather than a confirmed defect.
**Fix:** Include the scan token id in the temp filename, or skip the write entirely when `activeScanToken !== scanToken`.
**Confidence:** Needs check
