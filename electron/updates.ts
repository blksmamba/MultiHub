import type { LocalMod, ModUpdate, ModUpdateCheck, Profile, RemoteVersion } from '../src/shared'
import { compatible, type Modrinth } from './provider'

export async function checkModUpdates(mods: LocalMod[], profile: Profile, provider: Modrinth, refresh: boolean): Promise<ModUpdateCheck> {
  const files = mods.filter(mod => /^[a-f0-9]{128}$/i.test(mod.sha512))
  const byHash = new Map(files.map(mod => [mod.sha512, mod]))
  const hashes = [...byHash.keys()].sort()
  const installed = new Map<string, { file: LocalMod; current: RemoteVersion }>()
  const recognized = new Set<string>()
  for (let i = 0; i < hashes.length; i += 100) {
    const batch = hashes.slice(i, i + 100)
    const versions = await provider.identify(batch, refresh)
    for (const hash of batch) {
      const current = versions[hash]
      if (!current) continue
      recognized.add(hash)
      if (!compatible(current, profile)) continue
      const previous = installed.get(current.projectId)
      if (previous && Date.parse(previous.current.date) >= Date.parse(current.date)) continue
      installed.set(current.projectId, { file: byHash.get(hash)!, current })
    }
  }
  const projects = [...installed.values()]
  const projectByVersion = new Map(projects.map(({ current }) => [current.id, current.projectId]))
  const pinned = new Map<string, Set<string>>()
  for (const { file, current } of projects) {
    if (!file.enabled) continue
    for (const dependency of current.dependencies) {
      if (dependency.kind !== 'required' || !dependency.versionId) continue
      const project = dependency.projectId ?? projectByVersion.get(dependency.versionId)
      if (!project || project === current.projectId) continue
      const pins = pinned.get(project) ?? new Set<string>()
      pins.add(dependency.versionId)
      pinned.set(project, pins)
    }
  }
  const updates: ModUpdate[] = []
  for (let i = 0; i < projects.length; i += 8) {
    const results = await Promise.all(projects.slice(i, i + 8).map(async ({ file, current }) => {
      const versions = await provider.versions(current.projectId, profile, refresh)
      const pins = pinned.get(current.projectId)
      const available = versions.find(entry => entry.file && entry.projectId === current.projectId && entry.id !== current.id &&
        Date.parse(entry.date) > Date.parse(current.date) && (!pins || pins.size === 1 && pins.has(entry.id)))
      if (!available) return undefined
      return {
        projectId: current.projectId, versionId: available.id, installedVersionId: current.id, name: file.name,
        installed: current.number, available: available.number, date: available.date, changelog: available.changelog, type: available.type,
      }
    }))
    for (const result of results) if (result) updates.push(result)
  }
  updates.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  return { updates, checked: mods.length, unrecognized: mods.filter(mod => !recognized.has(mod.sha512)).length }
}
