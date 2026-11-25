import { contextBridge, ipcRenderer } from 'electron'
import type { AppUpdateState, ExplorerImport, GameLaunchState, ModKitApi, Transfer } from '../src/shared'

const invoke = <T>(name: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke('modkit:' + name, ...args)

const api: ModKitApi = {
  initialTheme: process.argv.includes('--modkit-theme=dark') ? 'dark' : 'light',
  state: () => invoke('state'),
  appUpdateState: () => invoke('app-update-state'),
  appUpdate: action => invoke('app-update', action),
  discover: () => invoke('discover'),
  browse: () => invoke('browse'),
  saveProfile: input => invoke('save-profile', input),
  selectProfile: id => invoke('select-profile', id),
  updateProfileSettings: (id, settings) => invoke('update-profile-settings', id, settings),
  gameMemoryLimit: () => invoke('game-memory-limit'),
  removeProfile: id => invoke('remove-profile', id),
  gameVersions: () => invoke('game-versions'),
  gameLoaderVersions: (game, loader) => invoke('game-loader-versions', game, loader),
  createGameProfile: data => invoke('create-game-profile', data),
  gameStatus: () => invoke('game-status'),
  launchGame: id => invoke('launch-game', id),
  installGame: id => invoke('install-game', id),
  cancelGame: () => invoke('cancel-game'),
  openGameLog: id => invoke('open-game-log', id),
  openGameFolder: id => invoke('open-game-folder', id),
  setSettings: settings => invoke('set-settings', settings),
  clearCache: () => invoke('clear-cache'),
  mods: id => invoke('mods', id),
  identify: id => invoke('identify', id),
  modUpdates: (id, refresh) => invoke('mod-updates', id, refresh),
  activity: id => invoke('activity', id),
  tags: () => invoke('tags'),
  search: query => invoke('search', query),
  contentSources: () => invoke('content-sources'),
  addLocalContent: () => invoke('add-local-content'),
  detail: (id, profileId) => invoke('detail', id, profileId),
  plan: (profileId, projectId, versionId, optional, installedVersionId) => invoke('plan', profileId, projectId, versionId, optional, installedVersionId),
  install: (id, allowRunning) => invoke('install', id, allowRunning),
  transfers: () => invoke('transfers'),
  cancel: id => invoke('cancel', id),
  retry: (id, allowRunning) => invoke('retry', id, allowRunning),
  watchDownloads: enabled => invoke('watch-downloads', enabled),
  supplyDownload: (key, pick) => invoke('supply-download', key, pick),
  explorerIntegration: () => invoke('explorer-integration'),
  setExplorerIntegration: enabled => invoke('set-explorer-integration', enabled),
  explorerImports: () => invoke('explorer-imports'),
  planExplorerImport: (batch, profile, include) => invoke('plan-explorer-import', batch, profile, include),
  closeExplorerImport: batch => invoke('close-explorer-import', batch),
  modify: (id, files, action, allowRunning) => invoke('modify', id, files, action, allowRunning),
  manual: (id, allowRunning, dependency) => invoke('manual', id, allowRunning, dependency),
  showFolder: (id, file) => invoke('show-folder', id, file),
  localPacks: (id, folder) => invoke('local-packs', id, folder),
  openResourceFolder: id => invoke('open-resource-folder', id),
  shaderRecommendation: id => invoke('shader-recommendation', id),
  optiFineRelease: id => invoke('optifine-release', id),
  downloadOptiFine: (id, filename) => invoke('download-optifine', id, filename),
  shaderPacks: id => invoke('shader-packs', id),
  searchShaders: (id, query, offset, sort, style) => invoke('search-shaders', id, query, offset, sort, style),
  installShader: (id, project) => invoke('install-shader', id, project),
  importShaderPack: id => invoke('import-shader-pack', id),
  openShaderFolder: id => invoke('open-shader-folder', id),
  external: url => invoke('external', url),
  window: action => { void invoke('window', action) },
  onTransfers: callback => {
    const listener = (_event: Electron.IpcRendererEvent, items: Transfer[]) => callback(items)
    ipcRenderer.on('modkit:transfers-changed', listener)
    return () => { ipcRenderer.removeListener('modkit:transfers-changed', listener) }
  },
  onMods: callback => {
    const listener = (_event: Electron.IpcRendererEvent, profile: string) => callback(profile)
    ipcRenderer.on('modkit:mods-changed', listener)
    return () => { ipcRenderer.removeListener('modkit:mods-changed', listener) }
  },
  onGameStatus: callback => {
    const listener = (_event: Electron.IpcRendererEvent, status: GameLaunchState) => callback(status)
    ipcRenderer.on('modkit:game-status', listener)
    return () => { ipcRenderer.removeListener('modkit:game-status', listener) }
  },
  onExplorerImports: callback => {
    const listener = (_event: Electron.IpcRendererEvent, batches: ExplorerImport[]) => callback(batches)
    ipcRenderer.on('modkit:explorer-imports', listener)
    return () => { ipcRenderer.removeListener('modkit:explorer-imports', listener) }
  },
  onAppUpdate: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppUpdateState) => callback(state)
    ipcRenderer.on('modkit:app-update', listener)
    return () => { ipcRenderer.removeListener('modkit:app-update', listener) }
  },
}
contextBridge.exposeInMainWorld('modkit', api)
