import { loaders, webUrl, type CatalogMod, type CatalogQuery, type Profile, type ProjectDetail, type RemoteVersion, type ShaderProject, type ShaderStyle } from '../src/shared'
import type { Store } from './db'
import { satisfies } from '../src/compatibility'

export const userAgent = 'MultiHub-Desktop/0.2.20'
const api = 'https://api.modrinth.com/v2'
export const compatible = (version: RemoteVersion, profile: Profile) => (
  version.games.includes(profile.game) || Boolean(version.file?.gameRange && satisfies(profile.game, version.file.gameRange) === true)
) && version.loaders.includes(profile.loader)

export interface CatalogProvider {
  search(input: CatalogQuery): Promise<{ items: CatalogMod[]; total: number }>
  detail(id: string, profile?: Profile): Promise<ProjectDetail>
  title(id: string): Promise<string>
  version(id: string): Promise<RemoteVersion>
  versions(id: string, profile: Profile, refresh?: boolean): Promise<RemoteVersion[]>
  identify(hashes: string[], refresh?: boolean): Promise<Record<string, RemoteVersion>>
  aliases?(id: string): string[]
  byModId?(id: string, profile: Profile): Promise<RemoteVersion[]>
  localAlternatives?(id: string, profile: Profile): Promise<RemoteVersion[]>
}

function project(raw: any): CatalogMod {
  return {
    id: raw.project_id ?? raw.id, slug: raw.slug, name: raw.title, summary: raw.description,
    author: raw.organization || raw.author || 'Modrinth', downloads: raw.downloads, icon: raw.icon_url || undefined,
    url: 'https://modrinth.com/mod/' + encodeURIComponent(raw.slug),
    categories: (raw.display_categories ?? raw.categories ?? []).filter((tag: string) => !loaders.some(loader => loader === tag)),
    games: raw.game_versions ?? raw.versions ?? [], loaders: loaders.filter(loader => (raw.loaders ?? raw.categories ?? []).includes(loader))
  }
}

function version(raw: any): RemoteVersion {
  const jars = (raw.files ?? []).filter((entry: any) => typeof entry.filename === 'string' && /\.jar$/i.test(entry.filename))
  const primary = jars.find((entry: any) => entry.primary) ?? jars[0]
  return {
    id: raw.id, projectId: raw.project_id, name: raw.name, number: raw.version_number, date: raw.date_published,
    changelog: raw.changelog ?? '', games: raw.game_versions ?? [], loaders: raw.loaders ?? [], type: raw.version_type,
    dependencies: (raw.dependencies ?? []).map((entry: any) => ({ projectId: entry.project_id || undefined, versionId: entry.version_id || undefined, fileName: entry.file_name || undefined, kind: entry.dependency_type })),
    file: primary && { name: primary.filename, url: primary.url, size: primary.size, sha1: primary.hashes?.sha1, sha512: primary.hashes?.sha512,
      pageUrl: 'https://modrinth.com/mod/' + encodeURIComponent(raw.project_id) + '/version/' + encodeURIComponent(raw.id) }
  }
}

export class Modrinth implements CatalogProvider {
  private pending = new Map<string, Promise<unknown>>()
  private blockedUntil = 0

  constructor(private store: Store) {}

  private async request<T>(path: string, body?: unknown, ttl = 15 * 60 * 1000, refresh = false): Promise<T> {
    const key = path + (body ? JSON.stringify(body) : '')
    const cached = this.store.cached<T>(key)
    if (!refresh && cached && Date.now() - cached.date < ttl) return cached.value
    const existing = this.pending.get(key)
    if (existing) return existing as Promise<T>
    const operation = (async () => {
      try {
        if (Date.now() < this.blockedUntil) throw new Error('Modrinth ограничил частоту запросов. Повторите позже.')
        const response = await fetch(api + path, {
          method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, redirect: 'error',
          headers: { 'User-Agent': userAgent, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          signal: AbortSignal.timeout(15000)
        })
        const reset = Number(response.headers.get('X-Ratelimit-Reset')) || 60
        if (response.status === 429 || response.headers.get('X-Ratelimit-Remaining') === '0') this.blockedUntil = Date.now() + reset * 1000
        if (!response.ok) throw new Error('Modrinth вернул ошибку ' + response.status + '.')
        const data = await response.json() as T
        this.store.cache(key, data)
        return data
      } catch (error) {
        if (cached && !refresh) return cached.value
        if (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')) throw new Error('Не удалось подключиться к Modrinth. Проверьте интернет и повторите запрос.')
        throw error
      }
    })()
    this.pending.set(key, operation)
    try { return await operation } finally { this.pending.delete(key) }
  }

  async search(input: CatalogQuery) {
    const facets = [['project_type:mod']]
    if (input.game) facets.push(['versions:' + input.game])
    if (input.loader) facets.push(['categories:' + input.loader])
    if (input.category) facets.push(['categories:' + input.category])
    if (input.side) facets.push([input.side + '_side:required', input.side + '_side:optional'])
    const query = new URLSearchParams({ query: input.query, facets: JSON.stringify(facets), index: input.sort, offset: String(input.offset), limit: '18' })
    const result = await this.request<{ hits: unknown[]; total_hits: number }>('/search?' + query)
    return { items: result.hits.map(project), total: result.total_hits }
  }

  async tags() {
    const [games, categories] = await Promise.all([
      this.request<{ version: string; version_type: string }[]>('/tag/game_version', undefined, 86400000),
      this.request<{ name: string; project_type: string }[]>('/tag/category', undefined, 86400000),
    ])
    return { games: games.filter(item => item.version_type === 'release').map(item => item.version), categories: [...new Set(categories.filter(item => item.project_type === 'mod').map(item => item.name))] }
  }

  async searchShaders(game: string, text: string, offset: number, sort: CatalogQuery['sort'], style: ShaderStyle | '') {
    const facets = [['project_type:shader'], ['categories:iris'], ['versions:' + game]]
    if (style) facets.push(['categories:' + style])
    const query = new URLSearchParams({ query: text, facets: JSON.stringify(facets), index: sort, offset: String(offset), limit: '6' })
    const result = await this.request<{ hits: any[]; total_hits: number }>('/search?' + query)
    const items: ShaderProject[] = result.hits.map(raw => {
      const preview = webUrl(raw.featured_gallery || raw.gallery?.[0] || raw.icon_url)
      return { id: raw.project_id, slug: raw.slug, name: raw.title, author: raw.author, summary: raw.description,
        image: preview?.protocol === 'https:' && ['cdn.modrinth.com', 'cdn-raw.modrinth.com'].includes(preview.hostname) ? preview.href : undefined }
    })
    return { items, total: result.total_hits }
  }

  async shaderFile(id: string, game: string): Promise<NonNullable<RemoteVersion['file']> & { projectId: string; versionId: string }> {
    const project = await this.request<{ project_type: string }>('/project/' + encodeURIComponent(id))
    if (project.project_type !== 'shader') throw new Error('Этот проект не является пакетом шейдеров.')
    const query = new URLSearchParams({ loaders: '["iris"]', game_versions: JSON.stringify([game]), include_changelog: 'false' })
    const releases = await this.request<any[]>('/project/' + encodeURIComponent(id) + '/version?' + query)
    const candidates = releases.filter(raw => raw.game_versions?.includes(game) && raw.loaders?.includes('iris'))
      .sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published))
      .flatMap(raw => {
        const files = (raw.files ?? []).filter((file: any) => typeof file.filename === 'string' && /\.zip$/i.test(file.filename) &&
          typeof file.url === 'string' && Number.isSafeInteger(file.size) && file.size > 0 && /^[a-f0-9]{128}$/i.test(file.hashes?.sha512 ?? ''))
        const file = files.find((item: any) => item.primary) ?? files[0]
        return file ? [{ type: raw.version_type, name: file.filename, url: file.url, size: file.size, sha512: file.hashes.sha512,
          projectId: raw.project_id, versionId: raw.id }] : []
      })
    const chosen = candidates.find(item => item.type === 'release') ?? candidates[0]
    if (!chosen) throw new Error('Для Minecraft ' + game + ' не найден ZIP-пакет с поддержкой Iris.')
    return chosen
  }

  async detail(id: string, profile?: Profile): Promise<ProjectDetail> {
    const path = '/project/' + encodeURIComponent(id)
    const data = await this.request<any>(path)
    const [members, versions] = await Promise.all([
      this.request<any[]>(path + '/members').catch(() => []),
      profile ? this.versions(id, profile) : this.request<any[]>(path + '/version?limit=30').then(items => items.map(version))
    ])
    return {
      ...project(data), author: members.find(member => member.is_owner)?.user?.username ?? members[0]?.user?.username ?? 'Modrinth',
      body: data.body ?? '',
      gallery: (data.gallery ?? []).map((image: any) => ({ url: image.url, title: image.title ?? '' })),
      versions: versions.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)),
      supportedGames: profile && !versions.some(entry => entry.file) ? await this.supportedGames(path).catch(() => undefined) : undefined
    }
  }

  private async supportedGames(path: string): Promise<ProjectDetail['supportedGames']> {
    const releases = await this.request<unknown[]>(path + '/version?include_changelog=false')
    const byLoader = new Map<string, Set<string>>()
    for (const release of releases.map(version)) {
      if (!release.file) continue
      for (const loader of release.loaders) {
        const games = byLoader.get(loader) ?? new Set<string>()
        for (const game of release.games) games.add(game)
        byLoader.set(loader, games)
      }
    }
    return [...byLoader].filter(([, games]) => games.size > 0)
      .map(([loader, games]) => ({ loader, games: [...games].sort((a, b) => b.localeCompare(a, 'en', { numeric: true })) }))
  }

  async title(id: string) {
    const data = await this.request<{ title: string }>('/project/' + encodeURIComponent(id))
    return data.title
  }

  async version(id: string) {
    return version(await this.request('/version/' + encodeURIComponent(id)))
  }

  async versions(id: string, profile: Profile, refresh = false) {
    const query = new URLSearchParams({ loaders: JSON.stringify([profile.loader]), game_versions: JSON.stringify([profile.game]) })
    const raw = await this.request<unknown[]>('/project/' + encodeURIComponent(id) + '/version?' + query, undefined, 15 * 60 * 1000, refresh)
    return raw.map(version).filter(entry => compatible(entry, profile)).sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
  }

  async identify(hashes: string[], refresh = false) {
    if (!hashes.length) return {}
    const results = await this.request<Record<string, unknown>>('/version_files', { hashes, algorithm: 'sha512' }, 3600000, refresh)
    return Object.fromEntries(Object.entries(results).map(([hash, raw]) => [hash, version(raw)]))
  }

}
