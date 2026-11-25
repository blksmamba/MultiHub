import { Check, CircleAlert, Download, FileText, FolderOpen, Play, Plus, X } from 'lucide-react'
import type { GameLaunchState } from './shared'
import { api, bytes } from './ui'

export const initialGameStatus: GameLaunchState = { status: 'idle', message: '', total: 0, ready: 0, bytes: 0 }

export function BuildActions({ create, connect }: { create: () => void; connect: () => void }) {
  return <>
    <button className="button secondary" onClick={connect}><FolderOpen size={16} />Подключить сборку</button>
    <button className="button primary" onClick={create}><Plus size={16} />Создать сборку</button>
  </>
}

export function LaunchButton({ status, label, start, needsInstall = false }: { status: GameLaunchState; label: string; start: () => void; needsInstall?: boolean }) {
  const preparing = status.status === 'preparing'
  const running = status.status === 'running'
  return <button className="button primary" disabled={preparing || running} onClick={start}>
    {needsInstall ? <Download size={16} /> : <Play size={16} />}
    {running ? 'Игра запущена' : preparing ? status.intent === 'install' ? 'Установка…' : 'Подготовка…' : needsInstall ? 'Скачать и установить' : label}
  </button>
}

export function GameStatusPanel({ status, name, report, retry }: { status: GameLaunchState; name: string; report: (error: unknown) => void; retry?: () => void }) {
  if (status.status === 'idle') return null
  const preparing = status.status === 'preparing'
  const installing = status.intent === 'install'
  const interrupted = status.status === 'failed' || status.status === 'cancelled'
  const log = status.logProfileId
  const title = installing ? preparing ? 'Установка Minecraft' : status.status === 'ready' ? 'Сборка готова' : 'Установка прервана' : name
  return <section className={'panel game-status' + (installing ? ' game-install-status' : '') + (interrupted ? ' game-status-interrupted' : '')} aria-label={installing ? 'Состояние установки' : 'Состояние запуска'}>
    <div className="section-heading">
      <div className="game-status-heading">
        {installing && <span className="shader-icon">{interrupted ? <CircleAlert size={20} /> : status.status === 'ready' ? <Check size={20} /> : <Download size={20} />}</span>}
        <div><h2>{title}</h2>{installing && <small>{name}</small>}<p role="status">{status.message}</p></div>
      </div>
      <div className="heading-actions">
        {log && <button className="button secondary small-btn" onClick={() => void api.openGameLog(log).catch(report)}><FileText size={15} />{installing ? 'Журнал установки' : 'Журнал запуска'}</button>}
        {preparing && <button className="button secondary small-btn" onClick={() => void api.cancelGame().catch(report)}><X size={15} />Отменить</button>}
        {installing && interrupted && retry && <button className="button primary small-btn" onClick={retry}>Повторить установку</button>}
      </div>
    </div>
    {preparing && <>
      <progress max={status.total || 1} value={status.total ? status.ready : undefined} aria-label="Файлы текущего этапа" />
      {status.total > 0 && <small>{status.ready} / {status.total} файлов{status.bytes > 0 && ' · ' + bytes(status.bytes)}</small>}
    </>}
  </section>
}
