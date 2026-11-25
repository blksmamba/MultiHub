import { execFile } from 'node:child_process'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { loaders, type Candidate, type Loader } from '../src/shared'

const exec = promisify(execFile)
type Version = Candidate['versions'][number]
const gamePattern = /(?<![\d.])(?:1\.\d+(?:\.\d+)?|26\.\d+(?:\.\d+)?)(?:-(?:pre|rc)\d+)?(?![\d.])|\b\d{2}w\d{2}[a-z]\b/i
const mavenArtifact: Record<Loader, string> = {
  fabric: 'net.fabricmc:fabric-loader:', quilt: 'org.quiltmc:quilt-loader:', forge: 'net.minecraftforge:forge:', neoforge: 'net.neoforged:neoforge:'
}
const readJson = async (path: string) => {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return null
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
  } catch { return null }
}

async function directories(path: string) {
  return (await readdir(path, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

function parseVersion(id: string, json: any): Version | undefined {
  const libs = (Array.isArray(json?.libraries) ? json.libraries : []).map((item: any) => String(item?.name ?? '')) as string[]
  const loader = loaders.find(name => libs.some(lib => lib.startsWith(mavenArtifact[name]))) ??
    loaders.find(name => new RegExp('(?:^|[-_ ])' + name + '(?:$|[-_ ])', 'i').test(id))
  const lib = loader ? libs.find(name => name.startsWith(mavenArtifact[loader])) : undefined
  let game = String(json?.inheritsFrom ?? json?.clientVersion ?? json?.arguments?.game?.find?.((x: unknown, index: number, list: unknown[]) => typeof x === 'string' && list[index - 1] === '--fml.mcVersion') ?? '').match(gamePattern)?.[0]
  game ??= id.match(/^(1\.\d+(?:\.\d+)?|26\.\d+(?:\.\d+)?)(?:-(?:pre|rc)\d+)?/)?.[0] ?? id.match(gamePattern)?.[0]
  if (!game) return undefined
  const loaderVersion = lib?.split(':')[2]?.replace(game + '-', '') ?? (loader ? id.match(new RegExp(loader + '(?:-loader)?[-_](\\d+(?:\\.\\d+){1,3})', 'i'))?.[1] : undefined)
  return { game, loader, loaderVersion }
}

export async function inspectDirectory(input: string, label?: string, inherited?: Version[]): Promise<Candidate> {
  if (!isAbsolute(input)) throw new Error('Укажите абсолютный путь к игровой папке.')
  const directory = await realpath(input)
  if (!(await lstat(directory)).isDirectory()) throw new Error('Выберите игровую папку Minecraft.')
  const nested = ['.minecraft', 'minecraft']
  for (const name of nested) {
    const entry = await lstat(join(directory, name)).catch(() => null)
    if (entry?.isDirectory()) return inspectDirectory(join(directory, name), label ?? basename(directory), inherited)
  }
  const versions = [...(inherited ?? [])]
  const pack = await readJson(join(directory, '..', 'mmc-pack.json')) ?? await readJson(join(directory, 'mmc-pack.json'))
  const components = Array.isArray(pack?.components) ? pack.components : []
  const minecraft = components.find((item: any) => item?.uid === 'net.minecraft')
  const loaderComponent = components.find((item: any) => ['net.fabricmc.fabric-loader', 'org.quiltmc.quilt-loader', 'net.minecraftforge', 'net.neoforged'].includes(item?.uid))
  const prismLoaders: Record<string, Loader> = { 'net.fabricmc.fabric-loader': 'fabric', 'org.quiltmc.quilt-loader': 'quilt', 'net.minecraftforge': 'forge', 'net.neoforged': 'neoforge' }
  if (typeof minecraft?.version === 'string') versions.push({ game: minecraft.version, loader: prismLoaders[loaderComponent?.uid], loaderVersion: loaderComponent?.version })
  for (const id of (await directories(join(directory, 'versions'))).slice(0, 300)) {
    const json = await readJson(join(directory, 'versions', id, id + '.json'))
    if (json) {
      const version = parseVersion(id, json)
      if (version) versions.push(version)
    }
  }
  const unique = new Map(versions.map(version => [[version.game, version.loader, version.loaderVersion].join(':'), version]))
  return { directory, label: label ?? basename(directory), versions: [...unique.values()].sort((a, b) => Number(Boolean(b.loader)) - Number(Boolean(a.loader)) || b.game.localeCompare(a.game, 'en', { numeric: true })) }
}

export async function discover(appData: string, localData: string): Promise<Candidate[]> {
  const base = join(appData, '.minecraft')
  const found = new Map<string, Candidate>()
  async function add(path: string, label?: string, inherited?: Version[]) {
    try {
      const candidate = await inspectDirectory(path, label, inherited)
      const key = candidate.directory.toLowerCase()
      if (!found.has(key)) found.set(key, candidate)
    } catch { /* The launcher or instance is absent. */ }
  }
  await add(base, 'Minecraft Launcher / TLauncher')
  const launcher = await readJson(join(base, 'launcher_profiles.json'))
  for (const item of Object.values(launcher?.profiles ?? {}).slice(0, 100) as any[]) {
    if (typeof item?.gameDir !== 'string') continue
    const id = String(item.lastVersionId ?? '')
    const version = parseVersion(id, await readJson(join(base, 'versions', id, id + '.json')))
    await add(item.gameDir, item.name || 'Minecraft Launcher', version ? [version] : [])
  }
  for (const [root, label] of [[join(appData, 'PrismLauncher', 'instances'), 'Prism Launcher'], [join(appData, 'MultiMC', 'instances'), 'MultiMC'], [join(appData, 'ModrinthApp', 'profiles'), 'Modrinth App'], [join(localData, 'Programs', 'PrismLauncher', 'instances'), 'Prism Launcher']]) {
    for (const instance of (await directories(root)).slice(0, 100)) await add(join(root, instance), label + ' · ' + instance)
  }
  return [...found.values()]
}

export async function gameRunning(directory?: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    const matches = directory
      ? "$_.CommandLine -and $_.CommandLine.IndexOf($env:MODKIT_GAME_CHECK_DIRECTORY, [StringComparison]::OrdinalIgnoreCase) -ge 0"
      : "$_.CommandLine -match 'minecraft|fabricmc|quiltmc|modlauncher|launchwrapper|prismlauncher'"
    const command = "(Get-CimInstance Win32_Process -Filter \"Name = 'java.exe' OR Name = 'javaw.exe'\" | Where-Object { " + matches + " } | Measure-Object).Count"
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, timeout: 8000, env: { ...process.env, MODKIT_GAME_CHECK_DIRECTORY: directory }
    })
    return Number(stdout.trim()) > 0
  } catch { return false }
}
