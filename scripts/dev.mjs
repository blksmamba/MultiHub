import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electron from 'electron'
import './build-electron.mjs'

const server = await createServer()
await server.listen()
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, MODKIT_DEV: '1' },
})
const close = () => { child.kill(); void server.close() }
process.on('SIGINT', close)
process.on('SIGTERM', close)
child.on('error', (error) => { console.error(error); void server.close(); process.exitCode = 1 })
child.on('exit', (code) => { void server.close(); process.exitCode = code ?? 0 })
