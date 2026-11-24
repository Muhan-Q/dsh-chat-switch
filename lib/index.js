/**
 * dsh-chat-switch — Host half.
 *
 * Serves the same-origin JSON API the browser half uses to drive the
 * chat.deepseek.com web account:
 *
 *   GET  /chat-switch/api/status
 *   POST /chat-switch/api/token          { token }
 *   POST /chat-switch/api/logout
 *   GET  /chat-switch/api/sessions?count=&pinned=&updated_at=
 *   GET  /chat-switch/api/messages?sessionId=
 *   POST /chat-switch/api/session/title  { sessionId, title }
 *   POST /chat-switch/api/session/pinned { sessionId, pinned }
 *   POST /chat-switch/api/session/delete { sessionId }
 *   GET  /chat-switch/api/probe
 *
 * No npm dependency: only node builtins and the Host services reachable
 * through ctx.get(). The DeepSeek web token never leaves the Host process —
 * status answers only whether one is stored and which account it belongs to.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'chat-switch'
/** Hard dependency: without the browser HTTP carrier the JSON API has no route. */
export const inject = ['webServer']

const API_PREFIX = '/chat-switch/api'
const ORIGIN_DEFAULT = 'https://chat.deepseek.com'

/** Headers chat.deepseek.com expects from its own web client. */
const CLIENT_HEADERS = {
  'content-type': 'application/json',
  'x-client-platform': 'web',
  'x-client-version': '2.0.0',
  'x-app-version': '20241129.1',
  'x-client-locale': 'zh_CN',
  'x-client-timezone-offset': '28800',
  'user-agent': 'Mozilla/5.0 (Linux; HarmonyOS) dsh-chat-switch',
}

/** Locate the plugin data directory (shared DSH home when the Host exposes one). */
function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'chat-switch')
}

/** @returns {{token: string, chatOrigin: string, count: number, updatedAt: string, userId: string, userName: string}} */
function emptyState() {
  return { token: '', chatOrigin: ORIGIN_DEFAULT, count: 100, updatedAt: '', userId: '', userName: '' }
}

async function readState() {
  try {
    const raw = await readFile(join(dataDir(), 'state.json'), 'utf8')
    return { ...emptyState(), ...JSON.parse(raw) }
  } catch {
    return emptyState()
  }
}

async function writeState(state) {
  const dir = dataDir()
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify(state, null, 2), 'utf8')
  try { await chmod(file, 0o600) } catch { /* best effort on filesystems without POSIX modes */ }
}

/** Trim a secret to a stable non-reversible fingerprint for diagnostics. */
function fingerprint(token) {
  return token === '' ? '' : createHash('sha256').update(token).digest('hex').slice(0, 12)
}

/** Turn one DeepSeek web payload into plain data, or throw the server's own message. */
function unwrap(payload) {
  if (payload === null || typeof payload !== 'object') throw new Error('chat: empty response')
  if (typeof payload.code === 'number' && payload.code !== 0) {
    const error = new Error(String(payload.msg ?? `chat: code ${payload.code}`))
    error.code = payload.code
    throw error
  }
  const data = payload.data
  if (data === null || typeof data !== 'object') return payload
  if (typeof data.biz_code === 'number' && data.biz_code !== 0) {
    const error = new Error(String(data.biz_msg ?? `chat: biz_code ${data.biz_code}`))
    error.code = data.biz_code
    throw error
  }
  return data.biz_data ?? data
}

/** One chat.deepseek.com request from the Host, so the browser never faces CORS. */
async function chatFetch(origin, path, options) {
  const { token, method = 'GET', body, extraHeaders } = options
  const headers = { ...CLIENT_HEADERS, ...extraHeaders }
  if (token !== '') headers.authorization = `Bearer ${token}`
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error(`chat: HTTP ${response.status} — ${text.slice(0, 200)}`) }
  if (!response.ok) throw new Error(`chat: HTTP ${response.status} — ${String(payload.msg ?? '')}`)
  return unwrap(payload)
}

/** Read a message body that may be a string, a fragment list, or a nested object. */
function flattenContent(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(flattenContent).filter(part => part !== '').join('\n')
  if (typeof content === 'object') {
    for (const key of ['content', 'text', 'value', 'result', 'answer']) {
      if (key in content) {
        const part = flattenContent(content[key])
        if (part !== '') return part
      }
    }
    if (Array.isArray(content.fragments)) return flattenContent(content.fragments)
    return ''
  }
  return String(content)
}

/** Normalize one session row; the web API has used both id spellings. */
function normalizeSession(raw) {
  return {
    id: String(raw.id ?? raw.chat_session_id ?? ''),
    title: String(raw.title ?? raw.name ?? ''),
    pinned: Boolean(raw.pinned),
    updatedAt: Number(raw.updated_at ?? raw.updatedAt ?? 0),
    createdAt: Number(raw.inserted_at ?? raw.created_at ?? 0),
  }
}

/** Normalize one message row; the web API delivers text as typed fragments. */
/**
 * chat.deepseek.com prefixes answers with a tool header such as
 * "搜索到 15 个网页" (sometimes glued straight onto the first sentence).
 * The page list is rendered under the answer instead, so drop the header.
 */
const SEARCH_HEADER = /(?:搜索到|已搜索到|已检索到|检索到|找到了|已找到|共找到|查看了)\s*\d+\s*个?\s*(?:网页|网站|结果|页面)[，,、。.：:\s]*/g

function stripSearchHeader(text) {
  if (typeof text !== 'string' || text === '') return text
  let out = text.replace(SEARCH_HEADER, '')
  out = out.replace(/^[\s，,、。.：:]+/, '')
  return out === '' ? text : out
}

function normalizeMessage(raw) {
  const rawRole = String(raw.role ?? raw.type ?? '').toUpperCase()
  const role = rawRole === 'USER' ? 'user' : 'assistant'
  let text = ''
  let thinking = ''
  const files = []
  const sources = []
  const seenSources = new Set()
  const fragments = Array.isArray(raw.fragments) ? raw.fragments : []
  for (const fragment of fragments) {
    const type = String(fragment?.type ?? '').toUpperCase()
    const content = typeof fragment?.content === 'string' ? fragment.content : ''
    if (type === 'TOOL_SEARCH') {
      // Web search produced a page list; the answer itself cites them inline.
      for (const result of Array.isArray(fragment.results) ? fragment.results : []) {
        const url = typeof result?.url === 'string' ? result.url.trim() : ''
        if (url === '' || seenSources.has(url)) continue
        seenSources.add(url)
        sources.push({ url, title: typeof result?.title === 'string' && result.title !== '' ? result.title : url })
        if (sources.length >= 20) break
      }
      // The tool header ("搜索到 15 个网页") is chrome, not answer text.
      continue
    }
    if (type === 'THINKING' || type === 'THINK' || type === 'REASONING') thinking += content
    else if (type === 'FILE') {
      /* listed below */
    } else {
      text += content
    }
    if (type === 'FILE') {
      for (const file of Array.isArray(fragment.files) ? fragment.files : []) {
        if (typeof file?.file_name === 'string' && file.file_name !== '') files.push(file.file_name)
      }
    }
  }
  if (text === '' && thinking === '') text = flattenContent(raw.content ?? raw.text)
  if (role === 'assistant') text = stripSearchHeader(text)
  return {
    id: String(raw.message_id ?? raw.id ?? ''),
    role,
    text,
    thinking,
    files,
    sources,
    createdAt: Number(raw.inserted_at ?? raw.created_at ?? raw.timestamp ?? 0),
  }
}

/** Largest JSON body we accept: a 100MB upload becomes ~134MB once base64-encoded. */
const MAX_BODY_BYTES = 150 * 1024 * 1024

/** Upload ceiling that mirrors chat.deepseek.com's own attachment rules. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
/** Largest text file we cache for the read-only side-panel preview. */
const MAX_TEXT_PREVIEW_BYTES = 8 * 1024 * 1024
/** How many text previews stay resolvable in memory. */
const MAX_PREVIEWS = 32

/** Collect the request body as UTF-8 JSON. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('chat-switch: request body too large (150MB)')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/** Plain UTF-8 text answer, used by the read-only attachment preview. */
function sendText(res, status, value) {
  const body = Buffer.from(value, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** Write one JSON answer. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Reject requests that did not come from this machine's own page. */
function isLocalRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address.startsWith('127.') || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Register the chat-switch API on the Host web server.
 * @param ctx - Host composition context.
 */
export function apply(ctx) {
  /** Last self-report posted by the browser half; diagnostics only. */
  let lastProbe = null
  /** Read-only text previews of uploaded attachments, newest last. */
  const previews = new Map()
  let server
  try { server = ctx.get('webServer') } catch { server = undefined }
  if (server === undefined || typeof server.register !== 'function') {
    ctx.logger?.warn?.('chat-switch: no webServer service; the API route was not registered')
    return
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  const handler = async (req, res) => {
    try {
      if (!isLocalRequest(req)) { sendJson(res, 403, { error: 'local requests only' }); return }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.slice(API_PREFIX.length) || '/'
      const state = await readState()
      const origin = state.chatOrigin || ORIGIN_DEFAULT

      if (route === '/status' && req.method === 'GET') {
        sendJson(res, 200, {
          signedIn: state.token !== '',
          tokenFingerprint: fingerprint(state.token),
          chatOrigin: origin,
          user: state.userId === '' ? null : { id: state.userId, name: state.userName },
          harness: await harnessIdentity(ctx),
          client: lastProbe,
        })
        return
      }

      if (route === '/probe' && req.method === 'GET') {
        const out = { chatOrigin: origin, signedIn: state.token !== '', attempts: [] }
        for (const path of ['/api/v0/users/current', '/api/v0/chat_session/fetch_page?count=1&lte_cursor.pinned=false']) {
          try {
            const data = await chatFetch(origin, path, { token: state.token })
            out.attempts.push({ path, ok: true, sample: JSON.stringify(data instanceof Object ? Object.keys(data) : data) })
          } catch (error) {
            out.attempts.push({ path, ok: false, error: String(error?.message ?? error), code: error?.code ?? null })
          }
        }
        sendJson(res, 200, out)
        return
      }

      if (route === '/client-probe' && req.method === 'POST') {
        const body = await readJsonBody(req)
        lastProbe = { at: new Date().toISOString(), ...body }
        ctx.logger?.info?.(`chat-switch: client ${String(body?.stage ?? '')} ${JSON.stringify(body)}`)
        sendJson(res, 200, { ok: true })
        return
      }

      if (route === '/token' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const token = String(body.token ?? '').trim()
        if (token === '') { sendJson(res, 400, { error: 'token 不能为空' }); return }
        let user
        try {
          user = await chatFetch(origin, '/api/v0/users/current', { token })
        } catch (error) {
          sendJson(res, 401, { error: `该 token 无法通过 chat.deepseek.com 校验：${String(error?.message ?? error)}` })
          return
        }
        const next = {
          ...state,
          token,
          userId: String(user?.id ?? user?.user_id ?? ''),
          userName: String(user?.name ?? user?.email ?? user?.mobile ?? ''),
          updatedAt: new Date().toISOString(),
        }
        await writeState(next)
        sendJson(res, 200, { signedIn: true, user: { id: next.userId, name: next.userName }, raw: user })
        return
      }

      if (route === '/logout' && req.method === 'POST') {
        await writeState({ ...state, token: '', userId: '', userName: '' })
        sendJson(res, 200, { signedIn: false })
        return
      }

      if (route === '/sessions' && req.method === 'GET') {
        if (state.token === '') { sendJson(res, 401, { error: '尚未登录 chat.deepseek.com' }); return }
        const count = Math.min(Math.max(Number(url.searchParams.get('count') ?? 100) || 100, 1), 100)
        const params = new URLSearchParams()
        params.set('lte_cursor.pinned', url.searchParams.get('pinned') ?? 'false')
        const updatedAt = url.searchParams.get('updated_at')
        if (updatedAt !== null && updatedAt !== '') params.set('lte_cursor.updated_at', updatedAt)
        params.set('count', String(count))
        const data = await chatFetch(origin, `/api/v0/chat_session/fetch_page?${params.toString()}`, { token: state.token })
        const rows = Array.isArray(data?.chat_sessions) ? data.chat_sessions : []
        const items = rows.map(normalizeSession).filter(item => item.id !== '')
        sendJson(res, 200, { items, hasMore: Boolean(data?.has_more), raw: rows.length === items.length ? undefined : rows })
        return
      }

      if (route === '/messages' && req.method === 'GET') {
        if (state.token === '') { sendJson(res, 401, { error: '尚未登录 chat.deepseek.com' }); return }
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') { sendJson(res, 400, { error: '缺少 sessionId' }); return }
        const data = await chatFetch(
          origin,
          `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`,
          { token: state.token },
        )
        const rows = data?.chat_messages ?? data?.messages ?? []
        const messages = (Array.isArray(rows) ? rows : []).map(normalizeMessage)
        sendJson(res, 200, {
          session: data?.chat_session === undefined ? null : normalizeSession(data.chat_session),
          messages,
          rawKeys: messages.length === 0 ? Object.keys(data ?? {}) : undefined,
        })
        return
      }

      if (route === '/file/upload' && req.method === 'POST') {
        if (state.token === '') { sendJson(res, 401, { error: '尚未登录 chat.deepseek.com' }); return }
        const body = await readJsonBody(req)
        const name = String(body.name ?? 'file')
        const mediaType = String(body.type ?? 'application/octet-stream')
        const bytes = Buffer.from(String(body.dataBase64 ?? ''), 'base64')
        if (bytes.length === 0) { sendJson(res, 400, { error: '文件为空' }); return }
        const headers = { ...CLIENT_HEADERS, authorization: `Bearer ${state.token}`, 'x-ds-pow-response': String(body.powHeader ?? '') }
        delete headers['content-type']
        const form = new FormData()
        form.append('file', new Blob([bytes], { type: mediaType }), name)
        const upstream = await fetch(`${origin}/api/v0/file/upload_file`, { method: 'POST', headers, body: form })
        const text = await upstream.text()
        let payload
        try { payload = JSON.parse(text) } catch { sendJson(res, 502, { error: `upload HTTP ${upstream.status} — ${text.slice(0, 200)}` }); return }
        if (!upstream.ok) { sendJson(res, 502, { error: `upload HTTP ${upstream.status} — ${String(payload?.msg ?? '')}` }); return }
        let data
        try { data = unwrap(payload) } catch (error) { sendJson(res, 502, { error: String(error?.message ?? error) }); return }
        sendJson(res, 200, {
          id: String(data?.id ?? ''),
          name: String(data?.file_name ?? name),
          status: String(data?.status ?? ''),
          size: Number(data?.file_size ?? bytes.length),
        })
        return
      }

      if (route === '/file/status' && req.method === 'GET') {
        const ids = (url.searchParams.get('ids') ?? '').split(',').map(value => value.trim()).filter(Boolean)
        if (ids.length === 0) { sendJson(res, 200, { files: [] }); return }
        const data = await chatFetch(origin, `/api/v0/file/fetch_files?file_ids=${encodeURIComponent(ids.join(','))}`, { token: state.token })
        const files = (Array.isArray(data?.files) ? data.files : []).map(file => ({
          id: String(file?.id ?? ''),
          name: String(file?.file_name ?? ''),
          status: String(file?.status ?? ''),
          isImage: Boolean(file?.is_image),
          signedPath: String(file?.signed_path ?? ''),
        }))
        sendJson(res, 200, { files })
        return
      }

      if (route === '/session/create' && req.method === 'POST') {
        if (state.token === '') { sendJson(res, 401, { error: '尚未登录 chat.deepseek.com' }); return }
        const data = await chatFetch(origin, '/api/v0/chat_session/create', { token: state.token, method: 'POST', body: {} })
        const created = data?.chat_session ?? data
        sendJson(res, 200, { session: normalizeSession(created ?? {}) })
        return
      }

      if (route === '/pow/challenge' && req.method === 'POST') {
        if (state.token === '') { sendJson(res, 401, { error: '尚未登录 chat.deepseek.com' }); return }
        const body = await readJsonBody(req)
        const targetPath = String(body.targetPath ?? '/api/v0/chat/completion')
        const data = await chatFetch(origin, '/api/v0/chat/create_pow_challenge', {
          token: state.token,
          method: 'POST',
          body: { target_path: targetPath },
        })
        const challenge = data?.challenge ?? data
        if (challenge === undefined || challenge === null) { sendJson(res, 502, { error: 'challenge 为空' }); return }
        sendJson(res, 200, {
          algorithm: challenge.algorithm,
          challenge: challenge.challenge,
          salt: challenge.salt,
          signature: challenge.signature,
          difficulty: challenge.difficulty,
          expireAt: challenge.expire_at,
          targetPath: challenge.target_path ?? targetPath,
        })
        return
      }

      if (route === '/chat/send' && req.method === 'POST') {
        if (state.token === '') { sendJson(res, 401, { error: '尚未登录 chat.deepseek.com' }); return }
        const body = await readJsonBody(req)
        const sessionId = String(body.sessionId ?? '')
        const prompt = String(body.prompt ?? '')
        if (sessionId === '' || prompt.trim() === '') { sendJson(res, 400, { error: '缺少 sessionId 或 prompt' }); return }
        const upstream = await fetch(`${origin}/api/v0/chat/completion`, {
          method: 'POST',
          headers: {
            ...CLIENT_HEADERS,
            authorization: `Bearer ${state.token}`,
            'x-ds-pow-response': String(body.powHeader ?? ''),
            accept: 'text/event-stream',
          },
          body: JSON.stringify({
            chat_session_id: sessionId,
            parent_message_id: body.parentMessageId ?? null,
            model_type: body.modelType ?? null,
            prompt,
            ref_file_ids: Array.isArray(body.refFileIds) ? body.refFileIds : [],
            thinking_enabled: Boolean(body.thinking),
            search_enabled: Boolean(body.search),
            preempt: false,
          }),
        })
        if (!upstream.ok || upstream.body === null) {
          const text = await upstream.text().catch(() => '')
          sendJson(res, 502, { error: `completion HTTP ${upstream.status} — ${text.slice(0, 300)}` })
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        const reader = upstream.body.getReader()
        let closed = false
        req.on('close', () => { closed = true; void reader.cancel().catch(() => undefined) })
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            if (closed) break
            res.write(Buffer.from(value))
          }
        } catch (error) {
          ctx.logger?.warn?.(`chat-switch: stream ended — ${String(error?.message ?? error)}`)
        } finally {
          if (!res.writableEnded) res.end()
        }
        return
      }

      if (route === '/session/title' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const data = await chatFetch(origin, '/api/v0/chat_session/update_title', {
          token: state.token,
          method: 'POST',
          body: { chat_session_id: String(body.sessionId ?? ''), title: String(body.title ?? '') },
        })
        sendJson(res, 200, { ok: true, data })
        return
      }

      if (route === '/session/pinned' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const data = await chatFetch(origin, '/api/v0/chat_session/update_pinned', {
          token: state.token,
          method: 'POST',
          body: { chat_session_id: String(body.sessionId ?? ''), pinned: Boolean(body.pinned) },
        })
        sendJson(res, 200, { ok: true, data })
        return
      }

      if (route === '/session/delete' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const data = await chatFetch(origin, '/api/v0/chat_session/delete', {
          token: state.token,
          method: 'POST',
          body: { chat_session_id: String(body.sessionId ?? '') },
        })
        sendJson(res, 200, { ok: true, data })
        return
      }

      if (route === '/file/preview' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const text = typeof body.text === 'string' ? body.text : ''
        if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_PREVIEW_BYTES) {
          sendJson(res, 413, { error: 'preview too large' })
          return
        }
        const id = randomUUID()
        previews.set(id, { name: String(body.name ?? 'file.txt'), text, createdAt: Date.now() })
        while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value)
        sendJson(res, 200, { id, url: `${API_PREFIX}/file/preview/${id}` })
        return
      }

      if (route.startsWith('/file/preview/') && req.method === 'GET') {
        const id = route.slice('/file/preview/'.length)
        const entry = previews.get(id)
        if (entry === undefined) { sendText(res, 404, '预览已过期，请重新上传该文件。'); return }
        sendText(res, 200, entry.text)
        return
      }

      sendJson(res, 404, { error: `unknown route: ${route}` })
    } catch (error) {
      const message = String(error?.message ?? error)
      ctx.logger?.warn?.(`chat-switch: ${message}`)
      sendJson(res, 500, { error: message, code: error?.code ?? null })
    }
  }

  ctx.effect(() => server.register({ kind: 'prefix', path: API_PREFIX, handler }), 'chat-switch: api route')
}

/** Best-effort read of the Harness account identity, so the UI can compare accounts. */
async function harnessIdentity(ctx) {
  const out = { signedIn: false, userId: null, name: null, origin: null }
  let account
  try { account = ctx.get('deepseekAccount') } catch { account = undefined }
  if (account === undefined) return out
  try {
    const session = await account.getPlatformSession?.()
    if (session == null) return out
    out.signedIn = true
    out.origin = session.origin ?? null
    out.userId = session.userId ?? null
  } catch { /* signed out or unavailable */ }
  return out
}
