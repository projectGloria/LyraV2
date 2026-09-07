const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spotfck', {
  readSettings: () => ipcRenderer.invoke('settings:read'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  reportEvent: (event, details = {}, level = 'info') => ipcRenderer.send('reports:log', { event, details, level }),
  getReportInfo: () => ipcRenderer.invoke('reports:info'),
  openReportFolder: () => ipcRenderer.invoke('reports:open-folder'),
  chooseLibrary: () => ipcRenderer.invoke('library:choose'),
  readLibraryCache: (rootPath) => ipcRenderer.invoke('library:cache-read', rootPath),
  refreshLibraryChanges: (rootPath, changes) => ipcRenderer.invoke('library:refresh-changes', rootPath, changes),
  chooseBackground: () => ipcRenderer.invoke('background:choose'),
  chooseProfilePicture: () => ipcRenderer.invoke('profile:choose'),
  choosePlaylistArtwork: () => ipcRenderer.invoke('playlist:choose-artwork'),
  createPlaylist: (payload) => ipcRenderer.invoke('playlist:create', payload),
  deletePlaylist: (payload) => ipcRenderer.invoke('playlist:delete', payload),
  editPlaylist: (payload) => ipcRenderer.invoke('playlist:edit', payload),
  reorderPlaylist: (payload) => ipcRenderer.invoke('playlist:reorder', payload),
  exportQueue: (tracks) => ipcRenderer.invoke('queue:export', tracks),
  revealInExplorer: (targetPath) => ipcRenderer.invoke('shell:reveal', targetPath),
  scanLibrary: (rootPath, requestId = null) => ipcRenderer.invoke('library:scan', rootPath, requestId),
  watchLibrary: (rootPath) => ipcRenderer.invoke('library:watch', rootPath),
  onLibraryProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('library:progress', listener);
    return () => ipcRenderer.removeListener('library:progress', listener);
  },
  onLibraryChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('library:changed', listener);
    return () => ipcRenderer.removeListener('library:changed', listener);
  },
  onAppError: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:error', listener);
    return () => ipcRenderer.removeListener('app:error', listener);
  },
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close')
});
