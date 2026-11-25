import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import yauzl from 'yauzl'
import type { LocalPack, PackFolder, Profile, RemoteVersion, ShaderPack, ShaderRecommendation } from '../src/shared'
import { checksum, gameContentPath, isJar } from './jars'
import { download } from './installer'
import type { CatalogProvider } from './provider'
import type { Store } from './db'

const oculusGames = new Set(['1.16.5', '1.18.1', '1.18.2', '1.19', '1.19.1', '1.19.2', '1.19.4', '1.20', '1.20.1'])
const isZip = (name: string) => /\.zip$/i.test(name) && isJar(name.slice(0, -4) + '.jar')

export async function shaderRecommendation(profile: Profile, provider: CatalogProvider): Promise<ShaderRecommendation | null> {
  if (profile.loader === 'forge') return oculusGames.has(profile.game) ? {
    kind: 'external', name: 'Oculus',
    url: 'https://www.curseforge.com/minecraft/mc-mods/oculus/files/all?version=' + encodeURIComponent(profile.game),
  } : null
  if (profile.loader === 'vanilla') return null
  const versions = (await provider.versions('iris', profile)).filter(version => version.file)
  const version = versions.find(item => item.type === 'release') ?? versions[0]
  return version ? { kind: 'install', name: 'Iris', projectId: version.projectId, versionId: version.id, version: version.number } : null
}

export async function localPacks(profile: Profile, kind: PackFolder) {
  const folder = await gameContentPath(profile, kind)
  const items = await readdir(folder, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const packs: LocalPack[] = []
  for (const item of items) {
    if (item.isFile() && isZip(item.name)) {
      const path = join(folder, item.name)
      const info = await lstat(path).catch(() => null)
      if (info?.isFile()) packs.push({ name: item.name, size: info.size })
    } else if (item.isDirectory()) {
      const contents = await lstat(join(folder, item.name, kind === 'shaderpacks' ? 'shaders' : 'pack.mcmeta')).catch(() => null)
      if (kind === 'shaderpacks' ? contents?.isDirectory() : contents?.isFile()) packs.push({ name: item.name })
    }
  }
  return { folder, packs: packs.sort((a, b) => a.name.localeCompare(b.name, 'ru')) }
}

export async function listShaderPacks(profile: Profile, store: Store, provider: CatalogProvider): Promise<ShaderPack[]> {
  const local = await localPacks(profile, 'shaderpacks')
  const packs: { pack: LocalPack; hash?: string }[] = []
  for (const pack of local.packs) {
    const hash = pack.size === undefined ? undefined : await checksum(join(local.folder, pack.name)).catch(() => undefined)
    packs.push({ pack, hash })
  }
  const unknown = [...new Set(packs.flatMap(({ hash }) => hash && !store.source(hash) ? [hash] : []))].sort()
  for (let index = 0; index < unknown.length; index += 100) {
    const entries = await provider.identify(unknown.slice(index, index + 100)).catch(() => ({}))
    for (const [hash, entry] of Object.entries(entries)) store.addSource(hash, { projectId: entry.projectId, versionId: entry.id })
  }
  return packs.map(({ pack, hash }) => ({ ...pack, projectId: hash ? store.source(hash)?.projectId : undefined }))
}

async function checkShaderZip(path: string) {
  return new Promise<void>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(new Error('Не удалось прочитать ZIP-архив.')); return }
      zip.once('error', reject)
      zip.once('end', () => reject(new Error('В корне ZIP должна быть папка shaders с файлами шейдеров.')))
      let entries = 0
      zip.on('entry', entry => {
        if (/^shaders\/.+\.(?:vsh|fsh|gsh|glsl|csh|tcs|tes)$/i.test(entry.fileName)) {
          zip.close()
          resolve()
        } else if (++entries >= 100000) {
          zip.close()
          reject(new Error('В архиве слишком много записей.'))
        } else zip.readEntry()
      })
      zip.readEntry()
    })
  })
}

async function saveShaderPack(profile: Profile, name: string, stage: (path: string) => Promise<unknown>) {
  if (!isZip(name)) throw new Error('Некорректное имя ZIP-архива шейдеров.')
  const folder = await gameContentPath(profile, 'shaderpacks', true)
  const staging = await mkdtemp(join(folder, '.modkit-'))
  try {
    const copy = join(staging, 'pack.zip')
    await stage(copy)
    await checkShaderZip(copy)
    await link(copy, join(folder, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error('Шейдеры с таким именем уже есть в сборке.')
      throw error
    })
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function importShaderPack(profile: Profile, source: string) {
  if (!(await lstat(source)).isFile()) throw new Error('Выберите ZIP-архив шейдеров.')
  await saveShaderPack(profile, basename(source), path => copyFile(source, path, constants.COPYFILE_EXCL))
}

export async function installShaderPack(profile: Profile, file: NonNullable<RemoteVersion['file']>) {
  if (!isZip(file.name)) throw new Error('Некорректное имя ZIP-архива шейдеров.')
  const folder = await gameContentPath(profile, 'shaderpacks')
  const target = join(folder, file.name)
  const present = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (present) {
    if (present.isFile() && file.sha512 && await checksum(target) === file.sha512.toLowerCase()) return file.name
    throw new Error('Шейдеры с таким именем уже есть в сборке.')
  }
  await saveShaderPack(profile, file.name, path => download(file, path, AbortSignal.timeout(120000)))
  return file.name
}
