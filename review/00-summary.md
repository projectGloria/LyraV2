# Codebase review — Lyra / Sona music player

Reviewed 2026-09-07. Working tree at `C:\Users\Nihil\Desktop\projectGloria\LyraV2`, version 3.0.0. Not a git repository, so there is no commit sha and no history to aim the read at.

## Scope and method

Five source files, ~5,400 lines total, all reviewed:

| File | Lines | Coverage |
|---|---|---|
| `main.cjs` | 1,237 | Read in full |
| `renderer.js` | 2,407 | Read in full |
| `styles.css` | 1,576 | Targeted greps — theming tokens, virtual row height, `.hidden`, reduced-motion, overflow handling |
| `index.html` | 171 | Read in full |
| `preload.cjs`, `window-bounds.js` | 90 | Read in full |

`node_modules` and `package-lock.json` excluded.

Trust boundaries identified and traced: the IPC surface in `preload.cjs` (24 named channels, no generic passthrough); the filesystem walk over a user-chosen directory; `music-metadata` parsing untrusted tag data; the `media://` protocol handler; the renderer's `innerHTML` construction.

**Tools:** no lint, typecheck, or test tooling is configured in this project, and `npm audit` was not runnable in this environment. In place of that, I executed the reorder algorithm in isolation under `node -e` to confirm the off-by-one, and used `grep` to verify each dead-code and missing-handler claim rather than inferring it.

Reading was prioritized toward: the scan/cancellation pipeline and its three cache layers; the incremental watcher refresh; playback state transitions; every `innerHTML` interpolation reachable from ID3 tag data; and process/window lifecycle.

## Verdict

This is a carefully built application, and the parts that usually go wrong in an Electron app are right here: `contextIsolation` on, `nodeIntegration` off, a genuinely restrictive CSP, a fixed IPC surface, path containment enforced at every handler that touches the filesystem, and — the thing I most expected to find broken — complete HTML escaping of tag metadata, including inside quoted attributes. I found no XSS and no privilege-boundary defect.

The defects are concentrated in two places. First, a small number of concrete correctness bugs, one of which (`main.cjs:980`) makes the app impossible to close from the title bar for any user who enables close-to-tray. Second, a pattern where the sophisticated caching design is defeated by a missing piece of bookkeeping: tracks with no embedded artwork are never recorded as "checked", so they are fully re-parsed on every launch, and every playlist reorder discards the incremental path and forces a full rescan.

The main structural gap is the absence of any test suite. Two of the confirmed bugs are in pure functions that take under a minute to test, and both are the kind that stay invisible on a Windows dev machine.

## Top issues

| Severity | Finding | File | Category |
|---|---|---|---|
| High | Tray icon path escapes app root; window becomes unclosable | `main.cjs:980` | [Bugs](01-bugs.md) |
| High | Artless tracks re-parsed in full on every scan | `main.cjs:729` | [Performance](02-performance.md) |
| High | Session write is O(history × library), runs every 2s during playback | `renderer.js:1213` | [Performance](02-performance.md) |
| Medium | Drag-to-reorder cannot move a track downward | `renderer.js:1640` | [Bugs](01-bugs.md) |
| Medium | Stale `basePlaybackList` survives a library switch | `renderer.js:1175` | [Bugs](01-bugs.md) |
| Medium | Unguarded `localStorage` write breaks session persistence at quota | `renderer.js:1218` | [Bugs](01-bugs.md) |
| Medium | `remapLocalPath` hard-codes `\`; playlist rename breaks off Windows | `renderer.js:1485` | [Bugs](01-bugs.md) |
| Medium | Every reorder/rename forces a full library rescan | `main.cjs:905` | [Performance](02-performance.md) |
| Medium | Three sidebar filter pills are dead controls | `index.html:43` | [UX](04-ux.md) |
| Medium | In-list search forces the caret to the end on every keystroke | `renderer.js:2245` | [UX](04-ux.md) |
| Medium | No test suite; the buggiest logic is pure and testable | repo-wide | [Architecture](05-architecture.md) |

## Counts

| Category | Critical | High | Medium | Low |
|---|---|---|---|---|
| Bugs | 0 | 1 | 5 | 4 |
| Performance | 0 | 2 | 4 | 3 |
| Security | 0 | 0 | 0 | 3 |
| UX | 0 | 0 | 3 | 4 |
| Architecture | 0 | 0 | 3 | 4 |

Two Medium findings are cross-listed (the reorder off-by-one appears in both Bugs and UX; the localStorage quota crash in both Bugs and Performance) and are counted in each.

## Fix status (applied 2026-09-07)

Seventeen fixes applied to `main.cjs` and `renderer.js` after this review. All three High findings and every Medium correctness bug are addressed. Source was backed up to the session scratchpad first; no test framework was added.

**Fixed**

| Finding | Where |
|---|---|
| Tray icon path escaped the app root | `main.cjs:1001` |
| Artless tracks re-parsed on every scan (negative result now cached as `embeddedArtworkChecked`) | `main.cjs:741`, `:758`, `:944` |
| Incremental adds landed at the end of the list | `main.cjs:427` (`applyTrackOrder` / new `compareTrackPaths`) |
| Cache compaction matched sibling directories by bare prefix | `main.cjs:186` |
| `shell:reveal` accepted any path | `main.cjs:1167` |
| Unrestricted `media://` handler (and its now-unused `protocol` import) | removed |
| Drag-to-reorder could not move a track downward | `renderer.js:1679` |
| `basePlaybackList` survived a library switch (also now declared in the state literal) | `renderer.js:10`, `:1198` |
| Session write was O(history × library) | `renderer.js:1222` |
| Session write threw unguarded on quota (now falls back to a trimmed payload) | `renderer.js:1241` |
| Queue modal repeated the same O(history × library) shape | `renderer.js:928` |
| `remapLocalPath` hard-coded Windows separators | `renderer.js:1515` |
| In-list search forced the caret to the end (and shared a timer with global search) | `renderer.js:2280` |
| Playback errors cascaded through the library indefinitely (capped at 5) | `renderer.js:2401` |
| Navigation history grew without bound (capped at 200) | `renderer.js:424` |
| `syncOverlayTheme` forced a style recalc on every render | `renderer.js:166` |

**Verification**

- Twelve unit checks over `applyTrackOrder` and the reorder logic, extracted from the patched source at run time so the tests cannot drift from the code. All pass, including the four reorder cases that failed before the fix.
- Runtime, against a generated 10-file WAV library: cold scan (10 tracks / 3 folders, artwork pass runs over all 10, 106 ms) followed by a warm scan where **the artwork stage is absent from the log entirely** and the scan takes 43 ms. All 10 cache entries carry `embeddedArtworkChecked`.
- Numeric collation confirmed in the snapshot (`1`, `2`, `10` — not `1`, `10`, `2`).
- Incremental refresh confirmed: a file added while running landed in sorted position between `2 Root Apple` and `10 Root Zebra` rather than at the end, via `library.incremental-refresh` with no full rescan.
- Test library, caches and `settings.json` were restored afterwards.

**Still open**

Watcher-triggered full rescan on reorder/rename (`02-performance.md`); synchronous diagnostic I/O; per-batch cache re-parse; session payload size (mitigated but not reduced); `settings:save` validation; the playlist-rename warning copy; `aria-live` verbosity; and everything in `05-architecture.md`, the test suite most of all.

## Dead UI resolved (2026-09-07)

The three sidebar filter pills and the "Show all" credits affordance from `04-ux.md` are no longer dead.

- **"Folders" pill removed.** In this data model a folder *is* a playlist, so that tab could never show anything different from "Playlists". It was structurally dead, not merely unimplemented.
- **"Albums" pill implemented.** New `getAlbumCollections()` groups the flat track list by album tag (skipping the `Local library` sentinel), memoized and invalidated in `normalizeLibrary`. Album rows carry `data-entity-type="album"`, so they route into the album view that already existed for search results. Both pills now carry `role="tab"` and a live `aria-selected`.
- **"Show all" implemented.** Now a real toggle expanding the credits card to track number, length, format and folder — all fields already present on the track object, so no main-process change was needed.

Verified against a purpose-built library of tag-carrying WAVs: three albums correctly grouped and name-sorted, every track accounted for, the memo returning an identical array on re-call, and — the case that justifies the feature — `Night Signals` grouping three tracks that live in two different folders.

## Blind spots

- **Measurements are from a 10-file synthetic library, not a real one.** The review findings were written from static analysis; the post-fix numbers above come from a generated test library of silent WAVs. That validates the code paths and the caching behaviour, but the timings say nothing about how the app performs on a library of tens of thousands of tracks, and the relative ranking of the performance findings remains inferred.
- **No git history.** I could not use recency or churn to aim the read, which is normally the highest-yield signal. Coverage is therefore uniform rather than risk-weighted.
- **Windows-only reasoning on platform behaviour.** The `fs.renameSync`-on-open-directory finding (`01-bugs.md`, Low) depends on Chromium's file sharing flags and is marked Needs check. `fs.watch({ recursive: true })` is unsupported on Linux and would throw into the existing catch — I did not verify the resulting degraded behaviour.
- **`styles.css` was skimmed, not read.** 1,576 lines checked only against specific questions. Visual regressions, theme-token gaps across the seven themes, and layout behaviour at the 1180px minimum width were not assessed.
- **Real-world data.** Cache-file sizes, journal growth rates, and the actual proportion of files lacking embedded artwork all drive the severity of the performance findings, and I have none of those numbers.
- **`npm audit` did not run.** The dependency surface is small (one runtime package), but no CVE check was performed.
- **Code signing.** No signing configuration is present in `package.json`; I inferred that builds are unsigned rather than confirming it against a produced installer.
