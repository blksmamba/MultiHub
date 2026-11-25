import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRight, FileArchive, FolderOpen, Layers3, Plus, Puzzle, RefreshCw, Sparkles } from 'lucide-react'
import type { LocalPack, PackFolder, Profile } from './shared'
import { api, Busy, bytes, Empty, ErrorBox, errorText } from './ui'

const tabs = [
  { id: 'mods', label: 'Моды', icon: Puzzle },
  { id: 'shaderpacks', label: 'Шейдеры', icon: Sparkles },
  { id: 'resourcepacks', label: 'Ресурспаки', icon: Layers3 },
] as const

export type BuildTab = typeof tabs[number]['id']

export function BuildContent({ profile, tab, select, mods, shaderCatalog, report }: {
  profile: Profile; tab: BuildTab; select: (tab: BuildTab) => void; mods: ReactNode
  shaderCatalog: () => void; report: (error: unknown) => void
}) {
  const current = tabs.find(item => item.id === tab)!
  return <section className="build-content" aria-labelledby="build-content-title">
    <h2 id="build-content-title">Содержимое сборки</h2>
    <div className="tabs build-tabs" role="tablist" aria-labelledby="build-content-title" onKeyDown={event => {
      const index = tabs.indexOf(current)
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length :
        event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length :
        event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined
      if (next === undefined) return
      event.preventDefault()
      select(tabs[next].id)
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
    }}>
      {tabs.map(({ id, label, icon: Icon }) => <button type="button" key={id} id={'build-tab-' + id}
        role="tab" aria-selected={tab === id} aria-controls={'build-panel-' + id} tabIndex={tab === id ? 0 : -1}
        onClick={() => select(id)}><Icon size={16} aria-hidden="true" />{label}</button>)}
    </div>
    {tabs.map(({ id }) => <div key={id} role="tabpanel" id={'build-panel-' + id} aria-labelledby={'build-tab-' + id} hidden={tab !== id}>
      {tab === id && (id === 'mods' ? mods : <BuildPacks profile={profile} folder={id} shaderCatalog={shaderCatalog} report={report} />)}
    </div>)}
  </section>
}

function BuildPacks({ profile, folder, shaderCatalog, report }: {
  profile: Profile; folder: PackFolder; shaderCatalog: () => void; report: (error: unknown) => void
}) {
  const [packs, setPacks] = useState<LocalPack[]>()
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [importing, setImporting] = useState(false)
  const shaders = folder === 'shaderpacks'
  const refresh = () => setRevision(value => value + 1)
  const openFolder = () => void (shaders ? api.openShaderFolder(profile.id) : api.openResourceFolder(profile.id)).catch(report)

  useEffect(() => {
    let active = true
    setError('')
    api.localPacks(profile.id, folder).then(items => { if (active) setPacks(items) })
      .catch(error => { if (active) setError(errorText(error)) })
    return () => { active = false }
  }, [profile.id, folder, revision])

  async function importPack() {
    setImporting(true)
    try { if (await api.importShaderPack(profile.id)) refresh() }
    catch (error) { report(error) }
    finally { setImporting(false) }
  }

  return <>
    <div className="build-pack-controls">
      {shaders && <button className="button text-button" onClick={shaderCatalog}>Каталог шейдеров<ArrowRight size={16} /></button>}
      <div className="heading-actions">
        <button className="button secondary" onClick={openFolder}><FolderOpen size={16} />{shaders ? 'Папка шейдеров' : 'Папка ресурспаков'}</button>
        {shaders && <button className="button primary" disabled={importing} onClick={() => void importPack()}><Plus size={16} />Импорт ZIP</button>}
        <button className="icon-button refresh" aria-label="Обновить список" title="Обновить список" onClick={refresh}><RefreshCw size={16} /></button>
      </div>
    </div>
    {error ? <ErrorBox message={error} retry={refresh} /> : packs === undefined ? <Busy label="Читаем папку сборки…" /> : packs.length ? (
      <ul className="panel data-list shader-pack-list">{packs.map(pack => <li className="data-row" key={pack.name}>
        <span className="icon-tile"><FileArchive size={17} /></span><span><strong>{pack.name}</strong>
          <small>{pack.size === undefined ? 'Папка' : bytes(pack.size)}</small></span>
      </li>)}</ul>
    ) : <Empty icon={shaders ? <Sparkles /> : <Layers3 />} title={shaders ? 'Шейдеров пока нет' : 'Ресурспаков пока нет'}
      text={shaders ? 'Установите шейдер из каталога или импортируйте ZIP.' : 'Добавьте ZIP или распакованный пакет в папку ресурспаков этой сборки.'} />}
  </>
}
