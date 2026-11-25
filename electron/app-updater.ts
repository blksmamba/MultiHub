import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, net } from 'electron'
import { autoUpdater, type AppUpdater, type UpdateInfo } from 'electron-updater'
import type { AppUpdateAction, AppUpdateState } from '../src/shared'
import type { Store } from './db'

const latestRelease = 'https://api.github.com/repos/blksmamba/MultiHub/releases/latest'

function message(error: unknown, fallback: string) {
  const code = (error as { code?: string } | undefined)?.code
  switch (code) {
    case 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND': return 'В стабильном релизе нет latest.yml. Повторите проверку после публикации файлов обновления.'
    case 'ERR_CHECKSUM_MISMATCH': return 'Контрольная сумма скачанного файла не совпала. Скачайте обновление повторно.'
    case 'ERR_UPDATER_INVALID_SIGNATURE': return 'Не удалось подтвердить подпись установщика.'
    case 'ERR_UPDATER_INVALID_UPDATE_INFO': return 'GitHub вернул некорректные метаданные обновления.'
    default: return fallback
  }
}

export class AppUpdates {
  private state: AppUpdateState
  private readonly updater?: AppUpdater

  constructor(private readonly store: Store, private readonly changed: (state: AppUpdateState) => void, private readonly installBlocked: () => boolean) {
    const enabled = process.platform === 'win32' && app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
    this.state = { current: app.getVersion(), status: enabled ? 'idle' : 'disabled' }
    if (!enabled) return
    this.updater = autoUpdater
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.updater.allowPrerelease = false
    this.updater.allowDowngrade = false
    this.updater.disableWebInstaller = true
    this.updater.on('download-progress', progress => {
      if (this.state.status === 'downloading') this.set({
        transferred: progress.transferred, total: progress.total, speed: progress.bytesPerSecond,
        percent: Math.min(100, Math.max(0, progress.percent)),
      })
    })
    // electron-updater emits an error as well as rejecting check/download promises.
    this.updater.on('error', error => {
      if (this.state.status === 'installing') this.set({
        status: 'error', retry: 'install', error: message(error, 'Не удалось запустить установщик обновления.'),
      })
    })
  }

  snapshot() { return this.state }

  private set(changes: Partial<AppUpdateState>) {
    this.state = { ...this.state, ...changes }
    this.changed(this.state)
  }

  private async publishedRelease() {
    const response = await net.fetch(latestRelease, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MultiHub/' + this.state.current },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    })
    if (response.status === 404) throw new Error('Публичный стабильный релиз MultiHub пока недоступен.')
    if (!response.ok) throw new Error('GitHub не ответил на проверку обновлений (HTTP ' + response.status + ').')
    const release: { tag_name?: string; draft?: boolean; prerelease?: boolean; body?: string; name?: string } = await response.json()
    if (!release.tag_name || release.draft || release.prerelease) throw new Error('Публичный стабильный релиз MultiHub пока недоступен.')
    return release
  }

  private offer(info: UpdateInfo, release: Awaited<ReturnType<AppUpdates['publishedRelease']>>) {
    if (release.tag_name?.replace(/^v/, '') !== info.version) throw new Error('Версия релиза GitHub расходится с версией в latest.yml.')
    const installer = info.files.find(file => /\.exe$/i.test(file.url))
    if (installer?.url !== 'MultiHub-Setup-' + info.version + '-x64.exe') throw new Error('В latest.yml указан неожиданный установщик.')
    if (!installer?.sha512 || !/^[a-zA-Z0-9+/]{86}==$/.test(installer.sha512))
      throw new Error('В latest.yml нет контрольной суммы SHA-512 установщика.')
    this.set({
      status: 'available', version: info.version, title: release.name?.slice(0, 160) || info.releaseName || 'MultiHub ' + info.version,
      notes: release.body?.slice(0, 30000) ?? '', deferred: this.store.deferredAppUpdate() === info.version,
      transferred: 0, total: installer.size, speed: 0, percent: 0,
    })
  }

  async action(action: AppUpdateAction) {
    const updater = this.updater
    if (!updater) return
    switch (action) {
      case 'check': {
        if (['checking', 'downloading', 'ready', 'installing'].includes(this.state.status)) return
        this.set({ status: 'checking', error: undefined, retry: undefined, version: undefined, deferred: false, notes: undefined, title: undefined })
        let release
        try { release = await this.publishedRelease() }
        catch (error) {
          const text = error instanceof Error && /^(Публичный |GitHub )/.test(error.message) ? error.message : 'Не удалось подключиться к GitHub. Проверьте соединение.'
          this.set({ status: text.startsWith('Публичный') ? 'no-release' : 'error', retry: 'check', error: text })
          return
        }
        try {
          const result = await updater.checkForUpdates()
          if (!result) throw new Error('Канал обновлений MultiHub недоступен.')
          if (release.tag_name?.replace(/^v/, '') !== result.updateInfo.version)
            throw new Error('Версия релиза GitHub расходится с версией в latest.yml.')
          if (result.isUpdateAvailable) this.offer(result.updateInfo, release)
          else this.set({ status: 'current' })
        } catch (error) {
          const details = error instanceof Error && /^(Канал |Версия релиза|В latest.yml)/.test(error.message) ? error.message :
            message(error, 'Не удалось проверить файлы стабильного релиза. Повторите попытку позже.')
          this.set({ status: 'error', retry: 'check', error: details })
        }
        return
      }
      case 'download': {
        if (this.state.status !== 'available' && !(this.state.status === 'error' && this.state.retry === 'download')) return
        this.set({ status: 'downloading', error: undefined, retry: undefined, deferred: false, percent: 0, transferred: 0, speed: 0 })
        try {
          const files = await updater.downloadUpdate()
          if (!files.length) throw new Error('Установщик обновления не был сохранён.')
          this.set({ status: 'ready', percent: 100, speed: 0 })
        } catch (error) {
          this.set({ status: 'error', retry: 'download', error: message(error, 'Не удалось скачать обновление. Проверьте соединение и повторите попытку.') })
        }
        return
      }
      case 'later':
        if (!this.state.version || !['available', 'ready'].includes(this.state.status)) return
        this.store.deferAppUpdate(this.state.version)
        this.set({ deferred: true })
        return
      case 'install':
        if (this.state.status !== 'ready' && !(this.state.status === 'error' && this.state.retry === 'install')) return
        if (this.installBlocked()) {
          this.set({ status: 'ready', error: 'Закройте Minecraft и дождитесь завершения установки файлов сборки.' })
          return
        }
        this.set({ status: 'installing', error: undefined, retry: undefined })
        try { updater.quitAndInstall(true, true) }
        catch (error) { this.set({ status: 'error', retry: 'install', error: message(error, 'Не удалось запустить установщик обновления.') }) }
        return
    }
  }
}
