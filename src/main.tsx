import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDownToLine, ArrowUpCircle, Box, CircleAlert, Copy, FolderOpen, Gamepad2, Layers, Map, ScrollText, House, Minus, Moon, Plus, Search, Settings as Gear, ShieldCheck, Sparkles, Square, Sun, X, ScanLine, Check, Clock3 } from 'lucide-react'
import { defaultSettings, interfaceScales, validInterfaceScale, validNickname, type AppState, type AppUpdateState, type ExplorerImport, type ExplorerIntegration, type LocalMod, type ModUpdateCheck, type Profile, type Settings, type Transfer, type Activity } from './shared'
import { localProblems, platformMod } from './compatibility'
import { ChangeDialog, InstallDialog, LocalDetails, RetryDialog, Setup } from './dialogs'
import { Catalog, Detail, Downloads, Heading, Home, MyMods } from './views'
import { initialGameStatus } from './GameControls'
import { BuildsPage, CreateGame } from './BuildsPage'
import { BuildContent, type BuildTab } from './BuildContent'
import { RemoveProfileDialog } from './RemoveProfileDialog'
import { UpdatesPage } from './UpdatesPage'
import { ArchiveCatalog } from './ArchiveCatalog'
import { ShadersPage } from './ShadersPage'
import { ExplorerImportDialog } from './ExplorerImport'
import { AppUpdateSection } from './AppUpdateSection'
import { api, Brand, Busy, Chip, Empty, errorText, ErrorBox, profileLabel } from './ui'
import './style.css'

declare global { interface Window { modkit: import('./shared').ModKitApi } }

const nav = [
  { label: 'Главная', icon: House, id: 'home' },
  { label: 'Мои сборки', icon: Gamepad2, id: 'play' },
  { label: 'Обновления модов', icon: ArrowUpCircle, id: 'updates' },
  { label: 'Диагностика', icon: ScanLine, id: 'diagnostics' },
  { label: 'Моды', icon: Search, id: 'catalog', group: 'КОНТЕНТ' },
  { label: 'Шейдеры', icon: Sparkles, id: 'shaders' },
  { label: 'Ресурспаки', icon: Layers, id: 'resourcepack' },
  { label: 'Датапаки', icon: ScrollText, id: 'datapack' },
  { label: 'Карты', icon: Map, id: 'world' },
  { label: 'Загрузки', icon: ArrowDownToLine, id: 'downloads', group: 'УПРАВЛЕНИЕ' },
  { label: 'Резервные копии', icon: ShieldCheck, id: 'backups', later: true },
  { label: 'Настройки', icon: Gear, id: 'settings' },
] as const
type Page = typeof nav[number]['id']
type Action = 'enable' | 'disable' | 'remove' | 'manual'
type Dialog = { kind: 'setup' } | { kind: 'create-game'; fabricGame?: string } | { kind: 'install'; profile: Profile; project: string; version?: string; installedVersionId?: string } | { kind: 'change'; profile: Profile; action: Action; files: string[]; dependency?: { file: string; id: string } } | { kind: 'info'; mod: LocalMod } | { kind: 'retry'; transfer: Transfer } | { kind: 'remove-profile'; profile: Profile }
const initialTheme = api?.initialTheme ?? defaultSettings.theme
document.documentElement.dataset.theme = initialTheme
const initial: AppState = { profiles: [], activeId: null, settings: { ...defaultSettings, theme: initialTheme } }

function App() {
  const [state, setState] = useState(initial)
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>()
  const [starting, setStarting] = useState(true)
  const [bootError, setBootError] = useState('')
  const [page, setPage] = useState<Page>('home')
  const [buildTab, setBuildTab] = useState<BuildTab>('mods')
  const [history, setHistory] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [topQuery, setTopQuery] = useState('')
  const [mods, setMods] = useState<LocalMod[]>([])
  const [modsError, setModsError] = useState('')
  const [scanningMods, setScanningMods] = useState(false)
  const [scannedProfileId, setScannedProfileId] = useState<string>()
  const [activity, setActivity] = useState<Activity[]>([])
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [watchingDownloads, setWatchingDownloads] = useState(false)
  const [explorerImports, setExplorerImports] = useState<ExplorerImport[]>([])
  const [gameStatus, setGameStatus] = useState(initialGameStatus)
  const [dialog, setDialog] = useState<Dialog>()
  const [toast, setToast] = useState<{ text: string; error: boolean; id: number; downloads?: boolean }>()
  const [revision, setRevision] = useState(0)
  const [updateRevision, setUpdateRevision] = useState(0)
  const [updateStatus, setUpdateStatus] = useState<{ profileId: string; checking: boolean; result?: ModUpdateCheck; error: string }>()
  const lastManualUpdate = useRef(0)
  const [maximized, setMaximized] = useState(false)
  const top = useRef<HTMLInputElement>(null)
  const content = useRef<HTMLElement>(null)
  const catalogScroll = useRef(0)
  const request = useRef(0)
  const failedJobs = useRef(new Set<string>())
  const profile = state.profiles.find(item => item.id === state.activeId)
  const modsLoading = Boolean(profile && (scanningMods || scannedProfileId !== profile.id))
  const profileUpdates = profile && updateStatus?.profileId === profile.id ? updateStatus : undefined
  const updateCount = profileUpdates?.result?.updates.length ?? 0
  const activeTransfers = transfers.filter(item => ['queued', 'downloading', 'verified'].includes(item.status))
  const activeCount = activeTransfers.length
  const waitingCount = transfers.filter(item => item.status === 'waiting').length
  const failedCount = new Set(transfers.filter(item => item.status === 'failed').map(item => item.jobId)).size
  const currentTransfer = activeTransfers.find(item => item.status === 'downloading') ??
    activeTransfers.find(item => item.status === 'verified') ?? activeTransfers.at(-1)
  const transferProgress = currentTransfer?.size ? Math.min(100, Math.floor(currentTransfer.received / currentTransfer.size * 100)) : 0
  const transferLabel = currentTransfer?.status === 'downloading' ? 'Скачивание' : currentTransfer?.status === 'verified' ? 'Установка' : 'В очереди'
  const detail = history.at(-1)
  const current = nav.find(item => item.id === page)!
  const notify = (text: string, error = false) => setToast({ text, error, id: Date.now() })
  const report = (error: unknown) => notify(errorText(error), true)
  const launch = (id: string) => {
    const target = state.profiles.find(item => item.id === id)
    void (target?.launcher?.installed === false ? api.installGame(id) : api.launchGame(id)).catch(report)
  }
  const setup = () => setDialog({ kind: 'setup' })
  const createGame = () => setDialog({ kind: 'create-game' })
  const close = () => setDialog(undefined)
  const refresh = () => setRevision(value => value + 1)
  function navigate(to: Page) {
    if (page !== to) catalogScroll.current = 0
    setHistory([])
    setPage(to)
  }
  function showBuildContent(tab: BuildTab) {
    setBuildTab(tab)
    navigate('play')
  }
  function searchCatalog(event: React.FormEvent) {
    event.preventDefault()
    catalogScroll.current = 0
    content.current?.scrollTo(0, 0)
    setQuery(topQuery)
    navigate('catalog')
  }
  function boot() {
    setBootError('')
    api.state().then(setState).catch(error => setBootError(errorText(error))).finally(() => setStarting(false))
  }
  useEffect(() => {
    if (!api) { setBootError('Откройте MultiHub из приложения Windows.'); setStarting(false); return }
    boot()
    api.transfers().then(setTransfers).catch(report)
    api.gameStatus().then(setGameStatus).catch(report)
    const offTransfers = api.onTransfers(rows => {
      setTransfers(rows)
      const failed = rows.find(row => row.status === 'failed' && !failedJobs.current.has(row.jobId))
      failedJobs.current = new Set(rows.filter(row => row.status === 'failed').map(row => row.jobId))
      if (failed) setToast({ text: failed.error || 'Не удалось завершить установку.', error: true, downloads: true, id: Date.now() })
    })
    const offMods = api.onMods(refresh)
    const offImports = api.onExplorerImports(setExplorerImports)
    const offAppUpdate = api.onAppUpdate(setAppUpdate)
    const offScale = api.onInterfaceScale(scale => setState(current => ({ ...current, settings: { ...current.settings, scale } })))
    api.appUpdateState().then(setAppUpdate).catch(report)
    api.explorerImports().then(setExplorerImports).catch(report)
    const offGameStatus = api.onGameStatus(status => {
      setGameStatus(status)
      if (status.status === 'ready' || status.status === 'running') {
        setState(current => ({ ...current, profiles: current.profiles.map(item => item.id === status.profileId && item.launcher?.installed === false ?
          { ...item, launcher: { ...item.launcher, installed: true } } : item) }))
      }
    })
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); top.current?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { offTransfers(); offMods(); offGameStatus(); offImports(); offAppUpdate(); offScale(); document.removeEventListener('keydown', key) }
  }, [])
  useEffect(() => {
    const id = ++request.current
    setModsError('')
    if (!profile) { setMods([]); setActivity([]); setScanningMods(false); setScannedProfileId(undefined); return }
    const profileId = profile.id
    setScanningMods(true)
    api.mods(profile.id).then(result => { if (id === request.current) setMods(result) }).catch(error => {
      if (id === request.current) { setMods([]); setModsError(errorText(error)) }
    }).finally(() => {
      if (id === request.current) { setScannedProfileId(profileId); setScanningMods(false) }
    })
    api.activity(profile.id).then(result => { if (id === request.current) setActivity(result) }).catch(() => undefined)
  }, [profile?.id, revision])
  useEffect(() => {
    if (!profile || profile.loader === 'vanilla') { setUpdateStatus(undefined); return }
    const id = profile.id
    let active = true
    let pending = false
    async function check(force = false) {
      if (pending) return
      pending = true
      setUpdateStatus(previous => ({
        profileId: id, checking: true, error: '', result: previous?.profileId === id ? previous.result : undefined,
      }))
      try {
        const result = await api.modUpdates(id, force)
        if (active) setUpdateStatus({ profileId: id, checking: false, result, error: '' })
      } catch (error) {
        if (active) setUpdateStatus(previous => ({
          profileId: id, checking: false, result: previous?.profileId === id ? previous.result : undefined, error: errorText(error),
        }))
      } finally { pending = false }
    }
    const force = lastManualUpdate.current !== updateRevision
    lastManualUpdate.current = updateRevision
    void check(force)
    const timer = window.setInterval(() => void check(true), 15 * 60 * 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [profile?.id, profile?.loader, revision, updateRevision])
  useLayoutEffect(() => { catalogScroll.current = 0 }, [profile?.id])
  useLayoutEffect(() => {
    content.current?.scrollTo(0, page === 'catalog' && !detail ? catalogScroll.current : 0)
  }, [page, detail])
  useLayoutEffect(() => { document.documentElement.dataset.theme = state.settings.theme }, [state.settings.theme])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(undefined), toast.downloads ? 10000 : toast.error ? 6500 : 3500)
    return () => window.clearTimeout(timer)
  }, [toast?.id])

  function folder() { if (profile) void api.showFolder(profile.id).catch(report) }
  function setSettings(changes: Partial<Settings>) {
    void api.setSettings(changes).then(() => setState(current => ({ ...current, settings: { ...current.settings, ...changes } }))).catch(report)
  }
  function activate(id: string) {
    if (id === profile?.id) return
    void api.selectProfile(id).then(next => { setMods([]); setActivity([]); setState(next) }).catch(report)
  }
  function removeProfile(item: Profile) {
    setDialog({ kind: 'remove-profile', profile: item })
  }
  function open(id: string) {
    if (page === 'catalog' && !detail) catalogScroll.current = content.current?.scrollTop ?? 0
    setHistory(items => [...items, id])
  }
  function install(project: string, version?: string) { profile ? setDialog({ kind: 'install', profile, project, version }) : setup() }
  function action(action: Action, files: string[], dependency?: { file: string; id: string }) { if (profile) setDialog({ kind: 'change', profile, action, files, dependency }) }
  async function identify() {
    if (!profile) return
    const id = request.current
    try {
      const result = await api.identify(profile.id)
      if (id === request.current) setMods(result)
      notify('Определено источников: ' + result.filter(mod => mod.projectId).length)
    } catch (error) { report(error) }
  }
  const local = { profile, mods, open, install }
  const selected = dialog?.kind === 'change' ? mods.filter(mod => dialog.files.includes(mod.file)) : []
  const selectedIds = new Set(selected.filter(mod => mod.enabled).flatMap(mod => mod.ids))
  const remaining = mods.filter(mod => mod.enabled && !selected.includes(mod))
  const remainingIds = new Set(remaining.flatMap(mod => mod.ids))
  const affected = dialog?.kind === 'change' && (dialog.action === 'disable' || dialog.action === 'remove') ?
    remaining.filter(mod => mod.requirements.some(rule => !rule.optional && !rule.conflict && !platformMod(rule.id) && selectedIds.has(rule.id) && !remainingIds.has(rule.id))).map(mod => mod.name) : []
  function windowAction(action: 'minimize' | 'maximize' | 'close') {
    api?.window(action)
    if (action === 'maximize') setMaximized(value => !value)
  }

  return <div className="app-shell">
    <header className="titlebar" onDoubleClick={event => { if (event.target === event.currentTarget) windowAction('maximize') }}>
      <div className="title-brand"><strong>MultiHub</strong></div>
      <form className="global-search search-field" onSubmit={searchCatalog}>
        <Search size={16} /><input ref={top} aria-label="Быстрый поиск модов" placeholder="Быстрый поиск модов…" value={topQuery} onChange={event => setTopQuery(event.target.value)} /><kbd>Ctrl K</kbd>
      </form>
      <div className="window-actions"><button aria-label="Свернуть" title="Свернуть" onClick={() => windowAction('minimize')}><Minus size={17} /></button><button aria-label={maximized ? 'Восстановить' : 'Развернуть'} title={maximized ? 'Восстановить' : 'Развернуть'} onClick={() => windowAction('maximize')}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button><button aria-label="Закрыть окно" title="Закрыть окно" onClick={() => windowAction('close')}><X size={17} /></button></div>
    </header>
    <div className="workspace">
      <aside className="sidebar" aria-label="Боковая навигация">
        <div className="sidebar-head"><Brand /><div><strong>MultiHub</strong><small>Менеджер модов</small></div></div>
        <nav>
          {nav.map(item => <div key={item.id} className={'group' in item ? 'nav-group-start' : undefined}>{'group' in item && <div className="nav-label">{item.group}</div>}<button title={item.label} className={'nav-item' + (item.id === page ? ' active' : '') + (item.id === 'updates' && updateCount ? ' has-updates' : '')} aria-current={item.id === page ? 'page' : undefined} onClick={() => navigate(item.id)}>
            <item.icon size={17} /><span>{item.label}</span>{item.id === 'downloads' && activeCount > 0 && <b>{activeCount}</b>}
            {item.id === 'downloads' && failedCount > 0 && <b className="download-errors" title={'Ошибок: ' + failedCount} aria-hidden="true"><CircleAlert size={14} /></b>}
            {item.id === 'downloads' && waitingCount > 0 && <b title={'Ожидаемых файлов: ' + waitingCount}>{waitingCount}</b>}
            {item.id === 'updates' && updateCount > 0 && <b className="update-count">{updateCount}</b>}
          </button></div>)}
        </nav>
        {currentTransfer && <button className="sidebar-transfer" onClick={() => navigate('downloads')}
          title={transferLabel + ' · ' + currentTransfer.name}
          aria-label={'Открыть загрузки. ' + transferLabel + ', ' + currentTransfer.name + ', ' + transferProgress + ' %'}>
          <ArrowDownToLine size={17} aria-hidden="true" />
          <span className="sidebar-transfer-copy"><strong>{transferLabel}</strong><small>{currentTransfer.name}</small></span>
          <span className="sidebar-transfer-value">{transferProgress}%</span>
          <progress max={100} value={transferProgress} aria-hidden="true" />
        </button>}
        {appUpdate?.version && !appUpdate.deferred && (appUpdate.status === 'available' || appUpdate.status === 'ready') &&
          <button className="sidebar-transfer" onClick={() => navigate('settings')} aria-label={'Обновление MultiHub ' + appUpdate.version}
            title={'Обновление MultiHub ' + appUpdate.version}>
            <ArrowUpCircle size={17} aria-hidden="true" /><span className="sidebar-transfer-copy"><strong>Обновление MultiHub</strong>
              <small>{appUpdate.status === 'ready' ? 'Готово к установке' : 'Доступна версия ' + appUpdate.version}</small></span>
          </button>}
        <div className="sidebar-footer">
          <div className="nav-label">АКТИВНАЯ СБОРКА</div>
          <div className="profile-current" title={profile?.name ?? 'Нет сборки'}>
            <Brand /><span><strong>{profile?.name ?? 'Нет сборки'}</strong>{profile && <small>{profileLabel(profile)}</small>}</span>
          </div>
        </div>
      </aside>
      <main className="main-content" ref={content} aria-label={current.label}>
        {starting ? <Busy label="Открываем MultiHub…" /> : bootError ? <ErrorBox message={bootError} retry={api ? boot : undefined} /> :
          <div className="page-inner" key={page}>
            {page === 'catalog' && <div hidden={Boolean(detail)}>
              <Catalog {...local} text={query} setText={setQuery} layout={state.settings.layout} setLayout={layout => setSettings({ layout })} />
            </div>}
            {detail ? <Detail key={detail} id={detail} profile={profile} back={() => setHistory(items => items.slice(0, -1))} install={install} report={report} open={open} /> :
              page === 'home' ? <Home {...local} globalNickname={state.settings.nickname} setup={setup} create={createGame} launch={launch} gameStatus={gameStatus} report={report} catalog={() => navigate('catalog')} myMods={() => showBuildContent('mods')} activity={activity} modsLoading={modsLoading} modsError={modsError} folder={folder} /> :
              page === 'play' ? <BuildsPage state={state} status={gameStatus} launch={launch} activate={activate} remove={removeProfile} create={createGame} connect={setup}
                updated={profile => setState(current => ({ ...current, profiles: current.profiles.map(item => item.id === profile.id ? { ...item, name: profile.name, launcher: profile.launcher } : item) }))} report={report}>
                {profile && <BuildContent key={profile.id} profile={profile} tab={buildTab} select={setBuildTab} shaderCatalog={() => navigate('shaders')} report={report}
                  mods={<MyMods profile={profile} mods={mods} loading={modsLoading} error={modsLoading ? '' : modsError} catalog={() => navigate('catalog')} identify={identify} folder={folder} refresh={refresh} details={mod => setDialog({ kind: 'info', mod })} open={open} act={action} report={report} />} />}
              </BuildsPage> :
              page === 'catalog' ? null :
              page === 'shaders' ? <ShadersPage key={profile?.id} profile={profile} mods={mods} modsLoading={modsLoading} modsError={modsError}
                setup={setup} install={install} enable={file => action('enable', [file])} manageMods={() => showBuildContent('mods')} manageShaders={() => showBuildContent('shaderpacks')}
                createFabric={fabricGame => setDialog({ kind: 'create-game', fabricGame })} report={report} /> :
              page === 'resourcepack' || page === 'datapack' || page === 'world' ? <ArchiveCatalog kind={page} profile={profile} setup={setup} /> :
              page === 'updates' ? <UpdatesPage profile={profile} result={profileUpdates?.result} checking={profileUpdates?.checking ?? Boolean(profile && profile.loader !== 'vanilla')} error={profileUpdates?.error ?? ''} check={() => setUpdateRevision(value => value + 1)} report={report}
                install={update => { if (profile) setDialog({ kind: 'install', profile, project: update.projectId, version: update.versionId, installedVersionId: update.installedVersionId }) }} /> :
              page === 'downloads' ? <Downloads transfers={transfers} retry={transfer => setDialog({ kind: 'retry', transfer })} report={report}
                watching={watchingDownloads} watch={enabled => void api.watchDownloads(enabled).then(() => setWatchingDownloads(enabled)).catch(report)} /> :
              page === 'settings' ? <SettingsPage state={state} update={setSettings} setup={setup} notify={notify} report={report} appUpdate={appUpdate} /> :
              page === 'diagnostics' ? <Diagnostics profile={profile} mods={mods} loading={modsLoading} error={modsError} setup={setup} refresh={refresh} /> :
              <><Heading title={current.label} /><Empty icon={<Clock3 />} title="Раздел в разработке" text="Будет доступен в следующих версиях MultiHub." /></>}
          </div>}
      </main>
    </div>
    <AnimatePresence>
      {!starting && !dialog && explorerImports[0] && <ExplorerImportDialog key={explorerImports[0].id} batch={explorerImports[0]}
        profiles={state.profiles} activeId={state.activeId} close={() => void api.closeExplorerImport(explorerImports[0].id).catch(report)}
        queued={manual => {
          void api.closeExplorerImport(explorerImports[0].id).catch(report)
          setToast({ text: manual ? 'Импорт ждёт обязательные файлы.' : 'Импорт добавлен в очередь.', error: false, downloads: true, id: Date.now() })
        }} />}
      {dialog?.kind === 'setup' && <Setup key="setup" profiles={state.profiles} close={close} saved={next => { setState(next); close(); notify('Сборка подключена') }} />}
      {dialog?.kind === 'create-game' && <CreateGame key="create-game" globalNickname={state.settings.nickname} fabricGame={dialog.fabricGame} close={close} gameBusy={gameStatus.status === 'preparing' || gameStatus.status === 'running'} saved={next => {
        setMods([]); setActivity([]); setState(next); close(); navigate('play')
        if (next.activeId) void api.installGame(next.activeId).catch(report)
      }} />}
      {dialog?.kind === 'remove-profile' && <RemoveProfileDialog key="remove-profile" profile={dialog.profile} close={close} removed={next => {
        if (state.activeId !== next.activeId) { setMods([]); setActivity([]) }
        setState(next)
        close()
        notify(dialog.profile.launcher ? 'Сборка удалена' : 'Профиль отключён')
      }} />}
      {dialog?.kind === 'install' && <InstallDialog key="install" profile={dialog.profile} project={dialog.project} version={dialog.version} installedVersionId={dialog.installedVersionId} close={close} queued={manual => {
        close()
        if (manual) setToast({ text: 'В очереди есть файлы для ручного скачивания.', error: false, downloads: true, id: Date.now() })
        else notify(dialog.installedVersionId ? 'Обновление добавлено в очередь' : 'Добавлено в очередь загрузки')
      }} />}
      {dialog?.kind === 'info' && <LocalDetails key="info" mod={dialog.mod} close={close} />}
      {dialog?.kind === 'retry' && <RetryDialog key="retry" transfer={dialog.transfer} close={close} />}
      {dialog?.kind === 'change' && <ChangeDialog key="change" action={dialog.action} mods={mods} affected={affected} files={dialog.files} dependency={dialog.dependency?.id} close={close} commit={async allow => {
        if (dialog.action === 'manual') {
          const count = await api.manual(dialog.profile.id, allow, dialog.dependency)
          if (count) notify('Импортировано модов: ' + count)
        } else {
          await api.modify(dialog.profile.id, dialog.files, dialog.action, allow)
          notify('Изменения сохранены')
        }
      }} />}
      {toast && <motion.div role={toast.error ? 'alert' : 'status'} className={'toast ' + (toast.error ? 'toast-error' : '')} key={toast.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .12 }}>
        {toast.error ? <CircleAlert size={19} /> : <Check size={19} />}<span>{toast.text}</span>
        {toast.downloads && <button className="button secondary small-btn" onClick={() => { setToast(undefined); navigate('downloads') }}>К загрузкам</button>}
        <button className="icon-button" onClick={() => setToast(undefined)} aria-label="Закрыть уведомление"><X size={16} /></button>
      </motion.div>}
    </AnimatePresence>
  </div>
}

function SettingsPage({ state, update, setup, notify, report, appUpdate }: { state: AppState; update: (settings: Partial<Settings>) => void; setup: () => void; notify: (value: string) => void; report: (error: unknown) => void; appUpdate?: AppUpdateState }) {
  const [explorer, setExplorer] = useState<ExplorerIntegration>()
  const [changingExplorer, setChangingExplorer] = useState(false)
  const [nickname, setNickname] = useState(state.settings.nickname)
  useEffect(() => { let active = true; api.explorerIntegration().then(value => { if (active) setExplorer(value) }).catch(report); return () => { active = false } }, [])
  return <>
    <Heading title="Настройки" subtitle="Оформление, игровые папки и загрузки." />
    <AppUpdateSection update={appUpdate} act={action => void api.appUpdate(action).catch(report)} />
    <section className="panel settings-panel">
      <h2>Интерфейс</h2>
      <div className="setting-row">
        <span id="interface-theme"><strong>Тема интерфейса</strong></span>
        <fieldset className="theme-options" aria-labelledby="interface-theme">
          <label className="theme-option"><input type="radio" name="theme" checked={state.settings.theme === 'light'} onChange={() => update({ theme: 'light' })} /><Sun size={16} />Светлая</label>
          <label className="theme-option"><input type="radio" name="theme" checked={state.settings.theme === 'dark'} onChange={() => update({ theme: 'dark' })} /><Moon size={16} />Тёмная</label>
        </fieldset>
      </div>
      <div className="setting-row">
        <span><label htmlFor="interface-scale"><strong>Масштаб интерфейса</strong></label><small>Ctrl + / Ctrl − / Ctrl 0</small></span>
        <div className="heading-actions">
          <select id="interface-scale" value={state.settings.scale} onChange={event => {
            const scale = Number(event.target.value)
            if (validInterfaceScale(scale)) update({ scale })
          }}>{interfaceScales.map(scale => <option value={scale} key={scale}>{scale}%</option>)}</select>
          <button className="button secondary small-btn" aria-label="Сбросить масштаб" disabled={state.settings.scale === defaultSettings.scale}
            onClick={() => update({ scale: defaultSettings.scale })}>Сбросить</button>
        </div>
      </div>
      <div className="setting-row"><span><strong>Язык</strong></span><Chip>Русский</Chip></div>
      {explorer?.available && <div className="setting-row"><span><strong>Импорт из Проводника Windows</strong><small>Добавить «Импортировать в MultiHub» в меню JAR-файлов.</small></span>
        <button className={'toggle ' + (explorer.enabled ? 'on' : '')} aria-label="Импорт из Проводника Windows" aria-pressed={explorer.enabled}
          disabled={changingExplorer} onClick={() => {
            setChangingExplorer(true)
            void api.setExplorerIntegration(!explorer.enabled).then(setExplorer).catch(report).finally(() => setChangingExplorer(false))
          }}><span /></button></div>}
    </section>
    <section className="panel settings-panel"><h2>Запуск Minecraft</h2>
      <form className="setting-row" onSubmit={event => {
        event.preventDefault()
        if (validNickname(nickname) && nickname !== state.settings.nickname) update({ nickname })
      }}>
        <span><label htmlFor="default-nickname"><strong>Никнейм по умолчанию</strong></label><small id="default-nickname-help">Для локального запуска. 3–16 символов: A–Z, 0–9 и подчёркивание.</small></span>
        <div className="heading-actions">
          <input id="default-nickname" className="default-nickname" maxLength={16} value={nickname}
            aria-describedby="default-nickname-help" aria-invalid={!validNickname(nickname)} onChange={event => setNickname(event.target.value)} />
          <button className="button secondary small-btn" disabled={!validNickname(nickname) || nickname === state.settings.nickname}>Сохранить</button>
        </div>
      </form>
    </section>
    <section className="panel settings-panel"><div className="section-heading"><h2>Игровые папки</h2><button className="button secondary" onClick={setup}><Plus size={16} />Подключить</button></div>
      {state.profiles.length ? state.profiles.map(profile => <div className="setting-row" key={profile.id}><span><strong>{profile.name}</strong><small>{profile.directory}</small></span><button className="button secondary small-btn" onClick={() => void api.showFolder(profile.id).catch(report)}><FolderOpen size={15} />Открыть</button></div>) : <p className="muted">Пока нет подключённых папок.</p>}
    </section>
    <section className="panel settings-panel"><h2>Загрузки и уведомления</h2>
      <div className="setting-row"><span><strong>Одновременные загрузки</strong><small>Лимит файлов в одной операции установки</small></span><select aria-label="Одновременные загрузки" value={state.settings.parallel} onChange={event => update({ parallel: Number(event.target.value) })}>{[1, 2, 3, 4, 5].map(item => <option key={item}>{item}</option>)}</select></div>
      <div className="setting-row"><span><strong>Системные уведомления</strong><small>Сообщать о завершении установки</small></span><button className={'toggle ' + (state.settings.notify ? 'on' : '')} aria-label="Системные уведомления" aria-pressed={state.settings.notify} onClick={() => update({ notify: !state.settings.notify })}><span /></button></div>
    </section>
    <section className="panel settings-panel"><h2>Источники</h2><div className="setting-row"><span><strong>Modrinth</strong><small>Публичный API каталога модов</small></span><Chip tone="positive">Доступен</Chip></div><div className="setting-row"><span><strong>CurseForge</strong><small>Для подключения понадобится доступ к API</small></span><Chip>Недоступен</Chip></div>
      <div className="setting-row"><span><strong>Кэш каталога</strong><small>Локальные метаданные Modrinth</small></span><button className="button secondary small-btn" onClick={() => void api.clearCache().then(() => notify('Кэш каталога очищен')).catch(report)}>Очистить</button></div></section>
  </>
}

function Diagnostics({ profile, mods, loading, error, setup, refresh }: { profile?: Profile; mods: LocalMod[]; loading: boolean; error: string; setup: () => void; refresh: () => void }) {
  const problems = profile ? localProblems(mods, profile) : []
  return <>
    <Heading title="Диагностика" subtitle="Проверка JAR-файлов, загрузчика и зависимостей по локальным метаданным." actions={profile && <button className="button secondary" onClick={refresh}><ScanLine size={16} />Проверить сборку</button>} />
    {!profile ? <Empty icon={<ScanLine />} title="Сборка не подключена" text="Подключите папку Minecraft для проверки." action={<button className="button primary" onClick={setup}>Подключить сборку</button>} /> : loading ? <Busy label="Проверяем файлы…" /> : error ? <ErrorBox message={error} retry={refresh} /> : !problems.length ? <Empty icon={<ShieldCheck />} title="Проблемы не найдены" text={mods.length ? 'В локальных метаданных модов нет обнаруженных проблем.' : 'В папке сборки пока нет JAR-файлов.'} /> : <div className="panel data-list">{problems.map((item, index) => <div className="data-row" key={index}><CircleAlert size={18} /><span><strong>{item.name} · {item.text}</strong><small>{item.hint}</small></span><Chip tone="warning">{item.uncertain ? 'Требует проверки' : 'Проблема'}</Chip></div>)}</div>}
  </>
}

createRoot(document.getElementById('root')!).render(<App />)
