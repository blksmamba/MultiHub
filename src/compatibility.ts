import type { LocalMod, Profile, Requirement } from './shared'

function compare(a: string, b: string): number | undefined {
  const pattern = /^v?(\d+(?:\.\d+)*)(?:\+[a-z0-9._-]+)?$/i
  const left = a.match(pattern)?.[1].split('.').map(Number)
  const right = b.match(pattern)?.[1].split('.').map(Number)
  if (!left || !right) return a === b ? 0 : undefined
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff) return Math.sign(diff)
  }
  return 0
}

export function satisfies(version: string, range?: string): boolean | undefined {
  const text = range?.trim()
  if (!text || text === '*') return true
  if (!version || version === '—') return undefined
  if (text.includes('||')) {
    const options = text.split('||').map(part => satisfies(version, part))
    return options.includes(true) ? true : options.includes(undefined) ? undefined : false
  }
  const single = text.match(/^\[([^,[\]()]+)\]$/)
  if (single) {
    const result = compare(version, single[1].trim())
    return result === undefined ? undefined : result === 0
  }
  const interval = text.match(/^([[(])([^,]*),([^,[\]()]*)([\])])$/)
  if (interval) {
    const min = interval[2].trim()
    const max = interval[3].trim()
    const lo = min ? compare(version, min) : 1
    const hi = max ? compare(version, max) : -1
    if (lo === undefined || hi === undefined) return undefined
    return (lo > 0 || lo === 0 && interval[1] === '[') && (hi < 0 || hi === 0 && interval[4] === ']')
  }
  const wildcard = text.match(/^=?v?(\d+(?:\.\d+)*)\.(?:x|\*)$/i)
  if (wildcard) {
    const actual = version.match(/^v?(\d+(?:\.\d+)*)(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i)?.[1].split('.').map(Number)
    if (!actual) return undefined
    const expected = wildcard[1].split('.').map(Number)
    return expected.every((component, index) => component === (actual[index] ?? 0))
  }
  if (!/^(?:(?:>=|<=|>|<|=)?v?\d+(?:\.\d+)*(?:\+[a-z0-9._-]+)?)(?:\s+(?:>=|<=|>|<|=)?v?\d+(?:\.\d+)*(?:\+[a-z0-9._-]+)?)*$/i.test(text)) return text === version ? true : undefined
  const terms = text.split(/\s+/).map(part => {
    const [, operator = '=', target] = part.match(/^(>=|<=|>|<|=)?(.+)$/)!
    const result = compare(version, target)
    if (result === undefined) return undefined
    return operator === '>=' ? result >= 0 : operator === '<=' ? result <= 0 : operator === '>' ? result > 0 : operator === '<' ? result < 0 : result === 0
  })
  return terms.includes(false) ? false : terms.includes(undefined) ? undefined : true
}
export function loaderMatches(mod: LocalMod, profile: Profile) {
  return !mod.loader || mod.loader === profile.loader || profile.loader === 'quilt' && mod.loader === 'fabric'
}
export function platformMod(id: string) {
  return ['minecraft', 'java', 'fabricloader', 'quilt_loader', 'forge', 'neoforge'].includes(id)
}
export function platformVersion(id: string, profile: Profile) {
  if (id === 'minecraft') return profile.game
  if ([profile.loader, profile.loader + 'loader', profile.loader + '_loader'].includes(id)) return profile.loaderVersion || undefined
  return undefined
}
function forgeCompatibilityMatch(rule: Requirement, profile: Profile) {
  if (profile.loader !== 'forge' || profile.game !== '1.21.1' || rule.conflict) return false
  // Forge's VersionSupportMatrix accepts these dependencies on Minecraft 1.21.1.
  const alias = rule.id === 'minecraft' ? '1.21' : rule.id === 'forge' ? '51.0.33' : undefined
  return alias !== undefined && satisfies(alias, rule.range) === true
}

export function profileIssue(mod: LocalMod, profile: Profile) {
  if (!loaderMatches(mod, profile)) return 'Мод предназначен для загрузчика ' + mod.loader + '.'
  for (const rule of mod.requirements) {
    const version = platformVersion(rule.id, profile)
    if (version && !rule.optional && thresholdMismatch(version, rule.range, rule.conflict) && !forgeCompatibilityMatch(rule, profile)) {
      return 'Требование к ' + rule.id + ' (' + (rule.range ?? 'любая версия') + ') конфликтует с версией ' + version + '.'
    }
  }
}

export function thresholdMismatch(version: string, range?: string, conflict?: boolean) {
  const match = satisfies(version, range)
  return match !== undefined && match === Boolean(conflict)
}

export function localProblems(mods: LocalMod[], profile: Profile) {
  const active = mods.filter(mod => mod.enabled)
  const provisions = new Map<string, LocalMod[]>()
  for (const mod of active) for (const id of new Set(mod.ids)) provisions.set(id, [...(provisions.get(id) ?? []), mod])
  const issues = mods.flatMap(mod => {
    const result: { name: string; text: string; hint: string; uncertain?: boolean }[] = []
    if (mod.issue) result.push({ name: mod.name, text: mod.issue, hint: 'Проверьте источник файла или скачайте его заново.' })
    if (!mod.enabled) return result
    const compatibility = profileIssue(mod, profile)
    if (compatibility) result.push({ name: mod.name, text: compatibility, hint: 'Выберите версию мода для активной сборки.' })
    for (const rule of mod.requirements) {
      if (rule.optional || platformMod(rule.id)) continue
      const candidates = provisions.get(rule.id) ?? []
      if (!candidates.length && !rule.conflict) result.push({ name: mod.name, text: 'В папке mods не обнаружена зависимость ' + rule.id + '.', hint: 'Проверьте, предоставляется ли она встроенной библиотекой, или установите её отдельно.', uncertain: true })
      else if (rule.conflict && candidates.some(candidate => thresholdMismatch(candidate.version, rule.range, true))) result.push({ name: mod.name, text: 'Конфликт с модом ' + rule.id + '.', hint: 'Отключите конфликтующий мод или замените версию.' })
      else if (!rule.conflict && candidates.length && candidates.every(candidate => thresholdMismatch(candidate.version, rule.range))) result.push({ name: mod.name, text: 'Неподходящая версия зависимости ' + rule.id + '.', hint: 'Проверьте требуемый диапазон: ' + rule.range })
    }
    return result
  })
  for (const [id, matches] of provisions) if (matches.length > 1) issues.push({ name: id, text: 'Несколько активных файлов содержат этот ID.', hint: 'Оставьте один файл: ' + matches.map(mod => mod.file).join(', ') })
  return issues
}
