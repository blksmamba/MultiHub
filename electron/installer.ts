import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, readdir, realpath, rm, rmdir, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants } from 'node:fs'
import { contentSource, type LocalMod, type Profile, type RemoteDependency, type Requirement, type Settings, type Transfer } from '../src/shared'
import { platformMod, profileIssue, satisfies, thresholdMismatch } from '../src/compatibility'
import type { Store, Source } from './db'
import { gameRunning } from './discovery'
import { checksum, inspectJar, isJar, modsPath, scanMods } from './jars'
import { compatible, userAgent } from './provider'
import type { ResolvedPlan } from './resolver'

type File = NonNullable<ResolvedPlan['downloads'][number]['version']['file']>
type Job = { id: string; plan: ResolvedPlan; allowRunning: boolean; controller: AbortController; rows: Transfer[]; done: boolean; files: Map<string, { path: string; hash: string }> }
type Place = { from: string; to: string; move: boolean }

export async function checkGame(allowRunning: boolean, directory?: string) {
  if (!allowRunning && await gameRunning(directory)) throw new Error('Обнаружен запущенный Minecraft. Закройте игру и повторите действие.')
}

async function transaction(placements: Place[], commit: () => void) {
  const undo: Place[] = []
  try {
    for (const placement of placements) {
      await link(placement.from, placement.to)
      try {
        if (placement.move) await unlink(placement.from)
      } catch (error) {
        await unlink(placement.to)
        throw error
      }
      undo.push(placement)
    }
    commit()
  } catch (error) {
    const failures: string[] = []
    for (const placement of undo.reverse()) {
      try {
        if (placement.move) await link(placement.to, placement.from)
        await unlink(placement.to)
      } catch { failures.push(basename(placement.to)) }
    }
    if (failures.length) throw new Error('Не удалось откатить изменения файлов: ' + failures.join(', '))
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Имя файла уже занято. Существующие файлы сохранены.')
    throw error
  }
}

const downloadHosts: Record<ReturnType<typeof contentSource>, string[]> = {
  modrinth: ['cdn.modrinth.com', 'cdn-raw.modrinth.com'],
  curseforge: ['edge.forgecdn.net', 'media.forgecdn.net', 'mediafilez.forgecdn.net', 'mediafiles.forgecdn.net'],
  github: ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'],
  local: [],
}

async function verifyBytes(file: File, path: string) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size < 1 || stat.size > 1024 ** 3 || (file.size > 0 && stat.size !== file.size)) throw new Error('Размер JAR отличается от ожидаемого.')
  const sha512 = await checksum(path)
  if (file.sha512 && file.sha512.toLowerCase() !== sha512) throw new Error('Контрольная сумма SHA-512 не совпала.')
  for (const algorithm of ['sha256', 'sha1', 'md5'] as const) {
    if (file[algorithm] && file[algorithm].toLowerCase() !== await checksum(path, algorithm)) throw new Error('Контрольная сумма ' + algorithm.toUpperCase() + ' не совпала.')
  }
  return sha512
}

export async function download(file: File, path: string, signal: AbortSignal, progress?: (received: number, speed: number) => void, source: keyof typeof downloadHosts = 'modrinth') {
  if (file.localPath) {
    await copyFile(file.localPath, path, constants.COPYFILE_EXCL)
    return verifyBytes(file, path)
  }
  let url = new URL(file.url)
  if (file.size > 1024 ** 3) throw new Error('Файл превышает ограничение в 1 ГБ.')
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)])
  let response: Response | undefined
  for (let redirect = 0; redirect < 5; redirect++) {
    if (url.protocol !== 'https:' || !downloadHosts[source].includes(url.hostname) || url.username || url.password || url.port ||
      (url.hostname === 'github.com' && !/^\/[\w.-]+\/[\w.-]+\/releases\/download\//.test(url.pathname))) throw new Error('Ссылка не ведёт на разрешённый сервер источника.')
    response = await fetch(url, { redirect: 'manual', signal: timeout, headers: { 'User-Agent': userAgent } })
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location) break
    await response.body?.cancel()
    url = new URL(location, url)
  }
  if (!response) throw new Error('Источник не вернул файл.')
  if (!response.ok || !response.body) throw new Error('Ошибка скачивания HTTP ' + response.status + '.')
  let received = 0
  let last = 0
  const started = Date.now()
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length
      if (received > file.size) return done(new Error('Размер файла отличается от данных источника.'))
      const now = Date.now()
      if (now - last >= 200 || received === file.size) {
        progress?.(received, received * 1000 / Math.max(1, now - started))
        last = now
      }
      done(null, chunk)
    }
  }), createWriteStream(path, { flags: 'wx' }), { signal: timeout })
  if (received !== file.size) throw new Error('Загрузка завершилась с неполным файлом.')
  return verifyBytes(file, path)
}

const waiting = Symbol('waiting')
export class Installer {
  private jobs = new Map<string, Job>()
  private running = false
  private locked = new Set<string>()

  private monitor?: NodeJS.Timeout
  private scanning = false
  private candidates = new Map<string, { path: string; hash: string }>()
  private observed = new Map<string, string>()
  private examined = new Set<string>()
  constructor(private store: Store, private tempPath: string, private change: (rows: Transfer[]) => void, private changed: (profile: string, summary: string) => void,
    private launched: (profile: string) => boolean, private resolveRequirements?: (profile: Profile, local: LocalMod[], missing: RemoteDependency[]) => Promise<ResolvedPlan>) {}

  list() { return [...this.jobs.values()].flatMap(job => job.rows.map(row => ({ ...row }))).reverse() }
  private emit() { this.change(this.list()) }

  private row(id: string, profile: Profile, item: ResolvedPlan['downloads'][number]['item'], updating: boolean): Transfer {
    return { key: id + ':' + item.key, jobId: id, name: item.name, filename: item.filename, received: 0, size: item.size, speed: 0,
      status: item.status === 'waiting' ? 'waiting' : 'queued', updating, source: contentSource(item.projectId), pageUrl: item.pageUrl,
      profileName: profile.name, error: item.reason }
  }

  enqueue(plan: ResolvedPlan, allowRunning: boolean) {
    this.store.profile(plan.public.profile.id)
    if (plan.public.blockers.length || !plan.downloads.length && !plan.enables.length) throw new Error('В плане нет доступных изменений.')
    const id = randomUUID()
    const updating = plan.downloads.some(entry => entry.previous)
    const rows: Transfer[] = plan.downloads.map(({ item }) => this.row(id, plan.public.profile, item, updating))
    rows.push(...plan.enables.map(entry => this.row(id, plan.public.profile, { key: entry.from, name: entry.to, version: '', size: 0, status: 'enable' }, updating)))
    this.jobs.set(id, { id, plan, allowRunning, rows, controller: new AbortController(), done: false, files: new Map() })
    for (const [key, job] of this.jobs) {
      if (this.jobs.size <= 30) break
      if (job.done) this.jobs.delete(key)
    }
    this.emit()
    void this.run()
  }

  cancel(id: string) {
    const job = this.jobs.get(id)
    if (job && !job.done) { job.controller.abort(); void this.run() }
  }

  watch(folder?: string) {
    if (this.monitor) clearInterval(this.monitor)
    this.monitor = undefined
    this.observed.clear()
    this.examined.clear()
    this.candidates.clear()
    for (const job of this.jobs.values()) for (const row of job.rows) delete row.candidate
    if (folder) {
      const timer = setInterval(() => void this.scan(folder, timer).catch(() => undefined), 2000)
      this.monitor = timer
      timer.unref()
    }
    this.emit()
  }

  private async validate(path: string, entry: ResolvedPlan['downloads'][number], profile: Profile, manual: boolean) {
    const file = entry.version.file!
    const hash = await verifyBytes(file, path)
    const mod = await inspectJar(path, entry.item.filename, profile.loader)
    if (mod.issue || !mod.ids.length) throw new Error('Не удалось прочитать идентификатор и версию мода из JAR.')
    const issue = profileIssue(mod, profile)
    if (issue || !compatible(entry.version, profile)) throw new Error(issue ?? 'JAR не подходит версии Minecraft или загрузчику.')
    const expectedIds = [file.modId, ...(entry.requirements ?? []).map(rule => rule.modId)].filter((id): id is string => Boolean(id))
    if (expectedIds.some(id => !mod.ids.includes(id))) throw new Error('В JAR указан другой идентификатор мода.')
    if (file.jarVersion && file.jarVersion !== mod.version ||
      entry.requirements?.some(rule => rule.range && satisfies(mod.version, rule.range) !== true))
      throw new Error('Версия зависимости в JAR не соответствует требованию.')
    if (manual && !(file.sha512 || file.sha256 || file.sha1 || file.md5) &&
      !(expectedIds.length && mod.version !== '—' && (file.jarVersion || entry.requirements?.some(rule => rule.modId)))) {
      throw new Error('Нет контрольной суммы или подтверждённых идентификатора и версии файла.')
    }
    if (manual && !entry.version.projectId &&
      !mod.requirements.some(rule => !rule.optional && !rule.conflict && rule.id === 'minecraft' && rule.range && satisfies(profile.game, rule.range) === true))
      throw new Error('В JAR отсутствует подтверждение совместимости с Minecraft ' + profile.game + '.')
    return { hash, mod }
  }

  private pendingFile(key: string) {
    for (const job of this.jobs.values()) {
      if (job.done || job.controller.signal.aborted) continue
      const entry = job.plan.downloads.find(item => item.item.status === 'waiting' && job.id + ':' + item.item.key === key)
      const row = job.rows.find(item => item.key === key && item.status === 'waiting')
      if (entry && row && !job.files.has(key)) return { job, entry, row }
    }
  }

  async supply(key: string, chosenPath?: string) {
    const pending = this.pendingFile(key)
    const candidate = this.candidates.get(key)
    const path = chosenPath ?? candidate?.path
    if (!pending || !path) throw new Error('Подходящий ожидаемый файл не найден. Выберите JAR вручную.')
    const { job, entry, row } = pending
    const { hash } = await this.validate(path, entry, job.plan.public.profile, true)
    if (!chosenPath && candidate?.hash !== hash) throw new Error('Файл в загрузках изменился.')
    if (!this.pendingFile(key)) throw new Error('Задание уже изменилось.')
    job.files.set(key, { path, hash })
    this.candidates.delete(key)
    delete row.candidate
    row.status = 'verified'
    row.error = undefined
    this.emit()
    void this.run()
  }

  private async scan(folder: string, timer: NodeJS.Timeout) {
    if (this.scanning || ![...this.jobs.values()].some(job => job.rows.some(row => this.pendingFile(row.key)))) return
    this.scanning = true
    try {
      const files = (await readdir(folder, { withFileTypes: true })).filter(entry => entry.isFile() && /\.jar$/i.test(entry.name))
      const nameSet = new Set(files.map(file => file.name))
      for (const name of this.observed.keys()) if (!nameSet.has(name)) this.observed.delete(name)
      for (const file of files) {
        if (this.monitor !== timer) return
        const path = join(folder, file.name)
        const stat = await lstat(path).catch(() => undefined)
        if (!stat?.isFile()) continue
        const signature = stat.size + ':' + stat.mtimeMs + ':' + stat.ctimeMs
        const ready = this.observed.get(file.name) === signature
        this.observed.set(file.name, signature)
        if (!ready) continue
        for (const job of this.jobs.values()) for (const row of job.rows) {
          const match = this.pendingFile(row.key)
          if (!match || this.candidates.has(row.key)) continue
          const expected = match.entry.version.file!
          if (expected.size && expected.size !== stat.size) continue
          const check = row.key + ':' + file.name + ':' + signature
          if (this.examined.has(check)) continue
          if (this.examined.size >= 5000) this.examined.clear()
          this.examined.add(check)
          const matchFile = await this.validate(path, match.entry, job.plan.public.profile, true).catch(() => undefined)
          if (matchFile && this.monitor === timer && this.pendingFile(row.key)) {
            this.candidates.set(row.key, { path, hash: matchFile.hash })
            row.candidate = file.name
            this.emit()
          }
        }
      }
    } finally { this.scanning = false }
  }

  hasPending(profileId: string) {
    return [...this.jobs.values()].some(job => !job.done && job.plan.public.profile.id === profileId)
  }

  busy() {
    return this.locked.size > 0 || [...this.jobs.values()].some(job => !job.done)
  }

  retry(id: string, allowRunning: boolean) {
    const job = this.jobs.get(id)
    if (!job || !job.done || !job.rows.some(row => row.status === 'cancelled' || row.status === 'failed')) return
    this.jobs.delete(id)
    this.enqueue(job.plan, allowRunning)
  }

  async lock<T>(profile: Profile, operation: () => Promise<T>): Promise<T> {
    if (this.locked.has(profile.id)) throw new Error('Для этой сборки уже выполняется изменение.')
    this.locked.add(profile.id)
    try { return await operation() } finally { this.locked.delete(profile.id) }
  }

  private async run() {
    if (this.running) return
    this.running = true
    try {
      for (const job of this.jobs.values()) {
        if (job.done || !job.controller.signal.aborted && job.rows.some(row => row.status === 'waiting')) continue
        let paused = false
        try {
          job.controller.signal.throwIfAborted()
          const summary = await this.lock(job.plan.public.profile, () => this.execute(job, this.store.state().settings))
          if (summary === waiting) { paused = true; continue }
          for (const row of job.rows) { row.status = 'installed'; row.speed = 0 }
          this.changed(job.plan.public.profile.id, summary)
        } catch (error) {
          for (const row of job.rows) {
            row.status = job.controller.signal.aborted ? 'cancelled' : 'failed'
            row.speed = 0
            row.error = job.controller.signal.aborted ? undefined : error instanceof Error ? error.message : String(error)
          }
        } finally {
          job.done = !paused
          this.emit()
        }
      }
    } finally {
      this.running = false
      if ([...this.jobs.values()].some(job => !job.done && (job.controller.signal.aborted || !job.rows.some(row => row.status === 'waiting'))))
        void this.run()
    }
  }

  private async execute(job: Job, settings: Settings) {
    const { plan, controller, rows, allowRunning } = job
    const profile = plan.public.profile
    const replacing = plan.downloads.flatMap(entry => entry.previous ? [entry.previous] : [])
    const updating = replacing.length > 0
    const check = async () => {
      if (updating && this.launched(profile.id)) throw new Error('Закройте Minecraft в этой сборке и повторите обновление.')
      await checkGame(!updating && allowRunning, updating ? profile.directory : undefined)
    }
    this.store.profile(profile.id)
    await check()
    await mkdir(this.tempPath, { recursive: true })
    const temp = await mkdtemp(join(this.tempPath, 'install-'))
    let staging: string | undefined
    let backup: string | undefined
    try {
      const downloads = plan.downloads
      const sources: [string, Source][] = []
      const downloaded: LocalMod[] = []
      let index = 0
      const stop = new AbortController()
      const signal = AbortSignal.any([controller.signal, stop.signal])
      let failure: unknown
      const worker = async () => {
        while (index < downloads.length && !signal.aborted) {
          const position = index++
          const entry = downloads[position]
          const row = rows.find(item => item.key === job.id + ':' + entry.item.key)!
          row.status = 'downloading'
          this.emit()
          try {
            const path = join(temp, String(position) + '.jar')
            const manual = job.files.get(row.key)
            if (manual) await copyFile(manual.path, path, constants.COPYFILE_EXCL)
            else await download(entry.version.file!, path, signal, (received, speed) => {
              Object.assign(row, { received, speed })
              this.emit()
            }, contentSource(entry.version.projectId))
            const { hash, mod } = await this.validate(path, entry, profile, Boolean(manual))
            if (manual && manual.hash !== hash) throw new Error('Файл в загрузках изменился после подтверждения.')
            downloaded.push(mod)
            if (entry.version.projectId) sources.push([hash, { projectId: entry.version.projectId, versionId: entry.version.id }])
            row.status = 'verified'
            row.speed = 0
            this.emit()
          } catch (error) {
            failure ??= new Error(entry.item.filename + ': ' + (error instanceof Error ? error.message : String(error)))
            stop.abort()
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(settings.parallel, downloads.length) }, worker))
      controller.signal.throwIfAborted()
      if (failure) throw failure
      const directory = await modsPath(profile, true)
      staging = await mkdtemp(join(directory, '.modkit-'))
      const placements: Place[] = []
      for (const [index, entry] of downloads.entries()) {
        const from = join(staging, String(index))
        await copyFile(join(temp, String(index) + '.jar'), from, constants.COPYFILE_EXCL)
        const target = entry.item.filename! + (entry.previous?.enabled === false ? '.disabled' : '')
        placements.push({ from, to: join(directory, target), move: false })
      }
      placements.push(...plan.enables.map(entry => ({ from: join(directory, entry.from), to: join(directory, entry.to), move: true })))

      const current = await scanMods(profile, this.store, true)
      const currentByFile = new Map(current.map(item => [item.file, item]))
      for (const item of plan.installed) {
        if (currentByFile.get(item.file)?.sha512 !== item.hash) throw new Error('Зависимости изменились после предпросмотра. Создайте новый план.')
      }
      for (const entry of plan.enables) {
        if (currentByFile.get(entry.from)?.sha512 !== entry.hash) throw new Error('Отключённая зависимость изменилась. Создайте новый план.')
      }
      const replacedFiles = new Set(replacing.map(item => item.file))
      for (const item of replacing) {
        if (currentByFile.get(item.file)?.sha512 !== item.sha512 || current.some(mod => mod.projectId === item.projectId && mod.file !== item.file)) {
          throw new Error('Установленный файл «' + item.file + '» изменился после предпросмотра. Проверьте обновления заново.')
        }
      }
      const enabling = new Set(plan.enables.map(item => item.from))
      const disabledTargets = new Set(downloads.filter(entry => entry.previous?.enabled === false).map(entry => entry.item.filename))
      const additions = [...current.filter(item => enabling.has(item.file)), ...downloaded.filter(item => !disabledTargets.has(item.file))]
      const remaining = current.filter(item => item.enabled && !replacedFiles.has(item.file))
      assertNoDuplicates(additions, remaining)
      const missing = missingRequirements(additions, [...remaining, ...additions])
      if (missing.length) {
        const expanded = await this.resolveRequirements?.(profile, [...remaining, ...additions, ...current.filter(item => !item.enabled)], missing)
        if (!expanded || expanded.public.blockers.length) throw new Error(expanded?.public.blockers.join(' ') || 'Отсутствуют зависимости: ' + missing.map(item => item.modId).join(', '))
        const keys = new Set(plan.downloads.map(entry => entry.item.key))
        const occupied = new Set(plan.downloads.map(entry => entry.item.filename?.toLowerCase()))
        const extra = expanded.downloads.filter(entry => !keys.has(entry.item.key) && !occupied.has(entry.item.filename?.toLowerCase()))
        const enables = expanded.enables.filter(entry => !enabling.has(entry.from))
        if ((!extra.length && !enables.length) || plan.downloads.length + extra.length > 180) {
          throw new Error('Требуются совместимые версии зависимостей: ' + missing.map(item => item.modId + (item.range ? ' ' + item.range : '')).join(', '))
        }
        plan.downloads.push(...extra)
        plan.enables.push(...enables)
        rows.push(...extra.map(entry => this.row(job.id, profile, entry.item, updating)),
          ...enables.map(entry => this.row(job.id, profile, { key: entry.from, name: entry.to, version: '', size: 0, status: 'enable' }, updating)))
        for (const row of rows) if (row.status === 'verified' && !job.files.has(row.key)) row.status = 'queued'
        this.emit()
        return waiting
      }
      await check()
      if (!updating && downloads.some(entry => entry.item.inputIndex !== undefined)) assertUpdateRequirements(current.filter(item => item.enabled), remaining, additions)
      if (updating) {
        assertUpdateRequirements(current.filter(item => item.enabled), remaining, additions)
        const recovery = join(profile.directory, '.modkit-updates')
        await mkdir(recovery, { recursive: true })
        if ((await realpath(recovery)).toLowerCase() !== recovery.toLowerCase()) throw new Error('Папка резервных версий перенаправлена.')
        const batch = await mkdtemp(join(recovery, 'mods-'))
        backup = batch
        placements.unshift(...replacing.map(mod => ({ from: join(directory, mod.file), to: join(batch, mod.file), move: true })))
      }
      controller.signal.throwIfAborted()
      const activity = updating ? 'Обновлено модов: ' + replacing.length : 'Установлено или включено модов: ' + rows.length
      await transaction(placements, () => this.store.record(profile.id, activity, sources))
      return activity
    } finally {
      await Promise.allSettled([
        rm(temp, { recursive: true, force: true }),
        ...(staging ? [rm(staging, { recursive: true, force: true })] : []),
        ...(backup ? [rmdir(backup)] : []),
      ])
    }
  }
}

function missingRequirements(additions: LocalMod[], mods: LocalMod[]): RemoteDependency[] {
  const missing = new Map<string, RemoteDependency>()
  const checked = new Set(additions)
  for (const mod of checked) for (const rule of mod.requirements) {
    if (rule.optional || rule.conflict || platformMod(rule.id)) continue
    const supplier = mods.find(candidate => {
      const version = candidate.ids.includes(rule.id) ? candidate.version : candidate.bundled?.[rule.id]
      return version !== undefined && satisfies(version, rule.range) === true
    })
    if (supplier) checked.add(supplier)
    else missing.set(rule.id + ':' + (rule.range ?? ''), { kind: 'required', modId: rule.id, range: rule.range })
  }
  return [...missing.values()]
}

function assertUpdateRequirements(before: LocalMod[], remaining: LocalMod[], additions: LocalMod[]) {
  const after = [...remaining, ...additions]
  const provisions = (mods: LocalMod[]) => {
    const result = new Map<string, LocalMod>()
    for (const mod of mods) for (const id of mod.ids) result.set(id, mod)
    return result
  }
  const old = provisions(before)
  const updated = provisions(after)
  const added = new Set(additions)
  for (const mod of after) {
    for (const rule of mod.requirements) {
      if (rule.optional || platformMod(rule.id)) continue
      const previous = old.get(rule.id)
      const next = updated.get(rule.id)
      if (!added.has(mod) && previous === next) continue
      const mismatch = next && (!rule.range || next.id === rule.id) && thresholdMismatch(next.version, rule.range, rule.conflict)
      const missing = !next && previous && !rule.conflict
      if (!mismatch && !missing) continue
      if (!added.has(mod) && previous && thresholdMismatch(previous.version, rule.range, rule.conflict)) continue
      throw new Error(mod.name + ': ' + (rule.conflict ? 'конфликт с ' : 'после обновления требуется ') + rule.id +
        (rule.range ? ' (' + rule.range + ')' : '') + '.')
    }
  }
}

function assertNoDuplicates(newMods: LocalMod[], current: LocalMod[]) {
  const ids = new Map(current.flatMap(item => item.ids.map(id => [id, item.file] as const)))
  for (const item of newMods) {
    for (const id of new Set(item.ids)) {
      if (ids.has(id)) throw new Error('Мод «' + id + '» уже есть в файле ' + ids.get(id) + '.')
      ids.set(id, item.file)
    }
  }
}

export async function changeMods(store: Store, profile: Profile, files: string[], action: 'enable' | 'disable' | 'remove') {
  const directory = await modsPath(profile)
  const mods = await scanMods(profile, store, true)
  const unique = new Set(files)
  const targets = mods.filter(mod => unique.has(mod.file))
  if (targets.length !== unique.size || !targets.length) throw new Error('Список модов изменился. Обновите страницу.')
  if (action === 'enable') {
    const inactive = targets.filter(mod => !mod.enabled)
    assertNoDuplicates(inactive, mods.filter(mod => mod.enabled))
    for (const mod of inactive) {
      const compatibility = profileIssue(mod, profile)
      if (compatibility) throw new Error(mod.file + ': ' + compatibility)
    }
  }
  if (action === 'remove') {
    const recovery = join(profile.directory, '.modkit-removed')
    await mkdir(recovery, { recursive: true })
    if ((await realpath(recovery)).toLowerCase() !== recovery.toLowerCase()) throw new Error('Папка удалённых файлов перенаправлена.')
    const batch = await mkdtemp(join(recovery, 'mods-'))
    await transaction(targets.map(mod => ({ from: join(directory, mod.file), to: join(batch, mod.file), move: true })),
      () => store.record(profile.id, 'Удалено модов: ' + targets.length))
  } else {
    const placements = targets.filter(mod => mod.enabled === (action === 'disable')).map(mod => ({
      from: join(directory, mod.file),
      to: join(directory, action === 'enable' ? mod.file.replace(/\.disabled$/i, '') : mod.file + '.disabled'), move: true
    }))
    if (placements.length) await transaction(placements, () => store.record(profile.id, (action === 'enable' ? 'Включено модов: ' : 'Отключено модов: ') + placements.length))
  }
}

export async function importJars(store: Store, profile: Profile, paths: string[], requirement?: Requirement) {
  const directory = await modsPath(profile, true)
  const staging = await mkdtemp(join(directory, '.modkit-import-'))
  try {
    const mods: LocalMod[] = []
    const placements: Place[] = []
    for (const [index, path] of paths.entries()) {
      const file = basename(path)
      if (!isJar(file) || !file.toLowerCase().endsWith('.jar') || !(await lstat(path)).isFile()) throw new Error('Импорт поддерживает обычные JAR-файлы.')
      const from = join(staging, String(index))
      await copyFile(path, from, constants.COPYFILE_EXCL)
      const mod = await inspectJar(from, file, profile.loader)
      if (mod.issue) throw new Error(file + ': ' + mod.issue)
      const compatibility = profileIssue(mod, profile)
      if (compatibility) throw new Error(file + ': ' + compatibility)
      if (requirement) {
        if (!mod.ids.includes(requirement.id)) throw new Error('Этот JAR не содержит зависимость «' + requirement.id + '».')
        if (mod.id === requirement.id && thresholdMismatch(mod.version, requirement.range)) {
          throw new Error('Для «' + requirement.id + '» требуется версия ' + requirement.range + '.')
        }
      }
      mods.push(mod)
      placements.push({ from, to: join(directory, file), move: false })
    }
    assertNoDuplicates(mods, await scanMods(profile, store, true))
    await transaction(placements, () => store.record(profile.id, 'Импортировано модов: ' + mods.length))
    return mods.length
  } finally { await rm(staging, { recursive: true, force: true }).catch(() => undefined) }
}
