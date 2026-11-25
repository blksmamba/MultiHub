import { useEffect, useState } from 'react'
import { Box, Check, CircleAlert, Download, FilePlus2, Folder, FolderOpen, HardDrive, Puzzle, Settings2 } from 'lucide-react'
import { contentNames, contentSource, loaders, loaderName, type AppState, type Candidate, type LocalMod, type Plan, type Profile, type ProfileInput, type Transfer } from './shared'
import { api, Busy, bytes, Chip, errorText, ErrorBox, Modal, profileLabel } from './ui'

export function Setup({ close, saved, profiles }: { close: () => void; saved: (state: AppState) => void; profiles: Profile[] }) {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [scanning, setScanning] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Omit<ProfileInput, 'loader'> & { loader: ProfileInput['loader'] | '' }>({ directory: '', name: '', game: '', loader: '', loaderVersion: '' })
  useEffect(() => {
    let alive = true
    api.discover().then(result => { if (alive) setCandidates(result) }).catch(error => { if (alive) setError(errorText(error)) }).finally(() => { if (alive) setScanning(false) })
    return () => { alive = false }
  }, [])
  function useCandidate(candidate: Candidate, index = 0) {
    const version = candidate.versions[index]
    setDraft({ name: candidate.label, directory: candidate.directory, game: version?.game ?? '', loader: version?.loader ?? '', loaderVersion: version?.loaderVersion ?? '' })
    setError('')
  }
  const visible = candidates.filter(item => !profiles.some(profile => profile.directory === item.directory))
  const selected = candidates.find(item => item.directory === draft.directory)
  async function browse() {
    try {
      const candidate = await api.browse()
      if (!candidate) return
      setCandidates(items => [...items.filter(item => item.directory !== candidate.directory), candidate])
      useCandidate(candidate)
    } catch (error) { setError(errorText(error)) }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (saving || !draft.loader) return
    setSaving(true)
    setError('')
    try { saved(await api.saveProfile({ ...draft, loader: draft.loader })) }
    catch (error) { setError(errorText(error)) }
    finally { setSaving(false) }
  }
  return <Modal title="Подключить сборку" subtitle="Выберите папку существующей установки Minecraft Java Edition." close={close}
    footer={<><button className="button secondary" onClick={close}>Отмена</button><button type="submit" form="setup-form" className="button primary" disabled={!draft.directory || !draft.name.trim() || !draft.game.trim() || !draft.loader || saving}><Check size={16} />Подключить</button></>}>
    <form id="setup-form" onSubmit={save} className="setup-form">
      {scanning && <Busy label="Ищем установки Minecraft…" />}
      {visible.length > 0 && <div className="candidate-list">{visible.map(item => <button type="button" className={'candidate ' + (draft.directory === item.directory ? 'selected' : '')} key={item.directory} onClick={() => useCandidate(item)}>
        <HardDrive size={19} /><span><strong>{item.label}</strong><small>{item.directory}</small></span>{draft.directory === item.directory && <Check size={17} />}
      </button>)}</div>}
      <button type="button" className="button secondary browse" onClick={() => void browse()}><FolderOpen size={17} />Выбрать папку вручную</button>
      {draft.directory && <div className="path"><Folder size={14} />{draft.directory}</div>}
      {selected && selected.versions.length > 1 && <label className="field">Обнаруженные версии<select defaultValue="0" key={selected.directory} onChange={event => useCandidate(selected, Number(event.target.value))}>{selected.versions.map((version, index) => <option key={index} value={index}>{version.game} {version.loader && '· ' + loaderName[version.loader]} {version.loaderVersion}</option>)}</select></label>}
      <label className="field">Название сборки<input value={draft.name} maxLength={100} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="Например, Vanilla Plus" /></label>
      <div className="form-row">
        <label className="field">Minecraft<input value={draft.game} onChange={event => setDraft({ ...draft, game: event.target.value })} placeholder="1.21.1" /></label>
        <label className="field">Загрузчик<select value={draft.loader} onChange={event => setDraft({ ...draft, loader: event.target.value as ProfileInput['loader'] | '', loaderVersion: '' })}><option value="">Выберите</option>{loaders.map(item => <option value={item} key={item}>{loaderName[item]}</option>)}</select></label>
        <label className="field">Версия загрузчика<input value={draft.loaderVersion} onChange={event => setDraft({ ...draft, loaderVersion: event.target.value })} placeholder="Необязательно" /></label>
      </div>
      {error && <ErrorBox message={error} />}
    </form>
  </Modal>
}

const planStatus = { download: 'Будет загружен', waiting: 'Ожидание скачивания', installed: 'Уже установлен', enable: 'Будет включён', optional: 'Необязательный', blocked: 'Заблокировано' }
export function InstallDialog({ profile, project, version, installedVersionId, close, queued }: { profile: Profile; project: string; version?: string; installedVersionId?: string; close: () => void; queued: (manual: boolean) => void }) {
  const [plan, setPlan] = useState<Plan>()
  const [optional, setOptional] = useState<string[]>([])
  const [custom, setCustom] = useState(false)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(true)
  const [request, setRequest] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    setBusy(true)
    setError('')
    setPlan(undefined)
    api.plan(profile.id, project, version, optional, installedVersionId).then(value => { if (current) setPlan(value) }).catch(error => { if (current) setError(errorText(error)) }).finally(() => { if (current) setBusy(false) })
    return () => { current = false }
  }, [profile.id, project, version, optional, request, installedVersionId])
  const actionable = plan?.items.some(item => item.status === 'download' || item.status === 'enable' || item.status === 'waiting')
  const waiting = plan?.items.filter(item => item.status === 'waiting') ?? []
  async function install() {
    if (!plan || busy || !actionable || plan.blockers.length) return
    setBusy(true)
    try {
      await api.install(plan.id, running)
      queued(Boolean(waiting.length))
    } catch (error) { setError(errorText(error)); setBusy(false) }
  }
  return <Modal title={installedVersionId ? 'Обновление мода' : 'План установки'} subtitle={profile.name + ' · ' + profileLabel(profile)} close={close} wide footer={<>
    <button className="button secondary" onClick={close}>Отмена</button>
    {plan && (optional.length > 0 || plan.items.some(item => item.status === 'optional')) && <button className="button secondary" onClick={() => setCustom(!custom)}><Settings2 size={16} />Настроить</button>}
    <button className="button primary" disabled={busy || !actionable || Boolean(plan?.blockers.length)} onClick={() => void install()}><Download size={16} />{waiting.length ? 'Добавить в загрузки' : installedVersionId ? 'Установить обновление' : 'Установить всё'}</button>
  </>}>
    {busy && <Busy label="Проверяем зависимости…" />}
    {error && <ErrorBox message={error} retry={() => setRequest(value => value + 1)} />}
    {plan && <>
      <div className="plan-summary"><Chip><FilePlus2 size={14} />{plan.items.filter(item => item.status === 'download').length} новых файлов</Chip><Chip>{bytes(plan.bytes)}</Chip></div>
      <div className="plan-list">{plan.items.filter(item => item.status !== 'waiting').map(item => {
        const chosen = optional.includes(item.key) || Boolean(item.versionId && optional.includes(item.versionId))
        const choice = item.versionId && optional.includes(item.versionId) ? item.versionId : item.key
        return <div className="plan-row" key={item.status + item.key}>
          {custom && (item.status === 'optional' || chosen) ? <input type="checkbox" aria-label={item.name} checked={chosen} onChange={() => setOptional(list => chosen ? list.filter(id => id !== choice) : [...list, choice])} /> : item.status === 'blocked' ? <CircleAlert size={17} /> : <Puzzle size={17} />}
          <span><strong>{item.name}</strong><small>{item.replaces ? item.replaces.version + ' → ' + item.version : item.reason ?? item.version}</small>
            {item.status !== 'blocked' && <small>{contentNames[contentSource(item.projectId)]}</small>}
            {item.replaces && <small>{item.replaces.filename}{!item.replaces.enabled && ' · останется отключённым'}</small>}
          </span><Chip tone={item.status === 'blocked' ? 'warning' : item.status === 'installed' ? 'positive' : ''}>{item.replaces ? 'Будет заменён' : planStatus[item.status]}</Chip>
        </div>
      })}</div>
      {Boolean(waiting.length) && <section aria-label="Ожидаемые файлы">
        <h3>Ожидаемые файлы</h3><p className="muted">Откройте страницу нужной версии из очереди и подтвердите импорт скачанного JAR.</p>
        <div className="plan-list">{waiting.map(item => <div className="plan-row" key={item.key}><Puzzle size={17} />
          <span><strong>{item.name}</strong><small>{contentNames[contentSource(item.projectId)]} · {item.filename}</small>{item.reason && <small>{item.reason}</small>}</span>
          <Chip tone="warning">{planStatus.waiting}</Chip>
        </div>)}</div>
      </section>}
      {!actionable && !plan.blockers.length && <p className="muted">Все файлы из плана уже установлены.</p>}
      {Boolean(plan.blockers.length) && <ErrorBox message="Устраните отмеченные проблемы перед установкой." />}
      {installedVersionId ? actionable && <div className="game-warning"><p><CircleAlert size={16} />Перед обновлением закройте Minecraft. Старые файлы сохранятся в папке .modkit-updates внутри сборки.</p></div>
        : <GameWarning running={running} setRunning={setRunning} />}
    </>}
  </Modal>
}

export function GameWarning({ running, setRunning }: { running: boolean; setRunning: (value: boolean) => void }) {
  return <div className="game-warning"><p><CircleAlert size={16} />Перед изменением файлов закройте Minecraft.</p><label><input type="checkbox" checked={running} onChange={event => setRunning(event.target.checked)} />Продолжить, даже если Minecraft запущен</label></div>
}

export function ChangeDialog({ action, mods, affected, files, dependency, close, commit }: { action: 'enable' | 'disable' | 'remove' | 'manual'; mods: LocalMod[]; affected: string[]; files: string[]; dependency?: string; close: () => void; commit: (allow: boolean) => Promise<void> }) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const titles = { enable: 'Включить моды', disable: 'Отключить моды', remove: 'Удалить моды', manual: 'Импортировать JAR' }
  const names = mods.filter(item => files.includes(item.file)).map(item => item.name)
  async function apply() {
    setBusy(true)
    try { await commit(running); close() }
    catch (error) { setError(errorText(error)); setBusy(false) }
  }
  return <Modal title={titles[action]} subtitle={dependency ? 'Зависимость · ' + dependency : undefined} close={close} footer={<><button className="button secondary" onClick={close}>Отмена</button><button className={'button ' + (action === 'remove' ? 'danger' : 'primary')} disabled={busy} onClick={() => void apply()}>{action === 'manual' ? dependency ? 'Выбрать JAR' : 'Выбрать JAR-файлы' : 'Подтвердить'}</button></>}>
    {names.length > 0 && <p className="muted">{names.join(', ')}</p>}
    {action === 'remove' && <p className="muted">Файлы будут перенесены в папку .modkit-removed внутри сборки.</p>}
    {affected.length > 0 && <ErrorBox message={'Эта зависимость нужна модам «' + affected.join('», «') + '». После изменения они могут перестать работать.'} />}
    <GameWarning running={running} setRunning={setRunning} />
    {error && <ErrorBox message={error} />}
  </Modal>
}

export function RetryDialog({ transfer, close }: { transfer: Transfer; close: () => void }) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  return <Modal title="Повторить загрузку" subtitle={transfer.name} close={close} footer={<><button className="button secondary" onClick={close}>Отмена</button><button className="button primary" onClick={() => void api.retry(transfer.jobId, running).then(close).catch(error => setError(errorText(error)))}>Повторить</button></>}>
    {transfer.updating ? <div className="game-warning"><p><CircleAlert size={16} />Перед обновлением закройте Minecraft.</p></div> : <GameWarning running={running} setRunning={setRunning} />}
    {error && <ErrorBox message={error} />}
  </Modal>
}

export function LocalDetails({ mod, close }: { mod: LocalMod; close: () => void }) {
  return <Modal title={mod.name} subtitle={mod.file} close={close}>
    <div className="plan-summary"><Chip><Box size={14} />{mod.version}</Chip><Chip>{bytes(mod.size)}</Chip>{mod.author && <Chip>{mod.author}</Chip>}</div>
    {mod.description && <p className="muted">{mod.description}</p>}
    {mod.issue && <ErrorBox message={mod.issue} />}
    <h3>Зависимости</h3>
    {!mod.requirements.length && <p className="muted">В метаданных файла нет списка зависимостей.</p>}
    <div className="plan-list">{mod.requirements.map((requirement, index) => <div className="plan-row" key={requirement.id + index}><Puzzle size={17} /><span><strong>{requirement.id}</strong><small>{requirement.range ?? 'Любая версия'}</small></span><Chip>{requirement.conflict ? 'Конфликт' : requirement.optional ? 'Необязательная' : 'Обязательная'}</Chip></div>)}</div>
  </Modal>
}
