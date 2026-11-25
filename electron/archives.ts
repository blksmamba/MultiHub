import { createWriteStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import type { ArchiveKind, Profile, RemoteVersion } from '../src/shared'
import { download } from './installer'
import { checksum, gameContentPath, isJar } from './jars'

function segment(value: string) {
  return value.length > 0 && value.length <= 240 && !/[<>:"/\\|?*\x00-\x1f]/.test(value) &&
    !/[. ]$/.test(value) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(value)
}

async function directory(path: string) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)).toLowerCase() !== path.toLowerCase()) {
    throw new Error('Выберите обычную папку мира внутри сборки.')
  }
  return path
}

export async function worlds(profile: Profile) {
  const saves = await gameContentPath(profile, 'saves')
  const entries = await readdir(saves, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  return (await Promise.all(entries.filter(entry => entry.isDirectory() && segment(entry.name)).map(async entry => {
    const folder = await directory(join(saves, entry.name)).catch(() => null)
    return folder && (await lstat(join(folder, 'level.dat')).catch(() => null))?.isFile() ? entry.name : null
  }))).filter(name => name !== null).sort((a, b) => a.localeCompare(b, 'ru'))
}

async function inspect(path: string, extract?: string) {
  const zip = await new Promise<ZipFile>((resolve, reject) => yauzl.open(path, { lazyEntries: true, strictFileNames: true },
    (error, value) => error || !value ? reject(error ?? new Error('Не удалось прочитать ZIP.')) : resolve(value)))
  const names = new Set<string>()
  const files: string[] = []
  let total = 0
  try {
    await new Promise<void>((resolve, reject) => {
      zip.once('error', reject)
      zip.once('end', resolve)
      const processEntry = async (entry: Entry) => {
        const folder = entry.fileName.endsWith('/')
        const name = folder ? entry.fileName.slice(0, -1) : entry.fileName
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000
        if (!name.split('/').every(segment) || (mode && mode !== (folder ? 0o040000 : 0o100000)) ||
          names.has(name.toLowerCase()) || names.size >= 50000 || (total += entry.uncompressedSize) > 2 * 1024 ** 3) {
          throw new Error('ZIP содержит небезопасные пути, типы файлов или превышает лимит распаковки.')
        }
        names.add(name.toLowerCase())
        if (!folder) files.push(name)
        if (!extract) return
        const target = join(extract, ...name.split('/'))
        if (folder) { await mkdir(target, { recursive: true }); return }
        await mkdir(dirname(target), { recursive: true })
        const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry,
          (error, value) => error || !value ? reject(error ?? new Error('Не удалось распаковать ZIP.')) : resolve(value)))
        await pipeline(stream, createWriteStream(target, { flags: 'wx' }))
      }
      zip.on('entry', entry => void processEntry(entry).then(() => zip.readEntry(), reject))
      zip.readEntry()
    })
    return files
  } finally { zip.close() }
}

export async function installArchive(profile: Profile, kind: ArchiveKind, world: string, input: { path: string } |
  { file: NonNullable<RemoteVersion['file']>; source: 'modrinth' | 'curseforge' }) {
  const name = 'path' in input ? basename(input.path) : input.file.name
  if (!/\.zip$/i.test(name) || !isJar(name.slice(0, -4) + '.jar')) throw new Error('Выберите ZIP с допустимым именем файла.')
  const root = await gameContentPath(profile, kind === 'resourcepack' ? 'resourcepacks' : 'saves', kind !== 'datapack')
  let destination = root
  if (kind === 'datapack') {
    if (!segment(world) || !(await worlds(profile)).includes(world)) throw new Error('Выберите существующий мир.')
    destination = join(await directory(join(root, world)), 'datapacks')
    await mkdir(destination, { recursive: true })
    await directory(destination)
  }
  const stage = await mkdtemp(join(destination, '.modkit-'))
  try {
    const archive = join(stage, 'download.zip')
    if ('path' in input) await copyFile(input.path, archive)
    else await download(input.file, archive, AbortSignal.timeout(180000), undefined, input.source)
    if (kind !== 'world') {
      const files = await inspect(archive)
      const prefix = kind === 'datapack' ? 'data/' : 'assets/'
      if (!files.includes('pack.mcmeta') || !files.some(file => file.startsWith(prefix))) {
        throw new Error('В ZIP отсутствуют метаданные или файлы выбранного типа пакета.')
      }
      const target = join(destination, name)
      try { await link(archive, target) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await lstat(target)
        if (!existing.isFile() || existing.isSymbolicLink() || await checksum(target) !== await checksum(archive)) {
          throw new Error('В сборке уже есть другой файл с таким именем.')
        }
      }
      return name
    }
    const extracted = join(stage, 'world')
    const files = await inspect(archive, extracted)
    const levels = files.filter(file => /^(?:[^/]+\/)?level\.dat$/.test(file))
    if (levels.length !== 1) throw new Error('В ZIP должен быть один мир Minecraft с файлом level.dat.')
    const level = levels[0].split('/')
    const folder = level.length === 2 ? level[0] : name.slice(0, -4).trim()
    if (!segment(folder)) throw new Error('Некорректное имя мира.')
    const worldRoot = level.length === 2 ? join(extracted, folder) : extracted
    // Reserve a new folder atomically. Existing saves are never replaced.
    for (let number = 1; number <= 1000; number++) {
      const label = number === 1 ? folder : folder + ' (' + number + ')'
      const target = join(destination, label)
      try { await mkdir(target) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error }
      try {
        const children = await readdir(worldRoot)
        for (const child of children.filter(item => item !== 'level.dat')) await rename(join(worldRoot, child), join(target, child))
        await rename(join(worldRoot, 'level.dat'), join(target, 'level.dat'))
        return label
      } catch (error) {
        await rm(target, { recursive: true, force: true })
        throw error
      }
    }
    throw new Error('Не удалось подобрать свободное имя мира.')
  } finally { await rm(stage, { recursive: true, force: true }) }
}
