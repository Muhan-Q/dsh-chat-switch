// Client-half smoke test: loads lib/client.js through a fake
// window.__ModuleLoader__, feeds it a fake React and a fake cordis ctx, then
// checks the three slot registrations and the mode switch.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const clientPath = process.env.CLIENT_JS ?? new URL('../lib/client.js', import.meta.url)
const source = readFileSync(clientPath, 'utf8')

const registrations = []
const documentListeners = {}
const effects = []
let styleCount = 0
let panel = 'conversation'
const storage = new Map([['chat-switch.mode', 'chat']])

const fakeReact = {
  Component: class Component { constructor(props) { this.props = props; this.state = {} } },
  createElement: (type, props, ...children) => ({ type, props, children }),
  createPortal: undefined,
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: fn => fn(),
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, get) => get(),
}

const ctx = {
  slots: {
    spec: key => (['sidebar.session.action', 'main', 'sidebar.workspaces'].includes(key) ? { kind: 'single' } : undefined),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => { registrations.splice(registrations.findIndex(entry => entry.options === options), 1) }
    },
  },
  get: name => (name === 'layout' ? { selectPanel: id => { panel = id } } : undefined),
  effect: fn => { const dispose = fn(); effects.push(dispose); return dispose },
  on: () => () => {},
  logger: console,
}

const sandbox = {
  window: {
    __ModuleLoader__: { load: ({ id, factory }) => { sandbox.__module = { id, exports: factory(spec => (spec === 'react' ? fakeReact : (() => { throw new Error(`unexpected require: ${spec}`) })())) } } },
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, value) },
    },
    setTimeout: (fn) => { fn(); return 0 },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    open: () => {},
  },
  document: {
    createElement: () => ({ dataset: {}, style: {}, remove: () => { styleCount -= 1 } }),
    head: { appendChild: () => { styleCount += 1 } },
    querySelector: () => null,
    addEventListener: (type, fn) => { (documentListeners[type] ??= []).push(fn) },
    removeEventListener: (type, fn) => {
      const list = documentListeners[type]
      if (list === undefined) return
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
  },
  console,
  fetch: async () => ({ ok: true, status: 200, text: async () => '{"signedIn":false}' }),
  setTimeout: (fn) => { fn(); return 0 },
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  URL,
}

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

const mod = sandbox.__module
if (mod === undefined) throw new Error('module did not register')
if (mod.id !== 'dsh-chat-switch') throw new Error(`wrong id: ${mod.id}`)
if (typeof mod.exports.apply !== 'function') throw new Error('apply missing')
if (!Array.isArray(mod.exports.inject)) throw new Error('inject missing')

mod.exports.apply(ctx)

const names = registrations.map(entry => entry.options.key === undefined ? entry.options.name : `${entry.options.name}:${entry.options.key}`)
console.log('registrations:', names)
console.log('styles injected:', styleCount)
console.log('panel after apply (chat mode off):', panel)

const layer = registrations.find(entry => entry.options.name === 'sidebar.session.action')
if (layer === undefined) throw new Error('session.action layer not registered')
const mainPanel = registrations.find(entry => entry.options.name === 'main')
if (mainPanel?.options.key !== 'chat') throw new Error('main:chat not registered')
if (!registrations.some(entry => entry.options.name === 'sidebar.workspaces')) throw new Error('workspace takeover missing in chat mode')

// A shipped New-session click must leave Chat before the shell opens the
// Session: the workspace browser returns and the switch follows.
const shellButton = {
  classList: { contains: () => false },
  getAttribute: name => (name === 'aria-label' ? '新建会话' : null),
  closest: () => shellButton,
}
const clickListeners = documentListeners.click ?? []
if (clickListeners.length !== 1) throw new Error(`expected one document click listener, got ${clickListeners.length}`)
clickListeners[0]({ target: shellButton })
const afterNewSession = registrations.map(entry => entry.options.name)
console.log('mode after shell 新会话 click:', storage.get('chat-switch.mode'), '| panel:', panel, '| workspaces held:', afterNewSession.includes('sidebar.workspaces'))
if (storage.get('chat-switch.mode') !== 'harness') throw new Error('new-session click did not switch to Harness')
if (afterNewSession.includes('sidebar.workspaces')) throw new Error('workspace takeover survived the new-session click')

// The switch still renders both segments and re-takes the Workspace region.
const renderButtons = () => {
  const layered = layer.component({ wide: true, children: { type: 'button', props: {}, children: ['新会话'] } })
  const tree = layered.children[0].type(layered.children[0].props)
  return tree.children[0].children.flat(2)
}
const chatSegment = renderButtons().find(button => button.children[0] === 'Chat')
chatSegment.props.onClick()
console.log('mode after Chat click:', storage.get('chat-switch.mode'), '| workspaces back:', registrations.some(entry => entry.options.name === 'sidebar.workspaces'))
if (storage.get('chat-switch.mode') !== 'chat') throw new Error('Chat click did not return to Chat')
if (!registrations.some(entry => entry.options.name === 'sidebar.workspaces')) throw new Error('workspace takeover missing after Chat click')

const harness = renderButtons().find(button => button.children[0] === 'Harness')
harness.props.onClick()
console.log('mode after Harness click:', storage.get('chat-switch.mode'), '| panel:', panel)
console.log('registrations after flip:', registrations.map(entry => entry.options.name))

// Token extraction accepts whatever the user managed to copy.
const extract = mod.exports.__internals.extractToken
const tokenCases = [
  ['abc.def.ghi', 'abc.def.ghi'],
  ['Bearer abc123', 'abc123'],
  ['{"userToken":"tok_12345"}', 'tok_12345'],
  ['curl https://chat.deepseek.com -H "authorization: Bearer TOK555"', 'TOK555'],
  ['"quotedToken"', 'quotedToken'],
  ['Authorization: Bearer t0k.en-1', 't0k.en-1'],
]
let tokenBad = 0
for (const [input, want] of tokenCases) {
  const got = extract(input)
  if (got !== want) { tokenBad += 1; console.log('FAIL token', JSON.stringify(input), '->', got) }
}
console.log('token extraction:', tokenBad === 0 ? 'all shapes pass' : tokenBad + ' failed')

// Markdown rendering must produce blocks without throwing.
try {
  const blocks = mod.exports.__internals.renderMarkdown('# 标题\n\n- 一\n- 二\n\n**粗体**与`code`')
  console.log('markdown blocks:', Array.isArray(blocks) ? blocks.length : typeof blocks)
} catch (error) {
  console.log('markdown FAIL', error)
}

for (const dispose of effects) dispose()
console.log('styles after dispose:', styleCount)
console.log('ok')
