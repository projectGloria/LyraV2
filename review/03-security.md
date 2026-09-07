# Security

## Posture

The Electron configuration is correct and deliberate, and that is worth stating plainly because it removes the whole class of findings that usually dominates an Electron review:

- `contextIsolation: true`, `nodeIntegration: false` (`main.cjs:1011-1013`).
- A restrictive CSP with `script-src 'self'` and no remote origins (`index.html:6`).
- No remote content is ever loaded — no `loadURL` to a network origin, no `<webview>`, no `new-window` handling needed.
- The IPC surface is a fixed, named list in `preload.cjs` with no generic `invoke(channel, ...)` passthrough.
- Path containment is enforced where it matters: `isPathInside` guards `editPlaylist` (`main.cjs:391`), `reorderPlaylist` (`main.cjs:415`) and `refreshLibraryChanges` (`main.cjs:903`); `readPlaylistMetadataAsync` reduces the sidecar's `artworkFile` to a `path.basename` before joining (`main.cjs:333`); `sanitizePlaylistName` strips separators, control characters and Windows reserved names (`main.cjs:348`).

**The primary untrusted input in this app is ID3/Vorbis tag content** — a downloaded music file can carry an arbitrary `title`, `artist` or `album`, and the renderer builds its DOM by assigning template literals to `innerHTML`. I traced every interpolation that reaches user-influenced data. All of them pass through `escapeHtml` (`renderer.js:86`), including the ones inside quoted attributes (`data-entity-value`, `aria-label`, `title`, `src`) — and `escapeHtml` covers both quote characters, so attribute breakout is closed too. `showToast` uses `textContent`. Artwork `src` values are produced by `pathToFileURL` in the main process, which percent-encodes. **I found no XSS.**

The findings below are latent — none is currently reachable by an attacker.

---

### [Low] `media://` protocol handler is an unrestricted file-read primitive

**Where:** `main.cjs:1086-1089`
**Detail:**

```js
protocol.registerFileProtocol('media', (request, callback) => {
  const requestedPath = decodeURIComponent(request.url.replace('media://', ''));
  callback({ path: requestedPath });
});
```

Any path the requester names is served verbatim — no containment check against the library root, no extension check, no normalization. It is currently unreachable: the scheme is absent from the CSP (`default-src 'self' file: data:`), it was never registered as privileged, and nothing in the codebase references `media://` (audio and artwork both use `file://` URLs from `fileUrl()`).
**Impact:** None today. It becomes an arbitrary-file-read the moment someone adds `media:` to the CSP or an XSS lands in the renderer, and it is the kind of dead handler that gets re-enabled later without anyone re-reading it.
**Fix:** Delete it. If a custom scheme is wanted later, use `protocol.handle` and resolve strictly under the configured library root.
**Confidence:** Verified

---

### [Low] `shell:reveal` accepts any absolute path from the renderer

**Where:** `main.cjs:1146-1153`
**Detail:** The handler resolves whatever string it is given and calls `shell.showItemInFolder`, checking only that the path exists. There is no check that the target is inside the configured library. The only caller passes `track.path`, so this is not currently exploitable.
**Impact:** With renderer script execution, an attacker could open Explorer windows at arbitrary filesystem locations. Low impact on its own (no read-back, no execution), but it is a needless widening of a boundary that is otherwise tightly held.
**Fix:** Require the path to satisfy `isPathInside(settings.libraryPath, target, true)`.
**Confidence:** Verified

---

### [Low] `settings:save` writes the renderer's object verbatim with no validation

**Where:** `main.cjs:1094`, `main.cjs:306` (`writeSettings`)
**Detail:** `ipcMain.handle('settings:save', (_event, settings) => writeSettings(settings))` serializes whatever arrives straight to `settings.json`, with no schema, key allowlist, or size cap. `readSettings` then parses it back and `createWindow` feeds `settings.windowBounds` into `fitBoundsToDisplays`.

`fitBoundsToDisplays` is defensive — it validates finiteness and falls back to a centered default (`window-bounds.js:20-32`) — so malformed bounds do not break startup. The remaining exposure is unbounded disk write and the general principle that a compromised renderer should not be able to write arbitrary content into the app's config file.
**Impact:** Low. No privilege gain; the config file is only ever read back by this app.
**Fix:** Pick known keys off the incoming object and clamp numeric ranges before writing.
**Confidence:** Verified

---

### Dependency check

`npm audit` could not be run (no lockfile-resolvable registry access in this environment). The runtime dependency surface is a single package, `music-metadata@^11`, which is the parser handling untrusted file input — worth keeping current, since a parser bug there is the most plausible route to memory-safety issues in this app. `electron@^42` and `electron-builder` are dev/build only.

**Not assessed:** whether the shipped installer is code-signed. `package.json` declares no `win.certificateFile`/`signtool` configuration and no `afterSign` hook, so on current evidence Windows builds are unsigned — worth confirming before distributing.
