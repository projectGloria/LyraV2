const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell, screen, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { fitBoundsToDisplays } = require('./window-bounds');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const mm = require('music-metadata');

// The window paints its backgroundColor before the renderer runs at all, so a fixed
// blue-black showed for a frame under the warm themes. Match it to the saved theme's
// own --bg (kept in sync with the [data-theme] blocks in styles.css).
const THEME_WINDOW_BACKGROUNDS = {
  aurora: '#050b17',
  lyra: '#0d0d0f',
  midnight: '#05070b',
  ember: '#10050a',
  violet: '#0b0619',
  forest: '#05130f',
  rose: '#130711'
};

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.wma', '.webm', '.aif', '.aiff', '.ape', '.mka', '.mp2', '.mpc', '.dsf', '.dff']);
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.avif', '.gif', '.bmp', '.ico', '.svg'];
const MAX_EMBEDDED_ARTWORK_BYTES = 16 * 1024 * 1024;
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const REPORT_DIRECTORY = () => path.join(app.getPath('userData'), 'reports');
const LOG_FILE = () => path.join(REPORT_DIRECTORY(), 'lyra-diagnostics.jsonl');
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_ARCHIVES = 5;
const PLAYLIST_METADATA_FILE = '.lyra-playlist.json';
const PLAYLIST_COVER_PREFIX = '.lyra-cover';
const TRACK_CACHE_VERSION = 8;
const TRACK_CACHE_COMPACTION_BYTES = 8 * 1024 * 1024;
const ARTWORK_CACHE_VERSION = 1;
const TRACK_CACHE_FILE = () => path.join(app.getPath('userData'), `track-metadata-cache-v${TRACK_CACHE_VERSION}.json`);
const TRACK_CACHE_JOURNAL_FILE = () => path.join(app.getPath('userData'), `track-metadata-cache-v${TRACK_CACHE_VERSION}.journal`);
const DIRECTORY_CACHE_VERSION = 1;
const DIRECTORY_CACHE_FILE = () => path.join(app.getPath('userData'), 'directory-index-cache.json');
const LIBRARY_SNAPSHOT_VERSION = 3;
const LIBRARY_SNAPSHOT_FILE = () => path.join(app.getPath('userData'), 'library-snapshot.json');

let mainWindow;
let activeScanToken = null;
let libraryWatcher = null;
let libraryWatchTimer = null;
let watchedLibraryPath = '';
let pendingLibraryChanges = new Map();
let tray = null;
let isQuitting = false;
const diagnosticSessionId = crypto.randomUUID();
let diagnosticSequence = 0;

const fsp = fs.promises;

async function safeStat(filePath) {
  try { return await fsp.stat(filePath); } catch { return null; }
}

async function safeLstat(filePath) {
  try { return await fsp.lstat(filePath); } catch { return null; }
}

async function safeReadDirAsync(directory) {
  try { return await fsp.readdir(directory, { withFileTypes: true }); } catch { return []; }
}

async function fileSignatureAsync(filePath) {
  const stat = await safeStat(filePath);
  return stat ? { size: Number(stat.size || 0), mtimeMs: Number(stat.mtimeMs || 0) } : { size: 0, mtimeMs: 0 };
}

class ScanCancelledError extends Error {
  constructor(message = 'Scan superseded by a newer scan') {
    super(message);
    this.name = 'ScanCancelledError';
    this.code = 'SCAN_CANCELLED';
  }
}

function assertScanActive(scanToken) {
  if (scanToken && activeScanToken !== scanToken) throw new ScanCancelledError();
}

function notifyRendererError(error, context = 'application') {
  const message = error?.message || String(error || 'Unknown error');
  logDiagnostic(context, { error: error?.stack || message });
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:error', { context, message, timestamp: Date.now() });
  } catch {}
}

process.on('uncaughtException', (error) => notifyRendererError(error, 'uncaught-exception'));
process.on('unhandledRejection', (reason) => notifyRendererError(reason, 'unhandled-rejection'));

function redactDiagnosticString(value) {
  let result = String(value);
  const homePath = os.homedir();
  if (homePath) {
    result = result.split(homePath).join('%USERPROFILE%');
    result = result.split(homePath.replaceAll('\\', '/')).join('%USERPROFILE%');
  }
  return result.slice(0, 4000);
}

function sanitizeDiagnosticValue(value, depth = 0) {
  if (depth > 5) return '[depth-limit]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactDiagnosticString(value);
  if (value instanceof Error) return { name: value.name, message: redactDiagnosticString(value.message), stack: redactDiagnosticString(value.stack || '') };
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeDiagnosticValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, sanitizeDiagnosticValue(item, depth + 1)]));
  }
  return redactDiagnosticString(value);
}

function rotateDiagnosticLogs() {
  try {
    const reportPath = LOG_FILE();
    if (!fs.existsSync(reportPath) || fs.statSync(reportPath).size < MAX_LOG_BYTES) return;
    const oldest = `${reportPath}.${MAX_LOG_ARCHIVES}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let index = MAX_LOG_ARCHIVES - 1; index >= 1; index -= 1) {
      const source = `${reportPath}.${index}`;
      if (fs.existsSync(source)) fs.renameSync(source, `${reportPath}.${index + 1}`);
    }
    fs.renameSync(reportPath, `${reportPath}.1`);
  } catch {}
}

function logDiagnostic(event, details = {}, level = 'info', source = 'main') {
  try {
    fs.mkdirSync(REPORT_DIRECTORY(), { recursive: true });
    rotateDiagnosticLogs();
    const record = {
      timestamp: new Date().toISOString(),
      sessionId: diagnosticSessionId,
      sequence: ++diagnosticSequence,
      level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
      source,
      event: String(event || 'unknown').slice(0, 120),
      details: sanitizeDiagnosticValue(details)
    };
    fs.appendFileSync(LOG_FILE(), `${JSON.stringify(record)}\n`, 'utf8');
  } catch {}
}

function diagnosticSettingsSummary(settings = {}) {
  return {
    theme: settings.theme,
    accentColor: settings.accentColor,
    showSpectrum: Boolean(settings.showSpectrum),
    libraryView: settings.libraryView,
    libraryConfigured: Boolean(settings.libraryPath),
    customBackground: Boolean(settings.backgroundPath),
    customProfile: Boolean(settings.profilePath),
    windowMaximized: Boolean(settings.windowMaximized),
    windowBounds: settings.windowBounds || null
  };
}

function cacheKey(filePath) {
  return path.resolve(filePath).replaceAll('\\', '/').toLowerCase();
}

async function readTrackMetadataCache() {
  const entries = {};
  try {
    const raw = await fsp.readFile(TRACK_CACHE_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === TRACK_CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
      Object.assign(entries, parsed.entries);
    }
  } catch {}

  try {
    const journal = await fsp.readFile(TRACK_CACHE_JOURNAL_FILE(), 'utf8');
    for (const line of journal.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record.key === 'string' && record.entry && typeof record.entry === 'object') {
          entries[record.key] = record.entry;
        }
      } catch {}
    }
  } catch {}
  return entries;
}

async function compactTrackMetadataCache(entries, activePaths, rootPath) {
  const activeKeys = new Set(activePaths.map(cacheKey));
  const rootKey = cacheKey(rootPath);
  const retained = {};
  const activeUrls = new Set();
  
  for (const [key, entry] of Object.entries(entries)) {
    if (activeKeys.has(key) || !(key === rootKey || key.startsWith(`${rootKey}/`))) {
      retained[key] = entry;
      if (entry.track && entry.track.artworkUrl) {
        activeUrls.add(entry.track.artworkUrl);
      }
    }
  }

  await fsp.mkdir(path.dirname(TRACK_CACHE_FILE()), { recursive: true });
  const temporaryPath = `${TRACK_CACHE_FILE()}.tmp`;
  await fsp.writeFile(temporaryPath, JSON.stringify({ version: TRACK_CACHE_VERSION, entries: retained }), 'utf8');
  await fsp.rename(temporaryPath, TRACK_CACHE_FILE());
  try { await fsp.rm(TRACK_CACHE_JOURNAL_FILE(), { force: true }); } catch {}

  try {
    const cacheDirectory = path.join(app.getPath('userData'), 'artwork-cache');
    const files = await safeReadDirAsync(cacheDirectory);
    for (const file of files) {
      if (file.isFile()) {
        const fullPath = path.join(cacheDirectory, file.name);
        if (!activeUrls.has(fileUrl(fullPath))) {
          await fsp.unlink(fullPath).catch(() => {});
        }
      }
    }
  } catch {}
}

async function writeTrackMetadataCacheDelta(entries, dirtyKeys, activePaths, rootPath) {
  if (!dirtyKeys?.size) return;
  try {
    await fsp.mkdir(path.dirname(TRACK_CACHE_FILE()), { recursive: true });
    const lines = [];
    for (const key of dirtyKeys) {
      const entry = entries[key];
      if (entry) lines.push(JSON.stringify({ key, entry }));
    }
    if (lines.length) {
      await fsp.appendFile(TRACK_CACHE_JOURNAL_FILE(), `${lines.join('\n')}\n`, 'utf8');
    }
    const stat = await safeStat(TRACK_CACHE_JOURNAL_FILE());
    if (stat && stat.size >= TRACK_CACHE_COMPACTION_BYTES) {
      await compactTrackMetadataCache(entries, activePaths, rootPath);
    }
  } catch (error) {
    logDiagnostic('track-cache-write-failed', { error: error.message || String(error) });
  }
}

async function mapWithConcurrency(items, limit, worker, shouldAbort = () => false) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      if (shouldAbort()) throw new ScanCancelledError();
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      if (shouldAbort()) throw new ScanCancelledError();
    }
  }));
  return results;
}

function makeId(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function fileUrl(filePath) {
  return pathToFileURL(filePath).toString();
}

// Artwork URLs are always strings. Cache entries written by an earlier build could hold
// the extractor's `{ url, checked }` result instead, which reached the renderer as
// "[object Object]" and rendered as a broken image. Coerce on the way out so existing
// caches heal themselves without needing a version bump and a full re-parse.
function normalizeArtworkUrl(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.url === 'string') return value.url;
  return '';
}

// Tags can carry several pictures (back cover, artist photo, booklet scans). Taking
// picture[0] blindly meant some tracks fell back to a placeholder even though a real
// front cover was sitting in the file, so prefer the front cover when one is tagged.
function pickBestPicture(pictures = []) {
  const list = Array.isArray(pictures) ? pictures.filter((picture) => picture?.data?.length) : [];
  if (!list.length) return null;
  const typeOf = (picture) => String(picture.type || '').toLowerCase();
  return list.find((picture) => typeOf(picture).includes('front'))
    || list.find((picture) => typeOf(picture).includes('cover'))
    || list.find((picture) => !typeOf(picture) || typeOf(picture) === 'other')
    || list[0];
}

async function materializeEmbeddedArtwork(picture, embeddedArtworkCache) {
  const data = picture?.data;
  if (!data || data.length > MAX_EMBEDDED_ARTWORK_BYTES) return '';
  const hash = crypto.createHash('sha1').update(data).digest('hex');
  if (embeddedArtworkCache?.has(hash)) return embeddedArtworkCache.get(hash);
  // Formats arrive as full MIME types from modern tags but as bare "JPG"/"PNG" from
  // ID3v2.2, so normalise both shapes before mapping to an extension.
  const rawFormat = String(picture.format || '').toLowerCase().replace(/^image\//, '');
  const extension = ({
    jpeg: '.jpg',
    jpg: '.jpg',
    png: '.png',
    webp: '.webp',
    gif: '.gif',
    bmp: '.bmp',
    tiff: '.tiff'
  })[rawFormat] || '.jpg';
  try {
    const cacheDirectory = path.join(app.getPath('userData'), 'artwork-cache');
    await fsp.mkdir(cacheDirectory, { recursive: true });
    const cachedPath = path.join(cacheDirectory, `${hash}${extension}`);
    try {
      await fsp.access(cachedPath, fs.constants.F_OK);
    } catch {
      try { await fsp.writeFile(cachedPath, data, { flag: 'wx' }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    const url = fileUrl(cachedPath);
    embeddedArtworkCache?.set(hash, url);
    return url;
  } catch {
    return '';
  }
}

// Returns { url, checked }. `checked` is false when the file could not be parsed at
// all: caching that as "this track has no cover" would make one transient read error
// permanently strip the artwork from a track.
async function extractEmbeddedArtwork(filePath, embeddedArtworkCache) {
  try {
    const metadata = await mm.parseFile(filePath, { duration: false, skipCovers: false, skipPostHeaders: false });
    const url = await materializeEmbeddedArtwork(pickBestPicture(metadata.common?.picture), embeddedArtworkCache);
    return { url, checked: true };
  } catch {
    return { url: '', checked: false };
  }
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
  } catch {
    return { libraryPath: '', backgroundPath: '', profilePath: '', showSpectrum: false, closeToTray: false, accentColor: '#c9a94a', theme: 'lyra', paletteVersion: 1, layoutVersion: 1, libraryView: 'list', leftSidebarWidth: 280, rightSidebarWidth: 286, windowBounds: null, windowMaximized: false };
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), 'utf8');
  logDiagnostic('settings.saved', diagnosticSettingsSummary(settings));
  return settings;
}

function safeReadDir(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isPathInside(rootPath, targetPath, allowRoot = false) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return (allowRoot && relative === '') || (relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isImagePath(filePath) {
  return IMAGE_EXTENSIONS.includes(path.extname(String(filePath || '')).toLowerCase());
}

async function readPlaylistMetadataAsync(directory) {
  const metadataPath = path.join(directory, PLAYLIST_METADATA_FILE);
  try {
    const raw = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
    const artworkFile = typeof raw.artworkFile === 'string' ? path.basename(raw.artworkFile) : '';
    const artworkPath = artworkFile && isImagePath(artworkFile) ? path.join(directory, artworkFile) : '';
    const artworkStat = artworkPath ? await safeStat(artworkPath) : null;
    return {
      name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : '',
      description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 240) : '',
      artworkPath: artworkStat?.isFile() ? artworkPath : '',
      trackOrder: Array.isArray(raw.trackOrder) ? raw.trackOrder.map((item) => String(item || '')).filter(Boolean) : []
    };
  } catch {
    return { name: '', description: '', artworkPath: '', trackOrder: [] };
  }
}

function sanitizePlaylistName(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(cleaned);
  return !cleaned || reserved ? fallback : cleaned;
}

function removeManagedPlaylistArtwork(directory) {
  for (const entry of safeReadDir(directory)) {
    if (!entry.isFile() || !entry.name.toLowerCase().startsWith(`${PLAYLIST_COVER_PREFIX}.`)) continue;
    try { fs.unlinkSync(path.join(directory, entry.name)); } catch {}
  }
}

function copyPlaylistArtwork(directory, sourcePath) {
  const source = path.resolve(String(sourcePath || ''));
  if (!source || !fs.existsSync(source) || !isImagePath(source) || !fs.statSync(source).isFile()) throw new Error('The selected cover image is not readable.');
  removeManagedPlaylistArtwork(directory);
  const extension = path.extname(source).toLowerCase() || '.jpg';
  const target = path.join(directory, `${PLAYLIST_COVER_PREFIX}${extension}`);
  if (source.toLowerCase() !== target.toLowerCase()) fs.copyFileSync(source, target);
  return path.basename(target);
}

function writePlaylistMetadata(directory, metadata) {
  const metadataPath = path.join(directory, PLAYLIST_METADATA_FILE);
  const temporaryPath = `${metadataPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(metadata, null, 2), 'utf8');
  fs.renameSync(temporaryPath, metadataPath);
}

// Creates a real directory in the music library, which is what a playlist *is* here.
// A uniquifying suffix is appended rather than failing, so repeated clicks keep working.
async function createPlaylist(payload = {}) {
  const rootPath = path.resolve(String(payload.rootPath || ''));
  if (!rootPath || !fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error('Choose a music folder before creating a playlist.');
  }
  const requested = sanitizePlaylistName(payload.name, 'New Playlist');
  let name = requested;
  let folderPath = path.join(rootPath, name);
  for (let suffix = 2; fs.existsSync(folderPath) && suffix < 500; suffix += 1) {
    name = `${requested} ${suffix}`;
    folderPath = path.join(rootPath, name);
  }
  if (fs.existsSync(folderPath)) throw new Error('A folder with that playlist name already exists.');
  await fsp.mkdir(folderPath, { recursive: false });
  writePlaylistMetadata(folderPath, { name, description: '', artworkFile: '', trackOrder: [] });
  logDiagnostic('playlist-created', { folderPath });
  return { ok: true, id: makeId(folderPath), folderPath, name, description: '', artworkPath: '', artworkUrl: '' };
}

// Deletion goes through the OS trash, never fs.rm: this removes a folder of the user's
// own music files, so it has to stay recoverable. The confirmation is raised here rather
// than in the renderer so the count of files at risk is read off the real directory.
async function deletePlaylist(payload = {}) {
  const rootPath = path.resolve(String(payload.rootPath || ''));
  const folderPath = path.resolve(String(payload.folderPath || ''));
  if (!rootPath || !folderPath || !isPathInside(rootPath, folderPath)) {
    throw new Error('That playlist folder is not inside the selected music library.');
  }
  if (cacheKey(folderPath) === cacheKey(rootPath)) throw new Error('The library root cannot be deleted.');
  const stat = await safeStat(folderPath);
  if (!stat?.isDirectory()) throw new Error('That playlist folder no longer exists.');

  const audioCount = safeReadDir(folderPath).filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())).length;
  const name = path.basename(folderPath);
  const detail = audioCount
    ? `“${name}” and the ${audioCount} audio file${audioCount === 1 ? '' : 's'} inside it will be moved to the Recycle Bin. You can restore them from there.`
    : `The empty folder “${name}” will be moved to the Recycle Bin.`;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Move to Recycle Bin'],
    defaultId: 0,
    cancelId: 0,
    title: 'Delete playlist',
    message: `Delete the playlist “${name}”?`,
    detail
  });
  if (response !== 1) return { ok: false, cancelled: true };

  await shell.trashItem(folderPath);
  logDiagnostic('playlist-deleted', { folderPath, audioCount });
  return { ok: true, id: makeId(folderPath), folderPath, audioCount };
}

async function editPlaylist(payload = {}) {
  const rootPath = path.resolve(String(payload.rootPath || ''));
  const folderPath = path.resolve(String(payload.folderPath || ''));
  if (!rootPath || !folderPath || !isPathInside(rootPath, folderPath) || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error('The playlist folder is no longer available inside the selected library.');
  }
  const currentName = path.basename(folderPath);
  const name = sanitizePlaylistName(payload.name, currentName);
  const targetPath = path.join(path.dirname(folderPath), name);
  if (targetPath.toLowerCase() !== folderPath.toLowerCase() && fs.existsSync(targetPath)) throw new Error('A folder with that playlist name already exists.');
  if (targetPath.toLowerCase() !== folderPath.toLowerCase()) fs.renameSync(folderPath, targetPath);
  const existing = await readPlaylistMetadataAsync(targetPath);
  let artworkFile = existing.artworkPath ? path.basename(existing.artworkPath) : '';
  if (payload.artworkChanged) {
    if (payload.artworkPath) artworkFile = copyPlaylistArtwork(targetPath, payload.artworkPath);
    else { removeManagedPlaylistArtwork(targetPath); artworkFile = ''; }
  }
  const description = String(payload.description || '').trim().slice(0, 240);
  writePlaylistMetadata(targetPath, { name, description, artworkFile, trackOrder: existing.trackOrder || [] });
  const returnedArtworkPath = artworkFile ? path.join(targetPath, artworkFile) : findArtwork(targetPath, new Map());
  return {
    ok: true,
    id: makeId(targetPath),
    folderPath: targetPath,
    name,
    description,
    artworkPath: returnedArtworkPath || '',
    artworkUrl: returnedArtworkPath ? fileUrl(returnedArtworkPath) : ''
  };
}

async function reorderPlaylist(payload = {}) {
  const rootPath = path.resolve(String(payload.rootPath || ''));
  const folderPath = path.resolve(String(payload.folderPath || ''));
  if (!rootPath || !folderPath || !isPathInside(rootPath, folderPath, true) || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error('The playlist folder is no longer available inside the selected library.');
  }
  const requested = Array.isArray(payload.paths) ? payload.paths.map((item) => path.resolve(String(item || ''))) : [];
  const valid = requested.filter((item) => isPathInside(folderPath, item) && fs.existsSync(item) && AUDIO_EXTENSIONS.has(path.extname(item).toLowerCase()));
  const metadata = await readPlaylistMetadataAsync(folderPath);
  const artworkFile = metadata.artworkPath ? path.basename(metadata.artworkPath) : '';
  writePlaylistMetadata(folderPath, { name: metadata.name || '', description: metadata.description || '', artworkFile, trackOrder: valid.map((item) => path.basename(item)) });
  return { ok: true, trackOrder: valid };
}

function compareTrackPaths(first, second) {
  return String(first?.path || '').localeCompare(String(second?.path || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function applyTrackOrder(tracks, trackOrder = []) {
  // With no custom order, fall back to the same path sort the full scan uses, so
  // incrementally added tracks land in place instead of at the end of the list.
  if (!trackOrder.length) return [...tracks].sort(compareTrackPaths);
  const positions = new Map(trackOrder.map((name, index) => [String(name).toLowerCase(), index]));
  return [...tracks].sort((a, b) => {
    const aIndex = positions.get(path.basename(a.path).toLowerCase());
    const bIndex = positions.get(path.basename(b.path).toLowerCase());
    if (aIndex == null && bIndex == null) return compareTrackPaths(a, b);
    if (aIndex == null) return 1;
    if (bIndex == null) return -1;
    return aIndex - bIndex;
  });
}

function isImageEntry(entry) {
  return entry?.isFile?.() && IMAGE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase());
}

function getArtworkEntries(directory, artworkCache) {
  if (artworkCache?.has(directory)) return artworkCache.get(directory);
  const entries = safeReadDir(directory).filter(isImageEntry);
  artworkCache?.set(directory, entries);
  return entries;
}

function findArtwork(directory, artworkCache) {
  const entries = getArtworkEntries(directory, artworkCache);
  const normalized = entries.map((entry) => ({ entry, stem: path.basename(entry.name, path.extname(entry.name)).toLowerCase() }));
  for (const preferred of ['cover', 'folder', 'front', 'album', 'albumart', 'album-art', 'artwork', 'thumbnail', 'thumb', 'default']) {
    const match = normalized.find(({ stem }) => stem === preferred || stem.startsWith(`${preferred}-`) || stem.startsWith(`${preferred}_`) || stem.startsWith(`${preferred} `));
    if (match) return path.join(directory, match.entry.name);
  }
  const fallback = normalized.sort((a, b) => a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: 'base' }))[0];
  return fallback ? path.join(directory, fallback.entry.name) : '';
}

function findTrackArtwork(filePath, artworkCache) {
  const directory = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const entries = getArtworkEntries(directory, artworkCache);
  const sameBase = entries.find((entry) => {
    const stem = path.basename(entry.name, path.extname(entry.name)).toLowerCase();
    return stem === base || stem.startsWith(`${base}-`) || stem.startsWith(`${base}_`) || stem.startsWith(`${base} `);
  });
  if (sameBase) return path.join(directory, sameBase.name);
  return '';
}

function findNearestArtwork(directory, rootPath, artworkCache) {
  const resolvedRoot = path.resolve(rootPath);
  let current = path.resolve(directory);
  while (current === resolvedRoot || current.startsWith(`${resolvedRoot}${path.sep}`)) {
    const artwork = findArtwork(current, artworkCache);
    if (artwork) return artwork;
    if (current === resolvedRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '';
}

async function readDirectoryIndexCache() {
  try {
    const raw = await fsp.readFile(DIRECTORY_CACHE_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === DIRECTORY_CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
  } catch {}
  return {};
}

async function writeDirectoryIndexCache(entries) {
  try {
    await fsp.mkdir(path.dirname(DIRECTORY_CACHE_FILE()), { recursive: true });
    const temporaryPath = `${DIRECTORY_CACHE_FILE()}.tmp`;
    await fsp.writeFile(temporaryPath, JSON.stringify({ version: DIRECTORY_CACHE_VERSION, entries }), 'utf8');
    await fsp.rename(temporaryPath, DIRECTORY_CACHE_FILE());
  } catch (error) {
    logDiagnostic('directory-cache-write-failed', { error: error.message || String(error) });
  }
}

function serializeDirectoryEntries(entries) {
  return entries.map((entry) => ({ name: entry.name, type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other' }));
}

function deserializeDirectoryEntries(directoryPath, serialized = []) {
  return serialized.map((entry) => {
    const fullPath = path.join(directoryPath, entry.name);
    return {
      name: entry.name,
      isFile: () => entry.type === 'file',
      isDirectory: () => entry.type === 'directory',
      isSymbolicLink: () => false,
      path: fullPath
    };
  });
}

async function discoverFolderDirectories(rootPath, directoryEntries = new Map(), scanToken = null) {
  const folders = [];
  const visited = new Set();
  const queue = [rootPath];
  const cachedDirectories = await readDirectoryIndexCache();
  const nextDirectoryCache = {};
  while (queue.length) {
    assertScanActive(scanToken);
    const directory = queue.shift();
    const resolvedDirectory = path.resolve(directory).toLowerCase();
    if (visited.has(resolvedDirectory)) continue;
    visited.add(resolvedDirectory);

    const stat = await safeStat(directory);
    if (!stat?.isDirectory()) continue;
    const signature = { size: Number(stat.size || 0), mtimeMs: Number(stat.mtimeMs || 0) };
    const cacheKeyValue = cacheKey(directory);
    const cached = cachedDirectories[cacheKeyValue];
    let entries;
    if (cached && cached.size === signature.size && cached.mtimeMs === signature.mtimeMs && Array.isArray(cached.entries)) {
      entries = deserializeDirectoryEntries(directory, cached.entries);
    } else {
      entries = await safeReadDirAsync(directory);
      assertScanActive(scanToken);
    }
    directoryEntries.set(directory, entries);
    nextDirectoryCache[cacheKeyValue] = { ...signature, entries: serializeDirectoryEntries(entries) };

    const audioFiles = entries.filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
    // A folder Lyra created is a playlist even before any audio lands in it: its sidecar
    // is the marker. Without this an empty new playlist vanished on the next scan.
    const hasPlaylistSidecar = entries.some((entry) => entry.isFile() && entry.name === PLAYLIST_METADATA_FILE);
    if ((audioFiles.length || hasPlaylistSidecar) && directory !== rootPath) folders.push(directory);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childPath = path.join(directory, entry.name);
      // Cached directory entries were previously verified as real directories.
      // On a fresh listing, verify symlinks before descending to prevent cycles.
      if (cached && cached.size === signature.size && cached.mtimeMs === signature.mtimeMs) {
        queue.push(childPath);
        continue;
      }
      const childStat = await safeLstat(childPath);
      if (!childStat || childStat.isSymbolicLink()) continue;
      queue.push(childPath);
    }
  }
  await writeDirectoryIndexCache(nextDirectoryCache);
  return folders;
}

async function readTrack(filePath, folderPath, fallbackIndex, artworkCache, trackCache, dirtyKeys = null) {
  const signature = await fileSignatureAsync(filePath);
  const key = cacheKey(filePath);
  const cached = trackCache?.[key];
  const cachedArtworkPath = cached?.track?.artworkPath || '';
  const cachedArtworkSignature = cached?.artworkSignature || { size: 0, mtimeMs: 0 };
  const currentArtworkSignature = cachedArtworkPath ? await fileSignatureAsync(cachedArtworkPath) : cachedArtworkSignature;
  const cacheIsValid = cached
    && cached.size === signature.size
    && cached.mtimeMs === signature.mtimeMs
    && (!cachedArtworkPath || (cachedArtworkSignature.size === currentArtworkSignature.size && cachedArtworkSignature.mtimeMs === currentArtworkSignature.mtimeMs));
  if (cacheIsValid && cached.track) {
    return { ...cached.track, id: makeId(filePath), path: filePath, url: fileUrl(filePath), folderPath, dateAdded: signature.mtimeMs, artworkUrl: normalizeArtworkUrl(cached.track.artworkUrl), trackNo: cached.track.trackNo || fallbackIndex + 1 };
  }
  try {
    const metadata = await mm.parseFile(filePath, { duration: true, skipCovers: true, skipPostHeaders: false });
    const common = metadata.common || {};
    const format = metadata.format || {};
    const title = common.title || path.basename(filePath, path.extname(filePath));
    const artist = common.artist || common.artists?.join(', ') || 'Unknown artist';
    const album = common.album || 'Local library';
    const duration = Number(format.duration || 0);
    const fileArtwork = findTrackArtwork(filePath, artworkCache);
    const track = {
      id: makeId(filePath),
      path: filePath,
      url: fileUrl(filePath),
      title,
      artist,
      album,
      duration,
      durationLabel: formatDuration(duration),
      dateAdded: Number(signature.mtimeMs || 0),
      folderPath,
      artworkUrl: fileArtwork ? fileUrl(fileArtwork) : (cached?.track?.artworkUrl || ''),
      artworkPath: fileArtwork || '',
      trackNo: common.track?.no || fallbackIndex + 1
    };
    if (trackCache) {
      trackCache[key] = { size: signature.size, mtimeMs: signature.mtimeMs, artworkSignature: fileArtwork ? await fileSignatureAsync(fileArtwork) : { size: 0, mtimeMs: 0 }, track };
      dirtyKeys?.add(key);
    }
    return track;
  } catch {
    const track = {
      id: makeId(filePath), path: filePath, url: fileUrl(filePath),
      title: path.basename(filePath, path.extname(filePath)), artist: 'Unknown artist', album: 'Local library',
      duration: 0, durationLabel: '--:--', dateAdded: Number(signature.mtimeMs || 0), folderPath, artworkUrl: '', artworkPath: '', trackNo: fallbackIndex + 1
    };
    if (trackCache) {
      trackCache[key] = { size: signature.size, mtimeMs: signature.mtimeMs, artworkSignature: { size: 0, mtimeMs: 0 }, track };
      dirtyKeys?.add(key);
    }
    return track;
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function reportScanProgress(onProgress, progress) {
  try { onProgress({ ...progress, timestamp: Date.now() }); } catch {}
}

async function scanLibrary(requestedRootPath, onProgress = () => {}, scanToken = null) {
  assertScanActive(scanToken);
  const requestedPath = String(requestedRootPath || '').trim();
  reportScanProgress(onProgress, { stage: 'validate', label: 'Checking your folder', detail: requestedPath || 'No folder selected', percent: 2, processed: 0, total: 0, folders: 0, tracks: 0 });
  if (!requestedPath) {
    return { rootPath: '', ok: false, error: 'no-folder-selected', likedSongs: [], likedSongsArtworkUrl: '', folders: [], folderCount: 0, trackCount: 0, scannedAt: Date.now() };
  }

  const resolvedRoot = path.resolve(requestedPath);
  let rootStat;
  try {
    rootStat = await safeStat(resolvedRoot);
    if (!rootStat?.isDirectory()) throw new Error('not-a-directory');
  } catch (error) {
    logDiagnostic('scan-folder-validation-failed', { rootPath: resolvedRoot, error: error.code || error.message || 'folder-not-readable' });
      return { rootPath: resolvedRoot, ok: false, error: error.code || error.message || 'folder-not-readable', likedSongs: [], likedSongsArtworkUrl: '', folders: [], folderCount: 0, trackCount: 0, scannedAt: Date.now() };
  }

  const rootPath = resolvedRoot;
  const directoryEntries = new Map();
  const folderPaths = await discoverFolderDirectories(rootPath, directoryEntries, scanToken);
  const allFolderPaths = [rootPath, ...folderPaths];
  reportScanProgress(onProgress, { stage: 'folders', label: 'Finding playlists', detail: `${folderPaths.length} playlist folders discovered`, percent: 18, processed: 0, total: 0, folders: folderPaths.length, tracks: 0 });

  const audioFilesByFolder = new Map();
  let totalAudio = 0;
  for (const folderPath of allFolderPaths) {
    assertScanActive(scanToken);
    const audioFiles = (directoryEntries.get(folderPath) || safeReadDir(folderPath))
      .filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(folderPath, entry.name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    audioFilesByFolder.set(folderPath, audioFiles);
    totalAudio += audioFiles.length;
  }
  reportScanProgress(onProgress, { stage: 'index', label: 'Indexing audio files', detail: `${totalAudio} audio files found`, percent: 28, processed: 0, total: totalAudio, folders: folderPaths.length, tracks: 0 });

  const tracksByFolder = new Map(allFolderPaths.map((folderPath) => [folderPath, []]));
  const artworkCache = new Map(Array.from(directoryEntries, ([directory, entries]) => [directory, entries.filter(isImageEntry)]));
  directoryEntries.clear();
  const embeddedArtworkCache = new Map();
  const trackCache = await readTrackMetadataCache();
  const dirtyCacheKeys = new Set();
  const jobs = [];
  for (const folderPath of allFolderPaths) {
    const audioFiles = audioFilesByFolder.get(folderPath) || [];
    audioFiles.forEach((currentPath, index) => jobs.push({ currentPath, folderPath, index }));
  }
  const activeAudioPaths = jobs.map((job) => job.currentPath);
  const concurrency = Math.max(2, Math.min(4, Math.max(2, Math.floor((os.cpus()?.length || 2) / 2))));
  let processedAudio = 0;
  let metadataStartReported = false;
  let lastMetadataProgressAt = 0;
  let lastMetadataProgressCount = -1;
  const reportMetadataProgress = (detail, force = false) => {
    const now = Date.now();
    if (!force && processedAudio < totalAudio && processedAudio - lastMetadataProgressCount < 8 && now - lastMetadataProgressAt < 80) return;
    lastMetadataProgressAt = now;
    lastMetadataProgressCount = processedAudio;
    reportScanProgress(onProgress, { stage: 'metadata', label: 'Reading metadata and artwork', detail, percent: totalAudio ? 28 + Math.round((processedAudio / totalAudio) * 62) : 90, processed: processedAudio, total: totalAudio, folders: folderPaths.length, tracks: processedAudio });
  };
  const parsedTracks = await mapWithConcurrency(jobs, concurrency, async ({ currentPath, folderPath, index }) => {
    assertScanActive(scanToken);
    if (!metadataStartReported) {
      metadataStartReported = true;
      reportMetadataProgress(path.basename(currentPath), true);
    }
    let track;
    try {
      track = await readTrack(currentPath, folderPath, index, artworkCache, trackCache, dirtyCacheKeys);
    } catch (error) {
      logDiagnostic('track-read-failed', { filePath: currentPath, error: error.message || String(error) });
      track = { id: makeId(currentPath), path: currentPath, url: fileUrl(currentPath), title: path.basename(currentPath, path.extname(currentPath)), artist: 'Unknown artist', album: 'Local library', duration: 0, durationLabel: '--:--', dateAdded: 0, folderPath, artworkUrl: '', artworkPath: '', trackNo: index + 1 };
    }
    processedAudio += 1;
    reportMetadataProgress(path.basename(currentPath), processedAudio === totalAudio);
    return { folderPath, index, track };
  });
  assertScanActive(scanToken);
  for (const result of parsedTracks) {
    const tracks = tracksByFolder.get(result.folderPath) || [];
    tracks[result.index] = result.track;
    tracksByFolder.set(result.folderPath, tracks);
  }

  // Resolve artwork per track. Album and folder artwork are used only as collection
  // covers; they must never overwrite the identity of an unrelated song.
  const embeddedArtworkJobs = [];
  for (const folderPath of allFolderPaths) {
    const folderTracks = tracksByFolder.get(folderPath) || [];
    for (const track of folderTracks) {
      if (track.artworkUrl) continue;
      // A cache entry flagged as checked already had its embedded picture read (and
      // found to be absent). Re-parsing it on every scan is pure wasted work.
      if (trackCache[cacheKey(track.path)]?.embeddedArtworkChecked) continue;
      embeddedArtworkJobs.push(track);
    }
  }
  if (embeddedArtworkJobs.length) {
    reportScanProgress(onProgress, { stage: 'artwork', label: 'Reading embedded artwork', detail: `Checking ${embeddedArtworkJobs.length} track covers`, percent: 91, processed: 0, total: embeddedArtworkJobs.length, folders: folderPaths.length, tracks: processedAudio });
    let artworkProcessed = 0;
    await mapWithConcurrency(embeddedArtworkJobs, Math.max(1, Math.min(2, concurrency)), async (track) => {
      assertScanActive(scanToken);
      const { url: artworkUrl, checked } = await extractEmbeddedArtwork(track.path, embeddedArtworkCache);
      const key = cacheKey(track.path);
      if (trackCache[key]) {
        if (artworkUrl) {
          track.artworkUrl = artworkUrl;
          if (trackCache[key].track) trackCache[key].track = { ...trackCache[key].track, artworkUrl };
        }
        // Record the negative result too; the entry is invalidated by signature on change.
        // A failed parse is not a negative result, so it stays unflagged and is retried.
        if (checked) trackCache[key].embeddedArtworkChecked = true;
        dirtyCacheKeys.add(key);
      } else if (artworkUrl) {
        track.artworkUrl = artworkUrl;
      }
      artworkProcessed += 1;
      if (artworkProcessed === embeddedArtworkJobs.length || artworkProcessed % 10 === 0) {
        reportScanProgress(onProgress, { stage: 'artwork', label: 'Reading embedded artwork', detail: path.basename(track.path), percent: 91 + Math.round((artworkProcessed / embeddedArtworkJobs.length) * 3), processed: artworkProcessed, total: embeddedArtworkJobs.length, folders: folderPaths.length, tracks: processedAudio });
      }
      return artworkUrl;
    }, () => activeScanToken !== scanToken);
  }

  for (const folderPath of allFolderPaths) {
    assertScanActive(scanToken);
    const tracks = (tracksByFolder.get(folderPath) || []).filter(Boolean);
    const albumArtwork = new Map();
    for (const track of tracks) {
      const albumKey = String(track.album || '').trim().toLowerCase();
      if (track.artworkUrl && albumKey && albumKey !== 'local library' && !albumArtwork.has(albumKey)) albumArtwork.set(albumKey, track.artworkUrl);
    }
    for (const track of tracks) {
      if (track.artworkUrl) continue;
      const albumKey = String(track.album || '').trim().toLowerCase();
      track.artworkUrl = albumKey && albumKey !== 'local library' ? (albumArtwork.get(albumKey) || '') : '';
    }
    tracksByFolder.set(folderPath, tracks);
  }
  const allTracks = [...tracksByFolder.values()].flat();
  const globalAlbumArtwork = new Map();
  for (const track of allTracks) {
    const albumKey = String(track.album || '').trim().toLowerCase();
    if (track.artworkUrl && albumKey && albumKey !== 'local library' && !globalAlbumArtwork.has(albumKey)) globalAlbumArtwork.set(albumKey, track.artworkUrl);
  }
  for (const track of allTracks) {
    if (track.artworkUrl) continue;
    const albumKey = String(track.album || '').trim().toLowerCase();
    track.artworkUrl = albumKey && albumKey !== 'local library' ? (globalAlbumArtwork.get(albumKey) || '') : '';
  }

  // Last resort: a track with no sidecar image, no embedded picture and no album sibling
  // still lives in a folder that may have a cover. Untagged rips and files whose album
  // tag is missing used to end up on a placeholder here even with cover.jpg beside them.
  // This runs only over tracks that have nothing at all, so it cannot displace real art.
  const folderArtworkFallback = new Map();
  for (const track of allTracks) {
    if (track.artworkUrl) continue;
    const folderPath = track.folderPath || path.dirname(track.path);
    if (!folderArtworkFallback.has(folderPath)) {
      const nearest = findNearestArtwork(folderPath, rootPath, artworkCache);
      folderArtworkFallback.set(folderPath, nearest ? fileUrl(nearest) : '');
    }
    track.artworkUrl = folderArtworkFallback.get(folderPath) || '';
  }

  await writeTrackMetadataCacheDelta(trackCache, dirtyCacheKeys, activeAudioPaths, rootPath);

  reportScanProgress(onProgress, { stage: 'finalize', label: 'Building your library', detail: 'Preparing playlists and artwork', percent: 94, processed: totalAudio, total: totalAudio, folders: folderPaths.length, tracks: processedAudio });

  assertScanActive(scanToken);
  const folderItems = (await mapWithConcurrency(folderPaths, Math.min(4, Math.max(1, concurrency)), async (folderPath) => {
    assertScanActive(scanToken);
    let tracks = tracksByFolder.get(folderPath) || [];
    const metadata = await readPlaylistMetadataAsync(folderPath);
    tracks = applyTrackOrder(tracks, metadata.trackOrder);
    const discoveredArtwork = findArtwork(folderPath, artworkCache);
    const artworkPath = metadata.artworkPath || discoveredArtwork || '';
    return {
      id: makeId(folderPath),
      name: metadata.name || path.basename(folderPath),
      path: folderPath,
      description: metadata.description || '',
      artworkPath,
      artworkUrl: artworkPath ? fileUrl(artworkPath) : (tracks.find((track) => track.artworkUrl)?.artworkUrl || ''),
      tracks,
      isRoot: false
    };
  }, () => activeScanToken !== scanToken)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const rootMetadata = await readPlaylistMetadataAsync(rootPath);
  const likedSongs = applyTrackOrder(tracksByFolder.get(rootPath) || [], rootMetadata.trackOrder);
  const rootArtwork = findArtwork(rootPath, artworkCache);
  const trackCount = likedSongs.length + folderItems.reduce((sum, folder) => sum + folder.tracks.length, 0);
  const result = {
    rootPath,
    ok: true,
    error: '',
    likedSongs,
    likedSongsArtworkUrl: rootArtwork ? fileUrl(rootArtwork) : (likedSongs.find((track) => track.artworkUrl)?.artworkUrl || ''),
    folders: folderItems,
    folderCount: folderItems.length,
    trackCount,
    scannedAt: Date.now()
  };
  await writeLibrarySnapshot(result);
  reportScanProgress(onProgress, { stage: 'complete', label: 'Library ready', detail: `${trackCount} tracks in ${folderItems.length} playlists`, percent: 100, processed: totalAudio, total: totalAudio, folders: folderItems.length, tracks: trackCount });
  return result;
}

async function readLibrarySnapshot(rootPath = '') {
  const requested = path.resolve(String(rootPath || '').trim());
  if (!requested) return null;
  try {
    const raw = await fsp.readFile(LIBRARY_SNAPSHOT_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== LIBRARY_SNAPSHOT_VERSION || !parsed.library) return null;
    if (cacheKey(parsed.rootPath || '') !== cacheKey(requested)) return null;
    if (!parsed.library.ok || cacheKey(parsed.library.rootPath || '') !== cacheKey(requested)) return null;
    // Snapshots written by an earlier build can carry a malformed artwork value; heal it
    // here so the instant startup paint is correct instead of flashing broken images
    // until the background scan replaces the snapshot.
    for (const track of [...(parsed.library.likedSongs || []), ...(parsed.library.folders || []).flatMap((folder) => folder.tracks || [])]) {
      track.artworkUrl = normalizeArtworkUrl(track.artworkUrl);
    }
    return { ...parsed.library, _cachedAt: Number(parsed.cachedAt || 0) };
  } catch {
    return null;
  }
}

async function writeLibrarySnapshot(library) {
  if (!library?.ok || !library.rootPath) return false;
  try {
    await fsp.mkdir(path.dirname(LIBRARY_SNAPSHOT_FILE()), { recursive: true });
    const temporaryPath = `${LIBRARY_SNAPSHOT_FILE()}.tmp`;
    const payload = { version: LIBRARY_SNAPSHOT_VERSION, rootPath: library.rootPath, cachedAt: Date.now(), library };
    await fsp.writeFile(temporaryPath, JSON.stringify(payload), 'utf8');
    await fsp.rename(temporaryPath, LIBRARY_SNAPSHOT_FILE());
    return true;
  } catch (error) {
    logDiagnostic('library-snapshot-write-failed', { error: error.message || String(error) });
    return false;
  }
}

function stopLibraryWatcher() {
  if (libraryWatchTimer) clearTimeout(libraryWatchTimer);
  libraryWatchTimer = null;
  try { libraryWatcher?.close(); } catch {}
  libraryWatcher = null;
  watchedLibraryPath = '';
  pendingLibraryChanges.clear();
}

function watchLibrary(rootPath) {
  const resolved = String(rootPath || '').trim() ? path.resolve(rootPath) : '';
  if (resolved && cacheKey(resolved) === cacheKey(watchedLibraryPath)) return true;
  stopLibraryWatcher();
  if (!resolved || !fs.existsSync(resolved)) return false;
  try {
    libraryWatcher = fs.watch(resolved, { recursive: true }, (eventType, filename) => {
      const changedName = String(filename || '');
      if (changedName.endsWith('.tmp') || changedName.includes('~$')) return;
      pendingLibraryChanges.set(changedName.toLowerCase(), { eventType, filename: changedName });
      clearTimeout(libraryWatchTimer);
      libraryWatchTimer = setTimeout(() => {
        libraryWatchTimer = null;
        const changes = [...pendingLibraryChanges.values()];
        pendingLibraryChanges.clear();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library:changed', { changes, timestamp: Date.now() });
      }, 120);
    });
    libraryWatcher.on('error', (error) => {
      logDiagnostic('library.watcher-error', { rootPath: resolved, error: error.message || String(error) }, 'warn');
      stopLibraryWatcher();
    });
    watchedLibraryPath = resolved;
    logDiagnostic('library.watcher-started', { rootPath: resolved });
    return true;
  } catch (error) {
    logDiagnostic('library.watcher-failed', { rootPath: resolved, error: error.message || String(error) }, 'warn');
    return false;
  }
}

async function refreshLibraryChanges(rootPath, changes = []) {
  const resolvedRoot = path.resolve(String(rootPath || '').trim());
  const snapshot = await readLibrarySnapshot(resolvedRoot);
  if (!snapshot?.ok || !Array.isArray(changes) || !changes.length) return null;
  const changedPaths = [...new Set(changes.map((change) => String(change?.filename || '')).filter(Boolean).map((name) => path.resolve(resolvedRoot, name)))];
  if (!changedPaths.length || changedPaths.some((changedPath) => !isPathInside(resolvedRoot, changedPath))) return null;
  const hasCollectionMetadataChange = changedPaths.some((changedPath) => path.basename(changedPath).toLowerCase() === PLAYLIST_METADATA_FILE || IMAGE_EXTENSIONS.includes(path.extname(changedPath).toLowerCase()));
  if (hasCollectionMetadataChange) return null;
  const paths = changedPaths.filter((changedPath) => AUDIO_EXTENSIONS.has(path.extname(changedPath).toLowerCase()));
  if (!paths.length) return null;

  const trackCache = await readTrackMetadataCache();
  const dirtyKeys = new Set();
  const touchedFolders = new Set();
  const removePath = (changedPath) => {
    const key = cacheKey(changedPath);
    snapshot.likedSongs = (snapshot.likedSongs || []).filter((track) => cacheKey(track.path) !== key);
    for (const folder of snapshot.folders || []) folder.tracks = (folder.tracks || []).filter((track) => cacheKey(track.path) !== key);
    delete trackCache[key];
  };

  for (const changedPath of paths) {
    const changedFolderPath = path.dirname(changedPath);
    if (cacheKey(changedFolderPath) !== cacheKey(resolvedRoot)) touchedFolders.add(changedFolderPath);
    removePath(changedPath);
    const stat = await safeStat(changedPath);
    if (!stat?.isFile()) continue;
    const folderPath = path.dirname(changedPath);
    const artworkCache = new Map([[folderPath, safeReadDir(folderPath).filter(isImageEntry)]]);
    let track = await readTrack(changedPath, folderPath, 0, artworkCache, trackCache, dirtyKeys);
    if (!track.artworkUrl) {
      const changedKey = cacheKey(changedPath);
      if (!trackCache[changedKey]?.embeddedArtworkChecked) {
        const { url: embedded, checked } = await extractEmbeddedArtwork(changedPath, new Map());
        if (embedded) track.artworkUrl = embedded;
        if (trackCache[changedKey]) {
          if (embedded && trackCache[changedKey].track) trackCache[changedKey].track = { ...trackCache[changedKey].track, artworkUrl: embedded };
          if (checked) trackCache[changedKey].embeddedArtworkChecked = true;
          dirtyKeys.add(changedKey);
        }
      }
    }
    if (cacheKey(folderPath) === cacheKey(resolvedRoot)) {
      snapshot.likedSongs = [...(snapshot.likedSongs || []), track];
    } else {
      let folder = (snapshot.folders || []).find((item) => cacheKey(item.path) === cacheKey(folderPath));
      if (!folder) {
        const metadata = await readPlaylistMetadataAsync(folderPath);
        const artworkPath = metadata.artworkPath || findArtwork(folderPath, artworkCache) || '';
        folder = { id: makeId(folderPath), name: metadata.name || path.basename(folderPath), path: folderPath, description: metadata.description || '', artworkPath, artworkUrl: artworkPath ? fileUrl(artworkPath) : '', tracks: [], isRoot: false };
        snapshot.folders = [...(snapshot.folders || []), folder];
      }
      folder.tracks.push(track);
      touchedFolders.add(folderPath);
    }
  }

  const rootMetadata = await readPlaylistMetadataAsync(resolvedRoot);
  snapshot.likedSongs = applyTrackOrder(snapshot.likedSongs || [], rootMetadata.trackOrder);
  const rootArtworkCache = new Map([[resolvedRoot, safeReadDir(resolvedRoot).filter(isImageEntry)]]);
  const rootArtwork = findArtwork(resolvedRoot, rootArtworkCache);
  snapshot.likedSongsArtworkUrl = rootArtwork ? fileUrl(rootArtwork) : (snapshot.likedSongs.find((track) => track.artworkUrl)?.artworkUrl || '');
  for (const folderPath of touchedFolders) {
    const folder = snapshot.folders.find((item) => cacheKey(item.path) === cacheKey(folderPath));
    if (!folder) continue;
    const metadata = await readPlaylistMetadataAsync(folderPath);
    folder.name = metadata.name || path.basename(folderPath);
    folder.description = metadata.description || '';
    folder.tracks = applyTrackOrder(folder.tracks, metadata.trackOrder);
    const artworkCache = new Map([[folderPath, safeReadDir(folderPath).filter(isImageEntry)]]);
    folder.artworkPath = metadata.artworkPath || findArtwork(folderPath, artworkCache) || '';
    folder.artworkUrl = folder.artworkPath ? fileUrl(folder.artworkPath) : (folder.tracks.find((track) => track.artworkUrl)?.artworkUrl || '');
  }
  snapshot.folders = (snapshot.folders || []).filter((folder) => folder.tracks?.length).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  snapshot.folderCount = snapshot.folders.length;
  snapshot.trackCount = snapshot.likedSongs.length + snapshot.folders.reduce((sum, folder) => sum + folder.tracks.length, 0);
  snapshot.scannedAt = Date.now();
  await writeTrackMetadataCacheDelta(trackCache, dirtyKeys, getAllSnapshotTrackPaths(snapshot), resolvedRoot);
  await writeLibrarySnapshot(snapshot);
  logDiagnostic('library.incremental-refresh', { changes: paths.length, tracks: snapshot.trackCount, folders: snapshot.folderCount });
  return snapshot;
}

function getAllSnapshotTrackPaths(snapshot) {
  return [...(snapshot.likedSongs || []), ...(snapshot.folders || []).flatMap((folder) => folder.tracks || [])].map((track) => track.path);
}

function ensureTray() {
  if (tray) return tray;
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('Lyra');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Lyra', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
  return tray;
}

function createWindow() {
  const savedSettings = readSettings();
  const savedBounds = savedSettings.windowBounds && typeof savedSettings.windowBounds === 'object' ? savedSettings.windowBounds : {};
  const windowBounds = fitBoundsToDisplays(savedBounds, {
    width: 1520,
    height: 960,
    minWidth: 1180,
    minHeight: 740
  }, screen);
  mainWindow = new BrowserWindow({
    ...windowBounds,
    minWidth: 1180,
    minHeight: 740,
    backgroundColor: THEME_WINDOW_BACKGROUNDS[savedSettings.theme] || THEME_WINDOW_BACKGROUNDS.lyra,
    frame: false,
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  logDiagnostic('window.created', { bounds: windowBounds, maximized: Boolean(savedSettings.windowMaximized) });
  if (savedSettings.windowMaximized) mainWindow.maximize();
  mainWindow.on('close', (event) => {
    if (mainWindow.isDestroyed()) return;
    const current = readSettings();
    current.windowBounds = mainWindow.isMaximized() ? (current.windowBounds || windowBounds) : mainWindow.getBounds();
    current.windowMaximized = mainWindow.isMaximized();
    try { writeSettings(current); } catch (error) { logDiagnostic('window-state-write-failed', { error: error.message || String(error) }); }
    if (!isQuitting && current.closeToTray) {
      event.preventDefault();
      ensureTray();
      mainWindow.hide();
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => logDiagnostic('renderer.loaded'));
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logDiagnostic('renderer.load-failed', { errorCode, errorDescription, validatedURL }, 'error');
  });
  mainWindow.webContents.on('console-message', (_event, ...args) => {
    const details = args.length === 1 && typeof args[0] === 'object'
      ? args[0]
      : { level: args[0], message: args[1], lineNumber: args[2], sourceId: args[3] };
    const severity = typeof details.level === 'number'
      ? (details.level >= 3 ? 'error' : details.level >= 2 ? 'warn' : 'debug')
      : (String(details.level).toLowerCase() === 'error' ? 'error' : String(details.level).toLowerCase().includes('warn') ? 'warn' : 'debug');
    if (severity === 'debug') return;
    logDiagnostic('renderer.console', details, severity, 'renderer');
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    notifyRendererError(new Error(details?.reason || 'Renderer process exited'), 'render-process-gone');
  });
  mainWindow.webContents.on('crashed', () => {
    notifyRendererError(new Error('Renderer process crashed'), 'renderer-crashed');
  });

  const recoverWindowPosition = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const current = mainWindow.getBounds();
    const recovered = fitBoundsToDisplays(current, {
      width: 1520,
      height: 960,
      minWidth: 1180,
      minHeight: 740
    }, screen);
    if (current.x !== recovered.x || current.y !== recovered.y || current.width !== recovered.width || current.height !== recovered.height) {
      mainWindow.setBounds(recovered);
      mainWindow.show();
    }
  };
  screen.on('display-removed', recoverWindowPosition);
  screen.on('display-metrics-changed', recoverWindowPosition);
  mainWindow.on('closed', () => {
    screen.removeListener('display-removed', recoverWindowPosition);
    screen.removeListener('display-metrics-changed', recoverWindowPosition);
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  logDiagnostic('session.started', {
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  });
  ipcMain.handle('settings:read', () => readSettings());
  ipcMain.handle('settings:save', (_event, settings) => writeSettings(settings));
  ipcMain.handle('library:watch', (_event, rootPath) => watchLibrary(rootPath));
  ipcMain.on('reports:log', (_event, payload = {}) => {
    logDiagnostic(payload.event, payload.details, payload.level, 'renderer');
  });
  ipcMain.handle('reports:info', () => ({ directory: REPORT_DIRECTORY(), file: LOG_FILE(), sessionId: diagnosticSessionId }));
  ipcMain.handle('reports:open-folder', async () => {
    fs.mkdirSync(REPORT_DIRECTORY(), { recursive: true });
    const error = await shell.openPath(REPORT_DIRECTORY());
    logDiagnostic('reports.folder-opened', { ok: !error, error: error || '' }, error ? 'warn' : 'info');
    return { ok: !error, error: error || '', directory: REPORT_DIRECTORY() };
  });
  ipcMain.handle('library:cache-read', async (_event, rootPath) => readLibrarySnapshot(rootPath));
  ipcMain.handle('library:refresh-changes', async (_event, rootPath, changes) => refreshLibraryChanges(rootPath, changes));
  ipcMain.handle('library:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return result.canceled ? '' : result.filePaths[0];
  });
  ipcMain.handle('background:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS.map((item) => item.slice(1)) }]
    });
    return result.canceled ? '' : result.filePaths[0];
  });
  ipcMain.handle('profile:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Profile pictures', extensions: IMAGE_EXTENSIONS.map((item) => item.slice(1)) }]
    });
    return result.canceled ? '' : result.filePaths[0];
  });
  ipcMain.handle('playlist:choose-artwork', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Playlist artwork', extensions: IMAGE_EXTENSIONS.map((item) => item.slice(1)) }]
    });
    return result.canceled ? '' : result.filePaths[0];
  });
  ipcMain.handle('playlist:create', (_event, payload) => createPlaylist(payload));
  ipcMain.handle('playlist:delete', (_event, payload) => deletePlaylist(payload));
  ipcMain.handle('playlist:edit', (_event, payload) => editPlaylist(payload));
  ipcMain.handle('playlist:reorder', (_event, payload) => reorderPlaylist(payload));
  ipcMain.handle('queue:export', async (_event, tracks = []) => {
    const validTracks = (Array.isArray(tracks) ? tracks : []).filter((track) => track?.path && fs.existsSync(track.path));
    if (!validTracks.length) return { ok: false, cancelled: false, error: 'Queue is empty' };
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Export queue', defaultPath: 'Lyra Queue.m3u8', filters: [{ name: 'M3U playlist', extensions: ['m3u8', 'm3u'] }] });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    const lines = ['#EXTM3U'];
    for (const track of validTracks) {
      lines.push(`#EXTINF:${Math.round(Number(track.duration || 0))},${String(track.artist || 'Unknown artist')} - ${String(track.title || path.basename(track.path))}`);
      lines.push(path.resolve(track.path));
    }
    await fsp.writeFile(result.filePath, `${lines.join('\n')}\n`, 'utf8');
    return { ok: true, filePath: result.filePath };
  });
  ipcMain.handle('shell:reveal', (_event, targetPath) => {
    const requestedPath = String(targetPath || '').trim();
    if (!requestedPath) return false;
    const resolvedPath = path.resolve(requestedPath);
    if (!fs.existsSync(resolvedPath)) return false;
    const libraryRoot = String(readSettings().libraryPath || '').trim();
    if (libraryRoot && !isPathInside(libraryRoot, resolvedPath, true)) {
      logDiagnostic('shell.reveal-rejected', { reason: 'outside-library' }, 'warn');
      return false;
    }
    shell.showItemInFolder(resolvedPath);
    return true;
  });
  ipcMain.handle('library:scan', async (event, rootPath, clientRequestId = null) => {
    if (activeScanToken) activeScanToken.cancelled = true;
    const scanToken = { id: crypto.randomUUID(), clientRequestId, rootPath: String(rootPath || ''), cancelled: false };
    activeScanToken = scanToken;
    const scanStartedAt = Date.now();
    logDiagnostic('library.scan-started', { clientRequestId, rootPath: String(rootPath || '') });
    let lastProgressSentAt = 0;
    let lastLoggedProgressStage = '';
    let lastLoggedProgressBucket = -1;
    let pendingProgress = null;
    let progressTimer = null;
    const sendProgress = (progress) => {
      lastProgressSentAt = Date.now();
      pendingProgress = null;
      event.sender.send('library:progress', { ...progress, scanId: scanToken.clientRequestId || null });
    };
    const onProgress = (progress) => {
      const progressStage = String(progress?.stage || 'unknown');
      const progressBucket = Math.floor(Number(progress?.percent || 0) / 10);
      if (progressStage !== lastLoggedProgressStage || progressBucket > lastLoggedProgressBucket) {
        lastLoggedProgressStage = progressStage;
        lastLoggedProgressBucket = progressBucket;
        logDiagnostic('library.scan-progress', {
          clientRequestId,
          stage: progressStage,
          percent: Number(progress?.percent || 0),
          processed: Number(progress?.processed || 0),
          total: Number(progress?.total || 0),
          folders: Number(progress?.folders || 0),
          tracks: Number(progress?.tracks || 0)
        });
      }
      const force = ['validate', 'folders', 'index', 'finalize', 'complete', 'error'].includes(progress?.stage);
      const now = Date.now();
      if (force) {
        if (progressTimer) clearTimeout(progressTimer);
        progressTimer = null;
        sendProgress(progress);
        return;
      }
      pendingProgress = progress;
      const wait = Math.max(0, 80 - (now - lastProgressSentAt));
      if (wait === 0) {
        if (progressTimer) clearTimeout(progressTimer);
        progressTimer = null;
        sendProgress(progress);
      } else if (!progressTimer) {
        progressTimer = setTimeout(() => {
          progressTimer = null;
          if (pendingProgress) sendProgress(pendingProgress);
        }, wait);
      }
    };
    try {
      const result = await scanLibrary(rootPath, onProgress, scanToken);
      if (activeScanToken !== scanToken) throw new ScanCancelledError();
      logDiagnostic('library.scan-completed', { clientRequestId, durationMs: Date.now() - scanStartedAt, ok: Boolean(result?.ok), folders: result?.folderCount || 0, tracks: result?.trackCount || 0 });
      return result;
    } catch (error) {
      if (error?.code === 'SCAN_CANCELLED') {
        logDiagnostic('library.scan-cancelled', { clientRequestId, durationMs: Date.now() - scanStartedAt }, 'warn');
        return { cancelled: true, rootPath: String(rootPath || '') };
      }
      notifyRendererError(error, 'scan-failed');
      event.sender.send('library:progress', { stage: 'error', label: 'Scan stopped safely', detail: error.message || 'Unknown scan error', percent: 0, processed: 0, total: 0, folders: 0, tracks: 0, timestamp: Date.now(), scanId: scanToken.clientRequestId || null });
      return { rootPath: String(rootPath || ''), ok: false, error: error.message || 'scan-failed', likedSongs: [], likedSongsArtworkUrl: '', folders: [], folderCount: 0, trackCount: 0, scannedAt: Date.now() };
    } finally {
      if (activeScanToken === scanToken) activeScanToken = null;
    }
  });
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { isQuitting = true; stopLibraryWatcher(); logDiagnostic('session.ending', { uptimeSeconds: Math.round(process.uptime()) }); });
