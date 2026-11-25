import { useEffect, useState } from 'react'
import { ArrowRight, Check, ChevronLeft, ChevronRight, Download, ExternalLink, Search, Sparkles } from 'lucide-react'
import { profileIssue } from './compatibility'
import { shaderStyles, type CatalogQuery, type LocalMod, type OptiFineRelease, type Profile, type ShaderPack, type ShaderProject, type ShaderRecommendation, type ShaderStyle } from './shared'
import { api, Busy, Chip, Empty, ErrorBox, errorText, profileLabel } from './ui'
import { Heading } from './views'

export function ShadersPage({ profile, mods, modsLoading, modsError, setup, install, enable, manageMods, manageShaders, createFabric, report }: {
  profile?: Profile; mods: LocalMod[]; modsLoading: boolean; modsError: string
  setup: () => void; install: (project: string, version: string) => void; enable: (file: string) => void
  manageMods: () => void; manageShaders: () => void; report: (error: unknown) => void
  createFabric: (game: string) => void
}) {
  const [recommendation, setRecommendation] = useState<ShaderRecommendation | null>()
  const [recommendationError, setRecommendationError] = useState('')
  const [optifineResult, setOptifineResult] = useState<{ release: OptiFineRelease | null; listedForge: string[] }>()
  const [optifineError, setOptifineError] = useState('')
  const [optifineBusy, setOptifineBusy] = useState(false)
  const [savedOptifine, setSavedOptifine] = useState('')
  const [packs, setPacks] = useState<ShaderPack[]>()
  const [packsError, setPacksError] = useState('')
  const [packRevision, setPackRevision] = useState(0)
  const [recommendationRevision, setRecommendationRevision] = useState(0)
  const id = profile?.id
  useEffect(() => {
    if (!id) return
    let active = true
    setRecommendationError('')
    api.shaderRecommendation(id).then(value => { if (active) setRecommendation(value) })
      .catch(error => { if (active) setRecommendationError(errorText(error)) })
    return () => { active = false }
  }, [id, recommendationRevision])
  useEffect(() => {
    if (!id || (profile?.loader !== 'vanilla' && profile?.loader !== 'forge')) return
    let active = true
    setOptifineError('')
    api.optiFineRelease(id).then(value => { if (active) setOptifineResult(value) })
      .catch(error => { if (active) setOptifineError(errorText(error)) })
    return () => { active = false }
  }, [id, profile?.loader, recommendationRevision])
  useEffect(() => {
    if (!id) return
    let active = true
    setPacksError('')
    api.shaderPacks(id).then(value => { if (active) setPacks(value) })
      .catch(error => { if (active) setPacksError(errorText(error)) })
    return () => { active = false }
  }, [id, packRevision])

  if (!profile) return <><Heading title="Каталог шейдеров" /><Empty icon={<Sparkles />} title="Сборка не подключена" text="Подключите сборку, чтобы подобрать мод для шейдеров." action={<button className="button primary" onClick={setup}>Подключить сборку</button>} /></>
  const found = mods.filter(mod => !mod.issue && mod.ids.some(id => id === 'iris' || id === 'oculus'))
  const available = found.filter(mod => !profileIssue(mod, profile))
  const enabled = available.find(mod => mod.enabled)
  const disabled = available.find(mod => !mod.enabled)
  const supported = recommendation?.kind === 'install' ? recommendation : undefined
  const external = recommendation?.kind === 'external' ? recommendation : undefined
  const optifine = optifineResult?.release
  const listedForge = optifineResult?.listedForge ?? []
  const fabricAlternative = recommendation === null && optifine === null && profile.loader === 'forge' &&
    (profile.game === '1.21' || profile.game === '1.21.1')
  const checkingOptifine = recommendation === null && (profile.loader === 'vanilla' || profile.loader === 'forge') && optifine === undefined && !optifineError
  const backup = optifine && !recommendation
  const optifineInfo = optifine && <p>{optifine.version}{optifine.preview ? ' · Предварительный выпуск' : ''}
    {optifine.forge && profile.loader === 'forge' ? ' · Forge ' + optifine.forge : ''}
    {profile.loader === 'vanilla' && ' · Установщик отдельного профиля'}</p>
  const optifineAction = optifine && (savedOptifine ? <Chip tone="positive"><Check size={15} />Скачан</Chip> :
    <button className="button secondary" disabled={optifineBusy} onClick={async () => {
      setOptifineBusy(true)
      try { setSavedOptifine(await api.downloadOptiFine(profile.id, optifine.file)) }
      catch (error) { report(error) }
      finally { setOptifineBusy(false) }
    }}><Download size={16} />{optifineBusy ? 'Скачиваем OptiFine…' : 'Скачать OptiFine'}</button>)
  return <>
    <Heading title="Каталог шейдеров" subtitle={profileLabel(profile) + (profile.loader === 'forge' && profile.loaderVersion ? ' ' + profile.loaderVersion : '')} actions={
      <button className="button secondary" onClick={manageShaders}>Шейдеры сборки<ArrowRight size={16} /></button>
    } />
    <section className="panel shader-readiness" aria-label="Поддержка шейдеров">
      <span className="shader-icon"><Sparkles size={21} /></span>
      <div className="shader-readiness-copy">
        <h2>{enabled ? 'Сборка готова к шейдерам' : disabled ? disabled.name + ' отключён' : modsError ? 'Не удалось проверить установленные моды' :
          modsLoading ? 'Проверяем установленные моды…' : found.length ? 'Установленный мод не подходит сборке' :
          recommendation ? 'Нужен ' + recommendation.name : recommendationError || optifineError ? 'Не удалось подобрать мод' :
          recommendation === undefined || checkingOptifine ? 'Ищем подходящий мод…' : backup ? 'Доступен OptiFine' : 'Подходящий мод не найден'}</h2>
        {enabled ? <p>{enabled.name} {enabled.version} · выберите пакет в настройках графики Minecraft.</p> :
          disabled ? <p>Включите мод, чтобы Minecraft мог загрузить пакеты.</p> :
          found.length ? <p>Проверьте версию установленного Iris или Oculus в разделе «Мои сборки».</p> :
          supported ? <p>Подходящая версия {supported.version}. Необходимые зависимости появятся в плане установки.</p> :
          external ? <p>Скачайте JAR с CurseForge и добавьте его на вкладке «Моды» в своей сборке. Сверьте зависимости на странице файла.</p> :
          backup ? optifineInfo :
          recommendation === null && optifine === null && <p>{profile.loader === 'forge' && listedForge.length
            ? 'Для Minecraft ' + profile.game + ' OptiFine указывает Forge ' + listedForge.join(', ') + '.'
            : profile.loader === 'forge' && profile.game === '1.21'
              ? 'OptiFine для Minecraft 1.21 не заявляет поддержку Forge.'
              : 'В официальном списке OptiFine нет выпуска для этой сборки.'}
            {fabricAlternative && ' Чтобы играть с шейдерами через Iris, создайте отдельную сборку с Fabric.'}</p>}
      </div>
      {enabled ? <Chip tone="positive">Включён</Chip> :
        disabled ? <button className="button primary" onClick={() => enable(disabled.file)}>Включить мод</button> :
        found.length ? <button className="button secondary" onClick={manageMods}>Моды сборки</button> :
        !modsLoading && !modsError && (supported ?
          <button className="button primary" onClick={() => install(supported.projectId, supported.versionId)}><Download size={16} />Установить Iris</button> :
          external ? <button className="button secondary" onClick={() => void api.external(external.url).catch(report)}><ExternalLink size={16} />Найти Oculus</button> :
          backup ? optifineAction :
          fabricAlternative && <button className="button secondary" onClick={() => createFabric(profile.game)}>Создать сборку с Fabric<ArrowRight size={16} /></button>)}
    </section>
    {external && optifine && !available.length && <section className="panel shader-readiness" aria-label="OptiFine">
      <span className="shader-icon"><Sparkles size={21} /></span>
      <div className="shader-readiness-copy"><h2>OptiFine</h2>{optifineInfo}</div>
      {optifineAction}
    </section>}
    {savedOptifine && <p role="status" className="muted">Файл {savedOptifine} сохранён в папке «Загрузки».</p>}
    {modsError && <ErrorBox message={modsError} />}
    {!available.length && recommendationError && <ErrorBox message={recommendationError} retry={() => setRecommendationRevision(value => value + 1)} />}
    {!available.length && recommendation === null && optifineError && <ErrorBox message={optifineError} retry={() => setRecommendationRevision(value => value + 1)} />}
    {packsError && <ErrorBox message={packsError} retry={() => setPackRevision(value => value + 1)} />}
    <ShaderCatalog profile={profile} packs={packs ?? []} checkingPacks={!packs && !packsError} unavailablePacks={Boolean(packsError)} installed={pack =>
      setPacks(previous => [...(previous ?? []).filter(item => item.name !== pack.name), pack].sort((a, b) => a.name.localeCompare(b.name, 'ru')))
    } report={report} />
  </>
}

const styleNames: Record<ShaderStyle, string> = { atmosphere: 'Атмосферные', fantasy: 'Фэнтези', realistic: 'Реалистичные', 'vanilla-like': 'В стиле Minecraft' }

function ShaderCatalog({ profile, packs, checkingPacks, unavailablePacks, installed, report }: { profile: Profile; packs: ShaderPack[]; checkingPacks: boolean; unavailablePacks: boolean; installed: (pack: ShaderPack) => void; report: (error: unknown) => void }) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [result, setResult] = useState<{ items: ShaderProject[]; total: number }>()
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState<string>()
  const [sort, setSort] = useState<CatalogQuery['sort']>('downloads')
  const [style, setStyle] = useState<ShaderStyle | ''>('')
  const installedProjects = new Set(packs.map(pack => pack.projectId))

  useEffect(() => {
    let active = true
    setResult(undefined)
    setError('')
    const timer = window.setTimeout(() => {
      api.searchShaders(profile.id, query.trim(), page * 6, sort, style).then(value => { if (active) setResult(value) })
        .catch(err => { if (active) setError(errorText(err)) })
    }, 170)
    return () => { active = false; window.clearTimeout(timer) }
  }, [profile.id, query, page, revision, sort, style])

  async function download(project: ShaderProject) {
    if (pending) return
    setPending(project.id)
    try {
      installed(await api.installShader(profile.id, project.id))
    } catch (error) { report(error) }
    finally { setPending(undefined) }
  }

  return <section className="shader-packs" aria-label="Каталог шейдеров">
    <div className="section-heading shader-catalog-heading">
      <div className="shader-filters">
      <label className="search-field"><Search size={16} /><input aria-label="Поиск шейдеров" placeholder="Поиск шейдеров" value={query}
        onChange={event => { setQuery(event.target.value); setPage(0) }} /></label>
      <select aria-label="Стиль шейдеров" value={style} onChange={event => { setStyle(event.target.value as ShaderStyle | ''); setPage(0) }}>
        <option value="">Все стили</option>{shaderStyles.map(item => <option key={item} value={item}>{styleNames[item]}</option>)}
      </select>
      <select aria-label="Сортировка шейдеров" value={sort} onChange={event => { setSort(event.target.value as CatalogQuery['sort']); setPage(0) }}>
        <option value="downloads">По скачиваниям</option><option value="follows">По популярности</option><option value="newest">Новые</option><option value="updated">Недавно обновлённые</option><option value="relevance">По релевантности</option>
      </select>
      </div>
    </div>
    {error ? <ErrorBox message={error} retry={() => setRevision(value => value + 1)} /> : !result ? <Busy label="Загружаем каталог шейдеров…" /> : result.items.length ? <>
      <div className="card-grid shader-grid">{result.items.map(project => <article className="panel shader-card" key={project.id}>
        {project.image && <img src={project.image} alt="" loading="lazy" />}
        <div className="shader-card-copy"><h3>{project.name}</h3><small>{project.author}</small><p>{project.summary}</p></div>
        <div className="shader-card-actions">
          <button className="icon-button" aria-label={'Открыть ' + project.name + ' на Modrinth'} title="Открыть на Modrinth"
            onClick={() => void api.external('https://modrinth.com/shader/' + encodeURIComponent(project.slug)).catch(report)}><ExternalLink size={16} /></button>
          <button className={'button secondary small-btn' + (installedProjects.has(project.id) ? ' shader-installed' : '')} disabled={checkingPacks || unavailablePacks || Boolean(pending) || installedProjects.has(project.id)} onClick={() => void download(project)}>
            {installedProjects.has(project.id) ? <Check size={15} /> : <Download size={15} />}
            {pending === project.id ? 'Скачиваем…' : installedProjects.has(project.id) ? 'Установлен' : checkingPacks ? 'Проверяем…' : 'Установить'}
          </button>
        </div>
      </article>)}</div>
      {result.total > 6 && <div className="pager">
        <button className="button secondary small-btn" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={16} />Назад</button>
        <span>Страница {page + 1}</span>
        <button className="button secondary small-btn" disabled={(page + 1) * 6 >= Math.min(result.total, 990)} onClick={() => setPage(page + 1)}>Далее<ChevronRight size={16} /></button>
      </div>}
    </> : <p className="muted">{query.trim() || style ? 'По этим параметрам пакеты не найдены.' : 'На Modrinth пока нет пакетов Iris для этой версии Minecraft.'}</p>}
  </section>
}
