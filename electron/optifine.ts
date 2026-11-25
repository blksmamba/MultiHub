import { link, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import yauzl from 'yauzl'
import type { OptiFineRelease, Profile } from '../src/shared'
import { download } from './launcher-files'

const origin = 'https://optifine.net'
const filenamePattern = /^(?:preview_)?OptiFine_(\d+(?:\.\d+)+)_HD_[A-Za-z0-9_]+\.jar$/
let catalog: { expires: number; releases: OptiFineRelease[] } | undefined
let pending: Promise<OptiFineRelease[]> | undefined

async function page(path: string) {
  const response = await fetch(origin + path, { redirect: 'error', signal: AbortSignal.timeout(15000) })
    .catch(error => { throw new Error('Не удалось открыть официальный сайт OptiFine.', { cause: error }) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('Сайт OptiFine вернул HTTP ' + response.status + '.')
  }
  return response.text()
}

function parseCatalog(html: string): OptiFineRelease[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap(([, row]) => {
    const file = /class=['"]colMirror['"][^>]*>\s*<a\s+href=['"](?:https?:\/\/(?:www\.)?optifine\.net\/)?\/?adloadx\?f=([^'"&]+)['"]/i.exec(row)?.[1]
    const game = file && filenamePattern.exec(file)?.[1]
    const version = /class=['"]colFile['"][^>]*>\s*(OptiFine [^<>]+)<\/td>/i.exec(row)?.[1].trim()
    const forge = /class=['"]colForge['"][^>]*>\s*Forge\s+#?(\d+\.\d+\.\d+)\s*<\/td>/i.exec(row)?.[1]
    return file && game && version ? [{ file, game, version, forge, preview: /(?:^|_)pre\d+/i.test(file) }] : []
  })
}

async function releases() {
  if (catalog && Date.now() < catalog.expires) return catalog.releases
  pending ??= page('/downloads').then(html => {
    const items = parseCatalog(html)
    if (!items.length) throw new Error('Не удалось прочитать список выпусков OptiFine.')
    catalog = { expires: Date.now() + 30 * 60 * 1000, releases: items }
    return items
  }).finally(() => { pending = undefined })
  return pending
}

export async function optiFineFor(profile: Profile) {
  if (profile.loader !== 'vanilla' && profile.loader !== 'forge') return { release: null, listedForge: [] }
  const sameGame = (await releases()).filter(item => item.game === profile.game)
  const matches = sameGame.filter(item => profile.loader === 'vanilla' || item.forge === profile.loaderVersion)
  return {
    release: matches.find(item => !item.preview) ?? matches[0] ?? null,
    listedForge: [...new Set(sameGame.flatMap(item => item.forge ? [item.forge] : []))],
  }
}

export async function saveOptiFine(release: OptiFineRelease, folder: string) {
  const html = await page('/adloadx?f=' + encodeURIComponent(release.file))
  const links = [...html.matchAll(/href=['"]([^'"<>]*downloadx\?[^'"<>]+)['"]/gi)]
  const url = links.map(([, href]) => new URL(href.replaceAll('&amp;', '&'), origin))
    .find(link => link.origin === origin && !link.username && !link.password && link.pathname === '/downloadx' &&
      link.searchParams.get('f') === release.file && /^[a-f0-9]+$/i.test(link.searchParams.get('x') ?? ''))
  if (!url) throw new Error('Сайт OptiFine не выдал ссылку на выбранный JAR.')
  await mkdir(folder, { recursive: true })
  const staging = await mkdtemp(join(folder, '.multihub-optifine-'))
  const target = join(staging, release.file)
  try {
    await download({ url: url.href, target }, AbortSignal.timeout(120000))
    await new Promise<void>((resolve, reject) => {
      yauzl.open(target, { lazyEntries: true }, (error, zip) => {
        if (error || !zip?.entryCount) {
          zip?.close()
          reject(new Error('Сайт OptiFine вернул файл, который не удалось открыть как JAR.'))
          return
        }
        zip.close()
        resolve()
      })
    })
    for (let suffix = 1; ; suffix++) {
      const file = suffix === 1 ? release.file : release.file.slice(0, -4) + ' (' + suffix + ').jar'
      try { await link(target, join(folder, file)); return file }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}
