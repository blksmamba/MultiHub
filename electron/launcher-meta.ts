import { release } from 'node:os'
import type { LauncherLoader, LauncherRelease } from '../src/shared'
import type { Store } from './db'
import { jsonFile, download, localPath, metadata, type RemoteFile } from './launcher-files'

const mojang = 'https://piston-meta.mojang.com'
const fabric = 'https://meta.fabricmc.net/v2'
const forge = 'https://maven.minecraftforge.net'
const forgeIndex = 'https://files.minecraftforge.net'
export const versionsManifest = mojang + '/mc/game/version_manifest_v2.json'
export const javaManifest = mojang + '/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json'
export const minecraftAssets = 'https://resources.download.minecraft.net/'
const validVersion = /^[a-z0-9][a-z0-9+_.-]{0,79}$/i
export const validId = (value: unknown): value is string => typeof value === 'string' && validVersion.test(value) && !value.endsWith('.')

interface IndexedRelease extends RemoteFile { id: string; type: string; releaseTime: string }
interface GameIndex { latest: { release: string }; versions: IndexedRelease[] }
export interface LaunchRule { action: 'allow' | 'disallow'; os?: { name?: string; arch?: string; version?: string }; features?: Record<string, boolean> }
type Argument = string | { value: string | string[]; rules: LaunchRule[] }
interface Artifact extends RemoteFile { path?: string }
export interface GameLibrary {
  name: string; url?: string; rules?: LaunchRule[]; natives?: { windows?: string }; extract?: { exclude: string[] }
  downloads?: { artifact?: Artifact; classifiers?: Record<string, Artifact> }
}
export interface VersionProfile {
  id: string; inheritsFrom?: string; mainClass: string; type?: string; assets?: string
  assetIndex?: RemoteFile & { id: string }; javaVersion?: { component: string; majorVersion: number }
  downloads?: { client: RemoteFile }; arguments?: { jvm?: Argument[]; game?: Argument[] }; libraries: GameLibrary[]
  logging?: { client?: { argument: string; file: RemoteFile & { id: string } } }
}
export interface JavaRelease { manifest: RemoteFile; version: { name: string }; availability?: { progress: number } }
export interface JavaIndex { [platform: string]: { [component: string]: JavaRelease[] } }
export interface JavaFiles { files: Record<string, { type: 'file' | 'directory' | 'link'; downloads?: { raw: RemoteFile }; target?: string }> }

export function supportedRelease(version: string) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version)
  return match && (Number(match[1]) >= 26 || match[1] === '1' && Number(match[2]) >= 16)
}

export class LauncherMetadata {
  constructor(private readonly store: Store) {}

  async cached<T>(url: string, signal: AbortSignal, ttl = 60 * 60 * 1000): Promise<T> {
    const entry = this.store.cached<T>('launcher:' + url)
    if (entry && Date.now() - entry.date < ttl) return entry.value
    try {
      const value = await metadata<T>(url, signal)
      this.store.cache('launcher:' + url, value)
      return value
    } catch (error) {
      signal.throwIfAborted()
      if (entry) return entry.value
      throw error
    }
  }

  private index(signal: AbortSignal) {
    return this.cached<GameIndex>(versionsManifest, signal)
  }

  async releases(signal: AbortSignal): Promise<LauncherRelease[]> {
    const index = await this.index(signal)
    return index.versions.filter(version => version.type === 'release' && supportedRelease(version.id))
      .map(version => ({ id: version.id, current: version.id === index.latest.release }))
  }

  async vanilla(game: string, directory: string, signal: AbortSignal) {
    const index = await this.index(signal)
    const entry = index.versions.find(item => item.type === 'release' && item.id === game && supportedRelease(item.id))
    if (!entry) throw new Error('Версия Minecraft не найдена.')
    const target = localPath(directory, 'versions/' + game + '/' + game + '.json')
    await download({ ...entry, target }, signal)
    return jsonFile<VersionProfile>(target)
  }

  async loaders(game: string, loader: LauncherLoader, signal: AbortSignal) {
    if (!validId(game) || !supportedRelease(game)) throw new Error('Версия Minecraft не поддерживается.')
    if (loader === 'vanilla') return []
    if (loader === 'fabric') {
      const list = await this.cached<{ loader: { version: string; stable: boolean } }[]>(fabric + '/versions/loader/' + game, signal)
      const recommended = (list.find(item => item.loader.stable) ?? list[0])?.loader.version
      return list.filter(item => validId(item.loader.version)).map(item => ({ id: item.loader.version, recommended: item.loader.version === recommended }))
    }
    const [index, offers] = await Promise.all([
      this.cached<Record<string, string[]>>(forgeIndex + '/net/minecraftforge/forge/maven-metadata.json', signal),
      this.cached<{ promos: Record<string, string> }>(forgeIndex + '/net/minecraftforge/forge/promotions_slim.json', signal),
    ])
    const versionList = (index[game] ?? []).map(entry => entry.slice(game.length + 1)).filter(validId).reverse()
    const recommended = offers.promos[game + '-recommended'] ?? offers.promos[game + '-latest'] ?? versionList[0]
    return versionList.map(id => ({ id, recommended: id === recommended }))
  }

  fabric(game: string, loader: string, signal: AbortSignal) {
    return this.cached<VersionProfile>(fabric + '/versions/loader/' + game + '/' + loader + '/profile/json', signal, 86400000)
  }
}

export function forgeArtifact(game: string, loader: string) {
  const coordinate = game + '-' + loader
  return { id: game + '-forge-' + loader, url: forge + '/net/minecraftforge/forge/' + coordinate + '/forge-' + coordinate + '-installer.jar' }
}

export function rulesAllow(rules: LaunchRule[] | undefined) {
  if (!rules?.length) return true
  let allowed = false
  for (const rule of rules) {
    if (rule.os?.name && rule.os.name !== 'windows' || rule.os?.arch && !/^(amd64|x86_64|x64)$/.test(rule.os.arch)) continue
    if (rule.os?.version && !new RegExp(rule.os.version).test(release())) continue
    if (rule.features && Object.values(rule.features).some(Boolean)) continue
    allowed = rule.action === 'allow'
  }
  return allowed
}

export function resolveArguments(args: Argument[] = [], values: Record<string, string>) {
  return args.flatMap(argument => typeof argument === 'string' ? [argument] : rulesAllow(argument.rules) ? [argument.value].flat() : [])
    .map(value => value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
      if (!Object.hasOwn(values, key)) throw new Error('Параметр запуска Minecraft не поддерживается: ' + key)
      return values[key]
    }))
}

export function libraryKey(name: string) {
  const [group, artifact, , classifier] = name.split(':')
  return [group, artifact, classifier].join(':')
}

function mavenPath(name: string) {
  const [group, artifact, version, classifier] = name.split(':')
  if (![group, artifact, version].every(validId) || classifier && !validId(classifier)) throw new Error('Некорректное имя библиотеки Minecraft.')
  return group.replace(/\./g, '/') + '/' + artifact + '/' + version + '/' + artifact + '-' + version + (classifier ? '-' + classifier : '') + '.jar'
}

export function libraryFiles(directory: string, libraries: GameLibrary[]) {
  const unique = [...new Map(libraries.filter(item => rulesAllow(item.rules)).map(item => [libraryKey(item.name), item])).values()]
  const artifacts = []
  const natives = []
  for (const item of unique) {
    const artifact = item.downloads?.artifact ?? (!item.downloads ? {
      url: new URL(mavenPath(item.name), item.url || 'https://libraries.minecraft.net/').href, path: mavenPath(item.name),
    } : undefined)
    if (artifact) artifacts.push({ ...artifact, target: localPath(directory, artifact.path ?? mavenPath(item.name)) })
    const classifier = item.natives?.windows?.replace('${arch}', '64')
    const native = classifier && item.downloads?.classifiers?.[classifier]
    if (native) {
      if (!native.path) throw new Error('В манифесте отсутствует путь к нативной библиотеке.')
      natives.push({ file: { ...native, target: localPath(directory, native.path) }, excludes: item.extract?.exclude ?? ['META-INF/'] })
    }
  }
  return { artifacts, natives }
}
