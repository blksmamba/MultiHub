import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Anvil, ArrowDownToLine, Box, Check, CircleAlert, ExternalLink, Flame, LayoutGrid, LoaderCircle, Plus, Tag, Tags, X } from 'lucide-react'
import { contentNames, contentSource, loaderName, type CatalogMod, type Loader, type Profile } from './shared'

export const api = window.modkit
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '')
export const number = new Intl.NumberFormat('ru-RU')
export const compact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 })
export const date = (value: number | string) => new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(new Date(value))
export const bytes = (value: number) => value < 1024 ? value + ' Б' : value < 1024 ** 2 ? number.format(Math.round(value / 1024)) + ' КБ' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value / 1024 ** 2) + ' МБ'
const names: Record<string, string> = { adventure: 'Приключения', decoration: 'Декор', equipment: 'Снаряжение', food: 'Еда', cursed: 'Необычное', economy: 'Экономика', 'game-mechanics': 'Механики', game_mechanics: 'Механики', library: 'Библиотеки', magic: 'Магия', management: 'Управление', minigame: 'Мини-игры', mobs: 'Мобы', optimization: 'Оптимизация', social: 'Социальное', storage: 'Хранение', technology: 'Технологии', transportation: 'Транспорт', utility: 'Утилиты', worldgen: 'Генерация мира' }
export const category = (value: string) => names[value] ?? value
export const profileLabel = (profile: Profile) => 'Minecraft ' + profile.game + ' · ' + loaderName[profile.loader]
export const modUrl = (slug: string) => 'https://modrinth.com/mod/' + encodeURIComponent(slug)
export const remoteCompatible = (item: CatalogMod, p: Profile) => item.games.includes(p.game) && item.loaders.some(loader => loader === p.loader)

export function Brand() {
  return <span className="brand-mark" aria-hidden="true"><img src={import.meta.env.BASE_URL + 'multihub-icon.png'} alt="" /></span>
}

export function IconTile({ url, large = false }: { url?: string; large?: boolean }) {
  const [failed, setFailed] = useState('')
  const [loaded, setLoaded] = useState('')
  return <span className={'icon-tile' + (large ? ' large' : '')}>
    <Box size={large ? 30 : 21} />
    {url && url !== failed && <img src={url} alt="" hidden={loaded !== url} onLoad={() => setLoaded(url)} onError={() => setFailed(url)} />}
  </span>
}
export function Busy({ label = 'Загрузка…' }: { label?: string }) { return <span className="busy"><LoaderCircle size={16} className="spin" />{label}</span> }
export function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="feedback error" role="alert"><CircleAlert size={17} /><span>{message}</span>{retry && <button className="button quiet small-btn" onClick={retry}>Повторить</button>}</div>
}
export function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{text}</p>{action}</div>
}
export function Chip({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={'chip ' + tone}>{children}</span> }
export function ProfileChips({ profile }: { profile: Profile }) {
  return <><Chip><Box size={13} />{profile.game}</Chip><Chip>{loaderName[profile.loader]}{profile.loaderVersion && ' ' + profile.loaderVersion}</Chip></>
}
export function Skeletons({ count = 6 }: { count?: number }) {
  return <div className="card-grid" aria-label="Загрузка каталога">{Array.from({ length: count }, (_, index) => <div className="skeleton-card" key={index}><span /><i /><i /></div>)}</div>
}
const platforms = [
  { id: 'babric', name: 'Babric', icon: Tags },
  { id: 'fabric', name: loaderName.fabric, icon: Tag },
  { id: 'forge', name: loaderName.forge, icon: Anvil },
  { id: 'neoforge', name: loaderName.neoforge, icon: Flame },
  { id: 'quilt', name: loaderName.quilt, icon: LayoutGrid },
] as const

export function PlatformChips({ mod }: { mod: CatalogMod }) {
  const available = platforms.filter(({ id }) => id === 'babric' ? mod.babric : mod.loaders.includes(id))
  if (!available.length) return null
  return <span className="platform-chips" role="group" aria-label="Загрузчики">
    {available.map(({ id, name, icon: Icon }) => <span className="platform-chip" data-platform={id} key={id}>
      <Icon size={13} aria-hidden="true" />{name}
    </span>)}
  </span>
}

export function ModCard({ mod, profile, installed, open, add }: { mod: CatalogMod; profile?: Profile; installed: boolean; open: () => void; add: () => void }) {
  const match = profile && remoteCompatible(mod, profile)
  return <article className="mod-card">
    <button className="card-main" onClick={open}>
      <div className="card-top"><IconTile url={mod.icon} /><div className="card-name"><strong>{mod.name}</strong><small>{mod.author}</small></div></div>
      <p>{mod.summary}</p>
      <PlatformChips mod={mod} />
    </button>
    <div className="card-footer"><span className="downloads"><ArrowDownToLine size={13} />{compact.format(mod.downloads)}</span><span className="card-category">{contentNames[contentSource(mod.id)]}{mod.categories[0] && ' · ' + category(mod.categories[0])}</span>
      {installed ? <span className="installed-check" aria-label="Установлен"><Check size={16} /></span> : <button className="icon-button card-add" title={profile && !match ? 'Проверить версии' : 'План установки'} aria-label={'Добавить ' + mod.name} onClick={profile && !match ? open : add}><Plus size={17} /></button>}
    </div>
  </article>
}
export function Modal({ title, subtitle, close, children, footer, wide = false }: { title: string; subtitle?: string; close: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const node = dialog.current
    node?.focus()
    return () => previous?.focus()
  }, [])
  return <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .12 }} onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <div className={'modal' + (wide ? ' modal-wide' : '')} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialog}
      onKeyDown={event => {
        if (event.key === 'Escape') close()
        if (event.key !== 'Tab') return
        const stops = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary') ?? [])]
        if (!stops.length) return
        if (event.shiftKey && (document.activeElement === stops[0] || document.activeElement === dialog.current)) { event.preventDefault(); stops.at(-1)?.focus() }
        if (!event.shiftKey && document.activeElement === stops.at(-1)) { event.preventDefault(); stops[0].focus() }
      }}>
      <div className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="Закрыть" onClick={close}><X size={20} /></button></div>
      <div className="modal-body">{children}</div>{footer && <div className="modal-footer">{footer}</div>}
    </div>
  </motion.div>
}
export function OfficialLink({ slug, failed }: { slug: string; failed: (error: unknown) => void }) {
  return <button className="button secondary" onClick={() => void api.external(modUrl(slug)).catch(failed)}><ExternalLink size={15} />Modrinth</button>
}
export const isLoader = (value: string): value is Loader => value !== 'vanilla' && Object.hasOwn(loaderName, value)
