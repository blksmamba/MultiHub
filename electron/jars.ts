import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parse } from '@iarna/toml'
import yauzl, { type ZipFile, type Entry } from 'yauzl'
import type { GameLoader, LocalMod, Profile, Requirement } from '../src/shared'
import type { Store } from './db'

export const jarName = /^[^<>:"/\\|?*\x00-\x1f]{1,240}\.jar(?:\.disabled)?$/i
export function isJar(name: string) {
  return jarName.test(name) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(name)
}
export async function checksum(path: string, algorithm = 'sha512') {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export async function modsPath(profile: Profile, create = false) {
  return gameContentPath(profile, 'mods', create)
}

export async function gameContentPath(profile: Profile, folder: 'mods' | 'shaderpacks' | 'resourcepacks', create = false) {
  if ((await realpath(profile.directory)).toLowerCase() !== profile.directory.toLowerCase()) {
    throw new Error('Путь к профилю изменился. Проверьте игровую папку.')
  }
  const path = join(profile.directory, folder)
  if (create) await mkdir(path, { recursive: true })
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)).toLowerCase() !== path.toLowerCase())) {
    throw new Error('Папка ' + folder + ' должна быть обычной папкой внутри игровой директории.')
  }
  return path
}

function readEntry(archive: ZipFile, entry: Entry, limit: number): Promise<Buffer> {
  if (entry.uncompressedSize > limit) return Promise.reject(new Error('Метаданные JAR превышают допустимый размер.'))
  return new Promise((resolve, reject) => {
    archive.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error)
      const chunks: Buffer[] = []
      stream.on('data', chunk => chunks.push(chunk))
      stream.once('error', reject)
      stream.once('end', () => resolve(Buffer.concat(chunks)))
    })
  })
}

async function bundledMetadata(buffer: Buffer): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false }, (error, archive) => {
      if (error || !archive) { reject(error); return }
      const ids: Record<string, string> = Object.create(null)
      const finish = () => { archive.close(); resolve(ids) }
      archive.once('error', reject)
      archive.once('end', finish)
      archive.on('entry', (entry: Entry) => {
        if (!['fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml'].includes(entry.fileName)) {
          archive.readEntry()
          return
        }
        void readEntry(archive, entry, 512 * 1024).then(data => {
          const text = data.toString('utf8').replace(/^\uFEFF/, '')
          const values = entry.fileName.endsWith('.toml') ? (parse(text).mods as any[] ?? []).map(item => [item.modId, item.version]) :
            entry.fileName === 'fabric.mod.json' ? [[JSON.parse(text).id, JSON.parse(text).version]] :
              [[JSON.parse(text).quilt_loader?.id, JSON.parse(text).quilt_loader?.version]]
          for (const [id, version] of values) if (typeof id === 'string' && /^[\w-]+$/.test(id) && typeof version === 'string') ids[id] = version
        }).catch(() => undefined).finally(() => archive.readEntry())
      })
      if (archive.entryCount > 100000) finish()
      else archive.readEntry()
    })
  })
}

export async function inspectJar(path: string, file = basename(path), preferred?: GameLoader): Promise<LocalMod> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Выберите обычный JAR-файл.')
  const mod: LocalMod = {
    file, id: file.replace(/\.jar(?:\.disabled)?$/i, ''), ids: [],
    name: file.replace(/\.jar(?:\.disabled)?$/i, ''), version: '—', size: stat.size,
    modified: stat.mtimeMs, enabled: !file.toLowerCase().endsWith('.disabled'), requirements: [], sha512: await checksum(path)
  }
  try {
    const archive = await new Promise<ZipFile>((resolve, reject) => yauzl.open(path, { lazyEntries: true, autoClose: false }, (error, zip) => error || !zip ? reject(error) : resolve(zip)))
    try {
      const entries = await new Promise<Map<string, Entry>>((resolve, reject) => {
        const found = new Map<string, Entry>()
        archive.on('error', reject)
        archive.once('end', () => resolve(found))
        archive.on('entry', (entry: Entry) => { found.set(entry.fileName, entry); archive.readEntry() })
        if (archive.entryCount > 100000) return reject(new Error('Слишком много записей в JAR.'))
        archive.readEntry()
      })
      const read = (key: string) => {
        const entry = entries.get(key)
        if (!entry) return undefined
        return readEntry(archive, entry, 512 * 1024).then(buffer => buffer.toString('utf8').replace(/^\uFEFF/, ''))
      }
      const fabric = await read('fabric.mod.json')
      const quilt = await read('quilt.mod.json')
      const neo = await read('META-INF/neoforge.mods.toml')
      const forge = neo ? undefined : await read('META-INF/mods.toml')
      const legacy = await read('mcmod.info')
      let icon: unknown
      const preferForge = (preferred === 'forge' || preferred === 'neoforge') && (neo || forge)
      if (fabric && !preferForge && !(preferred === 'quilt' && quilt)) {
        const info = JSON.parse(fabric)
        Object.assign(mod, { loader: 'fabric', id: info.id, name: info.name ?? info.id, version: info.version, description: info.description, author: authors(info.authors) })
        mod.ids = [info.id, ...(Array.isArray(info.provides) ? info.provides : [])].filter(x => typeof x === 'string')
        icon = typeof info.icon === 'object' && info.icon ? Object.values(info.icon).at(-1) : info.icon
        mod.requirements = [
          ...requirements(info.depends), ...requirements(info.recommends, true),
          ...requirements(info.breaks, false, true)
        ]
      } else if (quilt && !preferForge) {
        const info = JSON.parse(quilt).quilt_loader
        Object.assign(mod, { loader: 'quilt', id: info.id, name: info.metadata?.name ?? info.id, version: info.version, description: info.metadata?.description, author: Object.keys(info.metadata?.contributors ?? {}).join(', ') })
        mod.ids = [info.id, ...(info.provides ?? []).map((item: any) => item?.id)].filter(x => typeof x === 'string')
        icon = info.metadata?.icon
        const rules = (list: unknown, conflict = false) => !Array.isArray(list) ? [] : list.flatMap((item: any) => typeof item === 'string' ? [{ id: item, conflict }] : typeof item?.id === 'string' ? [{ id: item.id, range: stringifyRange(item.versions), optional: Boolean(item.optional), conflict }] : [])
        mod.requirements = [...rules(info.depends), ...rules(info.breaks, true)]
      } else if (neo || forge) {
        const info: any = parse((neo ?? forge)!)
        const item = info.mods?.[0]
        if (!item) throw new Error('В TOML отсутствует описание мода.')
        const loader = neo || Object.values(info.dependencies ?? {}).flat().some((dependency: any) => dependency?.modId === 'neoforge') ? 'neoforge' : 'forge'
        const manifest = await read('META-INF/MANIFEST.MF')
        const version = item.version === '${file.jarVersion}' ? manifest?.match(/^Implementation-Version:\s*(.+)$/mi)?.[1]?.trim() : item.version
        Object.assign(mod, { loader, id: item.modId, name: item.displayName ?? item.modId, version: version ?? '—', description: item.description, author: item.authors })
        mod.ids = info.mods.map((entry: any) => entry.modId).filter((id: unknown) => typeof id === 'string')
        mod.requirements = Object.values(info.dependencies ?? {}).flat().flatMap((dependency: any) => typeof dependency?.modId !== 'string' || dependency.side === 'SERVER' || (dependency.type === 'discouraged') ? [] : [{
          id: dependency.modId, range: dependency.versionRange, optional: dependency.type === 'optional' || dependency.mandatory === false, conflict: dependency.type === 'incompatible'
        }])
        icon = item.logoFile
      } else if (legacy) {
        const info = JSON.parse(legacy)
        const list = Array.isArray(info) ? info : info.modList
        const item = list?.[0]
        if (!item) throw new Error('В mcmod.info отсутствует описание мода.')
        Object.assign(mod, { loader: 'forge', id: item.modid, name: item.name, version: item.version, description: item.description, author: authors(item.authorList) })
        mod.ids = list.map((entry: any) => entry.modid).filter((id: unknown) => typeof id === 'string')
        mod.requirements = typeof item.mcversion === 'string' && item.mcversion ? [{ id: 'minecraft', range: item.mcversion }] : []
        icon = item.logoFile
      } else {
        mod.issue = 'Метаданные мода не найдены.'
      }
      const loaderManifest = fabric ? JSON.parse(fabric) : quilt ? JSON.parse(quilt).quilt_loader : undefined
      const forgeManifest = await read('META-INF/jarjar/metadata.json')
      const forgeJars = forgeManifest ? JSON.parse(forgeManifest).jars : undefined
      const embedded = [
        ...(Array.isArray(loaderManifest?.jars) ? loaderManifest.jars.map((item: any) => typeof item === 'string' ? item : item?.file) : []),
        ...(Array.isArray(forgeJars) ? forgeJars.map((item: any) => item?.path) : []),
      ]
      if (embedded.length) {
        const bundled: Record<string, string> = Object.create(null)
        for (const key of new Set(embedded.slice(0, 250))) {
          if (typeof key !== 'string' || !key.endsWith('.jar')) continue
          const entry = entries.get(key)
          if (entry && entry.uncompressedSize <= 12 * 1024 * 1024)
            await readEntry(archive, entry, 12 * 1024 * 1024).then(bundledMetadata).then(ids => Object.assign(bundled, ids)).catch(() => undefined)
        }
        if (Object.keys(bundled).length) mod.bundled = bundled
      }
      if (typeof icon === 'string' && /\.(png|jpe?g|webp)$/i.test(icon)) {
        const entry = entries.get(icon.replace(/^\/+/, ''))
        if (entry && entry.uncompressedSize <= 128 * 1024) {
          const mime = icon.toLowerCase().endsWith('.png') ? 'png' : icon.toLowerCase().endsWith('.webp') ? 'webp' : 'jpeg'
          mod.icon = 'data:image/' + mime + ';base64,' + (await readEntry(archive, entry, 128 * 1024)).toString('base64')
        }
      }
      if (![mod.name, mod.version, mod.id].every(value => typeof value === 'string' && value.length)) throw new Error('Некорректные метаданные мода.')
    } finally { archive.close() }
  } catch {
    mod.issue = 'Не удалось прочитать JAR или метаданные мода.'
    if (typeof mod.name !== 'string') mod.name = file
    if (typeof mod.id !== 'string') mod.id = file
    if (typeof mod.version !== 'string') mod.version = '—'
  }
  if (typeof mod.author !== 'string') delete mod.author
  if (typeof mod.description !== 'string') delete mod.description
  return mod
}

function authors(input: unknown) {
  return Array.isArray(input) ? input.flatMap(person => typeof person === 'string' ? [person] : typeof person?.name === 'string' ? [person.name] : []).join(', ') : undefined
}

function stringifyRange(value: unknown) {
  return typeof value === 'string' ? value : Array.isArray(value) ? value.filter(item => typeof item === 'string').join(' || ') || undefined : undefined
}

function requirements(input: unknown, optional = false, conflict = false): Requirement[] {
  return input && typeof input === 'object' ? Object.entries(input).map(([id, range]) => ({ id, range: stringifyRange(range), optional, conflict })) : []
}

const scanned = new Map<string, { modified: number; size: number; changed: number; mod: LocalMod }>()
export async function scanMods(profile: Profile, store: Store, fresh = false) {
  const directory = await modsPath(profile)
  const files = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return []
  })
  const result: LocalMod[] = []
  for (const file of files) {
    if (!file.isFile() || !isJar(file.name)) continue
    const path = join(directory, file.name)
    try {
      const stat = await lstat(path)
      const key = profile.loader + ':' + path
      const cached = scanned.get(key)
      const mod = !fresh && cached?.modified === stat.mtimeMs && cached.size === stat.size && cached.changed === stat.ctimeMs ? cached.mod : await inspectJar(path, file.name, profile.loader)
      scanned.set(key, { modified: stat.mtimeMs, size: stat.size, changed: stat.ctimeMs, mod })
      result.push({ ...mod, ...store.source(mod.sha512) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      result.push({ file: file.name, id: file.name, ids: [], name: file.name, version: '—', size: 0, modified: 0, enabled: !file.name.toLowerCase().endsWith('.disabled'), requirements: [], sha512: '', issue: 'Нет доступа к файлу.' })
    }
  }
  if (scanned.size > 2000) scanned.clear()
  return result.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}
