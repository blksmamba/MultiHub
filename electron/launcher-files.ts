import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl, { type ZipFile } from 'yauzl'

export interface RemoteFile { url: string; sha1?: string; size?: number }
export interface Download extends RemoteFile { target: string }

const hosts = new Set([
  'piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com',
  'launcher.mojang.com', 'libraries.minecraft.net', 'resources.download.minecraft.net',
  'meta.fabricmc.net', 'maven.fabricmc.net', 'maven.minecraftforge.net', 'files.minecraftforge.net',
  'repo.maven.apache.org', 'repo1.maven.org', 'maven.apache.org',
])

export function localPath(root: string, relative: string) {
  const segments = relative.split('/')
  if (!segments.length || segments.some(part => !/^[\w.+@_-]+$/.test(part) || part === '.' || part === '..' || part.endsWith('.') ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Недопустимый путь в манифесте Minecraft.')
  return join(root, ...segments)
}

async function source(url: string, signal: AbortSignal) {
  const optifineDownload = new URL(url).hostname === 'optifine.net'
  for (let redirects = 0; redirects < 4; redirects++) {
    const parsed = new URL(url)
    const optifine = parsed.hostname === 'optifine.net' && parsed.pathname === '/downloadx'
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
      !(optifineDownload ? optifine : hosts.has(parsed.hostname))) {
      throw new Error('Источник Minecraft не поддерживается: ' + parsed.hostname)
    }
    const response = await fetch(parsed, {
      signal, redirect: 'manual', headers: { 'User-Agent': 'MultiHub-Desktop/0.2.20' },
    }).catch(error => {
      if (signal.aborted && signal.reason?.name !== 'TimeoutError') throw error
      throw new Error('Не удалось подключиться к ' + parsed.hostname + '. Проверьте соединение и повторите установку.', { cause: error })
    })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel()
      url = new URL(location, parsed).href
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error('Не удалось получить ' + parsed.hostname + parsed.pathname + ' (HTTP ' + response.status + ').')
    }
    return response
  }
  throw new Error('Слишком много перенаправлений при загрузке.')
}

export async function metadata<T>(url: string, signal: AbortSignal): Promise<T> {
  return (await source(url, AbortSignal.any([signal, AbortSignal.timeout(25000)]))).json() as Promise<T>
}

export async function remoteHash(url: string, signal: AbortSignal) {
  const response = await source(url + '.sha1', AbortSignal.any([signal, AbortSignal.timeout(20000)]))
  const match = (await response.text()).trim().match(/^[a-f0-9]{40}\b/i)
  if (!match) throw new Error('Сервер вернул некорректную контрольную сумму.')
  return match[0].toLowerCase()
}

export async function sha1(path: string) {
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function existing(file: Download) {
  const info = await lstat(file.target).catch(() => undefined)
  if (!info) return false
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Ожидался обычный файл: ' + file.target)
  if (file.size !== undefined ? info.size !== file.size : !info.size) return false
  return !file.sha1 || await sha1(file.target) === file.sha1.toLowerCase()
}

export async function download(file: Download, signal: AbortSignal, onBytes?: (count: number) => void) {
  signal.throwIfAborted()
  if (await existing(file)) return
  if (!file.url) throw new Error('Нужный локальный файл отсутствует: ' + file.target)
  await mkdir(dirname(file.target), { recursive: true })
  const temporary = file.target + '.' + randomUUID() + '.part'
  const hash = createHash('sha1')
  try {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(180000)])
    const response = await source(file.url, timeout)
    let received = 0
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (received > (file.size ?? 256 * 1024 ** 2)) return callback(new Error('Превышен ожидаемый размер файла.'))
        hash.update(chunk)
        onBytes?.(chunk.length)
        callback(null, chunk)
      },
    }), createWriteStream(temporary, { flags: 'wx' }), { signal: timeout })
    if (file.size !== undefined && received !== file.size) throw new Error('Файл загружен не полностью.')
    if (file.sha1 && hash.digest('hex') !== file.sha1.toLowerCase()) throw new Error('Контрольная сумма не совпала: ' + file.target)
    await rename(temporary, file.target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function downloadAll(files: Download[], signal: AbortSignal, onProgress: (ready: number, total: number, bytes: number) => void) {
  const list = [...new Map(files.map(file => [file.target, file])).values()]
  const failed = new AbortController()
  const combined = AbortSignal.any([signal, failed.signal])
  let index = 0
  let ready = 0
  let bytes = 0
  let lastUpdate = 0
  let error: unknown
  const progress = () => {
    const now = Date.now()
    if (now - lastUpdate < 120 && ready !== list.length) return
    lastUpdate = now
    onProgress(ready, list.length, bytes)
  }
  progress()
  await Promise.all(Array.from({ length: Math.min(list.length, 16) }, async () => {
    while (!combined.aborted && index < list.length) {
      const file = list[index++]
      try {
        for (let attempt = 0; ; attempt++) {
          try { await download(file, combined, count => { bytes += count; progress() }); break }
          catch (cause) { if (attempt || combined.aborted || String(cause).includes('HTTP 404')) throw cause }
        }
        ready++
        progress()
      } catch (cause) {
        error ??= cause
        failed.abort()
      }
    }
  }))
  signal.throwIfAborted()
  if (error) throw error
}

export async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

export async function archiveJson<T>(jar: string, name: string): Promise<T> {
  const archive = await new Promise<ZipFile>((resolve, reject) => yauzl.open(jar, { lazyEntries: true, autoClose: false },
    (error, zip) => error || !zip ? reject(error) : resolve(zip)))
  try {
    return await new Promise<T>((resolve, reject) => {
      archive.once('error', reject)
      archive.once('end', () => reject(new Error('В установщике Forge отсутствует ' + name + '.')))
      archive.on('entry', entry => {
        if (entry.fileName !== name) { archive.readEntry(); return }
        if (entry.uncompressedSize > 4 * 1024 ** 2) { reject(new Error('Слишком большой манифест Forge.')); return }
        archive.openReadStream(entry, (error, stream) => {
          if (error || !stream) { reject(error); return }
          const chunks: Buffer[] = []
          stream.on('data', chunk => chunks.push(chunk))
          stream.once('error', reject)
          stream.once('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T) }
            catch (error) { reject(error) }
          })
        })
      })
      archive.readEntry()
    })
  } finally { archive.close() }
}

export async function extractNatives(jar: string, directory: string, excludes: string[], signal: AbortSignal) {
  const archive = await new Promise<ZipFile>((resolve, reject) => yauzl.open(jar, { lazyEntries: true, autoClose: false }, (error, zip) => error || !zip ? reject(error) : resolve(zip)))
  await mkdir(directory, { recursive: true })
  try {
    await new Promise<void>((resolve, reject) => {
      archive.on('error', reject)
      archive.once('end', resolve)
      archive.on('entry', entry => {
        const name = entry.fileName
        if (excludes.some(prefix => name.startsWith(prefix)) || !/^[\w.+-]+\.dll$/i.test(name)) return archive.readEntry()
        archive.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error)
          pipeline(stream, createWriteStream(localPath(directory, name)), { signal }).then(() => archive.readEntry(), reject)
        })
      })
      archive.readEntry()
    })
  } finally { archive.close() }
}
