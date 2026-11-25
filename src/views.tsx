import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ModDescription } from './ModDescription'
import { BuildActions, GameStatusPanel, LaunchButton } from './GameControls'
import { platformMod, thresholdMismatch } from './compatibility'
import { ChevronDown } from 'lucide-react'
import { Activity as ActivityIcon, ArrowDownToLine, ArrowLeft, ArrowRight, Box, Check, ChevronLeft, ChevronRight, CircleAlert, CircleMinus, Clock3, Download, ExternalLink, FileArchive, FolderOpen, HardDrive, LayoutGrid, List, MoreHorizontal, PackageOpen, Plus, Puzzle, RefreshCw, Search, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { contentNames, contentSource, loaders, loaderName, type ContentSource, type Activity, type CatalogMod, type CatalogQuery, type GameLaunchState, type LocalMod, type Profile, type ProjectDetail, type Settings, type Transfer } from './shared'
import { api, Busy, bytes, category, Chip, compact, date, Empty, errorText, ErrorBox, IconTile, ModCard, number, OfficialLink, ProfileChips, profileLabel, Skeletons } from './ui'

export function useCatalog(query: CatalogQuery) {
  const [data, setData] = useState<{ items: CatalogMod[]; total: number }>()
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setError('')
    setData(undefined)
    const timer = window.setTimeout(() => {
      api.search(query).then(data => { if (active) setData(data) }).catch(error => { if (active) setError(errorText(error)) })
    }, 170)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query.query, query.game, query.loader, query.category, query.sort, query.side, query.source, query.offset, reload])
  return { data, error, retry: () => setReload(value => value + 1) }
}

export function Heading({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return <header className="page-heading"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{actions && <div className="heading-actions">{actions}</div>}</header>
}
export interface BrowseActions { open: (id: string) => void; install: (id: string, version?: string) => void }
interface Collection extends BrowseActions { profile?: Profile; mods: LocalMod[] }

export function Home({ profile, mods, open, install, setup, create, launch, gameStatus, report, catalog, myMods, activity, modsLoading, modsError, folder }: Collection & {
  setup: () => void; create: () => void; launch: (id: string) => void; gameStatus: GameLaunchState; report: (error: unknown) => void
  catalog: () => void; myMods: () => void; activity: Activity[]; modsLoading: boolean; modsError: string; folder: () => void
}) {
  const popular = useCatalog({ query: '', game: profile?.game ?? '', loader: profile?.loader === 'vanilla' ? '' : profile?.loader ?? '', category: '', sort: 'downloads', side: '', offset: 0 })
  const active = mods.filter(mod => mod.enabled).length
  const totalBytes = mods.reduce((sum, mod) => sum + mod.size, 0)
  const total = (value: string | number) => !profile || modsLoading || modsError ? '—' : value
  const recent = [...mods].sort((a, b) => b.modified - a.modified).slice(0, 4)
  return <>
    <Heading title="Главная" actions={profile && <BuildActions create={create} connect={setup} />} />
    <section className="hero">
      <div className="hero-contents">
        <div className="hero-kicker">{profile ? 'Активная сборка' : 'Minecraft Java Edition'}</div>
        <h2>{profile?.name ?? 'Ваша первая сборка'}</h2>
        {profile ? <div className="hero-chips"><ProfileChips profile={profile} /></div> : <p>Создайте сборку в MultiHub или подключите игровую папку из другого лаунчера.</p>}
        <div className="hero-actions">
          {!profile && <BuildActions create={create} connect={setup} />}
          {profile?.launcher && <LaunchButton status={gameStatus} label="Запустить" needsInstall={profile.launcher.installed === false} start={() => launch(profile.id)} />}
          {profile && profile.loader !== 'vanilla' && <button className={'button ' + (profile.launcher ? 'hero-secondary' : 'primary')} onClick={catalog}><Search size={16} />Найти моды</button>}
          {profile && <button className="button hero-secondary" onClick={folder}><FolderOpen size={16} />Открыть папку</button>}
        </div>
      </div>
      <div className="hero-cover" aria-hidden="true" />
    </section>
    {profile?.launcher && profile.id === gameStatus.profileId && <GameStatusPanel status={gameStatus} name={profile.name} report={report} retry={() => launch(profile.id)} />}
    <div className="stats-grid">
      <div className="stat"><span className="stat-icon"><Puzzle size={19} /></span><div><strong>{total(mods.length)}</strong><small>Установлено модов</small></div></div>
      <div className="stat"><span className="stat-icon"><ActivityIcon size={19} /></span><div><strong>{total(active)}</strong><small>Активные моды</small></div></div>
      <div className="stat"><span className="stat-icon"><HardDrive size={19} /></span><div><strong>{total(bytes(totalBytes))}</strong><small>Размер модов</small></div></div>
    </div>
    {modsError && <ErrorBox message={modsError} />}
    <section className="home-section">
      <div className="section-heading"><div><h2>Популярные моды</h2><p>{profile ? 'Подборка для активной сборки' : 'Самые скачиваемые моды в каталоге'}</p></div><button className="button text-button" onClick={catalog}>Весь каталог <ArrowRight size={16} /></button></div>
      {popular.error ? <ErrorBox message={popular.error} retry={popular.retry} /> : !popular.data ? <Skeletons count={3} /> : !popular.data.items.length ? <Empty icon={<PackageOpen />} title="Моды не найдены" text="Попробуйте открыть каталог с другими фильтрами." /> :
        <div className="card-grid home-grid">{popular.data.items.slice(0, 3).map(item => <ModCard key={item.id} mod={item} profile={profile} installed={mods.some(mod => mod.projectId === item.id)} open={() => open(item.id)} add={() => install(item.id)} />)}</div>}
    </section>
    {profile && <div className="home-bottom">
      <section className="panel"><div className="section-heading"><h2>Недавние моды</h2><button className="button text-button" onClick={myMods}>Все моды сборки <ArrowRight size={15} /></button></div>
        {!recent.length ? <p className="muted">Здесь появятся файлы из папки mods.</p> : recent.map(mod => <div key={mod.file} className="simple-row"><IconTile url={mod.icon} /><span><strong>{mod.name}</strong><small>{mod.version}</small></span><small>{date(mod.modified)}</small></div>)}</section>
      <section className="panel"><div className="section-heading"><h2>Последние действия</h2></div>{!activity.length ? <p className="muted">История сборки пока пуста.</p> : activity.slice(0, 5).map((item, index) => <div className="simple-row" key={item.date + ':' + index}><Clock3 size={16} /><span>{item.title}</span><small>{date(item.date)}</small></div>)}</section>
    </div>}
  </>
}

export function Catalog({ profile, mods, open, install, text, setText, layout, setLayout }: Collection & { text: string; setText: (value: string) => void; layout: Settings['layout']; setLayout: (layout: Settings['layout']) => void }) {
  const supportsMods = !!profile && profile.loader !== 'vanilla'
  const [compatibleOnly, setCompatible] = useState(supportsMods)
  const [game, setGame] = useState('')
  const [loader, setLoader] = useState('')
  const [tag, setTag] = useState('')
  const [sort, setSort] = useState<CatalogQuery['sort']>('relevance')
  const [side, setSide] = useState<CatalogQuery['side']>('')
  const [page, setPage] = useState(0)
  const [source, setSource] = useState<ContentSource | ''>('')
  const [sources, setSources] = useState<ContentSource[]>([])
  const [localError, setLocalError] = useState('')
  const [tags, setTags] = useState<{ games: string[]; categories: string[] }>({ games: [], categories: [] })
  useEffect(() => { setCompatible(supportsMods); setPage(0) }, [profile?.id, supportsMods])
  useEffect(() => { setPage(0) }, [text, game, loader, tag, sort, side, compatibleOnly])
  useEffect(() => { let alive = true; api.tags().then(result => { if (alive) setTags(result) }).catch(() => undefined); return () => { alive = false } }, [])
  useEffect(() => { let alive = true; api.contentSources().then(items => { if (alive) setSources(items) }).catch(() => undefined); return () => { alive = false } }, [])
  const effectiveGame = compatibleOnly && profile ? profile.game : game
  const effectiveLoader = compatibleOnly && profile && profile.loader !== 'vanilla' ? profile.loader : loader
  const result = useCatalog({ query: text.trim(), game: effectiveGame, loader: effectiveLoader, category: tag, sort, side, offset: page * 18, source: source || undefined })
  const games = [...new Set([...(effectiveGame ? [effectiveGame] : []), ...tags.games])]
  return <>
    <Heading title="Каталог модов" subtitle="Найдите моды для Minecraft и установите их в свою сборку." actions={<>
      <select aria-label="Источник каталога" value={source} onChange={event => { setSource(event.target.value as ContentSource | ''); setTag(''); setSide(''); setPage(0) }}>
        <option value="">Источник автоматически</option>{sources.map(key => <option key={key} value={key}>{contentNames[key]}</option>)}
      </select>
      {source === 'local' && <button className="button secondary" onClick={() => {
        setLocalError('')
        void api.addLocalContent().then(count => { if (count) result.retry() }).catch(error => setLocalError(errorText(error)))
      }}><Plus size={16} />Добавить JAR в каталог</button>}
    </>} />
    {localError && <ErrorBox message={localError} />}
    {profile?.loader === 'vanilla' && <ErrorBox message="В активной сборке нет загрузчика модов. Для установки создайте сборку с Fabric или Forge." />}
    <div className="catalog-controls panel">
      <label className="search-field catalog-search"><Search size={17} /><input placeholder="Название, автор или описание" aria-label="Поиск модов в каталоге" value={text} onChange={event => setText(event.target.value)} />{text && <button className="icon-button" aria-label="Очистить поиск" onClick={() => setText('')}><X size={16} /></button>}</label>
      <div className="filters"><span className="filter-icon" title="Фильтры"><SlidersHorizontal size={17} /></span>
        <select aria-label="Версия Minecraft" title="Версия Minecraft" value={effectiveGame} onChange={event => { setCompatible(false); setGame(event.target.value) }}><option value="">Все версии</option>{games.map(item => <option key={item}>{item}</option>)}</select>
        <select aria-label="Загрузчик" value={effectiveLoader} onChange={event => { setCompatible(false); setLoader(event.target.value) }}><option value="">Все загрузчики</option>{loaders.map(item => <option value={item} key={item}>{loaderName[item]}</option>)}</select>
        {(!source || source === 'modrinth') && <>
          <select aria-label="Категория" value={tag} onChange={event => setTag(event.target.value)}><option value="">Все категории</option>{tags.categories.map(item => <option value={item} key={item}>{category(item)}</option>)}</select>
          <select aria-label="Сторона" value={side} onChange={event => setSide(event.target.value as CatalogQuery['side'])}><option value="">Клиент и сервер</option><option value="client">Клиент</option><option value="server">Сервер</option></select>
        </>}
        {supportsMods && <label className="check-label"><input type="checkbox" checked={compatibleOnly} onChange={event => setCompatible(event.target.checked)} />Для моей сборки</label>}
      </div>
    </div>
    <div className="results-bar"><span>{result.data ? 'Найдено: ' + number.format(result.data.total) : 'Модификации'}</span><div>
      <select aria-label="Сортировка" value={sort} onChange={event => setSort(event.target.value as CatalogQuery['sort'])}><option value="relevance">По релевантности</option><option value="downloads">По скачиваниям</option><option value="follows">По популярности</option><option value="updated">Недавно обновлённые</option><option value="newest">Новые</option></select>
      <div className="segmented"><button className={'icon-button ' + (layout === 'grid' ? 'selected' : '')} title="Сетка" aria-label="Сетка" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><LayoutGrid size={17} /></button><button className={'icon-button ' + (layout === 'list' ? 'selected' : '')} title="Список" aria-label="Список" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List size={19} /></button></div>
    </div></div>
    {result.error ? <ErrorBox message={result.error} retry={result.retry} /> : !result.data ? <Skeletons /> : result.data.items.length ? <>
      <div className={layout === 'grid' ? 'card-grid' : 'catalog-list'}>{result.data.items.map(mod => <ModCard mod={mod} key={mod.id} profile={profile} installed={mods.some(item => item.projectId === mod.id)} open={() => open(mod.id)} add={() => install(mod.id)} />)}</div>
      <div className="pager"><button className="button secondary" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={17} />Назад</button><span>Страница {page + 1}</span><button className="button secondary" disabled={(page + 1) * 18 >= Math.min(result.data.total, 990)} onClick={() => setPage(page + 1)}>Далее<ChevronRight size={17} /></button></div>
    </> : <Empty icon={<Search />} title="Моды не найдены" text="Попробуйте изменить запрос или сбросить фильтры." action={<button className="button secondary" onClick={() => { setText(''); setGame(''); setLoader(''); setTag(''); setSide(''); setCompatible(false) }}>Сбросить фильтры</button>} />}
  </>
}

const detailTabs = ['Описание', 'Галерея', 'Версии', 'Зависимости', 'История изменений'] as const

function SupportedMinecraftVersions({ groups, profile }: { groups: ProjectDetail['supportedGames']; profile: Profile }) {
  const ordered = [...(groups ?? [])].sort((a, b) => Number(b.loader === profile.loader) - Number(a.loader === profile.loader) || a.loader.localeCompare(b.loader))
  const showVersions = (games: string[]) => games.map(game => <Chip key={game} tone={game === profile.game ? 'positive' : ''}>{game}</Chip>)
  return <section className="panel supported-games" aria-label="Поддерживаемые версии Minecraft">
    <header className="compatibility-notice">
      <CircleAlert size={19} aria-hidden="true" />
      <div><h2>Мод несовместим с активной сборкой</h2><p>{profileLabel(profile)}</p></div>
    </header>
    <div className="supported-games-body">
    <h3>Поддерживаемые версии Minecraft</h3>
    {ordered.length ? <dl>{ordered.map(({ loader, games }) => {
      const name = loaders.find(item => item === loader)
      return <div key={loader}>
        <dt>{name ? loaderName[name] : loader}</dt>
        <dd><div className="chips">{showVersions(games.slice(0, 8))}</div>
          {games.length > 8 && <details><summary>Ещё {games.length - 8}</summary><div className="chips">{showVersions(games.slice(8))}</div></details>}
        </dd>
      </div>
    })}</dl> : <p className="muted">{groups ? 'Источник не опубликовал подходящие JAR-файлы.' : 'Список версий сейчас недоступен.'}</p>}
    </div>
  </section>
}

export function Detail({ id, profile, back, install, report, open }: { id: string; profile?: Profile; back: () => void; report: (error: unknown) => void } & BrowseActions) {
  const [project, setProject] = useState<ProjectDetail>()
  const [error, setError] = useState('')
  const [tab, setTab] = useState<typeof detailTabs[number]>('Описание')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true
    setProject(undefined)
    setError('')
    setTab('Описание')
    api.detail(id, profile?.id).then(result => { if (alive) setProject(result) }).catch(error => { if (alive) setError(errorText(error)) })
    return () => { alive = false }
  }, [id, profile?.id, retry])
  const automatic = (version: ProjectDetail['versions'][number]) => version.file?.url || version.file?.localPath
  const bestAutomatic = project?.versions.find(version => version.type === 'release' && automatic(version)) ?? project?.versions.find(automatic)
  const best = bestAutomatic ?? project?.versions.find(version => version.type === 'release' && version.file) ?? project?.versions.find(version => version.file)
  const another = !bestAutomatic && project?.sources?.find(choice => choice.id !== project.id && choice.automatic)
  return <>
    <button className="button back-link" onClick={back}><ArrowLeft size={17} />Назад</button>
    {error ? <ErrorBox message={error} retry={() => setRetry(value => value + 1)} /> : !project ? <Skeletons count={1} /> : <>
      <div className="detail-header panel"><IconTile large url={project.icon} /><div className="detail-title"><h1>{project.name}</h1><p>{project.author} · <ArrowDownToLine size={14} /> {compact.format(project.downloads)} скачиваний</p><div className="chips">{project.categories.map(tag => <Chip key={tag}>{category(tag)}</Chip>)}</div></div><div className="detail-actions">
        {project.url && <button className="button secondary" onClick={() => void api.external(project.url!).catch(report)}><ExternalLink size={16} />{contentNames[contentSource(project.id)]}</button>}
        {!project.url && <Chip>{contentNames[contentSource(project.id)]}</Chip>}
        <button className="button primary" disabled={Boolean(profile && !best && !another)}
          onClick={() => another ? install(another.id) : install(project.id, profile ? best?.id : undefined)}><Download size={16} />
          {profile ? another || bestAutomatic || !best ? 'Установить' : 'Перейти к скачиванию' : 'Подключить сборку'}</button>
        {profile && another && best?.file?.pageUrl && <button className="button secondary" onClick={() => install(project.id, best.id)}>
          <ExternalLink size={16} />Перейти к скачиванию
        </button>}
      </div></div>
      {project.sources && project.sources.length > 1 && <div className="project-profile"><label className="check-label">Источник версии <select aria-label="Источник версии"
        value={project.id} onChange={event => open(event.target.value)}>{project.sources.map(choice => <option value={choice.id} key={choice.id}>{contentNames[choice.name]}</option>)}</select></label></div>}
      {profile && !best ? <SupportedMinecraftVersions groups={project.supportedGames} profile={profile} /> :
        <div className="project-profile"><Box size={17} />{profile ? profileLabel(profile) : 'Сборка не подключена'}{profile && best && <Chip tone="positive">{'Совместимая версия: ' + best.number}</Chip>}</div>}
      <div className="tabs" role="tablist" aria-label="Разделы мода" onKeyDown={event => {
        const active = detailTabs.indexOf(tab)
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? detailTabs.length - 1 :
          event.key === 'ArrowLeft' ? (active + detailTabs.length - 1) % detailTabs.length :
          event.key === 'ArrowRight' ? (active + 1) % detailTabs.length : -1
        if (index < 0) return
        event.preventDefault()
        setTab(detailTabs[index])
        event.currentTarget.querySelectorAll('button')[index]?.focus()
      }}>{detailTabs.map((item, index) => <button role="tab" id={'project-tab-' + index} aria-controls="project-tab-panel" aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} key={item} onClick={() => setTab(item)}>{item}</button>)}</div>
      <section role="tabpanel" id="project-tab-panel" aria-labelledby={'project-tab-' + detailTabs.indexOf(tab)}>
      {tab === 'Описание' && <div className="panel markdown"><ModDescription text={project.body || project.summary} slug={project.slug} report={report} /></div>}
      {tab === 'Галерея' && (project.gallery.length ? <div className="gallery">{project.gallery.map(item => <figure className="panel" key={item.url}><img src={item.url} alt={item.title || project.name} loading="lazy" />{item.title && <figcaption>{item.title}</figcaption>}</figure>)}</div> : <Empty icon={<Box />} title="Галерея пуста" text="Автор не добавил изображения." />)}
      {tab === 'Версии' && (project.versions.length ? <div className="panel data-list">{project.versions.map(item => <div className="data-row" key={item.id}><IconTile /><span><strong>{item.name || item.number}</strong><small>{item.number} · {date(item.date)} · {item.loaders.join(', ')}</small></span>{item.id === best?.id && <Chip tone="positive">Рекомендуемая</Chip>}<button className="button secondary small-btn" disabled={Boolean(profile && !item.file)} onClick={() => install(project.id, item.id)}><Download size={15} />{profile ? automatic(item) ? 'Установить' : 'Перейти к скачиванию' : 'Подключить сборку'}</button></div>)}</div> : <Empty icon={<PackageOpen />} title="Подходящих версий нет" text="Проверьте версию игры и загрузчик активной сборки." />)}
      {tab === 'Зависимости' && (best?.dependencies.length ? <div className="panel data-list">{best.dependencies.map((dependency, index) => <div className="data-row" key={index}><Puzzle size={17} /><span>{dependency.fileName || dependency.modId || dependency.projectId || dependency.versionId || 'Встроенный файл'}<small>{contentNames[contentSource(dependency.projectId ?? dependency.versionId ?? project.id)]}</small></span><Chip>{{ required: 'Обязательная', optional: 'Необязательная', incompatible: 'Конфликт', embedded: 'Встроенная' }[dependency.kind]}</Chip>{dependency.projectId && <button className="button secondary small-btn" onClick={() => open(dependency.projectId!)}>Открыть</button>}</div>)}</div> : <Empty icon={<Puzzle />} title="Связи не указаны" text="MultiHub проверит требования в JAR перед установкой." />)}
      {tab === 'История изменений' && <div className="panel changelog">{project.versions.filter(item => item.changelog).length ? project.versions.filter(item => item.changelog).map(item => <details key={item.id}><summary>{item.name || item.number} <small>{date(item.date)}</small></summary><div className="markdown"><ModDescription text={item.changelog} slug={project.slug} report={report} /></div></details>) : <p className="muted">Для этих версий нет записей об изменениях.</p>}</div>}
      </section>
    </>}
  </>
}

const statuses: Record<Transfer['status'], string> = { queued: 'В очереди', waiting: 'Ожидание скачивания', downloading: 'Скачивание', verified: 'Проверено', installed: 'Установлено', cancelled: 'Отменено', failed: 'Ошибка' }
export function Downloads({ transfers, retry, report, watching, watch }: {
  transfers: Transfer[]; retry: (item: Transfer) => void; report: (error: unknown) => void
  watching: boolean; watch: (active: boolean) => void
}) {
  const active = transfers.filter(item => ['queued', 'downloading', 'verified'].includes(item.status))
  const total = active.reduce((sum, row) => sum + row.size, 0)
  const downloaded = active.reduce((sum, row) => sum + row.received, 0)
  return <>
    <Heading title="Загрузки" subtitle="Очередь скачивания и установки модов." actions={<>
      {active.length > 0 && <Chip tone="positive">Активных: {active.length}</Chip>}
      <label className="check-label"><input type="checkbox" checked={watching} onChange={event => watch(event.target.checked)} />Искать ожидаемые JAR в папке «Загрузки»</label>
    </>} />
    {Boolean(active.length) && <div className="panel total-progress"><div><strong>Прогресс очереди</strong><span>{bytes(downloaded)} / {bytes(total)}</span></div><progress value={downloaded} max={total || 1} /></div>}
    {transfers.length ? <div className="panel data-list">{transfers.map(item => {
      const progress = item.size ? Math.floor(item.received / item.size * 100) : item.status === 'installed' ? 100 : 0
      return <div className="data-row transfer-row" key={item.key}><IconTile /><div className="transfer-info"><strong>{item.name}</strong><small>{contentNames[item.source ?? 'modrinth']}{item.profileName && ' · ' + item.profileName}{item.size > 0 && ' · ' + (item.status === 'downloading' ? bytes(item.speed) + '/с · ' + progress + '%' : bytes(item.size))}</small>
        {['queued', 'downloading', 'verified'].includes(item.status) && <progress value={progress} max={100} />}
        {item.error && <small className="error-text">{item.error}</small>}
        {item.status === 'waiting' && <small>{item.candidate ? 'Найден JAR · ' + item.candidate : item.filename}</small>}
      </div><div className="heading-actions">
        <Chip tone={item.status === 'installed' ? 'positive' : item.status === 'failed' || item.status === 'waiting' ? 'warning' : ''}>{statuses[item.status]}</Chip>
        {item.status === 'waiting' && <>
          {item.pageUrl && <button className="button secondary small-btn" onClick={() => void api.external(item.pageUrl!).catch(report)}><ExternalLink size={15} />Перейти к скачиванию</button>}
          <button className="button secondary small-btn" onClick={() => void api.supplyDownload(item.key, !item.candidate).catch(report)}>{item.candidate ? 'Импортировать найденный JAR' : 'Выбрать JAR'}</button>
        </>}
        {['failed', 'cancelled'].includes(item.status) ? <button className="icon-button" title="Повторить" aria-label={'Повторить ' + item.name} onClick={() => retry(item)}><RefreshCw size={16} /></button> :
          item.status !== 'installed' ? <button className="icon-button" title="Отменить установку" aria-label={'Отменить ' + item.name} onClick={() => void api.cancel(item.jobId).catch(report)}><X size={18} /></button> :
            <span className="installed-check"><Check size={16} /></span>}
      </div></div>
    })}</div> : <Empty icon={<ArrowDownToLine />} title="Очередь пуста" text="Загрузки появятся здесь после подтверждения плана установки." />}
  </>
}

type ModAction = (action: 'enable' | 'disable' | 'remove' | 'manual', files: string[], dependency?: { file: string; id: string }) => void
const environmentNames: Record<string, string> = { minecraft: 'Minecraft', java: 'Java', fabricloader: 'Fabric Loader', quilt_loader: 'Quilt Loader', forge: 'Forge', neoforge: 'NeoForge' }

function InstalledDependencies({ mod, mods, act, details }: { mod: LocalMod; mods: LocalMod[]; act: ModAction; details: (mod: LocalMod) => void }) {
  const libraries = mod.requirements.filter(rule => !platformMod(rule.id))
  const environment = mod.requirements.filter(rule => platformMod(rule.id))
  return <section className="installed-dependencies" aria-label={'Зависимости ' + mod.name}>
    {libraries.length > 0 && <><h3>Зависимости мода</h3><ul>{libraries.map((rule, index) => {
      const providers = mods.filter(candidate => candidate.ids.includes(rule.id))
      const kind = <Chip tone={rule.conflict ? 'warning' : ''}>{rule.conflict ? 'Несовместимый мод' : rule.optional ? 'Необязательная' : 'Обязательная'}</Chip>
      const range = rule.range && rule.range !== '*' ? rule.range : undefined
      return <li key={rule.id + ':' + index}>
        {providers.map(provider => <div className="dependency-file" key={provider.file}>
          <div className="dependency-info">
            <button className="local-name" onClick={() => details(provider)}><strong>{provider.name}</strong></button>
            <small>{provider.version}{range && <> · {rule.conflict ? 'конфликтует с' : 'требуется'} <code>{range}</code></>}</small>
            {kind}
          </div>
          {provider.id === rule.id && thresholdMismatch(provider.version, rule.range, rule.conflict) && <Chip tone="warning">{rule.conflict ? 'Конфликт версий' : 'Версия не подходит'}</Chip>}
          {provider.file === mod.file ? <Chip>В том же JAR</Chip> : <>
            <button className={'button small-btn ' + (provider.enabled ? 'secondary' : 'primary')} onClick={() => act(provider.enabled ? 'disable' : 'enable', [provider.file])}>{provider.enabled ? 'Отключить' : 'Включить'}</button>
            <button className="button danger small-btn" onClick={() => act('remove', [provider.file])}><Trash2 size={14} />Удалить</button>
          </>}
        </div>)}
        {!providers.length && <div className="dependency-file">
          <div className="dependency-info"><strong>{rule.id}</strong>{range && <small><code>{range}</code></small>}{kind}
            {!rule.conflict && <small>Отдельный JAR не найден</small>}
          </div>
          {!rule.conflict && <button className="button secondary small-btn" onClick={() => act('manual', [], { file: mod.file, id: rule.id })}><Plus size={15} />Импорт JAR</button>}
        </div>}
      </li>
    })}</ul></>}
    {environment.length > 0 && <div className="dependency-environment"><h3>Требования среды</h3><div className="chips">
      {environment.map((rule, index) => <Chip key={rule.id + ':' + index}>{environmentNames[rule.id] ?? rule.id}{rule.range && rule.range !== '*' ? ' ' + rule.range : ''}</Chip>)}
    </div></div>}
  </section>
}

export function MyMods({ profile, mods, loading, error, refresh, catalog, identify, folder, details, open, act, report }: { profile: Profile; mods: LocalMod[]; loading: boolean; error: string; refresh: () => void; catalog: () => void; identify: () => Promise<void>; folder: () => void; details: (mod: LocalMod) => void; open: (id: string) => void; act: ModAction; report: (error: unknown) => void }) {
  const [selection, setSelection] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [matching, setMatching] = useState(false)
  const [expanded, setExpanded] = useState<string>()
  const modList = useRef<HTMLDivElement>(null)
  const visible = mods.filter(mod => (mod.name + ' ' + mod.file).toLowerCase().includes(search.toLowerCase()))
  const selected = selection.filter(file => visible.some(item => item.file === file))
  const selectedDisabled = visible.filter(mod => !mod.enabled && selected.includes(mod.file)).map(mod => mod.file)
  const canEnable = selectedDisabled.length > 0
  useLayoutEffect(() => { setSelection([]); setSearch(''); setExpanded(undefined) }, [profile?.id])
  useLayoutEffect(() => {
    const files = new Set(mods.map(mod => mod.file))
    setSelection(current => {
      const next = current.map(file => files.has(file) ? file : /\.disabled$/i.test(file) ? file.replace(/\.disabled$/i, '') : file + '.disabled')
        .filter(file => files.has(file))
      return next.every((file, index) => file === current[index]) && next.length === current.length ? current : next
    })
  }, [mods])
  useEffect(() => {
    const openMenu = () => modList.current?.querySelector<HTMLDetailsElement>('details.menu[open]')
    function dismissOutside(event: MouseEvent) {
      const menu = openMenu()
      if (menu && event.target instanceof Node && !menu.contains(event.target)) menu.open = false
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const menu = openMenu()
      if (!menu) return
      event.preventDefault()
      menu.open = false
      menu.querySelector('summary')?.focus()
    }
    document.addEventListener('click', dismissOutside, true)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('click', dismissOutside, true)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [])
  return <>
      <div className="results-bar local-controls"><label className="search-field"><Search size={16} /><input aria-label="Поиск установленных модов" placeholder="Поиск по модам сборки" value={search} onChange={event => setSearch(event.target.value)} /></label><div>
        <button className="button secondary" disabled={loading || !mods.length || matching} onClick={() => { setMatching(true); void identify().finally(() => setMatching(false)) }}>{matching ? <Busy label="Поиск…" /> : <><Search size={15} />Определить источники</>}</button>
        <button className="button secondary" onClick={folder}><FolderOpen size={16} />Папка модов</button>
        <button className="button primary" onClick={() => act('manual', [])}><Plus size={17} />Импорт JAR</button>
        <button className="icon-button refresh" aria-label="Обновить список" title="Обновить список" onClick={refresh}><RefreshCw size={16} /></button></div>
      </div>
      {!loading && Boolean(visible.length) && <div className="batch-bar"><label className="check-label"><input type="checkbox" checked={selected.length === visible.length} onChange={event => setSelection(event.target.checked ? visible.map(item => item.file) : [])} />{selected.length ? 'Выбрано: ' + selected.length : 'Выбрать все'}</label>
        {Boolean(selected.length) && <div>
          <button className={'button small-btn ' + (canEnable ? 'primary' : 'secondary')} onClick={() => canEnable ? act('enable', selectedDisabled) : act('disable', selected)}>
            {canEnable ? <Check size={15} /> : <CircleMinus size={15} />}{canEnable ? 'Включить' : 'Отключить'}
          </button>
          <button className="button danger small-btn" onClick={() => act('remove', selected)}><Trash2 size={15} />Удалить</button>
        </div>}
      </div>}
      {error ? <ErrorBox message={error} retry={refresh} /> : loading ? <Busy label="Читаем папку модов…" /> : !visible.length ? <Empty icon={<PackageOpen />} title={search ? 'Совпадений нет' : 'Модов пока нет'} text={search ? 'Измените запрос поиска.' : 'Установите мод из каталога или импортируйте JAR-файл.'} action={!search && <button className="button secondary" onClick={catalog}>Открыть каталог<ArrowRight size={16} /></button>} /> :
        <div className="panel data-list local-list" ref={modList}>{visible.map(mod => <div className="local-entry" key={mod.file}><div className="data-row">
          <input type="checkbox" aria-label={'Выбрать ' + mod.name} checked={selected.includes(mod.file)} onChange={event => setSelection(files => event.target.checked ? [...files, mod.file] : files.filter(file => file !== mod.file))} />
          {mod.requirements.length > 0 ? <button className="icon-button dependency-toggle" aria-label={'Зависимости ' + mod.name} aria-expanded={expanded === mod.file}
            title="Зависимости" onClick={() => setExpanded(expanded === mod.file ? undefined : mod.file)}>
            {expanded === mod.file ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button> : <span className="dependency-spacer" aria-hidden="true" />}
          <IconTile url={mod.icon} /><button className="local-name" onClick={() => details(mod)}><strong>{mod.name}</strong><small>{mod.version} · {bytes(mod.size)} · {contentNames[contentSource(mod.projectId)]}</small></button>
          {mod.issue ? <Chip tone="warning"><CircleAlert size={13} />Метаданные</Chip> : mod.loader && mod.loader !== profile.loader && !(profile.loader === 'quilt' && mod.loader === 'fabric') ? <Chip tone="warning">Другой загрузчик</Chip> : <Chip tone={mod.enabled ? 'positive' : ''}>{mod.enabled ? 'Включён' : 'Отключён'}</Chip>}
          <button className={'toggle ' + (mod.enabled ? 'on' : '')} title={mod.enabled ? 'Отключить' : 'Включить'} aria-label={(mod.enabled ? 'Отключить ' : 'Включить ') + mod.name} aria-pressed={mod.enabled} onClick={() => act(mod.enabled ? 'disable' : 'enable', [mod.file])}><span /></button>
          <details className="menu" onClick={event => {
            if (event.target instanceof Element && event.target.closest('button')) event.currentTarget.open = false
          }}><summary className="icon-button" aria-label={'Действия для ' + mod.name}><MoreHorizontal size={20} /></summary><div>
            <button onClick={() => details(mod)}>Сведения и зависимости</button>{mod.projectId && <button onClick={() => open(mod.projectId!)}>Открыть страницу мода</button>}
            <button onClick={() => void api.showFolder(profile.id, mod.file).catch(report)}>Показать файл</button><button className="error-text" onClick={() => act('remove', [mod.file])}>Удалить</button>
          </div></details>
        </div>{expanded === mod.file && <InstalledDependencies mod={mod} mods={mods} act={act} details={details} />}</div>)}</div>
      }
  </>
}
