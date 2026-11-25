import { useEffect, useState } from 'react'
import { Download, FileArchive } from 'lucide-react'
import { contentNames, contentSource, loaderName, type ExplorerImport, type Plan, type Profile } from './shared'
import { api, Busy, Chip, ErrorBox, errorText, Modal, profileLabel } from './ui'

const statusNames = {
  download: 'Будет установлен', waiting: 'Ожидание скачивания', installed: 'Пропущен',
  enable: 'Будет включён', optional: 'Необязательный', blocked: 'Требует внимания',
}

export function ExplorerImportDialog({ batch, profiles, activeId, close, queued }: {
  batch: ExplorerImport; profiles: Profile[]; activeId: string | null; close: () => void; queued: (manual: boolean) => void
}) {
  const choices = profiles.filter(profile => profile.loader !== 'vanilla')
  const [profileId, setProfileId] = useState(choices.find(profile => profile.id === activeId)?.id ?? choices[0]?.id ?? '')
  const [excluded, setExcluded] = useState(() => new Set<number>())
  const [plan, setPlan] = useState<Plan>()
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const hasProfile = choices.some(profile => profile.id === profileId)
  const selectedCount = batch.files.length - excluded.size
  useEffect(() => {
    setPlan(undefined)
    setError('')
    if (!hasProfile || !selectedCount) { setBusy(false); return }
    setBusy(true)
    let active = true
    const timer = window.setTimeout(() => {
      const indices = batch.files.flatMap((_, index) => excluded.has(index) ? [] : [index])
      api.planExplorerImport(batch.id, profileId, indices)
        .then(value => { if (active) setPlan(value) })
        .catch(error => { if (active) setError(errorText(error)) })
        .finally(() => { if (active) setBusy(false) })
    }, 180)
    return () => { active = false; window.clearTimeout(timer) }
  }, [batch, profileId, hasProfile, excluded, selectedCount, revision])

  const fileItems = new Map(plan?.items.filter(item => item.inputIndex !== undefined).map(item => [item.inputIndex, item]))
  const dependencies = plan?.items.filter(item => item.inputIndex === undefined) ?? []
  const actionable = plan?.items.some(item => ['download', 'waiting', 'enable'].includes(item.status))
  const waiting = dependencies.some(item => item.status === 'waiting')
  async function install() {
    if (!plan || saving || busy || plan.blockers.length || !actionable) return
    setSaving(true)
    try { await api.install(plan.id, false); queued(waiting) }
    catch (error) { setError(errorText(error)); setSaving(false) }
  }

  return <Modal title="Импортировать в MultiHub" subtitle={'Файлов из Проводника: ' + batch.files.length} close={() => { if (!saving) close() }} wide footer={<>
    <button className="button secondary" disabled={saving} onClick={close}>Отмена</button>
    <button className="button primary" disabled={busy || saving || !actionable || Boolean(plan?.blockers.length)} onClick={() => void install()}>
      <Download size={16} />{waiting ? 'Добавить в загрузки' : 'Установить выбранные'}
    </button>
  </>}>
    <label className="field">Сборка для импорта
      <select value={hasProfile ? profileId : ''} disabled={saving || !choices.length} onChange={event => { setPlan(undefined); setProfileId(event.target.value) }}>
        {!hasProfile && <option value="">{choices.length ? 'Выберите сборку' : 'Нет сборок с загрузчиком модов'}</option>}
        {choices.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profileLabel(profile)}</option>)}
      </select>
    </label>
    {!choices.length && <p className="muted">Создайте или подключите сборку с загрузчиком, чтобы импортировать файлы.</p>}
    {busy && <Busy label="Проверяем JAR и обязательные зависимости…" />}
    {error && <ErrorBox message={error} retry={() => setRevision(value => value + 1)} />}
    <section className="explorer-file-section" aria-label="Выбранные JAR">
      <div className="section-heading"><h3>Файлы для импорта</h3><Chip>{selectedCount} из {batch.files.length}</Chip></div>
      <div className="plan-list explorer-file-list">
        {batch.files.map((name, index) => {
          const item = fileItems.get(index)
          return <div className="plan-row" key={index}>
            <input type="checkbox" aria-label={'Включить в импорт ' + name} checked={!excluded.has(index)} disabled={saving} onChange={() => {
              setPlan(undefined)
              setExcluded(previous => {
                const next = new Set(previous)
                if (!next.delete(index)) next.add(index)
                return next
              })
            }} />
            <div className="explorer-file-label"><strong>{item?.name ?? name}</strong>
              {item && <small>{[item.version, item.loader && loaderName[item.loader], name].filter(Boolean).join(' · ')}</small>}
              {item?.reason && <small>{item.reason}</small>}
            </div>
            {item && <Chip tone={item.status === 'blocked' ? 'warning' : ''}>{statusNames[item.status]}</Chip>}
          </div>
        })}
      </div>
    </section>
    {dependencies.length > 0 && <section className="explorer-file-section" aria-label="Зависимости импорта">
      <div className="section-heading"><h3>Зависимости</h3></div>
      <div className="plan-list explorer-file-list">{dependencies.map(item => <div className="plan-row" key={item.key}>
        <FileArchive size={16} /><div className="explorer-file-label"><strong>{item.name}</strong><small>{contentNames[contentSource(item.projectId)]}{item.version && ' · ' + item.version}</small>
          {item.reason && <small>{item.reason}</small>}</div><Chip tone={item.status === 'waiting' ? 'warning' : ''}>{statusNames[item.status]}</Chip>
      </div>)}</div>
    </section>}
    {plan?.blockers.map(message => <ErrorBox key={message} message={message} />)}
  </Modal>
}
