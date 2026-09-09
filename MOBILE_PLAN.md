# Lyra Mobile — Implementation Plan

**Target:** Android only, standalone on-device player, user picks the folder(s) to scan.
**Stack:** Capacitor (WebView shell) reusing `index.html` / `renderer.js` / `styles.css`.
**Non-goals for v1:** iOS, desktop↔phone sync/streaming, cloud anything.

---

## 1. Why this is tractable

One fact makes the Capacitor route cheap: **`window.spotfck` is the only boundary.** Every
native call in `renderer.js` goes through it (24 methods, verified by grep — no `require`,
no `process`, no Node globals anywhere in the renderer). `main.cjs` is 1385 lines of
Electron-specific machinery that the phone will never run; `renderer.js` + `styles.css`
(4800 lines of UI you already like) port essentially as-is.

So the port is not "rewrite the app". It is:

1. Reimplement the `window.spotfck` contract on Android.
2. Replace three desktop assumptions that leak past that boundary (`file://` URLs, HTML5
   drag-and-drop, three-column layout).
3. Solve background audio, which the desktop version never had to think about.

### The three real engineering problems

Everything else is plumbing. These are the parts that can actually go wrong:

| Problem | Why it's hard | Where it's solved |
| --- | --- | --- |
| Serving audio/artwork to the WebView | Capacitor serves the app from `https://localhost`. `content://` URIs from the folder picker **cannot** be loaded from that origin, and `<audio>` seeking needs HTTP Range support | Phase 2 |
| Background playback | An `<audio>` element in a WebView stops when the screen locks, has no lockscreen controls, no headset buttons, no audio focus | Phase 3 |
| Scanning without a filesystem | There is no `fs.readdir` and no `fs.watch`. SAF tree-walking is slow; MediaStore is fast but doesn't index everything | Phase 2 |

---

## 2. Repo layout

Keep one repo. Do **not** fork `renderer.js`.

```
LyraV2/
  shared/                  # the UI, byte-identical for both platforms
    index.html
    renderer.js
    styles.css
    assets/
  desktop/
    main.cjs
    preload.cjs            # implements window.spotfck via Electron IPC
    window-bounds.js
  mobile/
    capacitor.config.json
    www/                   # build output: copy of shared/ + mobile-bridge.js
    src/
      mobile-bridge.js     # implements window.spotfck via Capacitor plugins
      library-scan.js      # scan pipeline, ported from main.cjs
      snapshot-cache.js
    android/               # native project
      .../LyraMediaPlugin.java
      .../LyraPlaybackService.java
  scripts/
    sync-shared.mjs        # copies shared/ into mobile/www, desktop stays in place
```

**Divergence is the main long-term risk.** A one-line `node scripts/sync-shared.mjs`
(run by `npm run mobile:sync`) copying rather than two hand-maintained copies is the
cheapest guard. If the two ever need to differ, they differ via `body.is-mobile` and the
bridge — never via a forked file.

Desktop keeps working throughout: `main.cjs` just loads `shared/index.html` instead of
`./index.html`. That single-line change is the whole desktop cost of this restructure.

---

## 3. The `window.spotfck` contract on Android

| Method | Android implementation | Notes |
| --- | --- | --- |
| `readSettings` / `saveSettings` | Capacitor `Preferences` | Drop `windowBounds`, `windowMaximized`, `leftSidebarWidth`, `rightSidebarWidth` |
| `chooseLibrary` | SAF `ACTION_OPEN_DOCUMENT_TREE` + `takePersistableUriPermission` | Returns a tree URI, not a path. Persist it — without the persistable grant, access dies on reboot |
| `scanLibrary` | Custom plugin: MediaStore cursor + SAF tree walk (§4) | Progress via the existing `library:progress` event shape |
| `readLibraryCache` | `Filesystem` read of `library-snapshot.json` in app data | Same JSON, same version constant |
| `watchLibrary` / `onLibraryChanged` | `ContentObserver` on `MediaStore.Audio` + rescan on `resume` | There is no `fs.watch` equivalent for SAF. Accept coarser granularity |
| `refreshLibraryChanges` | Pure JS, ported unchanged from `main.cjs` | Already platform-independent logic |
| `createPlaylist` / `deletePlaylist` / `editPlaylist` / `reorderPlaylist` | `DocumentsContract.createDocument` / `deleteDocument` / `renameDocument` + sidecar write | Phase 5 |
| `chooseBackground` / `chooseProfilePicture` / `choosePlaylistArtwork` | SAF `ACTION_OPEN_DOCUMENT` filtered to `image/*` | Copy into app data so the grant can't be revoked out from under you |
| `exportQueue` | `ACTION_CREATE_DOCUMENT` or the share sheet | |
| `reportEvent` / `getReportInfo` | `Filesystem` JSONL in app data, same rotation | Keep `redactDiagnosticString` |
| `openReportFolder` | Share sheet with the log file attached | No file manager guarantee on Android |
| `revealInExplorer` | **Drop.** Hide the button under `body.is-mobile` | |
| `minimize` / `maximize` / `close` | **Drop.** Hide the window buttons and `.app-drag` regions | |
| `onAppError` | In-process emitter in the bridge | |

Write the bridge to the *same shape* the preload exposes (promises, unsubscribe functions
returned from `on*`). Then `renderer.js` genuinely cannot tell which platform it is on,
except where you deliberately let it.

---

## 4. Library scanning on Android

The desktop three-layer cache exists because parsing 5000 files with `music-metadata`
is slow. **On Android, MediaStore has already done that work.** Use it.

### Tier 1 — MediaStore (the fast path, covers ~95% of a normal library)

One `ContentResolver.query` over `MediaStore.Audio.Media.EXTERNAL_CONTENT_URI` returns
title, artist, album, duration, track number, year, `relative_path`, `display_name`,
`size`, `date_modified`, and `album_id` for the whole device in well under a second for
thousands of tracks. Filter rows to those under the user's chosen tree
(`relative_path` prefix match). Album art comes from
`ContentUris.withAppendedId(Audio.Albums.EXTERNAL_CONTENT_URI, album_id)` — no extraction,
no `artwork-cache/` directory, no content hashing.

This deletes most of the desktop scan pipeline: no `directory-index-cache.json`, no
embedded-artwork extraction, no artwork dedupe by hash. `library-snapshot.json` stays
(it makes the first paint instant, which matters more on a phone).

### Tier 2 — SAF tree walk (the correctness path)

MediaStore misses files it hasn't indexed yet and formats it doesn't decode
(`.ape`, `.mpc`, `.dsf`, `.dff`, some `.wma`). Walk the chosen tree with
`DocumentsContract.buildChildDocumentsUriUsingTree` — a batched cursor per directory, not
a stat per file — and diff against the MediaStore results by relative path. For the
leftovers, pull tags with `MediaMetadataRetriever` on the native side.

`MediaMetadataRetriever` also won't read APE/MPC/DSF. If those matter to you, the fallback
is `music-metadata`'s browser build (`parseBlob`) in the WebView — but that needs a
bundler, which the project currently doesn't have. **Recommendation: skip it.** Ship
filename-derived titles for exotic formats and revisit only if your library actually
contains them.

Keep the small `(size, lastModified)`-keyed metadata cache for Tier-2 results only, so the
slow path runs once per file ever.

### Track identity

Desktop uses `sha1(absolutePath).slice(0,16)`. Do **not** switch to MediaStore `_id` —
it is not stable across re-indexes. Use `sha1(volumeName + '/' + relativePath + displayName)`,
which keeps identity path-derived exactly like desktop. Two consequences worth having:
`remapLocalPath` / `remapLocalUrl` keep working, and a folder synced to both machines
produces the same track IDs on both.

### Sidecar compatibility — treat as an invariant

`.lyra-playlist.json` and `.lyra-cover.*` are written into the music folder itself, and SAF
can create documents in the picked tree. **Keep the format byte-identical to desktop.**
That means a folder you later sync between PC and phone carries its custom names,
descriptions, manual ordering and covers across for free. This is the single highest-value
thing to not break, and it costs nothing to preserve now.

---

## 5. Serving media to the WebView

Set `server.androidScheme: 'https'`, so the app origin is `https://localhost`.

- **Real filesystem paths** (from MediaStore where a usable path exists):
  `Capacitor.convertFileSrc(path)` → `https://localhost/_capacitor_file_/...`. Works today,
  Range-capable, zero code.
- **`content://` URIs** (SAF-only files, album art): Capacitor cannot serve these. Add a
  handler in the custom plugin's `shouldInterceptRequest` for
  `https://localhost/_lyra_media_/<urlencoded content uri>` that opens a
  `ParcelFileDescriptor` via `ContentResolver` and streams it.

**The Range header is not optional.** If the interceptor ignores `Range` and always returns
200 with the whole body, `<audio>` will play but seeking will be broken or will restart the
file, and `duration` may read as `Infinity` on some formats. Implement `206 Partial Content`
with correct `Content-Range` / `Accept-Ranges` from day one — retrofitting it after the UI
"works" is how this bug ships.

In `renderer.js`, `fileUrl()` (line 107) becomes a platform hook: desktop keeps the current
implementation, mobile returns one of the two forms above.

**CSP:** `index.html` line 6 must gain the app origin in `media-src` and `img-src`. Keep
`script-src 'self'`. Do not add `allowNavigation` to the Capacitor config.

---

## 6. Playback and background audio

This is where a naive port produces an app that stops playing when the screen turns off.

### Phase 3 approach — keep `<audio>`, make it survive

1. **Foreground service** with `android:foregroundServiceType="mediaPlayback"`, plus
   `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_MEDIA_PLAYBACK` permissions (mandatory on
   Android 14+). Started on play, stopped on pause-plus-timeout. Without it, Doze kills
   playback.
2. **`navigator.mediaSession`** in the renderer — metadata (title/artist/album/artwork) plus
   `play`, `pause`, `previoustrack`, `nexttrack`, `seekto` action handlers. The WebView routes
   hardware media keys and Bluetooth controls through this. The app currently sets **no**
   MediaSession metadata at all; this is new code, roughly 40 lines next to `playTrack`.
3. **Audio focus**: pause on transient loss (a call), duck on `AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK`,
   stop on permanent loss. Also honour `ACTION_AUDIO_BECOMING_NOISY` (headphones unplugged) —
   users notice this one immediately when it's missing.
4. **Notification** with transport controls, driven from the service via `MediaSessionCompat`.

The spectrum visualizer (`createMediaElementSource`, line 2110) keeps working under this
approach. Note the existing finding that the spectrum loop runs even while paused
(`review/02-performance.md`) — on a phone that is measurable battery drain; fix it before
shipping, not after.

### Phase 6 approach — native Media3/ExoPlayer

More robust: gapless, audio offload (real battery savings), better format coverage,
no WebView lifecycle coupling. The cost is that the spectrum needs a native `Visualizer`
feed, and the renderer's playback engine becomes a thin controller.

**Sequence this correctly:** in Phase 0, put playback behind a small interface
(`load / play / pause / seek / volume / on(event)`) even while it's still backed by the
`<audio>` element. Then Phase 6 is swapping one implementation instead of unpicking
`audio.` references from 2769 lines. Skipping this in Phase 0 is what turns Phase 6 from a
week into a rewrite.

---

## 7. UI work

The good news: `#fullscreenPlayer` already *is* a mobile now-playing screen, and track lists
are already virtualized at 62px rows.

| Desktop | Mobile |
| --- | --- |
| Three-column workspace | Single view + bottom tab bar (Library / Search / Now Playing) |
| `.library-panel` sidebar | Its own route |
| `.now-playing-panel` sidebar | Folded into the fullscreen player |
| `.player-dock` footer | Mini player above the tab bar; tap expands to fullscreen |
| Window buttons, `.app-drag` | Removed |
| Sidebar resizers | Removed |
| Right-click context menu (line 2415) | Long-press → bottom sheet, reusing the existing menu builder and `contextTrackId` |
| Double-click to play (line 2436) | Single tap |
| **HTML5 drag-and-drop reorder** (lines 2594–2626) | **Full rewrite — `dragstart`/`dragover`/`drop` do not fire on touch at all.** Pointer-events based, with an explicit drag handle |
| Hover states, `title` tooltips | Removed or converted to pressed states |
| Keyboard shortcuts (line 2495) | Harmless, leave in place |

Other required work:
- `body.is-mobile` set by the bridge at boot. **Drive layout off this class, not off a
  width breakpoint** — a tablet at 1100px should still get touch behaviour, and a narrow
  desktop window should not.
- `<meta name="viewport" content="viewport-fit=cover">` + `env(safe-area-inset-*)` padding
  on the topbar, mini player and tab bar. Gesture-nav phones will otherwise clip controls.
- Touch targets to 44px minimum — current icon buttons are ~28–32px.
- `overscroll-behavior: contain` on scrollers; passive touch listeners; check the virtual
  list against momentum scrolling (fast flings can outrun a scroll-event-driven recycler —
  it may need `requestAnimationFrame` polling instead).
- Existing media queries stop at 760px (`styles.css:1049`). A ≤600px layer is new work.

---

## 8. Fix these before porting, not after

From `review/02-performance.md` — desktop tolerates them, a phone will not:

- Session persistence is O(history × library) **every 2 seconds during playback**, and
  serializes two full playlist copies to `localStorage`. On battery, in a WebView, this is
  the worst line in the codebase.
- Tracks without artwork are fully re-parsed on every scan.
- Reorder/rename forces a full rescan.
- Diagnostic logging does three synchronous filesystem calls per line.
- The spectrum animation loop runs while paused.

All five are platform-independent and fixable on desktop today, where you can debug them
properly. Doing them first also means Phase 0 lands on clean code.

---

## 9. Phases

Each phase ends with something runnable.

**Phase 0 — Platform seam (desktop only, no Android yet)**
Restructure into `shared/` + `desktop/`. Introduce `body.is-mobile`, the `fileUrl()` hook,
and the playback interface. Hide desktop-only affordances behind the class. Ship the
perf fixes from §8.
*Done when:* desktop app is byte-for-byte equivalent in behaviour, and forcing
`body.is-mobile` on desktop produces a plausible single-column layout.
*This is the de-risking phase — all of it is testable on hardware you already have.*

**Phase 1 — Capacitor shell**
`mobile/` project, `capacitor.config.json`, sync script, stub bridge that reports "no
library". Android project builds and installs.
*Done when:* the app boots on a device and paints the empty state with correct theming.

**Phase 2 — Library and first sound**
SAF folder picker with persisted permission. MediaStore scan → snapshot cache. Media URL
interceptor **with Range support**. `fileUrl()` mobile implementation.
*Done when:* you pick a folder, see your playlists, tap a track, and it plays.

**Phase 3 — Playback correctness**
Foreground service, MediaSession, audio focus, becoming-noisy, notification controls,
session restore across app kills.
*Done when:* music keeps playing with the screen off, lockscreen controls work, and a
phone call pauses and resumes it.

**Phase 4 — Mobile UI pass**
Tab bar routes, mini player, bottom sheets, long-press menus, touch reorder, safe areas,
touch targets, ≤600px stylesheet layer.
*Done when:* it feels like a phone app rather than a shrunk desktop app.

**Phase 5 — Writes**
Create/rename/delete playlist, reorder, artwork picking — all via `DocumentsContract`,
all writing the desktop-identical sidecar.
*Done when:* a folder edited on the phone opens correctly in desktop Lyra.

**Phase 6 — Native playback engine (optional)**
Media3/ExoPlayer behind the Phase 0 interface. Gapless, offload, native visualizer feed.

**Phase 7 — Packaging**
minSdk 26 / target 35. Signing key, icons, splash, `POST_NOTIFICATIONS` and
`READ_MEDIA_AUDIO` (33+) / `READ_EXTERNAL_STORAGE` (≤32) permission flows, diagnostics
export via share sheet, sideload APK or Play listing.

---

## 10. Open decisions

1. **Multiple library roots.** You mentioned wanting a dedicated songs folder later. The
   desktop model is strictly one root. Supporting several roots on mobile is a
   `state.library` shape change that would want porting back to desktop — decide now
   whether v1 is one folder or many, because it touches identity and the snapshot format.
2. **Exotic formats.** Does your library contain `.ape` / `.mpc` / `.dsf`? If not, Tier 2
   fallback stays simple and no bundler enters the repo.
3. **Spectrum on mobile.** Keep it (constrains you toward `<audio>` in Phase 6) or drop it
   on phones?
4. **Distribution.** Sideloaded APK or Play Store? Play adds a data-safety declaration and
   review latency for a broad-file-access app, but nothing blocking.

## 11. Where I'd start

Phase 0 plus the §8 perf fixes, in that order. It's the only work that is both a hard
prerequisite for the port and independently valuable if the mobile version never ships —
and it's all done on the desktop app, where the edit-test loop is a `npm start` restart
rather than a Gradle build.
