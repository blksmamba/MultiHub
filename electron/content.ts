import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { copyFile, link, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { profileIssue, satisfies } from '../src/compatibility'
import { contentSource, loaders, type CatalogMod, type CatalogQuery, type ContentSource, type Loader, type Profile, type ProjectDetail, type RemoteVersion } from '../src/shared'
import type { Store } from './db'
import { checksum, inspectJar, isJar } from './jars'
import { compatible, userAgent, type CatalogProvider, type Modrinth } from './provider'

// Use author-owned repository and platform project IDs. Display names are only for searching.
const identities = [
  { slug: 'sodium', id: 'AANobbMI', cf: 394468, repo: 'CaffeineMC/sodium', mod: 'sodium', name: 'Sodium' },
  { slug: 'lithium', id: 'gvQqBUqZ', cf: 360438, repo: 'CaffeineMC/lithium', mod: 'lithium', name: 'Lithium' },
  { slug: 'iris', id: 'YL57xq9U', cf: 455508, repo: 'IrisShaders/Iris', mod: 'iris', name: 'Iris Shaders' },
  { slug: 'fabric-api', id: 'P7dR8mSH', cf: 306612, repo: 'FabricMC/fabric', mod: 'fabric-api', name: 'Fabric API' },
  { slug: 'stereocraft-stereoscopic-3d', id: 'jZrDX6R1', cf: 1547525, repo: 'MitchellMarx/StereoCraft', mod: 'stereoscopic', name: 'StereoCraft' },
]
type Identity = typeof identities[number]
const identityKeys = (entry: Identity) => [entry.id, entry.slug, 'cf_' + entry.cf, 'gh_' + entry.slug]
const identity = (id: string) => identities.find(entry => identityKeys(entry).includes(id))
const loaderCodes: Record<string, string> = { forge: '1', fabric: '4', quilt: '5', neoforge: '6' }
const gameNumber = /^\d+\.\d+(?:\.\d+)?$/

class CachedApi {
  private requests = new Map<string, Promise<any>>()
  private retryAt = 0
  private readonly namespace: string
  constructor(private store: Store, private origin: string, private headers: Record<string, string>, private name: string) {
    const credential = headers['x-api-key'] ?? headers.Authorization
    this.namespace = credential ? origin + ':' + createHash('sha256').update(credential).digest('hex') : origin
  }

  async get(path: string, body?: unknown, refresh = false): Promise<any> {
    const key = this.namespace + path + (body === undefined ? '' : ':' + JSON.stringify(body))
    const cached = this.store.cached<any>(key)
    if (!refresh && cached && Date.now() - cached.date < 15 * 60000) return cached.value
    const existing = this.requests.get(key)
    if (existing) return existing
    const request = (async () => {
      try {
        if (Date.now() < this.retryAt) throw new Error(this.name + ' ограничил частоту запросов.')
        const response = await fetch(this.origin + path, {
          method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
          headers: { 'User-Agent': userAgent, Accept: 'application/json', ...this.headers,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          redirect: 'error', signal: AbortSignal.timeout(15000),
        })
        if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' ||
          response.status === 403 && response.headers.has('retry-after')) {
          const retry = response.headers.get('retry-after')
          this.retryAt = Math.max(Date.now() + 60000, Number(response.headers.get('x-ratelimit-reset')) * 1000,
            retry && (Number(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry)) || 0)
        }
        if (!response.ok) {
          await response.body?.cancel()
          if (response.status === 401 || response.status === 403 && !this.retryAt)
            throw new Error(this.name + ' отклонил доступ к API.', { cause: 'authorization' })
          throw new Error(this.name + ' вернул HTTP ' + response.status + '.')
        }
        const value = await response.json()
        this.store.cache(key, value)
        return value
      } catch (error) { if (cached && !(error instanceof Error && error.cause === 'authorization')) return cached.value; throw error }
    })()
    this.requests.set(key, request)
    try { return await request } finally { this.requests.delete(key) }
  }
}

type SearchResult = { items: CatalogMod[]; total: number }
const empty: SearchResult = { items: [], total: 0 }
type Adapter = Omit<CatalogProvider, 'identify'> & { identify?: CatalogProvider['identify'] }

function cfNumber(id: string) {
  if (!/^cf_\d+$/.test(id)) throw new Error('Некорректный идентификатор CurseForge.')
  return id.slice(3)
}

class CurseForge implements Adapter {
  private api: CachedApi
  private fileBatch = new Map<number, { resolve: (file: any) => void; reject: (error: unknown) => void }[]>()
  constructor(store: Store, key: string) { this.api = new CachedApi(store, 'https://api.curseforge.com/v1', { 'x-api-key': key }, 'CurseForge') }

  async search(query: CatalogQuery) {
    if (query.side || query.category) return empty
    const params = new URLSearchParams({ gameId: '432', classId: '6', searchFilter: query.query, index: String(query.offset), pageSize: '18' })
    if (query.game) {
      params.set('gameVersion', query.game)
      if (loaderCodes[query.loader]) params.set('modLoaderType', loaderCodes[query.loader])
    }
    if (query.sort !== 'relevance') {
      params.set('sortField', { downloads: '6', follows: '2', newest: '11', updated: '3' }[query.sort])
      params.set('sortOrder', 'desc')
    }
    const result = await this.api.get('/mods/search?' + params)
    return { items: result.data.map((item: any) => this.project(item)), total: Math.min(990, result.pagination.totalCount) }
  }

  private project(raw: any): CatalogMod {
    const versions: { gameVersion?: string; modLoader?: number }[] = raw.latestFilesIndexes ?? []
    return { id: 'cf_' + raw.id, slug: raw.slug, name: raw.name, summary: raw.summary,
      author: raw.authors?.map((item: any) => item.name).join(', ') || 'CurseForge', downloads: raw.downloadCount,
      icon: raw.logo?.thumbnailUrl, categories: [], games: [...new Set(versions.flatMap(item => item.gameVersion ? [item.gameVersion] : []))],
      loaders: loaders.filter(loader => versions.some(item => String(item.modLoader) === loaderCodes[loader])), url: this.website(raw.links?.websiteUrl) }
  }

  private website(input: unknown) {
    if (typeof input !== 'string') return undefined
    try {
      const url = new URL(input)
      if (url.protocol === 'https:' && ['curseforge.com', 'www.curseforge.com'].includes(url.hostname) &&
        !url.username && !url.password && !url.port && /^\/minecraft\/mc-mods\/[\w-]+\/?$/i.test(url.pathname))
        return url.origin + url.pathname.replace(/\/$/, '')
    } catch { return undefined }
  }

  private release(raw: any, project: any): RemoteVersion {
    const tags: string[] = raw.gameVersions || []
    const website = this.website(project.links?.websiteUrl)
    return {
      id: 'cf_' + raw.id, projectId: 'cf_' + raw.modId, name: raw.displayName, number: raw.displayName,
      date: raw.fileDate, changelog: '', games: tags.filter(tag => gameNumber.test(tag)),
      loaders: loaders.filter(loader => tags.some(tag => tag.toLowerCase() === loader)),
      type: raw.releaseType === 1 ? 'release' : raw.releaseType === 2 ? 'beta' : 'alpha',
      dependencies: (raw.dependencies ?? []).flatMap((dep: any) => {
        const kind = ({ 1: 'embedded', 2: 'optional', 3: 'required', 5: 'incompatible' } as Record<number, string>)[dep.relationType]
        return kind && Number.isInteger(dep.modId) ? [{ projectId: 'cf_' + dep.modId, kind }] : []
      }),
      file: isJar(raw.fileName) && (website || project.allowModDistribution !== false && raw.downloadUrl) ? {
        name: raw.fileName, url: project.allowModDistribution !== false && raw.isAvailable !== false && typeof raw.downloadUrl === 'string' ? raw.downloadUrl : '',
        size: raw.fileLength, sha1: raw.hashes?.find((item: any) => item.algo === 1)?.value,
        md5: raw.hashes?.find((item: any) => item.algo === 2)?.value,
        pageUrl: website && website + '/files/' + raw.id, modId: identity('cf_' + raw.modId)?.mod,
      } : undefined,
    }
  }

  private async raw(id: string) { return (await this.api.get('/mods/' + cfNumber(id))).data }
  async title(id: string) { return (await this.raw(id)).name as string }
  async version(id: string) {
    const fileId = Number(cfNumber(id))
    const file = await new Promise<any>((resolve, reject) => {
      const pending = this.fileBatch.size
      this.fileBatch.set(fileId, [...(this.fileBatch.get(fileId) ?? []), { resolve, reject }])
      if (!pending) queueMicrotask(() => void this.flushFiles())
    })
    if (!file || 'cf_' + file.id !== id) throw new Error('Файл CurseForge не найден.')
    return this.release(file, await this.raw('cf_' + file.modId))
  }
  private async flushFiles() {
    const batch = this.fileBatch
    this.fileBatch = new Map()
    const ids = [...batch.keys()].sort((a, b) => a - b)
    for (let offset = 0; offset < ids.length; offset += 50) {
      const fileIds = ids.slice(offset, offset + 50)
      try {
        const result = await this.api.get('/mods/files', { fileIds })
        const files = new Map<number, any>(result.data.map((file: any) => [file.id, file]))
        for (const id of fileIds) for (const callback of batch.get(id) ?? []) callback.resolve(files.get(id))
      } catch (error) {
        for (const id of fileIds) for (const callback of batch.get(id) ?? []) callback.reject(error)
      }
    }
  }
  async versions(id: string, profile: Profile, refresh = false) {
    if (!loaderCodes[profile.loader]) return []
    const query = new URLSearchParams({ gameVersion: profile.game, modLoaderType: loaderCodes[profile.loader], pageSize: '50' })
    const [project, result] = await Promise.all([this.raw(id), this.api.get('/mods/' + cfNumber(id) + '/files?' + query, undefined, refresh)])
    return result.data.map((file: any) => this.release(file, project)).filter((entry: RemoteVersion) => compatible(entry, profile))
  }
  async detail(id: string, profile?: Profile): Promise<ProjectDetail> {
    const raw = await this.raw(id)
    const versions = profile ? await this.versions(id, profile) : (await this.api.get('/mods/' + cfNumber(id) + '/files?pageSize=18')).data.map((file: any) => this.release(file, raw))
    return { ...this.project(raw), body: raw.summary, gallery: [], versions }
  }
}

class GitHub implements Adapter {
  private api: CachedApi
  constructor(store: Store, token?: string) {
    this.api = new CachedApi(store, 'https://api.github.com', { Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}) }, 'GitHub')
  }
  private project(entry: Identity): CatalogMod {
    return { id: 'gh_' + entry.slug, slug: entry.slug, name: entry.name, summary: 'Релизы официального репозитория', author: entry.repo.split('/')[0],
      downloads: 0, categories: [], games: [], loaders: [], url: 'https://github.com/' + entry.repo + '/releases' }
  }
  private entry(id: string) {
    const entry = identities.find(item => id === 'gh_' + item.slug)
    if (!entry) throw new Error('Репозиторий автора не подтверждён.')
    return entry
  }
  private async releases(entry: Identity, refresh = false): Promise<RemoteVersion[]> {
    const result = await this.api.get('/repos/' + entry.repo + '/releases?per_page=50', undefined, refresh)
    return result.flatMap((release: any) => release.draft ? [] : (release.assets ?? []).flatMap((asset: any) => {
      if (!isJar(asset.name) || /(?:sources|javadoc|dev|api|slim)\.jar$/i.test(asset.name) ||
        !Number.isSafeInteger(asset.id) || !Number.isSafeInteger(asset.size) || asset.size < 1) return []
      const info = asset.name.slice(0, -4)
      const loader = entry.slug === 'fabric-api' ? ['fabric'] : loaders.filter(item => new RegExp('(?:^|[-_+])' + item + '(?:[-_+]|$)', 'i').test(info))
      const game = /(?:^|[+_-])(?:minecraft|mc)[-_]?(\d+\.\d+(?:\.\d+)?)(?=$|[-_+])/i.exec(info)?.[1] ??
        /\+(\d+\.\d+(?:\.\d+)?)$/.exec(info)?.[1] ??
        (entry.mod === 'stereoscopic' ? /^stereoscopic-(?:fabric|neoforge)-(\d+\.\d+(?:\.\d+)?)-/i.exec(info)?.[1] : undefined)
      const jarVersion = entry.mod === 'stereoscopic' ? /^stereoscopic-(?:fabric|neoforge)-\d+\.\d+(?:\.\d+)?-(.+)$/i.exec(info)?.[1] : undefined
      const url = typeof asset.browser_download_url === 'string' &&
        asset.browser_download_url.toLowerCase().startsWith('https://github.com/' + entry.repo.toLowerCase() + '/releases/download/') ? asset.browser_download_url : ''
      if (!game || !loader.length || !url) return []
      return [{
        id: 'gh_' + entry.slug + '_' + asset.id, projectId: 'gh_' + entry.slug, name: release.name || release.tag_name, number: release.tag_name,
        date: release.published_at, changelog: release.body ?? '', games: [game], loaders: loader,
        type: release.prerelease ? 'beta' : 'release', dependencies: [],
        file: { name: asset.name, size: asset.size, url, sha256: /^sha256:[\da-f]{64}$/i.test(asset.digest ?? '') ? asset.digest.slice(7) : undefined,
          pageUrl: 'https://github.com/' + entry.repo + '/releases/tag/' + encodeURIComponent(release.tag_name), modId: entry.mod, jarVersion },
      }]
    }))
  }
  async search(query: CatalogQuery) {
    if (query.category || query.side) return empty
    const found = identities.filter(entry => (entry.name + ' ' + entry.repo).toLowerCase().includes(query.query.toLowerCase()))
    const checked = await Promise.allSettled(found.map(async entry => ({
      entry, releases: await this.releases(entry),
    })))
    const rejected = checked.find(item => item.status === 'rejected')
    if (rejected && checked.every(item => item.status === 'rejected')) throw rejected.reason
    const items = checked.flatMap(item => item.status === 'fulfilled' &&
      item.value.releases.some(release => (!query.game || release.games.includes(query.game)) &&
        (!query.loader || release.loaders.includes(query.loader))) ? [this.project(item.value.entry)] : [])
    return { items: items.slice(query.offset, query.offset + 18), total: items.length }
  }
  async title(id: string) { return this.entry(id).name }
  async version(id: string) {
    const match = /^(.+)_\d+$/.exec(id)
    if (!match) throw new Error('Некорректный идентификатор релиза GitHub.')
    const release = (await this.releases(this.entry(match[1]))).find(item => item.id === id)
    if (!release) throw new Error('Файл GitHub не найден.')
    return release
  }
  async versions(id: string, profile: Profile, refresh = false) { return (await this.releases(this.entry(id), refresh)).filter(item => compatible(item, profile)) }
  async detail(id: string, profile?: Profile): Promise<ProjectDetail> {
    const entry = this.entry(id)
    return { ...this.project(entry), body: '', gallery: [], versions: profile ? await this.versions(id, profile) : await this.releases(entry) }
  }
}

class LocalFiles implements Adapter {
  private parsed = new Map<string, { signature: string; mod: Awaited<ReturnType<typeof inspectJar>> }>()
  constructor(private directory: string) {}

  async add(paths: string[]) {
    let added = 0
    for (const source of paths) {
      const name = basename(source)
      if (!isJar(name) || !name.toLowerCase().endsWith('.jar') || !(await lstat(source)).isFile()) continue
      const mod = await inspectJar(source, name)
      if (mod.issue || !mod.loader || !mod.sha512) continue
      const folder = join(this.directory, mod.sha512)
      await mkdir(folder, { recursive: true })
      if ((await readdir(folder)).length) continue
      const stage = await mkdtemp(join(this.directory, '.incoming-'))
      try {
        const target = join(stage, name)
        await copyFile(source, target, constants.COPYFILE_EXCL)
        if (await checksum(target) !== mod.sha512) throw new Error('Исходный JAR изменился во время копирования.')
        await link(target, join(folder, name))
        added++
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      finally { await rm(stage, { recursive: true, force: true }) }
    }
    return added
  }

  private async read(hash: string) {
    if (!/^[a-f0-9]{128}$/.test(hash)) return
    const dir = join(this.directory, hash)
    const files = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const file = files.find(item => item.isFile() && isJar(item.name))
    if (!file) return
    const path = join(dir, file.name)
    const stat = await lstat(path)
    const signature = stat.mtimeMs + ':' + stat.ctimeMs + ':' + stat.size
    let entry = this.parsed.get(path)
    if (!entry || entry.signature !== signature) {
      entry = { signature, mod: await inspectJar(path, file.name) }
      this.parsed.set(path, entry)
    }
    const mod = entry.mod
    if (mod.issue || !mod.loader || mod.sha512 !== hash) return
    const projectId = 'jar_' + hash
    const artifact: RemoteVersion = { id: projectId, projectId, name: mod.name, number: mod.version,
      date: new Date(stat.mtimeMs).toISOString(), changelog: '', games: [], loaders: [mod.loader], type: 'release',
      dependencies: mod.requirements.filter(rule => !rule.optional && !rule.conflict).map(rule => ({ kind: 'required', modId: rule.id, range: rule.range })),
      file: { name: file.name, url: '', localPath: path, size: stat.size, sha512: hash, modId: mod.id, jarVersion: mod.version,
        gameRange: mod.requirements.find(rule => rule.id === 'minecraft' && !rule.optional && !rule.conflict)?.range },
    }
    const project: CatalogMod = { id: projectId, slug: projectId, name: mod.name, summary: mod.description ?? '', icon: mod.icon,
      author: mod.author ?? 'Локальный JAR', downloads: 0, categories: [], games: [], loaders: [mod.loader] }
    return { project, artifact, mod }
  }
  async index() {
    const hashes = await readdir(this.directory).catch(() => [])
    const result = []
    for (const hash of hashes) {
      const item = await this.read(hash).catch(() => undefined)
      if (item) result.push(item)
    }
    return result
  }
  async search(query: CatalogQuery) {
    if (query.category || query.side) return empty
    const items = (await this.index()).filter(({ project, artifact, mod }) =>
      (mod.id + ' ' + project.name + ' ' + project.author).toLowerCase().includes(query.query.toLowerCase()) &&
      (!query.loader || project.loaders.includes(query.loader as Loader)) &&
      (!query.game || artifact.file?.gameRange && satisfies(query.game, artifact.file.gameRange) === true))
    return { items: items.slice(query.offset, query.offset + 18).map(item => item.project), total: items.length }
  }
  async title(id: string) { return (await this.detail(id)).name }
  async version(id: string) {
    const item = await this.read(id.slice(4))
    if (!item) throw new Error('Локальный JAR отсутствует.')
    return item.artifact
  }
  async versions(id: string, profile: Profile) {
    const item = await this.read(id.slice(4))
    if (!item || profileIssue(item.mod, profile) || !compatible(item.artifact, profile)) return []
    return [item.artifact]
  }
  async detail(id: string, profile?: Profile): Promise<ProjectDetail> {
    const item = await this.read(id.slice(4))
    if (!item) throw new Error('Локальный JAR отсутствует.')
    return { ...item.project, body: item.project.summary, gallery: [], versions: profile ? await this.versions(id, profile) : [item.artifact] }
  }
  async identify(hashes: string[]) {
    const values = await Promise.all(hashes.map(hash => this.read(hash).catch(() => undefined)))
    return Object.fromEntries(values.flatMap(item => item ? [[item.mod.sha512, item.artifact]] : []))
  }
}

export class ContentCatalog implements CatalogProvider {
  readonly local: LocalFiles
  private readonly adapters: Partial<Record<ContentSource, Adapter>>
  constructor(private modrinth: Modrinth, store: Store, directory: string, curseforgeKey?: string, githubToken?: string) {
    this.local = new LocalFiles(directory)
    this.adapters = { modrinth, github: new GitHub(store, githubToken), local: this.local,
      ...(curseforgeKey ? { curseforge: new CurseForge(store, curseforgeKey) } : {}) }
  }
  sources() { return Object.keys(this.adapters) as ContentSource[] }
  private adapter(source: ContentSource) {
    const selected = this.adapters[source]
    if (!selected) throw new Error('Для CurseForge требуется разрешённый ключ API.')
    return selected
  }
  async search(query: CatalogQuery) {
    if (query.source) return this.adapter(query.source).search(query)
    const primary = await this.modrinth.search(query).catch(() => undefined)
    if (primary?.items.length === 18 || query.category || query.side) {
      if (!primary) throw new Error('Источник фильтров каталога временно недоступен.')
      return primary
    }
    const results = await Promise.allSettled(this.sources().filter(source => source !== 'modrinth').map(async source => {
      const adapter = this.adapter(source)
      return { adapter, result: await adapter.search({ ...query, offset: 0 }) }
    }))
    const successful = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    if (!primary && !successful.length) throw new Error('Источники каталога временно недоступны.')
    let offset = Math.max(0, query.offset - (primary?.total ?? 0))
    const items: CatalogMod[] = primary?.items.slice() ?? []
    for (const { adapter, result } of successful) {
      if (offset >= result.total) { offset -= result.total; continue }
      const batch = offset ? await adapter.search({ ...query, offset }).catch(() => empty) : result
      items.push(...batch.items.slice(0, 18 - items.length))
      if (items.length === 18) break
      offset = 0
    }
    return { items, total: successful.reduce((sum, entry) => sum + entry.result.total, primary?.total ?? 0) }
  }
  async detail(id: string, profile?: Profile) {
    const main = await this.adapter(contentSource(id)).detail(id, profile)
    const hashes = main.versions.flatMap(item => item.file?.sha512 ? [item.file.sha512] : [])
    const local = await this.local.identify(hashes)
    const alternatives = [...new Set([main.id, ...this.aliases(id), ...Object.values(local).map(item => item.projectId)])]
    if (alternatives.length > 1) {
      const choices = await Promise.allSettled(alternatives.map(async key => ({
        id: key, name: contentSource(key), automatic: Boolean(profile &&
          (key === main.id ? main.versions : await this.versions(key, profile)).some(item => item.file?.url || item.file?.localPath)),
      })))
      main.sources = choices.flatMap(choice => choice.status === 'fulfilled' ? [choice.value] : [])
    }
    return main
  }
  aliases(id: string) {
    const entry = identity(id)
    return entry ? [entry.id, 'gh_' + entry.slug, ...(this.adapters.curseforge ? ['cf_' + entry.cf] : [])] : []
  }
  async byModId(id: string, profile: Profile) {
    const keys = identities.filter(item => item.mod === id).flatMap(item => this.aliases(item.id))
    const local = (await this.local.index()).filter(item => item.mod.id === id && compatible(item.artifact, profile)).map(item => item.artifact)
    const results = await Promise.allSettled(keys.map(key => this.versions(key, profile)))
    return [...local, ...results.flatMap(result => result.status === 'fulfilled' ? result.value : [])]
  }
  async localAlternatives(id: string, profile: Profile) {
    const entry = identity(id)
    if (!entry) return []
    return (await this.local.index()).filter(item => item.mod.id === entry.mod && compatible(item.artifact, profile)).map(item => item.artifact)
  }
  title(id: string) { return this.adapter(contentSource(id)).title(id) }
  version(id: string) { return this.adapter(contentSource(id)).version(id) }
  versions(id: string, profile: Profile, refresh = false) { return this.adapter(contentSource(id)).versions(id, profile, refresh) }
  async identify(hashes: string[], refresh = false) {
    const sorted = [...new Set(hashes)].sort()
    const results = await Promise.allSettled([this.modrinth.identify(sorted, refresh), this.local.identify(sorted)])
    const sources = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    return Object.assign({}, ...sources.reverse()) as Record<string, RemoteVersion>
  }
}
