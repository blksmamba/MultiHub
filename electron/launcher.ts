import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { delimiter, join } from 'node:path'
import { gameMemory, validNickname, type GameLaunchState, type LauncherDraft, type LauncherLoader, type Profile } from '../src/shared'
import type { Store } from './db'
import { archiveJson, download, downloadAll, extractNatives, jsonFile, localPath, remoteHash, type Download } from './launcher-files'
import { forgeArtifact, javaManifest, LauncherMetadata, libraryFiles, minecraftAssets, resolveArguments, validId, type GameLibrary, type JavaFiles, type JavaIndex, type VersionProfile } from './launcher-meta'

interface AssetIndex { objects: Record<string, { hash: string; size: number }> }
const idle: GameLaunchState = { status: 'idle', message: '', total: 0, ready: 0, bytes: 0 }
const startSignal = () => AbortSignal.timeout(35000)
const javaEnv = { ...process.env, JAVA_TOOL_OPTIONS: undefined, _JAVA_OPTIONS: undefined, JDK_JAVA_OPTIONS: undefined, CLASSPATH: undefined }

export function gameMemoryLimit() {
  const systemMiB = totalmem() / 1024 ** 2
  const availableMiB = systemMiB - 2048
  return Math.max(gameMemory.min, Math.floor(availableMiB / gameMemory.step) * gameMemory.step)
}

function offlineUuid(username: string) {
  const bytes = createHash('md5').update('OfflinePlayer:' + username, 'utf8').digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
}

function message(error: unknown) {
  if (error instanceof TypeError && error.message === 'fetch failed') return 'Не удалось подключиться к серверам загрузки Minecraft.'
  return error instanceof Error ? error.message : String(error)
}

export class Launcher {
  private readonly meta: LauncherMetadata
  private readonly common: string
  private current = idle
  private controller?: AbortController

  constructor(private readonly root: string, private readonly store: Store, private readonly changed: (state: GameLaunchState) => void) {
    this.common = join(root, 'files')
    this.meta = new LauncherMetadata(store)
  }

  state() { return this.current }
  forgetProfile(id: string) {
    if (this.current.profileId === id) {
      this.current = idle
      this.changed(this.current)
    }
  }
  releases() { return this.meta.releases(startSignal()) }
  loaderVersions(game: string, loader: LauncherLoader) {
    if (!['vanilla', 'fabric', 'forge'].includes(loader)) throw new Error('Выберите поддерживаемый загрузчик.')
    return this.meta.loaders(game, loader, startSignal())
  }

  async create(data: LauncherDraft) {
    if (!data || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 75 ||
      !validNickname(data.nickname) ||
      !validId(data.game) || !['vanilla', 'fabric', 'forge'].includes(data.loader)) {
      throw new Error('Проверьте название сборки, версию игры и ник (3–16 букв, цифр или знаков подчёркивания).')
    }
    if (!(await this.releases()).some(version => version.id === data.game)) throw new Error('Версия Minecraft не найдена.')
    const choices = await this.loaderVersions(data.game, data.loader)
    const loaderVersion = data.loader === 'vanilla' ? '' :
      (data.loaderVersion ? choices.find(item => item.id === data.loaderVersion) : choices.find(item => item.recommended))?.id
    if (loaderVersion === undefined) throw new Error('Подходящая версия загрузчика не найдена.')
    const folder = join(this.root, 'instances')
    await mkdir(folder, { recursive: true })
    const directory = join(await realpath(folder), randomUUID())
    await mkdir(directory)
    return this.store.save({
      name: data.name.trim(), directory, game: data.game, loader: data.loader, loaderVersion,
      launcher: { nickname: data.nickname, installed: false },
    })
  }

  private update(update: Partial<GameLaunchState>) {
    this.current = { ...this.current, ...update }
    this.changed(this.current)
  }

  start(profile: Profile, intent: 'install' | 'launch' = 'launch') {
    if (!profile.launcher) throw new Error('Эта сборка подключена из другого лаунчера.')
    if (this.current.status === 'preparing' || this.current.status === 'running') throw new Error('Minecraft уже запускается или работает.')
    this.controller = new AbortController()
    const signal = this.controller.signal
    this.current = idle
    this.update({ status: 'preparing', intent, profileId: profile.id, message: 'Читаем метаданные Minecraft…' })
    return this.prepare(profile, signal, intent).catch(async error => {
      const reason = message(error)
      if (!signal.aborted && this.current.logProfileId) {
        await appendFile(join(profile.directory, 'modkit-launch.log'), '\r\n' + reason + '\r\n').catch(() => undefined)
      }
      this.update({ status: signal.aborted ? 'cancelled' : 'failed', message: signal.aborted ? 'Подготовка отменена. Можно продолжить позже.' : reason })
    }).finally(() => { this.controller = undefined })
  }

  cancel() {
    if (this.current.status === 'preparing') this.controller?.abort()
  }

  private async fetchFiles(label: string, files: Download[], signal: AbortSignal) {
    this.update({ message: label, ready: 0, total: files.length, bytes: 0 })
    await downloadAll(files, signal, (ready, total, bytes) => this.update({ ready, total, bytes }))
  }

  private async java(profile: VersionProfile, signal: AbortSignal) {
    const component = profile.javaVersion?.component
    if (!component || !validId(component)) throw new Error('Для этой версии не найдена среда Java.')
    const index = await this.meta.cached<JavaIndex>(javaManifest, signal, 86400000)
    const entry = index['windows-x64']?.[component]?.find(item => item.availability?.progress === 100) ?? index['windows-x64']?.[component]?.[0]
    if (!entry || !validId(entry.version.name)) throw new Error('Среда Java для Windows x64 недоступна.')
    const root = localPath(this.root, 'java/' + component + '/' + entry.version.name)
    const listPath = join(root, 'manifest.json')
    await download({ ...entry.manifest, target: listPath }, signal)
    const list = await jsonFile<JavaFiles>(listPath)
    const files: Download[] = []
    for (const [key, item] of Object.entries(list.files)) {
      const target = localPath(root, key)
      if (item.type === 'file' && item.downloads?.raw) files.push({ ...item.downloads.raw, target })
      else if (item.type === 'directory') await mkdir(target, { recursive: true })
      else throw new Error('Неподдерживаемая запись в манифесте Java: ' + key)
    }
    await this.fetchFiles('Подготавливаем Java ' + profile.javaVersion?.majorVersion, files, signal)
    return join(root, 'bin', 'java.exe')
  }

  private async installForge(profile: Profile, java: string, log: string, signal: AbortSignal) {
    const artifact = forgeArtifact(profile.game, profile.loaderVersion)
    const target = localPath(this.common, 'versions/' + artifact.id + '/' + artifact.id + '.json')
    const marker = localPath(this.common, 'forge/' + artifact.id + '.ready')
    const prepared = await lstat(marker).catch(() => undefined)
    if (prepared?.isFile()) {
      try { return await jsonFile<VersionProfile>(target) }
      catch { /* Restore a missing or unreadable Forge profile. */ }
    }
    this.update({ message: 'Загружаем установщик Forge ' + profile.loaderVersion, total: 0, ready: 0, bytes: 0 })
    const installer = localPath(this.common, 'forge/' + artifact.id + '-installer.jar')
    await download({ ...artifact, target: installer, sha1: await remoteHash(artifact.url, signal) }, signal)
    const manifest = await archiveJson<{ json: string; libraries?: GameLibrary[] }>(installer, 'install_profile.json')
    if (typeof manifest.json !== 'string') throw new Error('Установщик Forge не содержит клиентский профиль.')
    const version = await archiveJson<VersionProfile>(installer, manifest.json.replace(/^\//, ''))
    const libraries = [...manifest.libraries ?? [], ...version.libraries].flatMap(library => {
      const file = library.downloads?.artifact
      return file?.url && file.path ? [{ ...file, target: localPath(join(this.common, 'libraries'), file.path) }] : []
    })
    await this.fetchFiles('Загружаем библиотеки Forge', libraries, signal)
    this.update({ message: 'Устанавливаем Forge ' + profile.loaderVersion, total: 0, ready: 0, bytes: 0 })
    await writeFile(join(this.common, 'launcher_profiles.json'), JSON.stringify({ profiles: {} }), { flag: 'wx' }).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
    const handle = await open(log, 'a')
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(java, ['-Djava.awt.headless=true', '-jar', installer, '--offline', '--installClient', this.common], {
          windowsHide: true, cwd: this.common, env: javaEnv, stdio: ['ignore', handle.fd, handle.fd],
          signal: AbortSignal.any([signal, AbortSignal.timeout(12 * 60 * 1000)]),
        })
        child.once('error', reject)
        child.once('close', code => code === 0 ? resolve() : reject(new Error('Установщик Forge завершился с кодом ' + code + '. Откройте журнал запуска.')))
      })
    } finally { await handle.close() }
    let metadata: VersionProfile
    try { metadata = await jsonFile<VersionProfile>(target) }
    catch { throw new Error('Forge не создал клиентский профиль. Откройте журнал запуска.') }
    await writeFile(marker, 'ok', 'utf8')
    return metadata
  }

  private async prepare(profile: Profile, signal: AbortSignal, intent: 'install' | 'launch') {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Лаунчер рассчитан на Windows x64.')
    const instanceRoot = await realpath(join(this.root, 'instances'))
    const directory = await realpath(profile.directory)
    if (directory.toLowerCase() !== profile.directory.toLowerCase() || join(instanceRoot, directory.split(/[\\/]/).at(-1)!) !== directory) {
      throw new Error('Папка сборки перенаправлена за пределы MultiHub.')
    }
    const log = join(directory, 'modkit-launch.log')
    await writeFile(log, 'MultiHub · ' + profile.name + ' · Minecraft ' + profile.game + '\r\n', 'utf8')
    this.update({ logProfileId: profile.id })
    const vanilla = await this.meta.vanilla(profile.game, this.common, signal)
    const index = vanilla.assetIndex
    const jar = vanilla.downloads?.client
    if (!index || !jar || !vanilla.arguments) throw new Error('Этот формат версии Minecraft пока не поддерживается.')
    const appJar = localPath(this.common, 'versions/' + profile.game + '/' + profile.game + '.jar')
    const indexPath = localPath(this.common, 'assets/indexes/' + index.id + '.json')
    const logging = vanilla.logging?.client
    const logConfig = logging && localPath(this.common, 'assets/log_configs/' + logging.file.id)
    const core: Download[] = [{ ...jar, target: appJar }, { ...index, target: indexPath }]
    if (logging && logConfig) core.push({ ...logging.file, target: logConfig })
    await this.fetchFiles('Загружаем клиент Minecraft', core, signal)

    const java = await this.java(vanilla, signal)
    const loader = profile.loader === 'fabric' ? await this.meta.fabric(profile.game, profile.loaderVersion, signal) :
      profile.loader === 'forge' ? await this.installForge(profile, java, log, signal) : undefined
    if (loader && loader.inheritsFrom !== vanilla.id) throw new Error('Загрузчик предназначен для другой версии Minecraft.')
    const librariesDir = join(this.common, 'libraries')
    const libraries = libraryFiles(librariesDir, [...vanilla.libraries, ...(loader?.libraries ?? [])])
    const assetFiles = await jsonFile<AssetIndex>(indexPath)
    const assets = Object.values(assetFiles.objects).map(item => {
      if (!/^[a-f0-9]{40}$/.test(item.hash)) throw new Error('Недопустимый хеш ресурса Minecraft.')
      const relative = item.hash.slice(0, 2) + '/' + item.hash
      return { target: localPath(this.common, 'assets/objects/' + relative), url: minecraftAssets + relative, sha1: item.hash, size: item.size }
    })
    await this.fetchFiles('Загружаем библиотеки и ресурсы', [...libraries.artifacts, ...libraries.natives.map(item => item.file), ...assets], signal)
    const nativeDir = join(directory, '.modkit-natives')
    await mkdir(nativeDir, { recursive: true })
    for (const item of libraries.natives) await extractNatives(item.file.target, nativeDir, item.excludes, signal)
    signal.throwIfAborted()
    this.store.markGameInstalled(profile.id)
    if (intent === 'install') {
      this.update({ status: 'ready', message: 'Minecraft установлен. Сборку можно запускать.', total: 0, ready: 0, bytes: 0 })
      return
    }

    const username = profile.launcher!.nickname
    const values = {
      auth_player_name: username, auth_uuid: offlineUuid(username), auth_access_token: '0', auth_session: '0',
      user_properties: '{}', user_type: 'legacy', clientid: '', auth_xuid: '',
      version_name: loader?.id ?? vanilla.id, version_type: vanilla.type ?? 'release',
      game_directory: directory, assets_root: join(this.common, 'assets'), assets_index_name: index.id,
      game_assets: join(this.common, 'assets'), natives_directory: nativeDir,
      launcher_name: 'MultiHub', launcher_version: '0.2.29',
      classpath: [...libraries.artifacts.map(file => file.target), appJar].join(delimiter),
      classpath_separator: delimiter, library_directory: librariesDir,
      path: logConfig ?? '',
    }
    const jvm = resolveArguments([...vanilla.arguments.jvm ?? [], ...loader?.arguments?.jvm ?? []], values)
      .filter(arg => !arg.startsWith('-Xmx') && !arg.startsWith('-XX:MaxHeapSize='))
    const game = resolveArguments([...vanilla.arguments.game ?? [], ...loader?.arguments?.game ?? []], values)
    if (logging) jvm.push(...resolveArguments([logging.argument], values))
    this.update({ message: 'Запускаем Minecraft…', total: 0, ready: 0, bytes: 0 })
    const configured = profile.launcher?.heapMiB ?? gameMemory.default
    const selected = Number.isInteger(configured) && configured >= gameMemory.min ? configured : gameMemory.default
    const heapMiB = Math.min(selected, gameMemoryLimit())
    await this.spawnGame(java, ['-Xmx' + heapMiB + 'M', ...jvm, loader?.mainClass ?? vanilla.mainClass, ...game], directory, log, profile.id)
  }

  private async spawnGame(java: string, args: string[], directory: string, log: string, id: string) {
    const file = await open(log, 'a')
    try {
      const child = spawn(java, args, { windowsHide: true, detached: true, cwd: directory, env: javaEnv, stdio: ['ignore', file.fd, file.fd] })
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      this.update({ status: 'running', message: 'Minecraft запущен.', pid: child.pid })
      child.once('exit', (code, reason) => {
        if (this.current.profileId !== id) return
        this.update({ status: code === 0 ? 'finished' : 'failed', pid: undefined,
          message: code === 0 ? 'Minecraft закрыт.' : 'Minecraft завершился с кодом ' + (code ?? reason) + '. Откройте журнал запуска.' })
        void appendFile(log, '\r\nMinecraft exit: ' + (code ?? reason) + '\r\n').catch(() => undefined)
      })
      child.unref()
    } finally { await file.close() }
  }
}
