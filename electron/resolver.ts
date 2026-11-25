import { randomUUID } from 'node:crypto'
import type { LocalMod, Plan, PlanItem, Profile, RemoteDependency, RemoteVersion } from '../src/shared'
import { isJar } from './jars'
import { compatible, type CatalogProvider } from './provider'
import { platformMod, profileIssue, satisfies } from '../src/compatibility'

export interface ResolvedPlan {
  public: Plan
  downloads: { item: PlanItem; version: RemoteVersion; previous?: LocalMod; requirements?: RemoteDependency[] }[]
  enables: { from: string; to: string; hash: string }[]
  installed: { file: string; hash: string }[]
}

export async function resolvePlan(provider: CatalogProvider, profile: Profile, local: LocalMod[], projectId: string, versionId: string | undefined, optional: string[], installedVersionId?: string, requirements: RemoteDependency[] = []): Promise<ResolvedPlan> {
  const items = new Map<string, PlanItem>()
  const selected = new Map<string, RemoteVersion>()
  const titles = new Map<string, string>()
  const downloads: ResolvedPlan['downloads'] = []
  const enables: ResolvedPlan['enables'] = []
  const installed: ResolvedPlan['installed'] = []
  const blockers = new Set<string>()
  const conflicts: { dep: RemoteDependency; owner: string }[] = []
  const occupied = new Set(local.map(item => item.file.toLowerCase()))
  let checks = 0

  function block(key: string, name: string, reason: string) {
    blockers.add(reason)
    items.set('blocked:' + key, { key: 'blocked:' + key, name, version: '', size: 0, status: 'blocked', reason })
  }

  async function visit(id?: string, pinned?: string, root = false, requirement?: RemoteDependency) {
    if (++checks > 180) throw new Error('Слишком много связей в плане установки.')
    const pinnedVersion = pinned ? await provider.version(pinned).catch(() => undefined) : undefined
    if (pinned && !pinnedVersion) return block(pinned, id ?? pinned, 'Источник заданной версии недоступен.')
    if (pinnedVersion && id && pinnedVersion.projectId !== id) {
      block(pinned!, id, 'Версия из метаданных принадлежит другому проекту.')
      return
    }
    const key = pinnedVersion?.projectId ?? id ?? requirement?.modId
    if (!key) return block(requirement?.fileName ?? 'unknown', requirement?.fileName ?? 'Зависимость', 'В источнике отсутствует проверяемый идентификатор обязательной зависимости.')
    if (requirement?.modId && platformMod(requirement.modId)) return
    const waiting = downloads.find(entry => entry.item.key === key && entry.item.status === 'waiting')
    if (waiting && !pinned && requirement?.modId) { (waiting.requirements ??= []).push(requirement); return }
    const identityKeys = id ? [...new Set([id, ...(provider.aliases?.(id) ?? [])])] : []
    const logicalKey = provider.aliases?.(key)?.[0] ?? key
    const previous = selected.get(logicalKey)
    if (previous) {
      if (pinned && previous.id !== pinned) block(key, titles.get(key) ?? key, 'Для одного проекта требуются разные версии. Выберите другую версию основного мода.')
      return
    }
    const aliases = identityKeys
    const results = !pinned && id ? await Promise.allSettled((root ? [id] : aliases).map(candidate => provider.versions(candidate, profile))) : []
    let versions = pinnedVersion ? [pinnedVersion] : id ? results.flatMap(result => result.status === 'fulfilled' ? result.value : []) :
      await provider.byModId?.(key, profile) ?? []
    if (!root && !pinned && id && !versions.some(item => item.file?.url)) {
      versions = [...versions, ...(await provider.localAlternatives?.(id, profile) ?? [])]
    }
    if (pinnedVersion?.file && !root && !pinnedVersion.file.url && aliases.length > 1) {
      const expected = pinnedVersion.file
      const other = await Promise.allSettled(aliases.filter(alias => alias !== pinnedVersion.projectId).map(alias => provider.versions(alias, profile)))
      versions = [...versions, ...other.flatMap(result => result.status === 'fulfilled' ? result.value.filter(candidate =>
        (['sha512', 'sha256', 'sha1'] as const).some(hash => expected[hash] && expected[hash]?.toLowerCase() === candidate.file?.[hash]?.toLowerCase())) : [])]
    }
    const supported = versions.filter(entry => compatible(entry, profile) && (!requirement?.range ||
      satisfies(entry.file?.jarVersion ?? entry.number, requirement.range) !== false))
    const identityKnown = supported.map(entry => entry.file?.modId).find(Boolean)
    const sameLocal = (item: LocalMod) => item.projectId && aliases.includes(item.projectId) ||
      supported.some(entry => entry.file?.sha512 && entry.file.sha512.toLowerCase() === item.sha512) ||
      Boolean(!pinned && (requirement?.modId || identityKnown) && item.ids.includes((requirement?.modId ?? identityKnown)!) &&
      satisfies(item.version, requirement?.range) === true)
    const present = local.filter(item => !item.issue && !profileIssue(item, profile) && sameLocal(item))
    const candidates = !root && !pinned ? present.filter(item => requirement?.modId || supported.some(entry =>
      entry.id === item.versionId || entry.file?.sha512 === item.sha512 ||
      Boolean(identityKnown && item.requirements.some(rule => rule.id === 'minecraft' && rule.range &&
        satisfies(profile.game, rule.range) === true) && satisfies(item.version, requirement?.range) === true))) : []
    const provenLocal = candidates.find(item => item.enabled) ?? candidates[0]
    if (provenLocal) {
      if (items.has(key)) return
      if (provenLocal.enabled) installed.push({ file: provenLocal.file, hash: provenLocal.sha512 })
      else {
        const target = provenLocal.file.replace(/\.disabled$/i, '')
        if (occupied.has(target.toLowerCase())) return block(key, provenLocal.name, 'Имя файла уже занято: ' + target)
        occupied.add(target.toLowerCase())
        enables.push({ from: provenLocal.file, to: target, hash: provenLocal.sha512 })
      }
      items.set(key, { key, name: provenLocal.name, version: provenLocal.version, size: 0, status: provenLocal.enabled ? 'installed' : 'enable', projectId: provenLocal.projectId })
      return
    }
    const already = present.find(item => item.enabled && supported.some(entry => entry.id === item.versionId)) ??
      present.find(item => supported.some(entry => entry.id === item.versionId))
    const automatic = (entry: RemoteVersion) => entry.file?.url || entry.file?.localPath
    const preferred = supported.find(entry => entry.type === 'release' && automatic(entry)) ?? supported.find(automatic) ??
      supported.find(entry => entry.type === 'release' && entry.file?.pageUrl) ?? supported.find(entry => entry.file?.pageUrl)
    const entry = !root && already ? supported.find(candidate => candidate.id === already.versionId) : preferred ?? supported.find(candidate => candidate.id === already?.versionId)
    const title = await provider.title(entry?.projectId ?? key).catch(() => entry?.name || versions[0]?.name || key)
    if (!entry) {
      const reason = 'Нет доступной версии для ' + profile.game + ' · ' + profile.loader + (requirement?.range ? ' с требованием ' + requirement.range : '') + '.'
      if (!id && requirement?.modId) {
        const filename = requirement.modId + '.jar'
        if (!isJar(filename) || occupied.has(filename.toLowerCase())) return block(key, title, reason)
        occupied.add(filename.toLowerCase())
        const item: PlanItem = { key, name: title, filename, version: requirement.range ?? '', size: 0, status: 'waiting', reason }
        items.set(key, item)
        downloads.push({ item, requirements: [requirement], version: { id: key, projectId: '', name: title, number: '', date: '', changelog: '',
          games: [profile.game], loaders: [profile.loader], type: 'release', dependencies: [],
          file: { name: filename, url: '', size: 0, modId: requirement.modId } } })
        return
      }
      return block(key, title, reason)
    }
    selected.set(logicalKey, entry)
    titles.set(key, title)

    const isExact = (item: LocalMod) => item.versionId === entry.id || Boolean(entry.file?.sha512 && item.sha512 === entry.file.sha512)
    const exact = present.find(item => isExact(item) && item.enabled) ?? present.find(isExact)
    let replacing: LocalMod | undefined
    let oldVersion: RemoteVersion | undefined
    if (root && installedVersionId) {
      if (present.length !== 1 || present[0].versionId !== installedVersionId || !present[0].sha512) {
        return block(key, title, 'Установленный файл изменился или найдено несколько копий. Проверьте сборку и обновите список.')
      }
      replacing = present[0]
    } else if (installedVersionId && pinned && present.length === 1 && !exact && present[0].enabled && present[0].versionId && present[0].sha512) {
      replacing = present[0]
    }
    if (replacing) {
      oldVersion = await provider.version(replacing.versionId!)
      if (oldVersion.projectId !== key || !(Date.parse(entry.date) > Date.parse(oldVersion.date))) {
        return block(key, title, 'Для обновления нужна более новая версия проекта «' + title + '».')
      }
      occupied.delete(replacing.file.toLowerCase())
    }
    if (!replacing && (present.length > 1 || (present.length && !exact))) {
      block(key, title, 'В папке уже есть другой файл проекта «' + title + '». Проверьте его в разделе «Мои моды».')
    } else if (exact) {
      if (exact.enabled) {
        installed.push({ file: exact.file, hash: exact.sha512 })
        items.set(key, { key, name: exact.name, version: entry.number, size: 0, status: 'installed', projectId: key, versionId: entry.id })
      } else {
        const target = exact.file.replace(/\.disabled$/i, '')
        if (occupied.has(target.toLowerCase())) block(key, title, 'Имя файла уже занято: ' + target)
        else {
          occupied.add(target.toLowerCase())
          enables.push({ from: exact.file, to: target, hash: exact.sha512 })
          items.set(key, { key, name: exact.name, version: entry.number, size: 0, status: 'enable', projectId: key, versionId: entry.id })
        }
      }
    } else {
      const file = entry.file
      if (!file || !isJar(file.name) || !file.name.toLowerCase().endsWith('.jar') || !(file.url || file.localPath || file.pageUrl) || !Number.isSafeInteger(file.size) || file.size <= 0) {
        block(key, title, 'Источник не предоставил подходящий JAR.')
      } else if (occupied.has(file.name.toLowerCase()) || occupied.has((file.name + '.disabled').toLowerCase())) {
        block(key, title, 'Имя файла уже занято: ' + file.name)
      } else {
        occupied.add(file.name.toLowerCase())
        const item: PlanItem = { key, name: title, version: entry.number, filename: file.name, size: file.size,
          status: automatic(entry) ? 'download' : 'waiting', projectId: entry.projectId, versionId: entry.id, pageUrl: file.pageUrl }
        items.set(key, item)
        if (replacing && oldVersion) {
          item.replaces = { filename: replacing.file, version: oldVersion.number, enabled: replacing.enabled }
        }
        downloads.push({ item, version: entry, previous: replacing, requirements: requirement ? [requirement] : undefined })
      }
    }
    if (root && replacing && !replacing.enabled) return
    for (const dep of entry.dependencies) {
      if (dep.kind === 'required') await visit(dep.projectId, dep.versionId, false, dep)
      if (dep.kind === 'incompatible') conflicts.push({ dep, owner: title })
    }
  }

  if (projectId) await visit(projectId, versionId, true)
  for (const requirement of requirements) await visit(requirement.projectId, requirement.versionId, false, requirement)
  const optionalChecked = new Set<string>()
  for (const entry of selected.values()) {
    if (entry.projectId === projectId && downloads.some(download => download.version === entry && download.previous?.enabled === false)) continue
    for (const dep of entry.dependencies.filter(value => value.kind === 'optional')) {
      const id = dep.versionId ?? dep.projectId
      if (!id || optionalChecked.has(id) || (dep.projectId && selected.has(dep.projectId))) continue
      optionalChecked.add(id)
      if (optional.includes(id)) await visit(dep.projectId, dep.versionId)
      else {
        const candidate = dep.versionId ? await provider.version(dep.versionId).catch(() => undefined) : dep.projectId ? (await provider.versions(dep.projectId, profile).catch(() => []))[0] : undefined
        if (!candidate || !compatible(candidate, profile)) continue
        const title = await provider.title(candidate.projectId).catch(() => candidate.name)
        items.set('optional:' + id, { key: id, projectId: candidate.projectId, versionId: candidate.id, name: title, version: candidate.number, size: candidate.file?.size ?? 0, status: 'optional' })
      }
    }
  }
  const replaced = new Set(downloads.flatMap(download => download.previous ? [download.previous.file] : []))
  for (const { dep, owner } of conflicts) {
    const matches = (id: string, version: string) => (dep.projectId || dep.versionId) && (!dep.projectId || dep.projectId === id) && (!dep.versionId || dep.versionId === version)
    const match = [...selected.values()].find(item => matches(item.projectId, item.id)) ?? local.find(item => item.enabled && !replaced.has(item.file) && matches(item.projectId ?? '', item.versionId ?? ''))
    if (match) {
      const name = titles.get(match.projectId ?? '') ?? match.name
      block(owner + name, owner, '«' + owner + '» конфликтует с «' + name + '».')
    }
  }
  return {
    public: { id: randomUUID(), profile, items: [...items.values()], blockers: [...blockers], bytes: downloads.reduce((sum, entry) => sum + entry.item.size, 0) },
    downloads, enables, installed
  }
}
