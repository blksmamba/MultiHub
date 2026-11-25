import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Box, FolderOpen, Gamepad2, Pencil, Settings2, Trash2 } from 'lucide-react'
import { BuildActions, GameStatusPanel, LaunchButton } from './GameControls'
import { gameMemory, loaderName, nicknamePattern, validNickname, type AppState, type GameLaunchState, type LauncherDraft, type LauncherLoader, type LauncherLoaderVersion, type LauncherRelease, type Profile } from './shared'
import { api, Busy, Chip, Empty, ErrorBox, errorText, Modal, number } from './ui'
import { Heading } from './views'

export function BuildsPage({ state, status, activate, remove, updated, create, connect, report, launch, children }: {
  state: AppState; status: GameLaunchState; activate: (id: string) => void; create: () => void; connect: () => void
  report: (error: unknown) => void; remove: (profile: Profile) => void
  updated: (profile: Profile) => void
  launch: (id: string) => void
  children?: ReactNode
}) {
  const profiles = state.profiles
  const [editing, setEditing] = useState<Profile>()
  const current = profiles.find(profile => profile.id === state.activeId)
  const statusProfile = profiles.find(profile => profile.id === status.profileId)

  return <>
    <Heading title="Мои сборки" actions={<BuildActions create={create} connect={connect} />} />
    <GameStatusPanel status={status} name={statusProfile?.name ?? 'Minecraft'} report={report} retry={statusProfile ? () => launch(statusProfile.id) : undefined} />
    {profiles.length ? <section className="panel data-list game-instances" aria-label="Список сборок">
      {profiles.map(profile => {
        const removal = profile.launcher ? 'Удалить сборку' : 'Отключить профиль'
        const edit = profile.launcher ? 'Настройки сборки' : 'Переименовать'
        const active = current?.id === profile.id
        return <div className="data-row build-row" key={profile.id}>
          <span className="icon-tile">{profile.launcher ? <Gamepad2 size={20} /> : <Box size={20} />}</span>
          <span><strong>{profile.name}</strong><small>Minecraft {profile.game} · {loaderName[profile.loader]} {profile.loaderVersion}{!profile.launcher && ' · Внешний профиль'}</small></span>
          <div className="heading-actions build-actions">
            {active ? <Chip tone="positive">Активная</Chip> : <button className="button secondary small-btn" onClick={() => activate(profile.id)}>Выбрать</button>}
            {active && profile.launcher && <LaunchButton status={status} label="Запустить Minecraft" needsInstall={profile.launcher.installed === false} start={() => launch(profile.id)} />}
          </div>
          <button className="icon-button" aria-label={'Папка сборки ' + profile.name} title="Папка сборки" onClick={() => void (profile.launcher ? api.openGameFolder(profile.id) : api.showFolder(profile.id)).catch(report)}><FolderOpen size={16} /></button>
          <button className="icon-button" aria-label={edit + ' ' + profile.name} title={edit} onClick={() => setEditing(profile)}>{profile.launcher ? <Settings2 size={16} /> : <Pencil size={16} />}</button>
          <button className="icon-button remove-profile-icon" aria-label={removal + ' ' + profile.name} title={removal} onClick={() => remove(profile)}><Trash2 size={16} /></button>
        </div>
      })}
    </section> : <Empty icon={<Gamepad2 />} title="Сборок пока нет" text="Создайте сборку и скачайте Minecraft или подключите папку из другого лаунчера." />}
    {children}
    {editing && <BuildSettings profile={editing} close={() => setEditing(undefined)} saved={profile => { updated(profile); setEditing(undefined) }} />}
  </>
}

const memoryPresets = [
  { label: 'Низкая', heapMiB: 2048 },
  { label: 'Средняя', heapMiB: 4096 },
  { label: 'Высокая', heapMiB: 8192 },
]
const formatMemory = (heapMiB: number) => number.format(heapMiB / 1024) + ' ГБ'

function BuildSettings({ profile, close, saved }: { profile: Profile; close: () => void; saved: (profile: Profile) => void }) {
  const [name, setName] = useState(profile.name)
  const [nickname, setNickname] = useState(profile.launcher?.nickname ?? '')
  const [heapMiB, setHeapMiB] = useState<number>()
  const [limit, setLimit] = useState<number>()
  const [limitError, setLimitError] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const configured = profile.launcher?.heapMiB ?? gameMemory.default
  const selected = Math.min(heapMiB ?? configured, limit ?? configured)
  const memoryChanged = heapMiB !== undefined && selected !== configured
  const nicknameChanged = Boolean(profile.launcher && nickname !== (profile.launcher.nickname ?? ''))
  const valid = Boolean(name.trim()) && (!nicknameChanged || validNickname(nickname)) &&
    (name.trim() !== profile.name || memoryChanged || nicknameChanged)

  useEffect(() => {
    if (!profile.launcher) return
    let active = true
    api.gameMemoryLimit().then(value => { if (active) setLimit(value) })
      .catch(error => { if (active) setLimitError(errorText(error)) })
    return () => { active = false }
  }, [profile.launcher])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving || !valid) return
    setSaving(true)
    setError('')
    try { saved(await api.updateProfileSettings(profile.id, { name, heapMiB: memoryChanged ? selected : undefined, nickname: nicknameChanged ? nickname : undefined })) }
    catch (error) { setError(errorText(error)); setSaving(false) }
  }
  return <Modal title={profile.launcher ? 'Настройки сборки' : 'Переименовать сборку'} close={() => { if (!saving) close() }} footer={<>
    <button className="button secondary" disabled={saving} onClick={close}>Отмена</button>
    <button className="button primary" form="build-settings" type="submit" disabled={!valid || saving}>Сохранить</button>
  </>}>
    <form id="build-settings" className="setup-form" onSubmit={event => void submit(event)}>
      <label className="field">Название сборки<input maxLength={100} value={name} disabled={saving} onChange={event => setName(event.target.value)} /></label>
      {profile.launcher && <div className="field">
        <label htmlFor="build-nickname">Локальный ник</label>
        <input id="build-nickname" maxLength={16} value={nickname} disabled={saving} aria-describedby="build-nickname-help"
          aria-invalid={nicknameChanged && !validNickname(nickname)} onChange={event => setNickname(event.target.value)} />
        <small id="build-nickname-help">3–16 символов: латинские буквы, цифры и подчёркивание. Новый ник применяется при следующем запуске.</small>
        {nicknameChanged && validNickname(nickname) && <small>Minecraft может считать новый ник другим игроком в мирах и на серверах, где данные привязаны к нику.</small>}
      </div>}
      {profile.launcher && (limitError ? <ErrorBox message={limitError} /> : limit === undefined ? <Busy label="Определяем доступный объём памяти…" /> :
        <div className="memory-field">
          <div className="memory-heading"><label htmlFor="build-memory">Оперативная память</label><strong>{formatMemory(selected)}</strong></div>
          <input id="build-memory" type="range" min={gameMemory.min} max={limit} step={gameMemory.step} value={selected}
            disabled={saving || limit === gameMemory.min} aria-valuetext={formatMemory(selected)}
            onChange={event => setHeapMiB(event.target.valueAsNumber)} />
          <div className="memory-presets">{memoryPresets.map(preset => <button className="button secondary memory-preset" type="button" key={preset.heapMiB}
            aria-pressed={selected === preset.heapMiB} disabled={saving || preset.heapMiB > limit} onClick={() => setHeapMiB(preset.heapMiB)}>
            {preset.label}<small>{formatMemory(preset.heapMiB)}</small>
          </button>)}</div>
          <small>Применится при следующем запуске Minecraft.</small>
        </div>)}
      {error && <ErrorBox message={error} />}
    </form>
  </Modal>
}

export function CreateGame({ close, saved, gameBusy, fabricGame }: { close: () => void; saved: (state: AppState) => void; gameBusy: boolean; fabricGame?: string }) {
  const [versions, setVersions] = useState<LauncherRelease[]>()
  const [loaders, setLoaders] = useState<LauncherLoaderVersion[]>([])
  const [draft, setDraft] = useState<LauncherDraft>({ name: '', nickname: '', game: '', loader: fabricGame ? 'fabric' : 'vanilla', loaderVersion: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let alive = true
    setVersions(undefined)
    setError('')
    api.gameVersions().then(items => {
      if (!alive) return
      setVersions(items)
      const preferred = items.find(item => item.id === fabricGame) ?? items.find(item => item.current) ?? items[0]
      setDraft(value => ({ ...value, game: value.game || preferred?.id || '' }))
    }).catch(error => { if (alive) setError(errorText(error)) })
    return () => { alive = false }
  }, [retry, fabricGame])

  useEffect(() => {
    let alive = true
    setLoaders([])
    setSaveError('')
    if (!draft.game || draft.loader === 'vanilla') { setLoading(false); return }
    setLoading(true)
    api.gameLoaderVersions(draft.game, draft.loader)
      .then(items => { if (alive) setLoaders(items) })
      .catch(error => { if (alive) setSaveError(errorText(error)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [draft.game, draft.loader, retry])

  const validNick = validNickname(draft.nickname)
  const ready = Boolean(draft.game && validNick && (draft.loader === 'vanilla' || !loading && loaders.length > 0))
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready || saving || gameBusy) return
    setSaveError('')
    setSaving(true)
    try { saved(await api.createGameProfile({ ...draft, name: draft.name.trim() || 'Minecraft ' + draft.game + (draft.loader === 'vanilla' ? '' : ' · ' + loaderName[draft.loader]) })) }
    catch (error) { setSaveError(errorText(error)) }
    finally { setSaving(false) }
  }

  return <Modal title="Создать сборку" subtitle="После создания MultiHub скачает Minecraft, Java и выбранный загрузчик." close={() => { if (!saving) close() }} footer={<>
    <button className="button secondary" disabled={saving} onClick={close}>Отмена</button>
    <button className="button primary" form="new-game" type="submit" disabled={!ready || saving || gameBusy}><Box size={16} />{saving ? 'Создаём сборку…' : 'Скачать и установить'}</button>
  </>}>
    <form id="new-game" className="setup-form" onSubmit={event => void submit(event)}>
      <label className="field">Название сборки<input maxLength={75} value={draft.name} placeholder={draft.game ? 'Minecraft ' + draft.game : 'Моя сборка'} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="field">Локальный ник<input required maxLength={16} pattern={nicknamePattern} value={draft.nickname} placeholder="Player" onChange={event => setDraft({ ...draft, nickname: event.target.value })} /></label>
      <div className="game-form-row">
        <label className="field">Версия Minecraft<select aria-label="Версия Minecraft" value={draft.game} disabled={!versions?.length} onChange={event => setDraft({ ...draft, game: event.target.value, loaderVersion: '' })}>
          <option value="" disabled>Выбрать версию</option>{versions?.map(version => <option key={version.id} value={version.id}>{version.id}{version.current ? ' · Последний релиз' : ''}</option>)}
        </select></label>
        <label className="field">Загрузчик<select aria-label="Загрузчик" value={draft.loader} onChange={event => setDraft({ ...draft, loader: event.target.value as LauncherLoader, loaderVersion: '' })}>
          {(['vanilla', 'fabric', 'forge'] as const).map(loader => <option key={loader} value={loader}>{loaderName[loader]}</option>)}
        </select></label>
      </div>
      {draft.loader !== 'vanilla' && <label className="field">Версия загрузчика<select aria-label="Версия загрузчика" value={draft.loaderVersion} disabled={loading || !loaders.length} onChange={event => setDraft({ ...draft, loaderVersion: event.target.value })}>
        <option value="">Автоматически{loaders.some(item => item.recommended) ? ' · ' + loaders.find(item => item.recommended)!.id : ''}</option>
        {loaders.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
      </select></label>}
      {(!versions && !error || loading) && <Busy label="Получаем список версий…" />}
      {versions && !versions.length && <ErrorBox message="Доступные релизы не найдены." retry={() => setRetry(value => value + 1)} />}
      {draft.loader !== 'vanilla' && draft.game && !loading && !loaders.length && !saveError && <small>Для этой версии игры загрузчик недоступен.</small>}
      {error && <ErrorBox message={error} retry={() => setRetry(value => value + 1)} />}
      {saveError && <ErrorBox message={saveError} retry={!loaders.length && draft.loader !== 'vanilla' ? () => setRetry(value => value + 1) : undefined} />}
      {gameBusy && <small>Дождитесь завершения текущей операции или закройте Minecraft.</small>}
    </form>
  </Modal>
}
