import { useState } from 'react'
import type { AppState, Profile } from './shared'
import { api, ErrorBox, errorText, Modal } from './ui'

export function RemoveProfileDialog({ profile, close, removed }: {
  profile: Profile; close: () => void; removed: (state: AppState) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const label = profile.launcher ? 'Удалить сборку' : 'Отключить профиль'
  async function confirm() {
    if (busy) return
    setError('')
    setBusy(true)
    try { removed(await api.removeProfile(profile.id)) }
    catch (error) { setError(errorText(error)); setBusy(false) }
  }
  return <Modal title={label + '?'} subtitle={profile.name} close={() => { if (!busy) close() }}
    footer={<><button className="button secondary" disabled={busy} onClick={close}>Отмена</button>
      <button className="button danger" disabled={busy} onClick={() => void confirm()}>{busy ? 'Подождите…' : label}</button></>}>
    <p className="remove-profile-copy">{profile.launcher
      ? 'Вся сборка вместе с мирами, модами, настройками и скриншотами будет перемещена в корзину Windows.'
      : 'Профиль исчезнет из MultiHub. Папка Minecraft, миры, моды и настройки останутся на диске.'}</p>
    <small className="remove-profile-path">{profile.directory}</small>
    {error && <ErrorBox message={error} />}
  </Modal>
}
