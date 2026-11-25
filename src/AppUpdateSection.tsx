import { Download, RefreshCw, RotateCw } from 'lucide-react'
import Markdown from 'react-markdown'
import type { AppUpdateAction, AppUpdateState } from './shared'
import { Busy, bytes, Chip, ErrorBox } from './ui'

export function AppUpdateSection({ update, act }: { update?: AppUpdateState; act: (action: AppUpdateAction) => void }) {
  const status = update?.status
  const ready = status === 'ready' || status === 'error' && update?.retry === 'install'
  const canDownload = status === 'available' || status === 'error' && update?.retry === 'download'
  const percent = update?.percent ?? 0
  return <section className="panel settings-panel" aria-labelledby="app-update-heading">
    <div className="section-heading"><div><h2 id="app-update-heading">Обновление MultiHub</h2>
      {update && <p>Текущая версия {update.current}</p>}
    </div>{status !== 'disabled' && !ready && <button className="button secondary" type="button"
      disabled={!update || ['checking', 'downloading', 'installing'].includes(status ?? '')}
      onClick={() => act('check')}><RefreshCw size={16} />Проверить обновление приложения</button>}</div>
    {(!update || status === 'checking' || status === 'installing') && <Busy label={status === 'installing' ? 'Запускаем установщик…' : 'Проверяем GitHub Releases…'} />}
    {status === 'disabled' && <p className="muted">Автообновление доступно в установленной сборке Windows с каналом обновлений.</p>}
    {status === 'current' && <div role="status"><Chip tone="positive">Установлена актуальная версия</Chip></div>}
    {status === 'no-release' && <p className="muted" role="status">{update?.error}</p>}
    {update?.version && <div className="app-update-content">
      <div className="section-heading"><h3>{update.title}</h3><Chip tone="positive">Версия {update.version}</Chip></div>
      {update.notes && <details className="app-update-notes" open>
        <summary>Что изменилось</summary>
        <div className="markdown"><Markdown skipHtml components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>{update.notes}</Markdown></div>
      </details>}
      {status === 'downloading' && <div className="app-update-progress">
        <progress max={100} value={update.transferred !== undefined && update.total ? percent : undefined} aria-label="Скачивание обновления MultiHub" />
        <small>{update.transferred !== undefined ? bytes(update.transferred) : 'Начинаем скачивание…'}{update.total ? ' / ' + bytes(update.total) : ''}{update.speed ? ' · ' + bytes(update.speed) + '/с' : ''}{update.total && update.transferred !== undefined ? ' · ' + Math.floor(percent) + '%' : ''}</small>
      </div>}
      {ready && <p role="status">Файл проверен. Обновление установится с перезапуском MultiHub.</p>}
      {update.deferred && <p className="muted">Напоминание отложено. Обновление можно установить отсюда.</p>}
      <div className="heading-actions">
        {canDownload && <button className="button primary" onClick={() => act('download')}><Download size={16} />{update.retry === 'download' ? 'Повторить скачивание' : 'Скачать обновление'}</button>}
        {ready && <button className="button primary" onClick={() => act('install')}><RotateCw size={16} />Установить и перезапустить</button>}
        {!update.deferred && (status === 'available' || status === 'ready') && <button className="button secondary" onClick={() => act('later')}>Позже</button>}
      </div>
    </div>}
    {update?.error && status !== 'no-release' && <ErrorBox message={update.error} />}
  </section>
}
