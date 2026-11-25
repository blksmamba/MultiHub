import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, ExternalLink, FolderPlus, Package, Search } from 'lucide-react'
import type { ArchiveKind, ArchiveProject, CatalogQuery, Profile } from './shared'
import { api, Busy, Chip, Empty, ErrorBox, errorText, profileLabel } from './ui'
import { Heading } from './views'

const titles = { resourcepack: 'Ресурспаки', datapack: 'Датапаки', world: 'Карты' }
const sorts: Record<CatalogQuery['sort'], string> = { downloads: 'По скачиваниям', follows: 'По популярности',
  newest: 'Новые', updated: 'Недавно обновлённые', relevance: 'По релевантности' }

export function ArchiveCatalog({ kind, profile, setup }: { kind: ArchiveKind; profile?: Profile; setup: () => void }) {
  if (!profile) return <><Heading title={titles[kind]} /><Empty icon={<Package />} title="Сборка не подключена"
    text="Подключите сборку, чтобы подобрать совместимые файлы." action={<button className="button primary" onClick={setup}>Подключить сборку</button>} /></>
  return <ArchiveResults key={profile.id + kind} kind={kind} profile={profile} />
}

function ArchiveResults({ kind, profile }: { kind: ArchiveKind; profile: Profile }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<CatalogQuery['sort']>('downloads')
  const [compatible, setCompatible] = useState(true)
  const [page, setPage] = useState(0)
  const [world, setWorld] = useState('')
  const [worlds, setWorlds] = useState<string[]>([])
  const [result, setResult] = useState<{ items: ArchiveProject[]; total: number; available: boolean }>()
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [worldError, setWorldError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [installed, setInstalled] = useState<Record<string, boolean>>({})
  const [manual, setManual] = useState<Record<string, string>>({})
  const source = kind === 'world' ? 'CurseForge' : 'Modrinth'

  useEffect(() => {
    if (kind === 'resourcepack') return
    let active = true
    setWorldError('')
    api.archiveWorlds(profile.id).then(items => {
      if (!active) return
      setWorlds(items)
      setWorld(current => items.includes(current) ? current : '')
    }).catch(err => { if (active) setWorldError(errorText(err)) })
    return () => { active = false }
  }, [kind, profile.id, revision])

  useEffect(() => {
    let active = true
    setError('')
    setResult(undefined)
    const timer = window.setTimeout(() => {
      api.archiveSearch(profile.id, kind, query.trim(), page * 6, sort, compatible)
        .then(value => { if (active) setResult(value) })
        .catch(err => { if (active) setError(errorText(err)) })
    }, 170)
    return () => { active = false; window.clearTimeout(timer) }
  }, [profile.id, kind, query, sort, compatible, page, revision])

  async function install(project?: ArchiveProject) {
    setBusy(true)
    setActionError('')
    setMessage('')
    try {
      if (project) {
        const response = await api.archiveInstall(profile.id, kind, project.id, world)
        if ('url' in response) setManual(previous => ({ ...previous, [project.id]: response.url }))
        else {
          setInstalled(previous => ({ ...previous, [world + '/' + project.id]: true }))
          setMessage('Установлено · ' + response.name)
        }
      } else {
        const name = await api.archiveImport(profile.id, kind, world)
        if (name) setMessage('Импортировано · ' + name)
      }
      if (kind === 'world') setRevision(value => value + 1)
    } catch (err) { setActionError(errorText(err)) }
    finally { setBusy(false) }
  }

  return <>
    <Heading title={titles[kind]} subtitle={profileLabel(profile)} actions={
      <button className="button secondary" disabled={busy || (kind === 'datapack' && !world)} onClick={() => void install()}><FolderPlus size={16} />Импорт ZIP</button>} />
    {kind === 'world' && <p className="muted">При импорте проверьте версию карты у автора. Если имя уже занято, MultiHub создаст отдельную папку.</p>}
    {kind === 'datapack' && <div className="section-heading"><label>Мир для установки <select value={world} disabled={busy} onChange={event => setWorld(event.target.value)}>
      <option value="">{worlds.length ? 'Выберите мир' : 'Нет доступных миров'}</option>
      {worlds.map(item => <option key={item}>{item}</option>)}</select></label>
      <button className="button secondary small-btn" onClick={() => setRevision(value => value + 1)}>Обновить список миров</button></div>}
    {worldError && <ErrorBox message={worldError} />}
    {actionError && <ErrorBox message={actionError} />}
    {message && <p role="status">{message}</p>}
    <div className="section-heading shader-catalog-heading"><div className="shader-filters">
      <label className="search-field"><Search size={16} /><input aria-label="Поиск по каталогу" placeholder="Название или автор" value={query}
        onChange={event => { setQuery(event.target.value); setPage(0) }} /></label>
      <select aria-label="Сортировка" value={sort} onChange={event => { setSort(event.target.value as CatalogQuery['sort']); setPage(0) }}>
        {Object.entries(sorts).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <label><input type="checkbox" checked={compatible} onChange={event => { setCompatible(event.target.checked); setPage(0) }} /> Для моей версии</label>
    </div><Chip>{source}</Chip></div>
    {error ? <ErrorBox message={error} retry={() => setRevision(value => value + 1)} /> :
      !result ? <Busy label="Загружаем каталог…" /> : !result.available ?
        <Empty icon={<Package />} title="Онлайн-каталог карт недоступен" text="Для поиска в CurseForge нужен разрешённый доступ к API. Уже скачанную карту можно импортировать из ZIP." /> :
      !result.items.length ? <Empty icon={<Search />} title="Ничего не найдено" text="Попробуйте изменить запрос или фильтр версии." /> : <>
        <div className="card-grid shader-grid">{result.items.map(project => <article className="panel shader-card" key={project.id}>
          {project.image && <img src={project.image} alt="" loading="lazy" />}
          <div className="shader-card-copy"><h3>{project.name}</h3><small>{project.author}</small><p>{project.summary}</p></div>
          <div className="shader-card-actions">
            <button className="icon-button" title={'Открыть на ' + source} aria-label={'Открыть на ' + source}
              onClick={() => void api.external(project.url).catch(err => setActionError(errorText(err)))}><ExternalLink size={16} /></button>
            {installed[world + '/' + project.id] ? <Chip tone="positive">Установлено</Chip> : manual[project.id] ?
              <button className="button secondary small-btn" onClick={() => void api.external(manual[project.id]).catch(err => setActionError(errorText(err)))}>Перейти к скачиванию</button> :
              <button className="button secondary small-btn" disabled={busy || (kind === 'datapack' && !world)}
                onClick={() => void install(project)}><Download size={16} />{compatible ? 'Установить' : 'Проверить и установить'}</button>}
          </div>
        </article>)}</div>
        <div className="pager">
          <button className="button secondary small-btn" disabled={!page} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} />Назад</button>
          <span>Страница {page + 1}</span>
          <button className="button secondary small-btn" disabled={(page + 1) * 6 >= Math.min(result.total, 990)} onClick={() => setPage(value => value + 1)}>Далее<ChevronRight size={16} /></button>
        </div>
      </>}
    {kind === 'world' && worlds.length > 0 && <section className="panel settings-panel"><h2>Миры сборки</h2><ul>
      {worlds.map(item => <li key={item}>{item}</li>)}</ul></section>}
  </>
}
