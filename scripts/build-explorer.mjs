import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const programs = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
const vswhere = join(programs, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
const visualStudio = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '-property', 'installationPath'], { encoding: 'utf8' }).trim()
if (!visualStudio) throw new Error('Для сборки интеграции MultiHub нужен Visual Studio Build Tools с компонентами C++ x64 и Windows SDK.')
mkdirSync('dist-native', { recursive: true })
mkdirSync('dist-native/identity', { recursive: true })
const signed = 'dist-native/MultiHub.Explorer.msix'
const unsigned = 'dist-native/MultiHub.Explorer.unsigned.msix'
rmSync(signed, { force: true })
rmSync('dist-native/explorer-command.lib', { force: true })
rmSync('dist-native/explorer-command.exp', { force: true })
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const thumbprint = process.env.MULTIHUB_EXPLORER_CERT_SHA1?.trim()
if (thumbprint && !/^[a-f0-9]{40}$/i.test(thumbprint)) throw new Error('MULTIHUB_EXPLORER_CERT_SHA1 должен содержать отпечаток сертификата SHA-1.')
const publisher = thumbprint ? execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $cert = Get-Item -LiteralPath ("Cert:\\CurrentUser\\My\\" + $env:MULTIHUB_EXPLORER_CERT_SHA1.Trim()) -ErrorAction Stop; if (-not $cert.HasPrivateKey) { throw "Private key required" }; $cert.Subject'],
{ encoding: 'utf8' }).trim() : 'CN=MultiHub'
const attribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const version = JSON.parse(readFileSync('package.json', 'utf8')).version + '.0'
const packageXml = readFileSync('build/explorer-package.xml', 'utf8').replace('@PUBLISHER@', () => attribute(publisher)).replace('@VERSION@', version)
writeFileSync('dist-native/identity/AppxManifest.xml', packageXml)
writeFileSync('dist-native/explorer-publisher.h', 'constexpr wchar_t multiHubPublisher[] = L' + JSON.stringify(publisher) + ';\n')
writeFileSync('dist-native/explorer-fusion.xml', '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">\n' +
  '  <assemblyIdentity name="MultiHub.Explorer" version="' + version + '" />\n' +
  '  <msix xmlns="urn:schemas-microsoft-com:msix.v1" publisher="' + attribute(publisher) + '" packageName="MultiHub.Explorer" applicationId="Explorer" />\n' +
  '</assembly>\n')
const compiler = join(visualStudio, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
const flags = 'cl /nologo /std:c++20 /utf-8 /O2 /EHsc /MT /DUNICODE /D_UNICODE /Idist-native'
const libs = 'ole32.lib shell32.lib shlwapi.lib advapi32.lib user32.lib uuid.lib'
execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c',
  'call "' + compiler + '" && ' + flags + ' /Fo:dist-native\\explorer.obj /Fe:dist-native\\MultiHubExplorer.exe build\\explorer.cpp ' +
  '/link /SUBSYSTEM:WINDOWS windowsapp.lib ' + libs + ' && ' +
  flags + ' /Fo:dist-native\\explorer-identity-host.obj /Fe:dist-native\\identity\\MultiHubExplorerIdentity.exe build\\explorer-identity-host.cpp ' +
  '/link /SUBSYSTEM:WINDOWS /MANIFEST:EMBED /MANIFESTINPUT:dist-native\\explorer-fusion.xml && ' +
  flags + ' /DMULTIHUB_MODERN /LD /Fo:dist-native\\explorer-command.obj /Fe:dist-native\\identity\\MultiHubExplorerCommand.dll build\\explorer.cpp ' +
  '/link /DEF:build\\explorer-command.def /IMPLIB:dist-native\\explorer-command.lib ' + libs], {
  stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true,
})

const icon = readFileSync('build/icon.ico')
const entries = Array.from({ length: icon.readUInt16LE(4) }, (_, index) => 6 + index * 16)
const png = entries.find(index => icon[index] === 0 && icon[index + 1] === 0 &&
  icon.subarray(icon.readUInt32LE(index + 12), icon.readUInt32LE(index + 12) + 4).toString('hex') === '89504e47')
if (png === undefined) throw new Error('В значке MultiHub отсутствует PNG 256 × 256.')
const start = icon.readUInt32LE(png + 12)
writeFileSync('dist-native/explorer-icon-source.png', icon.subarray(start, start + icon.readUInt32LE(png + 8)))
execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Drawing',
  '$source = [Drawing.Bitmap]::new((Resolve-Path -LiteralPath "dist-native/explorer-icon-source.png").Path)',
  'foreach ($item in @(@{name="Logo"; size=50}, @{name="Square44"; size=44}, @{name="Square150"; size=150})) {',
  '  $bitmap = [Drawing.Bitmap]::new($source, $item.size, $item.size)',
  '  $bitmap.Save((Join-Path (Resolve-Path -LiteralPath "dist-native/identity") ($item.name + ".png")), [Drawing.Imaging.ImageFormat]::Png)',
  '  $bitmap.Dispose()',
  '}',
  '$source.Dispose()',
].join('\n')], { stdio: 'inherit', windowsHide: true })

const sdkRoot = join(programs, 'Windows Kits', '10', 'bin')
const sdk = readdirSync(sdkRoot).filter(name => /^\d+(\.\d+)+$/.test(name))
  .sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).map(name => join(sdkRoot, name, 'x64'))
  .find(folder => existsSync(join(folder, 'makeappx.exe')) && existsSync(join(folder, 'signtool.exe')))
if (!sdk) throw new Error('Не найдены MakeAppx и SignTool из Windows SDK.')
execFileSync(join(sdk, 'makeappx.exe'), ['pack', '/o', '/d', 'dist-native/identity', '/p', unsigned],
  { stdio: 'inherit', windowsHide: true })
if (thumbprint) {
  execFileSync(join(sdk, 'signtool.exe'), ['sign', '/sha1', thumbprint, '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256', unsigned],
    { stdio: 'inherit', windowsHide: true })
  execFileSync(join(sdk, 'signtool.exe'), ['verify', '/pa', unsigned], { stdio: 'inherit', windowsHide: true })
  renameSync(unsigned, signed)
} else {
  console.log('MultiHub.Explorer.unsigned.msix собран для проверки. Для установки верхнего меню нужен доверенный сертификат издателя.')
}
