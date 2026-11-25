export const loaders = ['fabric', 'forge', 'neoforge', 'quilt'] as const
export type Loader = typeof loaders[number]
export type GameLoader = Loader | 'vanilla'
export const loaderName: Record<GameLoader, string> = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', vanilla: 'Без модов' }

export function webUrl(value: string, base?: string) {
  try {
    if (typeof value !== 'string' || !value.trim()) return undefined
    const url = new URL(value, base)
    if (['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password && !url.port) return url
  } catch { /* Malformed link. */ }
}

export interface ProfileInput {
  name: string; directory: string; game: string; loader: GameLoader; loaderVersion: string
  launcher?: { nickname?: string | null; heapMiB?: number; installed?: boolean }
}
export interface Profile extends ProfileInput { id: string; updated: number }
export interface ProfileSettings { name: string; heapMiB?: number; nickname?: string | null }
export const nicknamePattern = '[A-Za-z0-9_]{3,16}'
const nicknameRule = new RegExp('^' + nicknamePattern + '$')
export const validNickname = (value: unknown): value is string => typeof value === 'string' && value === value.trim() && nicknameRule.test(value)
export const gameMemory = { min: 1024, step: 512, default: 3072 }
export type LauncherLoader = 'vanilla' | 'fabric' | 'forge'
export interface LauncherRelease { id: string; current: boolean }
export interface LauncherLoaderVersion { id: string; recommended: boolean }
export interface LauncherDraft {
  name: string; nickname: string; game: string; loader: LauncherLoader; loaderVersion: string
}
export interface GameLaunchState {
  status: 'idle' | 'preparing' | 'ready' | 'running' | 'finished' | 'cancelled' | 'failed'
  intent?: 'install' | 'launch'
  message: string; total: number; ready: number; bytes: number
  profileId?: string; logProfileId?: string; pid?: number
}
export interface LocalPack { name: string; size?: number }
export interface ShaderPack extends LocalPack { projectId?: string }
export type ArchiveKind = 'resourcepack' | 'datapack' | 'world'
export interface ArchiveProject extends ShaderProject { url: string }
export type PackFolder = 'shaderpacks' | 'resourcepacks'
export const shaderStyles = ['atmosphere', 'fantasy', 'realistic', 'vanilla-like'] as const
export type ShaderStyle = typeof shaderStyles[number]
export interface ShaderProject { id: string; slug: string; name: string; author: string; summary: string; image?: string }
export type ShaderRecommendation =
  | { kind: 'install'; name: string; projectId: string; versionId: string; version: string }
  | { kind: 'external'; name: string; url: string }
export interface OptiFineRelease { game: string; file: string; version: string; forge?: string; preview: boolean }
export interface Candidate { directory: string; label: string; versions: { game: string; loader?: Loader; loaderVersion?: string }[] }
export interface Requirement { id: string; range?: string; optional?: boolean; conflict?: boolean }
export interface LocalMod {
  file: string; id: string; ids: string[]; name: string; version: string; size: number; modified: number; enabled: boolean
  loader?: Loader; requirements: Requirement[]; sha512: string; author?: string; description?: string; icon?: string
  projectId?: string; versionId?: string; issue?: string
  bundled?: Record<string, string>
}
export interface CatalogQuery {
  query: string; game: string; loader: string; category: string; sort: 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated'
  side: '' | 'client' | 'server'; offset: number; source?: ContentSource
}
export const contentNames = { modrinth: 'Modrinth', curseforge: 'CurseForge', github: 'GitHub Releases', local: 'Локальные файлы' } as const
export type ContentSource = keyof typeof contentNames
export function contentSource(id?: string): ContentSource {
  return id?.startsWith('cf_') ? 'curseforge' : id?.startsWith('gh_') ? 'github' : id?.startsWith('jar_') || !id ? 'local' : 'modrinth'
}
export interface CatalogMod {
  id: string; slug: string; name: string; summary: string; author: string; downloads: number; icon?: string
  categories: string[]; games: string[]; loaders: Loader[]; babric?: boolean
  url?: string
}
export interface RemoteDependency { projectId?: string; versionId?: string; fileName?: string; modId?: string; range?: string; kind: 'required' | 'optional' | 'incompatible' | 'embedded' }
export interface RemoteVersion {
  id: string; projectId: string; name: string; number: string; date: string; changelog: string
  games: string[]; loaders: string[]; type: string; dependencies: RemoteDependency[]
  file?: { name: string; url: string; size: number; sha512?: string; sha256?: string; sha1?: string; md5?: string; pageUrl?: string; localPath?: string; modId?: string; jarVersion?: string; gameRange?: string }
}
export interface ProjectDetail extends CatalogMod {
  body: string; gallery: { url: string; title: string }[]; versions: RemoteVersion[]
  supportedGames?: { loader: string; games: string[] }[]
  sources?: { id: string; name: ContentSource; automatic: boolean }[]
}
export interface PlanItem {
  key: string; name: string; version: string; filename?: string; size: number
  status: 'download' | 'waiting' | 'installed' | 'enable' | 'optional' | 'blocked'; reason?: string; projectId?: string; versionId?: string; pageUrl?: string
  replaces?: { filename: string; version: string; enabled: boolean }
  inputIndex?: number; loader?: Loader
}
export interface Plan { id: string; profile: Profile; items: PlanItem[]; blockers: string[]; bytes: number }
export interface ExplorerImport { id: string; files: string[] }
export interface ExplorerIntegration { available: boolean; enabled: boolean }
export interface AppUpdateState {
  current: string
  status: 'disabled' | 'idle' | 'checking' | 'current' | 'no-release' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'
  version?: string; title?: string; notes?: string; deferred?: boolean
  transferred?: number; total?: number; speed?: number; percent?: number; error?: string
  retry?: 'check' | 'download' | 'install'
}
export type AppUpdateAction = 'check' | 'download' | 'later' | 'install'
export interface Transfer {
  key: string; jobId: string; name: string; received: number; size: number; speed: number; updating?: boolean
  status: 'queued' | 'waiting' | 'downloading' | 'verified' | 'installed' | 'cancelled' | 'failed'; error?: string
  source?: ContentSource; pageUrl?: string; candidate?: string; profileName?: string; filename?: string
}
export interface Activity { title: string; date: number }
export interface ModUpdate {
  projectId: string; versionId: string; installedVersionId: string; name: string; installed: string; available: string; date: string; changelog: string; type: string
}
export interface ModUpdateCheck { updates: ModUpdate[]; checked: number; unrecognized: number }
export type Theme = 'light' | 'dark'
export const interfaceScales = [75, 85, 90, 100, 110, 125, 150] as const
export type InterfaceScale = typeof interfaceScales[number]
export const validInterfaceScale = (value: unknown): value is InterfaceScale => interfaceScales.some(scale => scale === value)
export function launchNickname(profile: Profile, globalNickname: string) {
  if (!profile.launcher) return undefined
  return profile.launcher.nickname ?? globalNickname
}
export interface Settings { scale: InterfaceScale; nickname: string; layout: 'grid' | 'list'; parallel: number; notify: boolean; theme: Theme }
export const defaultSettings: Settings = { layout: 'grid', parallel: 3, notify: true, theme: 'light', scale: 100, nickname: 'Player' }
export interface AppState { profiles: Profile[]; activeId: string | null; settings: Settings }

export interface ModKitApi {
  readonly initialTheme: Theme
  state(): Promise<AppState>
  discover(): Promise<Candidate[]>
  browse(): Promise<Candidate | null>
  saveProfile(data: ProfileInput): Promise<AppState>
  selectProfile(id: string): Promise<AppState>
  updateProfileSettings(id: string, settings: ProfileSettings): Promise<Profile>
  gameMemoryLimit(): Promise<number>
  removeProfile(id: string): Promise<AppState>
  gameVersions(): Promise<LauncherRelease[]>
  gameLoaderVersions(game: string, loader: LauncherLoader): Promise<LauncherLoaderVersion[]>
  createGameProfile(data: LauncherDraft): Promise<AppState>
  gameStatus(): Promise<GameLaunchState>
  launchGame(id: string): Promise<void>
  installGame(id: string): Promise<void>
  cancelGame(): Promise<void>
  openGameLog(id: string): Promise<void>
  openGameFolder(id: string): Promise<void>
  setSettings(data: Partial<Settings>): Promise<AppState>
  clearCache(): Promise<void>
  mods(id: string): Promise<LocalMod[]>
  identify(id: string): Promise<LocalMod[]>
  modUpdates(id: string, refresh?: boolean): Promise<ModUpdateCheck>
  activity(id: string): Promise<Activity[]>
  search(data: CatalogQuery): Promise<{ items: CatalogMod[]; total: number }>
  contentSources(): Promise<ContentSource[]>
  addLocalContent(): Promise<number>
  tags(): Promise<{ games: string[]; categories: string[] }>
  detail(id: string, profileId?: string): Promise<ProjectDetail>
  plan(profileId: string, projectId: string, versionId: string | undefined, optional: string[], installedVersionId?: string): Promise<Plan>
  install(id: string, allowRunning: boolean): Promise<void>
  transfers(): Promise<Transfer[]>
  cancel(job: string): Promise<void>
  retry(job: string, allowRunning: boolean): Promise<void>
  watchDownloads(enabled: boolean): Promise<void>
  supplyDownload(key: string, pick: boolean): Promise<void>
  explorerIntegration(): Promise<ExplorerIntegration>
  appUpdateState(): Promise<AppUpdateState>
  appUpdate(action: AppUpdateAction): Promise<void>
  setExplorerIntegration(enabled: boolean): Promise<ExplorerIntegration>
  explorerImports(): Promise<ExplorerImport[]>
  planExplorerImport(batch: string, profile: string, include: number[]): Promise<Plan>
  closeExplorerImport(batch: string): Promise<void>
  modify(id: string, files: string[], action: 'enable' | 'disable' | 'remove', allowRunning: boolean): Promise<void>
  manual(id: string, allowRunning: boolean, dependency?: { file: string; id: string }): Promise<number>
  showFolder(id: string, file?: string): Promise<void>
  localPacks(id: string, folder: PackFolder): Promise<LocalPack[]>
  openResourceFolder(id: string): Promise<void>
  archiveWorlds(id: string): Promise<string[]>
  archiveSearch(id: string, kind: ArchiveKind, query: string, offset: number, sort: CatalogQuery['sort'], compatible: boolean): Promise<{ items: ArchiveProject[]; total: number; available: boolean }>
  archiveInstall(id: string, kind: ArchiveKind, project: string, world: string): Promise<{ name: string } | { url: string }>
  archiveImport(id: string, kind: ArchiveKind, world: string): Promise<string | null>
  shaderRecommendation(id: string): Promise<ShaderRecommendation | null>
  optiFineRelease(id: string): Promise<{ release: OptiFineRelease | null; listedForge: string[] }>
  downloadOptiFine(id: string, filename: string): Promise<string>
  shaderPacks(id: string): Promise<ShaderPack[]>
  importShaderPack(id: string): Promise<boolean>
  openShaderFolder(id: string): Promise<void>
  searchShaders(id: string, query: string, offset: number, sort: CatalogQuery['sort'], style: ShaderStyle | ''): Promise<{ items: ShaderProject[]; total: number }>
  installShader(id: string, project: string): Promise<ShaderPack>
  external(url: string): Promise<void>
  window(action: 'minimize' | 'maximize' | 'close'): void
  onTransfers(callback: (items: Transfer[]) => void): () => void
  onMods(callback: (id: string) => void): () => void
  onGameStatus(callback: (status: GameLaunchState) => void): () => void
  onExplorerImports(callback: (batches: ExplorerImport[]) => void): () => void
  onInterfaceScale(listener: (scale: InterfaceScale) => void): () => void
  onAppUpdate(callback: (state: AppUpdateState) => void): () => void
}
