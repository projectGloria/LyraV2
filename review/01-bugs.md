# Correctness

### [High] Tray icon path escapes the app root, making the window unclosable

**Where:** `main.cjs:980`
**Trigger:** Enable "Close window to tray" in Options, then click the title-bar close button.
**Detail:** `ensureTray()` builds the icon path as `path.join(__dirname, '..', 'assets', 'icon.ico')` — one directory above the app root. Only `LyraV2/assets/icon.ico` exists (verified); `../assets` does not. Every other reference uses the correct form, e.g. `createWindow` at `main.cjs:1009` uses `path.join(__dirname, 'assets', 'icon.ico')`.

`nativeImage.createFromPath` on a missing path returns an empty image, and `new Tray(<empty image>)` throws on Windows. The `close` handler runs in this order:

```js
if (!isQuitting && current.closeToTray) {
  event.preventDefault();   // close already cancelled
  ensureTray();             // throws here
  mainWindow.hide();        // never runs
}
```

**Impact:** The close is cancelled, the window neither hides nor closes, and no tray icon appears to restore or quit the app. The user cannot close Lyra from the title bar at all — only via Task Manager. This is the entire feature failing, not a degraded icon.
**Fix:** Drop the `'..'` segment.
**Confidence:** Verified

---

### [Medium] Drag-to-reorder cannot move a track downward

**Where:** `renderer.js:1640` (`reorderSelectedTracks`)
**Trigger:** In any playlist, drag a song onto a song below it.
**Detail:** The dragged tracks are removed from the list, the target's index is recomputed in the *remaining* list, and the tracks are always inserted **before** the target. Removing an item that sat above the target shifts the target's index down by one, which exactly cancels the intended move. Verified by executing the logic in isolation on `[A,B,C,D,E]`:

| Gesture | Result |
|---|---|
| drag C onto D (down 1) | `A B C D E` — **no change** |
| drag C onto E (down 2) | `A B D C E` — moved only one slot |
| drag A onto E (to the end) | `B C D A E` — **cannot reach last position** |
| drag D onto B (upward) | `A D B C E` — correct |

**Impact:** Downward reordering silently does nothing or under-shoots by one, and no track can ever be dragged to the end of a playlist. The (correct) upward direction masks the bug, so it reads as flaky rather than broken. The wrong order is then persisted to `.lyra-playlist.json` in the user's music folder.
**Fix:** When the target originally sat after the dragged block, insert at `targetIndex + 1`; compare original indices before filtering.
**Confidence:** Verified

---

### [Medium] `invalidatePlayback()` leaves the previous library's tracks in `basePlaybackList`

**Where:** `renderer.js:1175-1190`
**Trigger:** Choose a different music folder, then press shuffle before playing anything from the new library.
**Detail:** `invalidatePlayback()` clears `currentTrack`, `queue`, `playbackList` and `playbackHistory` but never touches `state.basePlaybackList`. `toggleShuffleMode()` (`renderer.js:1249`) rebuilds the playable list from that stale array:

```js
if (state.basePlaybackList?.length) {
  const shuffled = fisherYatesShuffle(state.basePlaybackList);
  ...
  state.playbackList = shuffled;
}
```

`chooseLibrary()` → `scanLibrary()` with `preservePlayback: false` → `invalidatePlayback(true)`, so the stale list survives a full library switch.
**Impact:** After switching libraries, pressing shuffle repopulates playback with tracks from the *old* folder, and Next plays files the user removed from their library. If those files were deleted or the drive was unmounted, playback errors instead.
**Fix:** Add `state.basePlaybackList = [];` alongside the other resets in `invalidatePlayback`.
**Confidence:** Verified

---

### [Medium] Session persistence throws unguarded on `localStorage` quota

**Where:** `renderer.js:1218` (`writePlaybackSessionNow`)
**Trigger:** Play from a playlist large enough that the serialized session exceeds the ~5 MB origin quota.
**Detail:** The payload stores full absolute paths for the queue, `playbackList`, **and** `basePlaybackList` — i.e. two complete copies of the active playlist. At a typical Windows path length of ~80 characters that crosses 5 MB somewhere around 30k tracks. `localStorage.setItem` is called with no `try`/`catch`, unlike `readPlaybackSession` (`renderer.js:1202`) which is guarded.

The call runs from a `setTimeout` (fired by `timeupdate`, so roughly every 2 seconds during playback) and from `beforeunload`.
**Impact:** `QuotaExceededError` is thrown as an uncaught exception every ~2 seconds during playback, and the playback session is never saved — resume-on-restart silently stops working for exactly the users with the largest libraries. The `beforeunload` throw also fires during app shutdown.
**Fix:** Wrap the write in `try`/`catch`; store the collection identity plus indices rather than two full path arrays.
**Confidence:** Verified

---

### [Medium] `remapLocalPath` hard-codes Windows separators, breaking playlist rename off Windows

**Where:** `renderer.js:1485`
**Trigger:** On macOS or Linux, rename a playlist from the edit dialog.
**Detail:** The function ends with `.replaceAll('/', '\\')`, converting every remapped path to backslash form unconditionally. `refreshEditedPlaylist` (`renderer.js:1498`) applies it to `folder.path`, `track.path` and `track.folderPath` for the whole library, then looks the folder back up with an exact string compare:

```js
const updated = state.library.folders.find((folder) => folder.path === newRoot);
if (!updated) return false;
```

`newRoot` comes from the main process as a POSIX path, so on macOS/Linux the lookup never matches.
**Impact:** Renaming a playlist rewrites every track path in the in-memory library to an invalid backslash form, and the function bails before applying the new name — so the UI shows the old name over a library whose paths no longer resolve. Playback of any already-loaded track continues (its `url` is separate), but selecting anything new fails until a rescan. `package.json` declares mac and Linux build targets, so these platforms are in scope.
**Fix:** Use `path.sep` semantics — rebuild with the separator observed in the input rather than forcing `\`.
**Confidence:** Verified

---

### [Medium] Incrementally added tracks land at the bottom instead of in sorted order

**Where:** `main.cjs:934` and `main.cjs:945`
**Trigger:** Drop a new audio file into a watched playlist folder that has no `.lyra-playlist.json` custom order.
**Detail:** A full scan sorts each folder's files with `localeCompare(..., { numeric: true })` (`main.cjs:670`). The incremental path instead appends:

```js
snapshot.likedSongs = [...(snapshot.likedSongs || []), track];   // :934
folder.tracks.push(track);                                        // :945
```

`applyTrackOrder` then runs, but with no sidecar `trackOrder` it returns the array unchanged (`main.cjs:428`).
**Impact:** A newly added song appears at the bottom of the playlist rather than in its alphabetical position, and stays there until the next full rescan — so the list order silently differs depending on how the track arrived. In a numbered album folder the new track sits after every other track regardless of its number.
**Fix:** Re-sort with the same comparator the full scan uses when `trackOrder` is empty.
**Confidence:** Verified

---

### [Low] Renaming a playlist whose track is playing may fail on Windows

**Where:** `main.cjs:389` (`editPlaylist`)
**Trigger:** Play a song, then rename the playlist folder it lives in.
**Detail:** `fs.renameSync(folderPath, targetPath)` renames a directory that contains a file currently open by the renderer's `<audio>` element. Whether this succeeds depends on the sharing flags Chromium used to open the media file; a failure surfaces as a raw `EPERM`/`EBUSY` message in the toast rather than an explanatory one.
**Impact:** Intermittent, unexplained "could not update this playlist" failures that depend on what is playing.
**Fix:** Catch the rename error specifically and report it as "stop playback before renaming this playlist", or pause and re-point the audio element around the rename.
**Confidence:** Needs check — depends on Chromium's file sharing mode, which I could not verify statically.

---

### [Low] Unreadable tracks trigger a 2-second auto-advance cascade

**Where:** `renderer.js:2350`
**Trigger:** Play from a folder on a network drive that disconnects, or a folder of corrupt files.
**Detail:** The `error` handler schedules `nextTrack()` after 2 seconds with no failure counter. Each subsequent track fails the same way.
**Impact:** The app walks the entire playlist at one track every 2 seconds, showing a toast for each, with no way to stop it except pausing between toasts.
**Fix:** Track consecutive failures and stop after a small number.
**Confidence:** Verified

---

### [Low] Navigation history grows without bound

**Where:** `renderer.js:403` (`navigateTo`)
**Trigger:** Long session with heavy browsing.
**Detail:** `state.navigationHistory.push(next)` has no cap. Entries are small view descriptors, so this is a slow leak rather than a fast one.
**Impact:** Unbounded memory growth over a long-running session; no user-visible failure at realistic sizes.
**Fix:** Cap at a few hundred entries, dropping from the front.
**Confidence:** Verified

---

### [Low] Cache compaction treats sibling directories as inside the library root

**Where:** `main.cjs:181-190` (`compactTrackMetadataCache`)
**Trigger:** Library root is `.../Music` and another scanned-at-some-point folder is `.../Music2`.
**Detail:** Retention is decided with `!key.startsWith(rootKey)` on raw lowercased path strings, with no separator boundary. `c:/users/x/music2/song.mp3` starts with `c:/users/x/music`, so it is treated as living under the current root and is evicted when not in the active set.
**Impact:** Cached metadata for a sibling folder is discarded, costing a full re-parse if the user switches back to it. No incorrect data, only lost work.
**Fix:** Compare against `` `${rootKey}/` `` , or use `path.relative`.
**Confidence:** Verified
