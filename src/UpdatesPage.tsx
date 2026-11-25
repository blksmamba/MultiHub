import { ArrowRight, ArrowUpCircle, Download, ExternalLink, RefreshCw } from 'lucide-react'
import type { ModUpdate, ModUpdateCheck, Profile } from './shared'
import { api, Busy, Chip, date, Empty, ErrorBox, profileLabel } from './ui'
import { Heading } from './views'
import { ModDescription } from './ModDescription'

export function UpdatesPage({ profile, result, checking, error, check, report, install }: {
  profile?: Profile; result?: ModUpdateCheck; checking: boolean; error: string
  check: () => void; report: (error: unknown) => void; install: (update: ModUpdate) => void
}) {
  const canCheck = profile && profile.loader !== 'vanilla'
  return <>
    <Heading title="Обновления модов" subtitle={profile ? profile.name + ' · ' + profileLabel(profile) : undefined}
      actions={canCheck && <button className="button secondary" disabled={checking} onClick={check}><RefreshCw size={16} />Проверить обновления</button>} />
    {!profile && <Empty icon={<ArrowUpCircle />} title="Сборка не подключена" text="Подключите или создайте сборку, чтобы проверить её моды." />}
    {profile?.loader === 'vanilla' && <Empty icon={<ArrowUpCircle />} title="Сборка без загрузчика" text="Обновления модов доступны для сборок с загрузчиком." />}
    {checking && <Busy label="Проверяем версии модов…" />}
    {error && <ErrorBox message={error} />}
    {result && canCheck && <>
      {result.updates.length ? <section className="panel data-list" aria-label="Доступные обновления">
        {result.updates.map(update => <div className="update-item" key={update.projectId}>
          <div className="data-row">
            <ArrowUpCircle size={19} className="update-icon" />
            <span><strong>{update.name}</strong><small>{date(update.date)}</small></span>
            <div className="update-versions"><Chip>{update.installed}</Chip><ArrowRight size={14} /><Chip tone="positive">{update.available}</Chip>
              {update.type === 'beta' && <Chip tone="warning">Бета</Chip>}{update.type === 'alpha' && <Chip tone="warning">Альфа</Chip>}
            </div>
            <button className="button secondary small-btn" onClick={() => void api.external('https://modrinth.com/mod/' + encodeURIComponent(update.projectId) + '/version/' + encodeURIComponent(update.versionId)).catch(report)}><ExternalLink size={15} />Открыть версию</button>
            <button className="button primary small-btn" onClick={() => install(update)}><Download size={15} />Обновить</button>
          </div>
          {update.changelog && <details className="update-changelog">
            <summary>Список изменений</summary>
            <div className="markdown"><ModDescription text={update.changelog} slug={update.projectId} report={report} /></div>
          </details>}
        </div>)}
      </section> : !checking && !error && <Empty icon={<ArrowUpCircle />}
        title={result.checked === 0 ? 'В сборке пока нет модов' : result.checked === result.unrecognized ? 'Modrinth не распознал моды' : 'Обновлений пока нет'}
        text={result.checked === 0 ? 'Установите моды, чтобы MultiHub мог проверить их версии.' :
          result.checked === result.unrecognized ? 'MultiHub ищет проекты по контрольной сумме установленных файлов.' : 'Для распознанных модов нет более новых версий под эту сборку.'} />}
      {result.unrecognized > 0 && result.unrecognized < result.checked && <p className="muted updates-note">Файлов, которые Modrinth не распознал: {result.unrecognized}.</p>}
    </>}
  </>
}
