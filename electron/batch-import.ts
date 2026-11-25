import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { platformMod, profileIssue, satisfies } from '../src/compatibility'
import type { LocalMod, PlanItem, Profile, RemoteDependency } from '../src/shared'
import { inspectJar } from './jars'
import { resolvePlan, type ResolvedPlan } from './resolver'
import type { CatalogProvider } from './provider'

export async function planJarBatch(provider: CatalogProvider, profile: Profile, installed: LocalMod[], input: { key: number; path: string }[]): Promise<ResolvedPlan> {
  const items: PlanItem[] = []
  const blockers: string[] = []
  const additions: { mod: LocalMod; path: string; item: PlanItem }[] = []
  const filenames = new Map(installed.map(mod => [mod.file.replace(/\.disabled$/i, '').toLowerCase(), mod]))
  const byHash = new Map(installed.map(mod => [mod.sha512, mod]))
  const ids = new Map(installed.flatMap(mod => mod.ids.map(id => [id, mod] as const)))
  let next = 0
  const parsed = new Map<number, LocalMod | Error>()
  async function inspect() {
    while (next < input.length) {
      const { key, path } = input[next++]
      try { parsed.set(key, await inspectJar(path, basename(path), profile.loader)) }
      catch (error) { parsed.set(key, new Error(error instanceof Error ? error.message : String(error))) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(input.length, 4) }, inspect))
  for (const { key, path } of input) {
    const result = parsed.get(key)!
    const name = result instanceof Error ? basename(path) : result.name
    const item: PlanItem = { key: 'jar-input-' + key, name, filename: basename(path), version: '', size: 0, status: 'download', inputIndex: key }
    if (!(result instanceof Error)) Object.assign(item, { version: result.version, loader: result.loader, size: result.size })
    items.push(item)
    const reason = result instanceof Error ? result.message : result.issue ?? profileIssue(result, profile)
    if (reason || result instanceof Error) {
      item.status = 'blocked'
      item.reason = reason
      blockers.push(name + ' · ' + reason)
      continue
    }
    const duplicate = byHash.get(result.sha512)
    if (duplicate) {
      item.status = 'installed'
      item.reason = installed.includes(duplicate) ? 'Тот же файл уже в сборке.' : 'Тот же файл уже включён в план.'
      continue
    }
    const collision = filenames.get(result.file.toLowerCase()) ?? result.ids.map(id => ids.get(id)).find(Boolean)
    if (collision) {
      item.status = 'blocked'
      item.reason = 'Конфликт файла или идентификатора с «' + collision.name + '» (' + collision.version + ').'
      blockers.push(name + ' · ' + item.reason)
      continue
    }
    if (!result.requirements.some(rule => rule.id === 'minecraft' && rule.range)) item.reason = 'В JAR не указан диапазон версий Minecraft.'
    additions.push({ mod: result, path, item })
    byHash.set(result.sha512, result)
    filenames.set(result.file.toLowerCase(), result)
    for (const id of result.ids) ids.set(id, result)
  }

  const active = [...installed.filter(mod => mod.enabled && !mod.issue), ...additions.map(item => item.mod)]
  const missing = new Map<string, RemoteDependency>()
  const included = new Set(additions.map(item => item.mod))
  for (const mod of included) {
    for (const rule of mod.requirements) {
      if (rule.optional || platformMod(rule.id)) continue
      const instances = active.flatMap(candidate => {
        const version = candidate.ids.includes(rule.id) ? candidate.version : candidate.bundled?.[rule.id]
        return version === undefined ? [] : [{ candidate, version }]
      })
      const matches = instances.filter(entry => satisfies(entry.version, rule.range) === true)
      if (rule.conflict) {
        if (matches.length) blockers.push(mod.name + ' конфликтует с «' + matches[0].candidate.name + '».')
        continue
      }
      if (matches.length) { matches.forEach(entry => included.add(entry.candidate)); continue }
      if (instances.length) blockers.push(mod.name + ' требует «' + rule.id + '» ' + (rule.range ?? '') + '. В сборке или пакете есть другая версия.')
      else missing.set(rule.id + ':' + (rule.range ?? ''), { modId: rule.id, range: rule.range, kind: 'required' })
    }
  }
  for (const mod of installed.filter(item => item.enabled && !included.has(item))) {
    for (const rule of mod.requirements) if (rule.conflict && !rule.optional &&
      additions.some(({ mod: added }) => added.ids.includes(rule.id) && satisfies(added.version, rule.range) === true))
      blockers.push(mod.name + ' конфликтует с «' + rule.id + '».')
  }
  const dependency = missing.size && !blockers.length ? await resolvePlan(
    provider, profile, [...installed, ...additions.map(item => item.mod)], '', undefined, [], undefined, [...missing.values()],
  ) : undefined
  const downloads: ResolvedPlan['downloads'] = additions.map(({ mod, path, item }) => ({
    item, version: { id: '', projectId: '', name: mod.name, number: mod.version, date: '', changelog: '',
      games: [profile.game], loaders: [profile.loader], type: 'release', dependencies: [],
      file: { name: mod.file, size: mod.size, url: '', localPath: path, sha512: mod.sha512, modId: mod.id, jarVersion: mod.version },
    }
  }))
  downloads.push(...(dependency?.downloads ?? []))
  return { public: { id: randomUUID(), profile, items: [...items, ...dependency?.public.items ?? []],
    blockers: [...new Set([...blockers, ...dependency?.public.blockers ?? []])], bytes: downloads.reduce((total, entry) => total + entry.item.size, 0) },
    downloads, enables: dependency?.enables ?? [], installed: dependency?.installed.filter(item => installed.some(mod => mod.file === item.file && mod.sha512 === item.hash)) ?? [],
  }
}
