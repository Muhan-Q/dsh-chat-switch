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

// The Chat surface renders in both shapes: a centred hero card when empty,
// and the web-style column plus a docked card once there are messages.
const { store: chatStore, Composer, ChatMain, MessageRow, docxToMarkdown, previewFormat } = mod.exports.__internals
const flatten = node => {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(flatten)
  return [node, ...flatten(node.children)]
}
const classNames = node => flatten(node)
  .filter(entry => entry !== null && typeof entry === 'object' && entry.props != null && typeof entry.props.className === 'string')
  .map(entry => entry.props.className)
const texts = node => flatten(node)
  .filter(entry => entry !== null && typeof entry === 'object' && Array.isArray(entry.children))
  .map(entry => entry.children.filter(child => typeof child === 'string').join(''))
  .filter(text => text !== '')
// Shallow-expands plain function components (Composer's SendButton) for assertions.
const expandFns = node => {
  if (node === null || node === undefined) return []
  if (Array.isArray(node)) return node.flatMap(expandFns)
  if (typeof node !== 'object') return []
  const type = node.type
  const isPlainFn = typeof type === 'function' && Object.getOwnPropertyNames(type.prototype ?? {}).length <= 1
  if (isPlainFn) return expandFns(type(node.props ?? {}))
  return [{
    ...node,
    children: (Array.isArray(node.children) ? node.children : [])
      .flatMap(child => (typeof child === 'string' ? [child] : expandFns(child))),
  }]
}

chatStore.set({
  status: { signedIn: true, chatOrigin: 'https://chat.deepseek.com' },
  messages: [],
  messagesLoading: false,
  sending: false,
  draft: '',
})
const heroClasses = classNames(ChatMain())
console.log('hero surface:', ['csx-hero', 'csx-hero-card'].every(name => heroClasses.includes(name)) ? 'ok' : 'MISSING ' + heroClasses.join(','))
const heroCard = Composer({ variant: 'hero' })
const heroCardClasses = classNames(heroCard)
const expandedHero = expandFns(heroCard)
const heroLabels = texts(expandedHero)
const iconSvgs = flatten(expandedHero)
  .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.props?.dangerouslySetInnerHTML?.__html === 'string'
    && entry.props.dangerouslySetInnerHTML.__html.includes('<svg'))
console.log('hero card:', heroCardClasses.includes('csx-card') ? 'ok' : 'MISSING csx-card',
  '| tools:', ['深度思考', '智能搜索'].every(label => heroLabels.some(text => text.includes(label))) ? 'ok' : 'MISSING tools')
const heroMain = ChatMain()
const heroDrop = flatten(expandFns(heroMain))
  .filter(entry => entry !== null && typeof entry === 'object' && entry.props !== undefined)
const mainNode = heroDrop.find(entry => String(entry?.props?.className ?? '').includes('csx-main'))
console.log('drop target:',
  typeof mainNode?.props?.onDrop === 'function' && typeof mainNode?.props?.onDragOver === 'function'
    ? 'ok' : 'MISSING onDrop/onDragOver',
  '| upload limits:', /MAX_UPLOAD_BYTES = 100 \* 1024 \* 1024/.test(source) && /MAX_UPLOAD_FILES = 50/.test(source) ? 'ok' : 'MISSING limits',
  '| drop css:', source.includes('.csx-drop {') ? 'ok' : 'MISSING css',
  '| hero note:', source.includes('.csx-hero > .csx-msg-note { text-align:center') ? 'ok' : 'MISSING note')
chatStore.set({ mode: 'chat', messages: [{ id: 'a' }] })
chatStore.set(state => ({ docPreview: { name: 'x', url: 'u', text: 't', error: '', loading: false } }))
console.log('store merge:', chatStore.get().mode === 'chat' && chatStore.get().messages.length === 1 && chatStore.get().docPreview?.name === 'x' ? 'ok' : 'LOST STATE')
chatStore.set({ docPreview: null })
{
  const xml = '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>标题</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>要点</w:t></w:r></w:p>'
    + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>粗</w:t></w:r><w:r><w:t>体混排</w:t></w:r></w:p>'
  const converted = docxToMarkdown(xml)
  console.log('docx markdown:', converted.includes('# 标题') && converted.includes('- 要点') && converted.includes('**粗**') ? 'ok' : 'BAD ' + JSON.stringify(converted))
  console.log('doc format:', previewFormat('a.md') === 'markdown' && previewFormat('a.docx') === 'markdown' && previewFormat('a.txt') === 'text' ? 'ok' : 'BAD')
}
console.log('doc panel:', source.includes('.csx-docpanel-body') && /docPreview/.test(source) ? 'ok' : 'MISSING')
console.log('preview routes:',
  /function isPreviewable\(name\)/.test(source) && /async function extractDocxText\(file\)/.test(source) ? 'ok' : 'MISSING docx helpers',
  '| lightbox:', source.includes('.csx-lightbox-inner') ? 'ok' : 'MISSING inner',
  '| upload note:', source.includes('csx-upload-note') ? 'ok' : 'MISSING note')
console.log('hero icons:', iconSvgs.length >= 4 ? `ok (${iconSvgs.length} glyphs)` : `MISSING glyphs (${iconSvgs.length})`,
  '| hero mark:', classNames(expandFns(ChatMain())).includes('csx-hero-mark') ? 'ok' : 'MISSING whale')

chatStore.set({
  messages: [
    { id: 'u1', role: 'user', text: '你好' },
    { id: 'a1', role: 'assistant', text: '你好呀', sources: [{ url: 'https://example.com', title: '示例' }] },
  ],
})
const threadClasses = classNames(ChatMain())
console.log('thread surface:',
  ['csx-web-scroll', 'csx-web-col', 'csx-dock'].every(name => threadClasses.includes(name)) ? 'ok' : 'MISSING ' + threadClasses.join(','))
const assistantRow = MessageRow({ message: chatStore.get().messages[1] })
const flatAssistant = flatten(assistantRow)
const noteText = texts(assistantRow)
console.log('message footer:',
  flatAssistant.some(entry => entry !== null && typeof entry === 'object' && entry.props != null && entry.props.className === 'csx-sources') ? 'sources ok' : 'MISSING sources',
  '|', noteText.includes('1 个网页') ? 'count ok' : 'MISSING count',
  '|', flatAssistant.some(entry => entry !== null && typeof entry === 'object'
    && entry.props?.className === 'csx-src-favicon' && String(entry.props.src).endsWith('/favicon.ico')) ? 'favicon ok' : 'MISSING favicon',
  '|', noteText.includes('内容由 AI 生成，请仔细甄别') ? 'note ok' : 'MISSING note')

const actionButtons = flatten(expandFns(assistantRow)).filter(entry => entry !== null && typeof entry === 'object'
  && entry.props?.className === 'csx-act')
const actionTitles = actionButtons.map(entry => entry.props['aria-label']).join(',')
console.log('answer actions:',
  actionButtons.length === 4 ? 'ok (4)' : `MISSING (${actionButtons.length})`,
  '|', ['复制', '重新生成', '朗读', '分享'].every(label => actionTitles.includes(label)) ? 'labels ok' : `MISSING ${actionTitles}`,
  '|', actionButtons.filter(entry => flatten(entry).some(child => child !== null && typeof child === 'object'
    && typeof child.props?.dangerouslySetInnerHTML?.__html === 'string')).length === 4 ? 'glyphs ok' : 'MISSING glyphs',
  '|', !flatten(expandFns(MessageRow({ message: chatStore.get().messages[1], streaming: true })))
    .some(entry => entry !== null && typeof entry === 'object' && entry.props?.className === 'csx-actions') ? 'hidden while streaming' : 'shown while streaming')

for (const dispose of effects) dispose()
console.log('styles after dispose:', styleCount)
console.log('ok')