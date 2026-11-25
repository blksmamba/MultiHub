import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from 'electron'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lstat, realpath } from 'node:fs/promises'
import { defaultSettings, gameMemory, interfaceScales, loaders, validInterfaceScale, shaderStyles, validNickname, webUrl, type AppUpdateAction, type ArchiveKind, type CatalogQuery, type LauncherDraft, type LauncherLoader, type Profile, type ProfileInput, type ProfileSettings, type Settings, type ShaderStyle, type Theme } from '../src/shared'
import { Store } from './db'
import { discover, inspectDirectory } from './discovery'
import { checkGame, changeMods, importJars, Installer } from './installer'
import { gameContentPath, isJar, modsPath, scanMods } from './jars'
import { importShaderPack, installShaderPack, listShaderPacks, localPacks, shaderRecommendation } from './shaders'
import { Modrinth } from './provider'
import { ContentCatalog, CurseForge } from './content'
import { installArchive, worlds } from './archives'
import { optiFineFor, saveOptiFine } from './optifine'
import { resolvePlan, type ResolvedPlan } from './resolver'
import { checkModUpdates } from './updates'
import { gameMemoryLimit, Launcher } from './launcher'
import { explorerIntegration, importArgument, maxExplorerFiles, readExplorerBatch, setExplorerIntegration } from './explorer'
import { planJarBatch } from './batch-import'
import { AppUpdates } from './app-updater'

const dev = !app.isPackaged && process.env.MODKIT_DEV === '1'
const html = join(__dirname, '../dist/index.html')
const target = dev ? 'http://127.0.0.1:5173/' : pathToFileURL(html).href
const windowBackground: Record<Theme, string> = { light: '#f5f5f2', dark: '#15171b' }
let window: BrowserWindow | null = null
if (app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  // Upgrades keep using the same profiles, worlds, and database.
  app.setPath('userData', join(app.getPath('appData'), 'ModKit'))
}
app.setAppUserModelId('app.modkit.desktop')

function register() {
  const store = new Store(join(app.getPath('userData'), 'modkit.sqlite'))
  const launcher = new Launcher(join(app.getPath('userData'), 'minecraft'), store,
    status => window?.webContents.send('modkit:game-status', status))
  const provider = new Modrinth(store)
  const catalog = new ContentCatalog(provider, store, join(app.getPath('userData'), 'local-content'),
    process.env.MULTIHUB_CURSEFORGE_API_KEY?.trim(), process.env.MULTIHUB_GITHUB_TOKEN?.trim())
  const curseForgeKey = process.env.MULTIHUB_CURSEFORGE_API_KEY?.trim()
  const mapSource = curseForgeKey ? new CurseForge(store, curseForgeKey) : undefined
  const authorizedPaths = new Set<string>()
  const plans = new Map<string, { resolved: ResolvedPlan; date: number }>()
  const imports = new Map<string, string[]>()
  const publicImports = () => [...imports].map(([id, paths]) => ({ id, files: paths.map(path => basename(path)) }))
  const sendImports = () => window?.webContents.send('modkit:explorer-imports', publicImports())
  const contentChanged = (id: string) => window?.webContents.send('modkit:mods-changed', id)
  const installer = new Installer(store, join(app.getPath('userData'), 'downloads'),
    rows => window?.webContents.send('modkit:transfers-changed', rows),
    (profile, summary) => {
      contentChanged(profile)
      if (store.state().settings.notify && !window?.isFocused() && Notification.isSupported()) {
        new Notification({ title: 'MultiHub', body: summary }).show()
      }
    }, profileId => {
      const game = launcher.state()
      return game.profileId === profileId && (game.status === 'preparing' || game.status === 'running')
    }, (profile, local, missing) => resolvePlan(catalog, profile, local, '', undefined, [], undefined, missing))
  const appUpdates = new AppUpdates(store, status => window?.webContents.send('modkit:app-update', status), () =>
    ['preparing', 'running'].includes(launcher.state().status) || installer.busy())

  function handle<T extends unknown[]>(name: string, callback: (...args: T) => unknown) {
    ipcMain.handle('modkit:' + name, (event, ...args) => {
      if (!window || event.sender !== window.webContents || event.senderFrame?.url !== target || event.senderFrame.parent) throw new Error('Источник запроса не разрешён.')
      return callback(...args as T)
    })
  }

  const token = (id: string) => {
    if (typeof id !== 'string' || !/^(?:[a-z0-9_-]{1,100}|jar_[a-f0-9]{128})$/i.test(id)) throw new Error('Некорректный идентификатор.')
    return id
  }
  const field = (value: string, limit = 100) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
  const safeGame = (value: string) => /^[a-z0-9.+_-]{1,40}$/i.test(value)
  const profileFor = (id: string) => store.profile(token(id))

  async function identify(profile: Profile) {
    const mods = await scanMods(profile, store)
    const hashes = [...new Set(mods.filter(item => !item.projectId && item.sha512).map(item => item.sha512))]
    for (let index = 0; index < hashes.length; index += 100) {
      for (const [hash, entry] of Object.entries(await catalog.identify(hashes.slice(index, index + 100)))) {
        store.addSource(hash, { projectId: entry.projectId, versionId: entry.id })
      }
    }
    return mods.map(mod => ({ ...mod, ...store.source(mod.sha512) }))
  }

  handle('window', (action: string) => {
    if (action === 'minimize') window?.minimize()
    if (action === 'maximize' && window) window.isMaximized() ? window.unmaximize() : window.maximize()
    if (action === 'close') window?.close()
  })
  handle('state', () => store.state())
  handle('app-update-state', () => appUpdates.snapshot())
  handle('app-update', (action: AppUpdateAction) => {
    if (!['check', 'download', 'later', 'install'].includes(action)) throw new Error('Действие обновления недоступно.')
    return appUpdates.action(action)
  })
  handle('discover', async () => {
    const candidates = await discover(app.getPath('appData'), process.env.LOCALAPPDATA ?? app.getPath('appData'))
    for (const item of candidates) authorizedPaths.add(item.directory)
    return candidates
  })
  handle('browse', async () => {
    const result = await dialog.showOpenDialog(window!, { title: 'Выберите игровую папку Minecraft', properties: ['openDirectory'] })
    if (result.canceled) return null
    const candidate = await inspectDirectory(result.filePaths[0])
    authorizedPaths.add(candidate.directory)
    return candidate
  })
  handle('save-profile', async (data: ProfileInput) => {
    const name = field(data?.name)
    const game = field(data?.game, 40)
    if (!name || !safeGame(game) || !loaders.some(loader => loader === data?.loader) || !authorizedPaths.has(data?.directory)) throw new Error('Выберите игровую папку, версию Minecraft и загрузчик.')
    const verified = await inspectDirectory(data.directory)
    if (verified.directory !== data.directory) throw new Error('Игровая папка изменилась. Выберите её повторно.')
    return store.save({ name, directory: data.directory, game, loader: data.loader, loaderVersion: field(data.loaderVersion) })
  })
  handle('select-profile', (id: string) => store.select(token(id)))
  handle('game-memory-limit', gameMemoryLimit)
  handle('update-profile-settings', (id: string, settings: ProfileSettings) => {
    const profile = profileFor(id)
    const name = typeof settings?.name === 'string' ? settings.name.trim() : ''
    const heapMiB = settings?.heapMiB
    const nickname = settings?.nickname
    if (!name || name.length > 100) throw new Error('Введите название длиной до 100 символов.')
    if (heapMiB !== undefined) {
      if (!profile.launcher) throw new Error('Память внешней сборки задаётся в её лаунчере.')
      if (!Number.isInteger(heapMiB) || heapMiB < gameMemory.min || heapMiB > gameMemoryLimit() || heapMiB % gameMemory.step !== 0) {
        throw new Error('Выберите объём памяти в доступном диапазоне.')
      }
    }
    if (nickname !== undefined) {
      if (!profile.launcher) throw new Error('Ник внешней сборки задаётся в её лаунчере.')
      if (nickname !== null && !validNickname(nickname)) throw new Error('В нике должно быть от 3 до 16 латинских букв, цифр или знаков подчёркивания.')
    }
    return store.updateProfileSettings(profile, { name, heapMiB, nickname })
  })
  handle('remove-profile', (id: string) => {
    const profile = profileFor(id)
    return installer.lock(profile, async () => {
      if (installer.hasPending(id)) throw new Error('Дождитесь завершения загрузок этой сборки.')
      if (profile.launcher) {
        const game = launcher.state()
        if (game.profileId === id && (game.status === 'preparing' || game.status === 'running')) {
          throw new Error('Закройте игру или отмените запуск перед удалением сборки.')
        }
        await checkGame(false, profile.directory)
        const instances = join(await realpath(app.getPath('userData')), 'minecraft', 'instances')
        const folder = basename(profile.directory)
        const expected = join(instances, folder)
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(folder)
          || expected.toLowerCase() !== profile.directory.toLowerCase()) {
          throw new Error('Папка сборки находится за пределами MultiHub.')
        }
        const info = await lstat(expected).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        if (info) {
          if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(expected)).toLowerCase() !== expected.toLowerCase()) {
            throw new Error('Папка сборки перенаправлена. Проверьте её расположение.')
          }
          await shell.trashItem(expected)
        }
      }
      const state = store.removeProfile(id)
      for (const [key, plan] of plans) if (plan.resolved.public.profile.id === id) plans.delete(key)
      launcher.forgetProfile(id)
      return state
    })
  })
  handle('game-versions', () => launcher.releases())
  handle('game-loader-versions', (game: string, loader: LauncherLoader) => launcher.loaderVersions(game, loader))
  handle('create-game-profile', (data: LauncherDraft) => launcher.create(data))
  handle('game-status', () => launcher.state())
  handle('launch-game', (id: string) => {
    const profile = profileFor(id)
    return installer.lock(profile, () => launcher.start(profile))
  })
  handle('install-game', (id: string) => {
    const profile = profileFor(id)
    return installer.lock(profile, () => launcher.start(profile, 'install'))
  })
  handle('cancel-game', () => launcher.cancel())
  handle('open-game-log', async (id: string) => {
    const profile = profileFor(id)
    if (!profile.launcher) throw new Error('Журнал доступен для сборок MultiHub.')
    const log = join(profile.directory, 'modkit-launch.log')
    if (!(await lstat(log).catch(() => null))?.isFile()) throw new Error('Журнал запуска пока пуст.')
    if (await shell.openPath(log)) shell.showItemInFolder(log)
  })
  handle('open-game-folder', async (id: string) => {
    const profile = profileFor(id)
    if (!profile.launcher) throw new Error('Сборка MultiHub не найдена.')
    const error = await shell.openPath(profile.directory)
    if (error) throw new Error(error)
  })
  handle('set-settings', (changes: Partial<Settings>) => {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
      Object.keys(changes).some(key => !Object.hasOwn(defaultSettings, key)) ||
      ('scale' in changes && !validInterfaceScale(changes.scale)) ||
      ('nickname' in changes && !validNickname(changes.nickname)) ||
      ('layout' in changes && changes.layout !== 'grid' && changes.layout !== 'list') ||
      ('parallel' in changes && ![1, 2, 3, 4, 5].some(value => value === changes.parallel)) ||
      ('notify' in changes && typeof changes.notify !== 'boolean') ||
      ('theme' in changes && changes.theme !== 'light' && changes.theme !== 'dark')) throw new Error('Некорректные настройки.')
    const state = store.updateSettings(changes)
    if (changes.scale) window?.webContents.setZoomFactor(state.settings.scale / 100)
    if (changes.theme) {
      nativeTheme.themeSource = changes.theme
      window?.setBackgroundColor(windowBackground[changes.theme])
    }
    return state
  })
  handle('clear-cache', () => store.clearCache())
  handle('mods', (id: string) => scanMods(profileFor(id), store))
  handle('identify', (id: string) => identify(profileFor(id)))
  handle('mod-updates', async (id: string, refresh?: boolean) => {
    const profile = profileFor(id)
    if (profile.loader === 'vanilla') return { updates: [], checked: 0, unrecognized: 0 }
    return checkModUpdates(await scanMods(profile, store), profile, provider, refresh === true)
  })
  handle('activity', (id: string) => store.history(profileFor(id).id))
  handle('tags', () => provider.tags())
  handle('content-sources', () => catalog.sources())
  handle('add-local-content', async () => {
    const result = await dialog.showOpenDialog(window!, { title: 'Добавить JAR в локальный каталог', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Моды Minecraft', extensions: ['jar'] }] })
    if (result.canceled) return 0
    if (result.filePaths.length > 100) throw new Error('Выберите не более 100 JAR-файлов.')
    return catalog.local.add(result.filePaths)
  })
  handle('search', (query: CatalogQuery) => {
    if (!query || !['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(query.sort) ||
      !['', 'client', 'server'].includes(query.side) || (query.loader && !loaders.some(loader => loader === query.loader)) ||
      (query.game && !safeGame(query.game)) || (query.category && !/^[a-z0-9_-]{1,50}$/i.test(query.category)) ||
      (query.source !== undefined && !catalog.sources().includes(query.source)) ||
      !Number.isInteger(query.offset) || query.offset < 0 || query.offset > 990) throw new Error('Некорректные фильтры каталога.')
    return catalog.search({ ...query, query: field(query.query, 160) })
  })
  handle('detail', (id: string, profileId?: string) => catalog.detail(token(id), profileId ? profileFor(profileId) : undefined))
  handle('plan', async (id: string, project: string, version: string | undefined, optional: string[], installedVersionId?: string) => {
    const profile = profileFor(id)
    if (profile.loader === 'vanilla') throw new Error('Для установки модов создайте сборку с Fabric или Forge.')
    if (!Array.isArray(optional) || optional.length > 50) throw new Error('Слишком много необязательных зависимостей.')
    token(project)
    if (version) token(version)
    if (installedVersionId !== undefined) {
      token(installedVersionId)
      token(version!)
    }
    optional.forEach(token)
    const local = await identify(profile).catch(() => scanMods(profile, store))
    const resolved = await resolvePlan(catalog, profile, local, project, version, optional, installedVersionId)
    for (const [key, value] of plans) if (Date.now() - value.date > 20 * 60 * 1000 || plans.size >= 32) plans.delete(key)
    plans.set(resolved.public.id, { resolved, date: Date.now() })
    return resolved.public
  })
  handle('install', (id: string, allowRunning: boolean) => {
    const item = plans.get(token(id))
    if (!item || Date.now() - item.date > 20 * 60 * 1000) throw new Error('Предпросмотр устарел. Сформируйте новый план установки.')
    installer.enqueue(item.resolved, allowRunning === true)
    plans.delete(id)
  })
  handle('explorer-integration', explorerIntegration)
  handle('set-explorer-integration', setExplorerIntegration)
  handle('explorer-imports', publicImports)
  handle('close-explorer-import', (id: string) => {
    imports.delete(token(id))
    sendImports()
  })
  handle('plan-explorer-import', async (id: string, profileId: string, include: number[]) => {
    const paths = imports.get(token(id))
    if (!paths) throw new Error('Выбранный пакет больше не доступен.')
    const profile = profileFor(profileId)
    if (profile.loader === 'vanilla') throw new Error('Выберите сборку с загрузчиком модов.')
    if (!Array.isArray(include) || include.length > maxExplorerFiles ||
      !include.every(index => Number.isSafeInteger(index) && index >= 0 && index < paths.length)) throw new Error('Некорректный список файлов.')
    const requested = [...new Set(include)].map(key => ({ key, path: paths[key] }))
    const mods = await scanMods(profile, store)
    const resolved = await planJarBatch(catalog, profile, mods, requested)
    for (const [key, value] of plans) if (Date.now() - value.date > 20 * 60000 || plans.size >= 32) plans.delete(key)
    plans.set(resolved.public.id, { resolved, date: Date.now() })
    return resolved.public
  })
  handle('transfers', () => installer.list())
  handle('cancel', (id: string) => installer.cancel(token(id)))
  handle('retry', (id: string, allowRunning: boolean) => installer.retry(token(id), allowRunning === true))
  handle('watch-downloads', (enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('Требуется явно включить отслеживание.')
    installer.watch(enabled ? app.getPath('downloads') : undefined)
  })
  handle('supply-download', async (key: string, pick: boolean) => {
    if (typeof key !== 'string' || key.length > 230 || typeof pick !== 'boolean') throw new Error('Некорректный файл очереди.')
    if (!pick) return installer.supply(key)
    const choice = await dialog.showOpenDialog(window!, { title: 'Выбрать скачанный JAR', properties: ['openFile'],
      filters: [{ name: 'Моды Minecraft', extensions: ['jar'] }] })
    if (!choice.canceled && choice.filePaths[0]) await installer.supply(key, choice.filePaths[0])
  })
  handle('modify', async (id: string, files: string[], action: 'enable' | 'disable' | 'remove', allowRunning: boolean) => {
    if (!Array.isArray(files) || files.length > 500 || !files.every(file => typeof file === 'string' && isJar(file)) || !['enable', 'disable', 'remove'].includes(action)) throw new Error('Некорректное изменение файлов.')
    const profile = profileFor(id)
    await installer.lock(profile, async () => {
      await checkGame(allowRunning === true)
      await changeMods(store, profile, files, action)
      contentChanged(id)
    })
  })
  handle('manual', async (id: string, allowRunning: boolean, dependency?: { file: string; id: string }) => {
    const profile = profileFor(id)
    if (profile.loader === 'vanilla') throw new Error('Для установки модов создайте сборку с Fabric или Forge.')
    if (dependency !== undefined && (!dependency || typeof dependency.file !== 'string' || !isJar(dependency.file) || typeof dependency.id !== 'string')) throw new Error('Некорректная зависимость.')
    const result = await dialog.showOpenDialog(window!, { title: dependency ? 'Импорт JAR зависимости' : 'Импорт JAR-файлов', properties: dependency ? ['openFile'] : ['openFile', 'multiSelections'], filters: [{ name: 'Моды Minecraft', extensions: ['jar'] }] })
    if (result.canceled) return 0
    if (result.filePaths.length > 100) throw new Error('Импортируйте не более 100 файлов за раз.')
    return installer.lock(profile, async () => {
      await checkGame(allowRunning === true)
      const requirement = dependency && (await scanMods(profile, store, true)).find(mod => mod.file === dependency.file)
        ?.requirements.find(rule => rule.id === dependency.id && !rule.conflict)
      if (dependency && !requirement) throw new Error('Требования мода изменились. Откройте его зависимости заново.')
      const count = await importJars(store, profile, result.filePaths, requirement)
      contentChanged(id)
      return count
    })
  })
  handle('show-folder', async (id: string, file?: string) => {
    const profile = profileFor(id)
    if (file) {
      if (!isJar(file)) throw new Error('Некорректное имя файла.')
      const path = join(await modsPath(profile), file)
      if (!(await lstat(path)).isFile()) throw new Error('Файл не найден.')
      shell.showItemInFolder(path)
    } else {
      const directory = await modsPath(profile)
      const stat = await lstat(directory).catch(() => null)
      const error = await shell.openPath(stat?.isDirectory() ? directory : profile.directory)
      if (error) throw new Error(error)
    }
  })
  const archiveKind = (kind: ArchiveKind) => {
    if (kind !== 'resourcepack' && kind !== 'datapack' && kind !== 'world') throw new Error('Неизвестный тип каталога.')
    return kind
  }
  handle('archive-worlds', (id: string) => worlds(profileFor(id)))
  handle('archive-search', (id: string, type: ArchiveKind, query: string, offset: number, sort: CatalogQuery['sort'], compatible: boolean) => {
    const kind = archiveKind(type)
    const game = profileFor(id).game
    if (typeof compatible !== 'boolean' || !Number.isSafeInteger(offset) || offset < 0 || offset >= 990 ||
      !['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(sort)) throw new Error('Некорректные параметры каталога.')
    const version = compatible ? game : ''
    const search = field(query, 160)
    return kind === 'world' ? mapSource?.searchWorlds(version, search, offset, sort) ?? { items: [], total: 0, available: false }
      : provider.searchPacks(kind, version, search, offset, sort)
  })
  handle('archive-install', async (id: string, type: ArchiveKind, project: string, world: string) => {
    const kind = archiveKind(type)
    const profile = profileFor(id)
    const projectId = token(project)
    if (kind === 'world') {
      if (!mapSource) throw new Error('Каталог карт требует разрешённого доступа к CurseForge.')
      const release = await mapSource.worldFile(projectId, profile.game)
      if (!release.file) return { url: release.manual }
      return { name: await installer.lock(profile, () => installArchive(profile, kind, '', { file: release.file, source: 'curseforge' })) }
    }
    const file = await provider.packFile(kind, projectId, profile.game)
    if (file.manual) return { url: file.manual }
    return { name: await installer.lock(profile, () => installArchive(profile, kind, world, { file, source: 'modrinth' })) }
  })
  handle('archive-import', async (id: string, type: ArchiveKind, world: string) => {
    const kind = archiveKind(type)
    const profile = profileFor(id)
    const result = await dialog.showOpenDialog(window!, { title: 'Импорт ZIP в сборку', properties: ['openFile'],
      filters: [{ name: 'ZIP-архивы', extensions: ['zip'] }] })
    if (!result.filePaths[0]) return null
    return installer.lock(profile, () => installArchive(profile, kind, world, { path: result.filePaths[0] }))
  })
  handle('shader-recommendation', (id: string) => shaderRecommendation(profileFor(id), provider))
  handle('optifine-release', (id: string) => optiFineFor(profileFor(id)))
  handle('download-optifine', async (id: string, filename: unknown) => {
    const { release } = await optiFineFor(profileFor(id))
    if (!release || release.file !== filename) throw new Error('Подходящий выпуск OptiFine изменился. Обновите каталог шейдеров.')
    return saveOptiFine(release, app.getPath('downloads'))
  })
  handle('shader-packs', (id: string) => listShaderPacks(profileFor(id), store, provider))
  handle('local-packs', async (id: string, folder: unknown) => {
    if (folder !== 'shaderpacks' && folder !== 'resourcepacks') throw new Error('Неизвестная папка пакетов.')
    return (await localPacks(profileFor(id), folder)).packs
  })
  handle('open-resource-folder', async (id: string) => {
    const error = await shell.openPath(await gameContentPath(profileFor(id), 'resourcepacks', true))
    if (error) throw new Error(error)
  })
  handle('search-shaders', (id: string, query: string, offset: number, sort: CatalogQuery['sort'], style: ShaderStyle | '') => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 990 || !['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(sort) ||
      (style !== '' && !shaderStyles.includes(style))) throw new Error('Некорректные параметры каталога шейдеров.')
    return provider.searchShaders(profileFor(id).game, field(query, 160), offset, sort, style)
  })
  handle('install-shader', async (id: string, project: string) => {
    const file = await provider.shaderFile(token(project), profileFor(id).game)
    const profile = profileFor(id)
    return installer.lock(profile, async () => {
      const name = await installShaderPack(profile, file)
      if (file.sha512) store.addSource(file.sha512.toLowerCase(), { projectId: file.projectId, versionId: file.versionId })
      return { name, size: file.size, projectId: file.projectId }
    })
  })
  handle('open-shader-folder', async (id: string) => {
    const error = await shell.openPath(await gameContentPath(profileFor(id), 'shaderpacks', true))
    if (error) throw new Error(error)
  })
  handle('import-shader-pack', async (id: string) => {
    profileFor(id)
    const result = await dialog.showOpenDialog(window!, { title: 'Импорт шейдеров', properties: ['openFile'], filters: [{ name: 'ZIP-архивы', extensions: ['zip'] }] })
    if (result.canceled || !result.filePaths[0]) return false
    const profile = profileFor(id)
    await installer.lock(profile, () => importShaderPack(profile, result.filePaths[0]))
    return true
  })
  handle('external', async (value: string) => {
    const url = webUrl(value)
    if (!url) throw new Error('Эта ссылка не поддерживается.')
    await shell.openExternal(url.href)
  })
  return {
    store, appUpdates, receiveImport: async (id: string) => {
      const files = await readExplorerBatch(id)
      if (!files.length || imports.has(id)) return
      if (imports.size >= 16) {
        dialog.showErrorBox('Импортировать в MultiHub', 'Сначала завершите один из открытых пакетов импорта.')
        return
      }
      imports.set(id, files)
      sendImports()
      if (window?.isMinimized()) window.restore()
      window?.show()
      window?.focus()
    },
  }
}

function openWindow(store: Store) {
  const { theme, scale } = store.readSettings()
  nativeTheme.themeSource = theme
  window = new BrowserWindow({
    title: 'MultiHub', width: 1380, height: 880, minWidth: 790, minHeight: 600, frame: false, backgroundColor: windowBackground[theme], show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      additionalArguments: ['--modkit-theme=' + theme],
      zoomFactor: scale / 100,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  const contents = window.webContents
  contents.setZoomMode('isolated')
  contents.on('dom-ready', () => contents.setZoomFactor(store.readSettings().scale / 100))
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return
    const increase = input.key === '+' || input.key === '=' || input.code === 'NumpadAdd'
    const decrease = input.key === '-' || input.code === 'NumpadSubtract'
    const reset = input.key === '0' || input.code === 'Numpad0'
    if (!increase && !decrease && !reset) return
    event.preventDefault()
    if (input.isAutoRepeat) return
    const current = store.readSettings().scale
    const index = interfaceScales.indexOf(current)
    const next = reset ? defaultSettings.scale : interfaceScales[index + (increase ? 1 : -1)] ?? current
    if (next === current) return
    store.updateSettings({ scale: next })
    contents.setZoomFactor(next / 100)
    contents.send('modkit:interface-scale', next)
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_content, _permission, callback) => callback(false))
  window.once('ready-to-show', () => window?.show())
  window.on('closed', () => { window = null })
  if (dev) void window.loadURL(target)
  else void window.loadFile(html)
}

const initialImport = importArgument(process.argv)
if (!app.requestSingleInstanceLock({ batch: initialImport ?? '' })) app.quit()
else {
  const pending = initialImport ? [initialImport] : []
  let receive: ((id: string) => Promise<void>) | undefined
  function accept(id: string) {
    if (receive) void receive(id).catch(error => dialog.showErrorBox('Импортировать в MultiHub', String(error)))
    else pending.push(id)
  }
  app.on('second-instance', (_event, args, _directory, data) => {
    const supplied = typeof data === 'object' && data && 'batch' in data && typeof data.batch === 'string' ? data.batch : undefined
    const id = importArgument(supplied ? ['--multihub-import=' + supplied] : args)
    if (id) accept(id)
    if (window?.isMinimized()) window.restore()
    window?.show()
    window?.focus()
  })
  app.whenReady().then(() => {
    const { store, appUpdates, receiveImport } = register()
    receive = receiveImport
    openWindow(store)
    window?.once('ready-to-show', () => void appUpdates.action('check'))
    for (const id of pending) accept(id)
  }).catch(error => { dialog.showErrorBox('MultiHub', String(error)); app.quit() })
  app.on('window-all-closed', () => app.quit())
}
