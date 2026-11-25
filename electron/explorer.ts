import { execFile } from 'node:child_process'
import { lstat, readFile, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { isJar } from './jars'

const run = promisify(execFile)
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const prefix = '--multihub-import='
export const maxExplorerFiles = 4096

export function importArgument(argv: string[]) {
  const value = argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
  return value && guid.test(value) ? value : undefined
}

export async function readExplorerBatch(id: string) {
  if (process.platform !== 'win32' || !guid.test(id) || !process.env.LOCALAPPDATA) return []
  const manifest = join(process.env.LOCALAPPDATA, 'MultiHub', 'ExplorerImports', id + '.paths')
  const stat = await lstat(manifest).catch(() => undefined)
  if (!stat?.isFile() || stat.size > 16 * 1024 * 1024 || stat.size % 2 || Date.now() - stat.mtimeMs > 10 * 60000) return []
  const contents = await readFile(manifest)
  await unlink(manifest)
  const paths = contents.toString('utf16le').split('\n').filter(Boolean)
  if (paths.length > maxExplorerFiles) return []
  return [...new Map(paths.filter(path => isAbsolute(path) && !path.includes('\0') &&
    isJar(basename(path)) && /\.jar$/i.test(path)).map(path => [path.toLowerCase(), path])).values()]
}

function helper() {
  return join(process.platform === 'win32' && app.isPackaged ? join(process.resourcesPath, '..') : join(app.getAppPath(), 'dist-native'), 'MultiHubExplorer.exe')
}

export async function explorerIntegration() {
  if (process.platform !== 'win32' || !app.isPackaged || !(await lstat(helper()).catch(() => undefined))?.isFile())
    return { available: false, enabled: false }
  const enabled = await run(helper(), ['--registered'], { windowsHide: true }).then(() => true).catch(error => {
    if (error.code === 2) return false
    throw error
  })
  return { available: true, enabled }
}

export async function setExplorerIntegration(enabled: boolean) {
  if (typeof enabled !== 'boolean' || !(await explorerIntegration()).available) throw new Error('Интеграция доступна в установленной версии MultiHub для Windows.')
  await run(helper(), [enabled ? '--enable' : '--disable'], { windowsHide: true })
  return explorerIntegration()
}
