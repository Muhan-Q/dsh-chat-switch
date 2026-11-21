// Host-half smoke test: boots the plugin against a bare ctx, mounts its route
// on a throwaway server, and exercises the JSON API end to end.
import { createServer } from 'node:http'
import { apply } from '../lib/index.js'

let route
const disposers = []
const ctx = {
  get(name) {
    if (name === 'webServer') return { register(registration) { route = registration; return () => { route = undefined } } }
    return undefined
  },
  logger: { warn: (...args) => console.log('[warn]', ...args), error: (...args) => console.log('[error]', ...args) },
  effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose },
}

apply(ctx)
if (route === undefined) { console.error('no route registered'); process.exit(1) }
console.log('route:', route.kind, route.path)

const server = createServer((req, res) => { route.handler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const base = `http://127.0.0.1:${port}/chat-switch/api`

async function call(path, options) {
  const response = await fetch(base + path, {
    method: options?.method ?? 'GET',
    headers: { 'x-chat-switch': '1', ...(options?.body ? { 'content-type': 'application/json' } : {}) },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  return { status: response.status, body: text.length > 400 ? text.slice(0, 400) + '…' : text }
}

console.log('status  ', await call('/status'))
console.log('probe   ', await call('/probe'))
console.log('bad tok ', await call('/token', { method: 'POST', body: { token: 'not-a-real-token' } }))
console.log('sessions', await call('/sessions'))
console.log('unknown ', await call('/nope'))
server.close()
for (const dispose of disposers) dispose?.()
console.log('ok')
