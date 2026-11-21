# chat.deepseek.com 网页端接口调研（供 dsh-chat-switch 插件 Host 侧使用）

> 调研时间：2026-11-21。目标：Host 侧用 HTTP 直接「列出账号历史对话目录」+「读取某对话消息」。
> 标注约定：**【确定】**＝有可运行的公开实现或官方文档直接支撑；**【推测】**＝由邻近证据推出，需真机抓包复核。
> 本文不编造接口；凡未查实处均写明「推测，需真机验证」。

## 0. 结论速查（可直接抄进代码）

| 用途 | 方法 | 路径 | 鉴权 | 是否需要 PoW |
|---|---|---|---|---|
| 当前账号 / 探活 | GET | `/api/v0/users/current` | `Authorization: Bearer <userToken>` | 否 |
| 会话目录 | GET | `/api/v0/chat_session/fetch_page?count=100&lte_cursor.pinned=false[&lte_cursor.updated_at=<ts>]` | 同上 | 否 |
| 单会话消息 | GET | `/api/v0/chat/history_messages?chat_session_id=<uuid>` | 同上 | 否 |
| 新建会话 | POST | `/api/v0/chat_session/create`，body `{}` | 同上 | 否 |
| 发送（SSE） | POST | `/api/v0/chat/completion` | 同上 + `x-ds-pow-response` | **是** |
| 重命名 / 删除 / 置顶 | POST | `/api/v0/chat_session/update_title`、`delete`、`delete_all`、`update_pinned` | 同上 | 否 |
| PoW 挑战 | POST | `/api/v0/chat/create_pow_challenge`，body `{"target_path":"/api/v0/chat/completion"}` | 同上 | — |

Base URL：`https://chat.deepseek.com`。

### 0.1 先校正一个前提（重要）

- 2026-11-13 的「全家桶应用 API」确实存在：官方公告为 **The full DeepSeek App experience, now via API**，开放的是 **搜索 / 文件输入 / URL 读取 / 安全审核 / OCR / ASR / TTS** 等**能力参数**，并给了开源前端 demo `deepseek-ai/chat-demo`。来源：<https://api-docs.deepseek.com/news/news261113.md>
- 但这份公告**没有**「列出账号 chat 历史」的端点。chat-demo 是**纯前端 + 官方 API Key** 的应用：会话存在浏览器 IndexedDB，导入走**用户自己导出的 ZIP**（`export_format_version: 3`，文件名 `deepseek_data-日期.zip`）。来源：<https://raw.githubusercontent.com/deepseek-ai/chat-demo/main/README.md>、<https://raw.githubusercontent.com/deepseek-ai/chat-demo/main/src/services/chat/history/README.md>
- 结论：**官方 API 无法列出 chat 账号的历史对话**（官方 Chat Completions 是无状态 API）。要「列目录 + 读消息」只有两条路：① 网页端私有接口 + `userToken`；② 让用户从网页端导出 ZIP，Host 侧解析（DSH 已内置该能力的官方 bundle，见 E.4）。

---

## A. 登录态与请求头

### A.1 Token 存放位置 【确定】

- **`localStorage` 的键名是 `userToken`**，值就是 Bearer token。
  - 反代项目 README：「F12 → Application → Local Storage → 找到 `userToken` 中的 value 值，这将作为 Authorization 的 Bearer Token 值」。来源：<https://github.com/xiaoY233/DeepSeek-Free-API>（README「接入准备」）
  - 插件实现同样按此读取：`localStorage.userToken`。来源：<https://fastly.jsdelivr.net/npm/dsh-deepseek-web-login@1.0.3/README.md>（「那个页面是真的『已登录』的」一节）、<https://raw.githubusercontent.com/loyalchiiina/dsh-deepseek-web-free/main/README.md>
- **两种存法都要兼容**：有时值是裸字符串，有时是 JSON 包装 `{"value":"<token>","__version":"0"}`。
  - 来源：<https://raw.githubusercontent.com/CwavGuy/deepseek-web-import/4318049c584dc2dff0470d5d58de6c976a578208/README.md>（「自动提取 userToken 中的 `value` 字段（兼容 `{"value":"...","__version":"0"}` 格式）」）
  - 落地：`const t = raw.trim().startsWith('{') ? (JSON.parse(raw).value ?? raw) : raw`，解析失败按原字符串用。
- Cookie **不是**主鉴权手段。【确定】仅带 cookie 不带 token 会被拒 `40002 Missing Token`。来源：dsh-deepseek-web-login README「cookie 的过期构成会记下来」一节。
  - 冲突记录：`deepseek-driver` README 声称同域脚本可「fetch 自动携带页面 Cookie」直接调 `/api/v0/users/current` 拿 token（<https://cdn.jsdelivr.net/npm/deepseek-driver@0.1.0/README.md>）。两者矛盾 → Host 侧一律以 Bearer token 为准。

### A.2 请求头 【确定 + 部分推测】

最小可用集合（Host 侧直接发）：

```http
Authorization: Bearer <userToken>
Content-Type: application/json      # 仅 POST 需要
Accept: */*
Referer: https://chat.deepseek.com/
Origin:  https://chat.deepseek.com/ # 见 F.2：Host 直连是否必须带 Origin 需真机验证
User-Agent: <一个正常的桌面 Chrome UA>
```

客户端标识头（来自 `deepseek-driver@0.1.0` 的 `CLIENT_HEADERS`，逐字）：

```js
const CLIENT_HEADERS = {
  "x-client-platform": "web",
  "x-client-version": "2.0.0",
  "x-app-version": "20241129.1",
  "x-client-locale": "zh_CN",
  "x-client-timezone-offset": "28800",
}
```

来源：<https://cdn.jsdelivr.net/npm/deepseek-driver@0.1.0/dist/deepseek-driver.es.js>（第 4–11 行）

- 【推测】`x-app-version` 可能**不必需甚至不该发**：另一实测型插件在 0.9.2 明确「删掉真实浏览器根本不发的写死 `x-app-version`」，并用测试约束「发出去的头集合必须等于真实浏览器的集合」。来源：<https://fastly.jsdelivr.net/npm/dsh-deepseek-web-login@1.0.3/README.md>（「关于装了这个插件之后封号了」一节）
  → 建议：先只发 `x-client-platform` / `x-client-version` / `x-client-locale`，若 400 再补。

反爬指纹头（**只在发消息/上传时被实测需要**，列表/读取未见需要）：

```http
x-hif-leim: <GET https://hif-leim.deepseek.com/query 的 data.biz_data.value>
x-hif-dliq: <GET https://hif-dliq.deepseek.com/query 的 data.biz_data.value>
```

来源：`deepseek-driver.es.js` 第 402–421 行（两个 URL 与取值路径）、第 704–714 行（仅 completion 相关路径组装这两个头）；另一实现从浏览器真实请求头旁路捕获同名头（dsh-deepseek-web-login README「① 登录捕获」）。

### A.3 PoW（工作量证明）【确定】

- 列表 / 读消息 / 建会话**不需要** PoW：`deepseek-driver` 的 `fetch_page`、`history_messages`、`chat_session/create` 分支都不调用 `solvePow`，只有 `completion` / `edit_message` / `regenerate` / `upload_file` 调用。来源：同上 es.js 第 205–280 行 vs 第 704–716、806–815 行。
- 需要时流程：`POST /api/v0/chat/create_pow_challenge` body `{"target_path":"/api/v0/chat/completion"}` → `data.biz_data.challenge`（字段 `algorithm/challenge/salt/signature/difficulty/expire_at/expire_after/target_path`）→ 用官方 `sha3_wasm_bg.wasm` 的 `wasm_solve` 求解 → 头 `x-ds-pow-response: base64(JSON.stringify({algorithm,challenge,salt,answer,signature,target_path}))`。来源：es.js 第 349–395 行；字段类型见 `dist/index.d.ts` 的 `PowChallenge`。
- 实现层面的事实：在 Node 里解 PoW 被成熟实现视为高危，已改为「在真实页面上下文里解」。来源：dsh-deepseek-web-login README「为什么这样更不容易被限流」。

### A.4 失败形态

| 形态 | 含义 | 来源 |
|---|---|---|
| HTTP 200 + `{"code":40003,...}`，msg 含 `Authorization Failed` / `INVALID_TOKEN` | token 失效/被吊销 → 清凭据、提示重新登录 | <https://github.com/cheaper-inference/OmniRoute/issues/10993>；dsh-deepseek-web-login README 故障排查表 |
| HTTP 200 + `code 40002`，msg `Missing Token` | 没带 token（只带 cookie 就会这样） | dsh-deepseek-web-login README |
| HTTP 200 + `data.biz_code != 0` | 业务错：如 `9 / invalid ref file id`、`10 / too many ref file`、`user is muted` | 同上（「envelopeError 只看外层 code…」一条） |
| HTTP 401 / 403 | 网关层拒绝；403 时正文常见 `Authorization Failed (invalid token)` | 同上；p2d-deepseek 说明 <https://pypi.org/project/p2d-deepseek/0.1.3/> |
| 响应 `too_large` | 单会话历史过大（>约 4 MB 文本） | CwavGuy/deepseek-web-import README |

**统一响应信封（确定）**：`{"code":0,"msg":"","data":{"biz_code":0,"biz_data":{...}}}` —— 业务数据在 `data.biz_data`，业务码在 `data.biz_code`。来源：`deepseek-driver.es.js` 全部取 `res.data.biz_data`；DSH 官方 `dsh-deepseek-account` 的 zod 信封 `{code: literal(0), data:{biz_code, biz_data}}`（本地 `node_modules/@deepseek-ai/dsh-deepseek-account/src/protocol.ts` 第 78 行）。

---

## B. 会话列表接口

### B.1 端点与参数 【确定】

```
GET https://chat.deepseek.com/api/v0/chat_session/fetch_page
```

Query（来自 `deepseek-driver` 的 `listSessions`，逐字）：

| 参数 | 类型 | 说明 |
|---|---|---|
| `count` | number | 每页条数。实测常用 `100`（也是上限，见 B.4） |
| `lte_cursor.pinned` | `"true"`/`"false"` | 游标：置顶区标记。驱动默认填 `"false"` |
| `lte_cursor.updated_at` | number | 游标：上一页最后一条的 `updated_at`（首页不带） |

来源：<https://cdn.jsdelivr.net/npm/deepseek-driver@0.1.0/dist/deepseek-driver.es.js> 第 215–234 行；参数名独立佐证见一篇公开的「导出全年聊天记录」脚本，其分页同样使用 `{"lte_cursor.pinned":"false"}` + `lte_cursor.updated_at`（<http://mp.weixin.qq.com/s?__biz=MzkwNDcwNjMxNA==&mid=2247485864&idx=1&sn=ab135f650f3d298d9e91e351b73b4e77>）。

### B.2 curl

```bash
curl -sS 'https://chat.deepseek.com/api/v0/chat_session/fetch_page?count=100&lte_cursor.pinned=false' \
  -H 'authorization: Bearer <userToken>' \
  -H 'x-client-platform: web' \
  -H 'x-client-version: 2.0.0' \
  -H 'x-client-locale: zh_CN' \
  -H 'referer: https://chat.deepseek.com/' \
  -H 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
```

### B.3 响应结构【确定】

```ts
interface SessionListResult { chat_sessions: ChatSession[]; has_more: boolean }
interface ChatSession {
  id: string                    // uuid，同时也是网页 URL /chats/<id> 的一段
  title: string | null
  title_type: 'SYSTEM' | 'USER' | 'WIP'
  pinned: boolean
  model_type: 'default' | 'expert' | 'vision'
  updated_at: number
  inserted_at?: number
  seq_id?: number
  agent?: string
  version?: number
  current_message_id?: number | null
  is_empty?: boolean
}
```

来源：<https://cdn.jsdelivr.net/npm/deepseek-driver@0.1.0/dist/index.d.ts>（`ChatSession` 第 49–62 行、`SessionListResult` 第 709–712 行）。
另有一处实现读 `has_more ?? hasMore`（驼峰兜底），说明服务端曾出现过驼峰形态：<https://github.com/zhu1090093659/deepseek-pp/commit/276008ddd0345a9b3930a2c626b830b595054f68>

**响应样例（按上述字段清单重建的示意，非原文抓包 —— 字段名确定，值示例化）**：

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_data": {
      "chat_sessions": [
        {
          "id": "0f1e2d3c-4b5a-6978-8c9d-0a1b2c3d4e5f",
          "title": "帮我看下这段 TypeScript 的类型推断",
          "title_type": "SYSTEM",
          "pinned": false,
          "model_type": "default",
          "updated_at": 1763600000,
          "inserted_at": 1763500000,
          "seq_id": 128,
          "version": 2,
          "current_message_id": 41,
          "is_empty": false
        }
      ],
      "has_more": true
    }
  }
}
```

> `updated_at` 的时间单位【推测】：与消息 `inserted_at` 同为「秒级 epoch」（消息侧已由可用实现确认为秒，见 C.3）。游标回传时按原值 `String()` 即可，**不要自己换算** —— 驱动就是原样回传。

### B.4 分页：三种互相矛盾的实测，必须真机定夺 【未确定】

| 说法 | 出处 |
|---|---|
| 支持 `lte_cursor.pinned` + `lte_cursor.updated_at` 翻页（驱动按此实现） | deepseek-driver es.js 215–234 |
| 支持 `lte_cursor.*` 翻页（脚本按此循环拉到全量） | 微信公众号「把DeepSeek全年聊天记录变成年度报告」脚本 |
| **游标不生效**，`fetch_page` 响应只有 `chat_sessions` + `has_more`，超过 100 条只返回最新 100 条 | <https://raw.githubusercontent.com/CwavGuy/deepseek-web-import/4318049c584dc2dff0470d5d58de6c976a578208/README.md>、<http://dsh.pub/zh/plugins/cwavguy-deepseek-web-import/> |
| 带分页参数（`count`/`cursor`/`offset`）时只返回前 50 条且 `has_more` 恒为 true，循环无法终止 | <https://scriptcat.org/de/script-show-page/6432/issue/1840> |

**落地建议（防御式）**：
1. 首屏固定 `count=100&lte_cursor.pinned=false`，一次拿到最新 100 条 —— 这是所有实现都同意的行为。
2. 若 `has_more === true`，再尝试 `count=100&lte_cursor.pinned=false&lte_cursor.updated_at=<最后一条.updated_at>`；
   若返回为空、与上一页 id 有交集，或 `has_more` 仍为 true 且 id 集合不前进（最多重试 2 次），判定「游标不可用」，停止翻页并在 UI 上显示「仅显示最近 100 条」。
3. 去重键用 `id`。

---

## C. 会话消息接口

### C.1 端点与参数【确定】

```
GET https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=<chat_session.id>
```

- 唯一参数：`chat_session_id`（即 B.3 的 `id`，uuid）。来源：`deepseek-driver.es.js` 第 273–280 行；独立实现同样如此：<https://raw.githubusercontent.com/CwavGuy/deepseek-web-import/4318049c584dc2dff0470d5d58de6c976a578208/README.md>（「对话历史：`GET /api/v0/chat/history_messages?chat_session_id=<uuid>`」）
- 该接口**一次返回整条主线**，无分页；超大对话会因体积被拒（约 4 MB 文本上限，返回 `too_large`）。来源：同上 README「已知限制」。
- 候选端点 `/api/v0/chat_session/{id}` 未在任何实现中出现，**不要用**。

### C.2 curl

```bash
curl -sS 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=0f1e2d3c-4b5a-6978-8c9d-0a1b2c3d4e5f' \
  -H 'authorization: Bearer <userToken>' \
  -H 'x-client-platform: web' \
  -H 'x-client-version: 2.0.0' \
  -H 'referer: https://chat.deepseek.com/'
```

### C.3 响应结构【确定】

`data.biz_data` 类型（`HistoryMessagesResult`）：

```ts
interface HistoryMessagesResult {
  chat_session: ChatSession      // 同 B.3
  chat_messages: ChatMessage[]
  cache_control: string
  cache_reset_at: number
}
```

`ChatMessage`（类型声明逐字）：

```ts
interface ChatMessage {
  message_id: number
  parent_id: number | null
  role: 'USER' | 'ASSISTANT'        // 注意：大写
  thinking_enabled: boolean
  ban_edit: boolean
  ban_regenerate: boolean
  status: 'WIP' | 'FINISHED' | 'INCOMPLETE' | 'INTERRUPTED' | 'CONTENT_FILTER'
  incomplete_message: string | null
  accumulated_token_usage: number
  feedback: FeedbackType
  search_enabled: boolean
  fragments: Fragment[]
  has_pending_fragment: boolean
  auto_continue: boolean
}
```

来源：<https://cdn.jsdelivr.net/npm/deepseek-driver@0.1.0/dist/index.d.ts>（`ChatMessage` 第 32–47 行、`MessageRole`/`MessageStatus` 第 518–520 行、`HistoryMessagesResult` 第 482–487 行）。

**正文不在 `content` 字段，而在 `fragments[]`** —— 最容易踩的坑，两个独立实现都点明：

- 驱动按片段的 `content` 累加（es.js 第 660–699 行 `yieldFragmentDelta`）。
- 导入插件：「DeepSeek 的正文在 `fragments`（`REQUEST`/`RESPONSE`/`THINK`），不在 `content`；现在按角色提取」<https://raw.githubusercontent.com/CwavGuy/deepseek-web-import/4318049c584dc2dff0470d5d58de6c976a578208/README.md>

片段 `type` 取值（接口与官方导出格式同构，可互证）：

| fragment.type | 归属 | 取值方式 |
|---|---|---|
| `REQUEST` | USER 消息正文 | `content` |
| `RESPONSE` | ASSISTANT 正文 | `content` |
| `THINK` | ASSISTANT 思维链 | `content`（另有 `elapsed_secs` 思考耗时） |
| `TEMPLATE_RESPONSE` | 服务端模板回复（错误/拒绝） | `content` |
| `TOOL_SEARCH` | 联网检索步骤 | `queries[]` / `results[{url,title,snippet,published_at}]` / `status` |
| `TOOL_OPEN` / `TOOL_FIND` | 打开网页 / 页内查找 | `status` / `url` / `title` / `pattern` |
| `READ_LINK` | 读链结果（含签名，回传上下文用） | `results[{url,title}]` |
| `TOOL_IMAGE_SEARCH` / `PARTIAL_FILE_READ` / `TIP` / `FILE` | 图搜 / 部分读文件 / 提示 / 附件 | — |

来源：官方导出格式说明 <https://raw.githubusercontent.com/deepseek-ai/chat-demo/main/src/services/chat/history/README.md>（同一批片段类型）＋ DSH 官方导入器的 zod 定义：本地 `node_modules/@deepseek-ai/dsh-deepseek-chat-import/src/format.ts` 第 100–118 行（逐字列出上表全部 `type`）。

**消息时间戳**：`inserted_at`，**秒级 epoch**。依据：导入插件用它还原真实时间 —— `const seconds = Number(message.inserted_at)`，注释写明 `inserted_at` is seconds since the epoch。来源：`CwavGuy/deepseek-web-import` 的 `lib/events.js` 第 118–126 行。
⚠️ 该字段**未出现在** `deepseek-driver` 的 `ChatMessage` 类型声明里：属「实现确实读到、驱动没声明」的字段 —— 见 F.1。

**响应样例（按已确认字段重建的示意，非原文抓包）**：

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_data": {
      "chat_session": {
        "id": "0f1e2d3c-4b5a-6978-8c9d-0a1b2c3d4e5f",
        "title": "帮我看下这段 TypeScript 的类型推断",
        "title_type": "SYSTEM",
        "pinned": false,
        "model_type": "default",
        "updated_at": 1763600000,
        "current_message_id": 41
      },
      "chat_messages": [
        {
          "message_id": 40,
          "parent_id": null,
          "role": "USER",
          "thinking_enabled": false,
          "ban_edit": false,
          "ban_regenerate": false,
          "status": "FINISHED",
          "incomplete_message": null,
          "accumulated_token_usage": 0,
          "feedback": null,
          "search_enabled": true,
          "fragments": [
            { "type": "REQUEST", "content": "帮我看下这段 TS 的类型推断为什么退化" },
            { "type": "FILE", "files": [{ "id": "file_xxx", "file_name": "a.png", "file_size": 10240, "is_image": true, "export_path": null }] }
          ],
          "has_pending_fragment": false,
          "auto_continue": false,
          "inserted_at": 1763599990
        },
        {
          "message_id": 41,
          "parent_id": 40,
          "role": "ASSISTANT",
          "thinking_enabled": true,
          "ban_edit": false,
          "ban_regenerate": false,
          "status": "FINISHED",
          "incomplete_message": null,
          "accumulated_token_usage": 812,
          "feedback": null,
          "search_enabled": true,
          "fragments": [
            { "type": "THINK", "content": "先确认泛型约束…", "elapsed_secs": 4 },
            { "type": "RESPONSE", "content": "问题出在 `extends` 约束上……" },
            { "type": "TOOL_SEARCH", "status": "FINISHED", "queries": ["ts 类型推断 退化"], "results": [] }
          ],
          "has_pending_fragment": false,
          "auto_continue": false,
          "inserted_at": 1763600000
        }
      ],
      "cache_control": "",
      "cache_reset_at": 0
    }
  }
}
```

### C.4 拼装规则（照抄成熟实现的做法）

- `role === 'USER'` → 只取 `REQUEST` 片段的 `content`；
- `role === 'ASSISTANT'` → `RESPONSE` 拼正文、`THINK` 拼思维链，二者分开存；
- 按 `message_id` 升序即主线顺序；`parent_id` 只在「编辑/重新生成」产生兄弟分支时需要，**不解析 `parent_id` 也能用**（导入插件就是这么做的，副作用是把分支当成先后两轮）。来源：CwavGuy README 已知限制。
- `status` 为 `WIP` / `INCOMPLETE` 时可能带 `incomplete_message`（半截内容）。

---

## D. 发送消息（次要，简）

### D.1 建会话【确定】

```bash
curl -sS -X POST 'https://chat.deepseek.com/api/v0/chat_session/create' \
  -H 'authorization: Bearer <userToken>' -H 'content-type: application/json' \
  -d '{}'
# → data.biz_data.chat_session.id
```

来源：`deepseek-driver.es.js` 第 205–214 行。

### D.2 流式发送【确定，但需 PoW】

```
POST /api/v0/chat/completion
x-ds-pow-response: <base64(JSON{algorithm,challenge,salt,answer,signature,target_path:"/api/v0/chat/completion"})>
（可选）x-hif-leim / x-hif-dliq
```

```json
{
  "chat_session_id": "<uuid>",
  "parent_message_id": 41,
  "model_type": null,
  "prompt": "继续",
  "ref_file_ids": [],
  "thinking_enabled": true,
  "search_enabled": true,
  "preempt": false
}
```

来源：`deepseek-driver.es.js` 第 701–736 行（body 字段逐字）。

SSE 要点：
- 帧由 payload 里的 `response/fragments` 驱动，补丁形如 `{o:"APPEND"|"SET", p:"...", v:"..."}`；首帧 `ready` 携带 `request_message_id` / `response_message_id` / `model_type`；结束有 `status: FINISHED` 与 `title` 帧。
- 两套形态并存（fragments patch 流 + 直连 `content`/`thinking_content`），解析器要都吃。来源：dsh-deepseek-web-login README「流式」一行；`deepseek-driver.es.js` `parseSSEStream`。

### D.3 其他会话操作【确定】

| 操作 | 端点 | body |
|---|---|---|
| 重命名 | `POST /api/v0/chat_session/update_title` | `{"chat_session_id":"<uuid>","title":"新标题"}` |
| 删除单个 | `POST /api/v0/chat_session/delete` | `{"chat_session_id":"<uuid>"}` |
| 清空全部 | `POST /api/v0/chat_session/delete_all` | `{}` |
| 置顶 | `POST /api/v0/chat_session/update_pinned` | `{"chat_session_id":"<uuid>","pinned":true}` |
| 编辑消息 | `POST /api/v0/chat/edit_message` | `{chat_session_id,message_id,prompt,search_enabled,thinking_enabled}`（需 PoW） |
| 重新生成 | `POST /api/v0/chat/regenerate` | `{chat_session_id,child_message_id,...}`（需 PoW） |
| 反馈 | `POST /api/v0/chat/message_feedback` | `{chat_session_id,message_id,feedback_type}` |

来源：`deepseek-driver.es.js` 第 235–272、737–799 行；第三份独立佐证（转发路径白名单）：<https://zread.ai/TQZHR/deepseek2api/7-native-proxy-layer>（列出 `chat_session/create|delete|delete_all|fetch_page|update_pinned|update_title` 与 `chat/completion|continue|edit_message|history_messages|message_feedback|regenerate|resume_stream|stop_stream`）。

---

## E. 与 harness 账号（platform / deepseekAccount 服务）的关系

### E.1 两套体系互不通用【确定（架构层面）】

| | chat.deepseek.com（网页端） | platform / DSH 账号 |
|---|---|---|
| 凭证 | `localStorage.userToken`（JWT 形态） | DSH 托管的 account grant |
| 传输头 | `Authorization: Bearer <userToken>` | `x-dsh-auth-token: <grant>` |
| 端点 | `/api/v0/chat*`、`/api/v0/chat_session/*` | `/auth-api/v0/users/current`、`/api/v0/users/get_user_summary`、`/api/v0/users/notifications/*`（platform origin） |
| 失败语义 | `code 40002` / `40003` | HTTP 401 或 `code 40003` → 清除本地凭据 |
| 用途 | 网页版会话、历史 | 账号资料 / 余额 / 通知、模型推理（`api.deepseek.com`） |

来源：本地安装的官方包 `node_modules/@deepseek-ai/dsh-deepseek-account/src/protocol.ts`（第 78–182 行：信封、`requestAccount` 的路径联合类型、`x-dsh-auth-token`、401/40003 处理）；`@deepseek-ai/dsh-web-deepseek-api/src/transport.ts`（第 29–47、318–326 行：account 源只把 token 发往「release 给该 endpoint 的 base」，API key 源才用 `Authorization: Bearer`）。

**web token 能否用 platform 的账号 token 换到？**
- 【推测：不能】现有证据里没有任何 exchange 端点；DSH 账号服务的 token 是**按 dispatch endpoint 逐次释放**的 scoped grant（`resolveToken(endpoint)`），只对它自己的 origin 放行；`chat.deepseek.com` 的 `userToken` 由 chat 登录流程签发，域、头、错误码全不同。
- 【未证实线索】有插件 README 提到「稳定性优先请用官方 API，或用已有的**付费订阅走 OAuth**」（dsh-deepseek-web-login README 开头末段）。是否存在「订阅 OAuth → 网页端额度」的官方通道，本次未能查证，**不要写进实现**。

### E.2 现实可落地的三条路（按侵入性排序）

1. **让用户粘贴 `userToken`**（最省事，已有三个插件这么做）
   - UI：输入框 + 「校验」→ `GET /api/v0/users/current` 成功即有效（零额度探活）。
   - 存储：放 DSH credentials 服务，别写进会话日志/浏览器（CwavGuy 明确用 `credentials` 服务）。
   - 缺陷：token 有时效（实测「数小时~数天」），过期要用户重新复制 → 必须做 40003 的显式提示与一键重填。
2. **内置浏览器登录后旁路捕获**（体验最好）
   - 开独立 profile 窗口让用户正常登录，用 `webRequest.onBeforeSendHeaders` 读一次真实请求的 `Authorization`、域 cookie、`x-hif-*`、`x-client-*`，之后关窗也能用。
   - 注意：登录窗口 UA 必须洗掉 `Electron` 标记，否则网页端直接回「使用环境异常」；微信扫码因 OAuth 白名单只认 `chat.deepseek.com` 而不可用，手机号登录同一账号可用。
   - 来源：dsh-deepseek-web-login README「① 登录捕获」「微信扫码为什么用不了」；<https://raw.githubusercontent.com/cwx2/dsh-deepseek-web-panel/main/README.md>（同样结论：回环代理 + 手机号登录）。
3. **不碰接口，直接嵌页面**（只做「打开历史」不做结构化数据）
   - 回环代理 iframe 载入 chat.deepseek.com，剥 CSP/X-Frame-Options、用 cookie jar 维持登录。来源：cwx2/dsh-deepseek-web-panel README「工作原理」。

### E.3 「同账号」的判定建议

- 不要试图让 chat 域与 platform 域共享一个 token。**把「网页版账号」当成独立的第二条凭据链**，与 DSH 的 `deepseekAccount` 服务并列，各自独立失效、独立提示。
- 若产品上要「一个账号、两种能力」，判断依据只能是**用户可读标识**（`GET /api/v0/users/current` 返回的账号掩码，如 `192******27`）与 platform 侧 `users/current` 的掩码做弱比对，且只用于展示提示，不用于自动合并。来源：dsh-deepseek-web-login README「账号显示名用的是『网页端返回的屏蔽值』」。

### E.4 如果只需要「把历史搬进 DSH」，官方已有现成通道

- 网页端可导出全部会话为 `deepseek_data-日期.zip`（`export_format_version: 3`），结构：`manifest.json` → `chat_session_index.json`（`[{id,inserted_at,updated_at}]`，时间为 RFC3339 字符串）→ `chat_sessions/{id}.json`（`{id,title,current_message_id,inserted_at,messages[{id,parent_id,role,status,inserted_at,fragments}]}`）。
- DSH 自带官方 bundle `@deepseek-ai/dsh-deepseek-chat-import` 负责导入（本地 `node_modules/@deepseek-ai/dsh-deepseek-chat-import/`，字段校验见 `src/format.ts`）。
- 对本插件的含义：**「列目录 + 读消息」如果允许走导出文件，就不必依赖私有接口**；代价是用户要手动导出一次，且拿不到「实时新增」的会话。来源：<https://raw.githubusercontent.com/deepseek-ai/chat-demo/main/src/services/chat/history/README.md>、本地 `dsh-deepseek-chat-import/src/format.ts`。

---

## F. 不确定项与风险

### F.1 未验证字段 / 行为（写代码时必须容错）

1. **`fetch_page` 游标是否真的生效** —— 见 B.4，四份实测互相矛盾。→ 防御式翻页 + 去重。
2. **`updated_at` / `inserted_at` 的时间单位（会话侧）**：消息侧已确认秒级（`lib/events.js`），会话侧仅【推测】同为秒。→ 显示时用「秒/毫秒自适应」判定（值 < 1e11 视为秒）。
3. **消息 `inserted_at` 是否存在**：驱动类型声明里没有，但有可用实现直接读并成功。→ 缺失时回退到会话 `updated_at` 或本地接收时间。
4. **`x-app-version` 是否该发**：驱动发了 `20241129.1`；另一实测插件认为真实浏览器不发、删掉更安全。→ 先不发，400/403 时再补。
5. **`Origin` / `Referer` 是否必需**：未找到直接证据。→ 两者都带 `https://chat.deepseek.com/`，成本为零。
6. **响应样例的具体值**：本文两份 JSON 都是「按确定字段名重建的示意」，不是原文抓包；字段名可信，值不可引用。
7. **`feedback` 字段类型**（`FeedbackType`）未展开；`cache_control` / `cache_reset_at` 语义未查证。→ 忽略即可。
8. **`has_more` 是否有驼峰别名**：有实现读 `biz_data.has_more ?? bizData.hasMore`，说明历史上有过驼峰形态。→ 两者都判。
9. **`users/current` 的 `biz_data` 是否含 `token`**：驱动在 API 发现路径里读 `res.data.biz_data.token`，但另有实现反过来说只带 cookie 会被 40002 拒。→ 只把该端点当**探活**用，不要依赖它取 token。

### F.2 CORS / 网络位置

- 网页端从**第三方 origin** 直连会被拦：响应无 `Access-Control-Allow-Origin`、预检被 429（本任务前置已确认）。这也解释了为什么成熟实现要么走 Host 转发（CwavGuy 的 host 半部用 `subprocess` 起 node 发请求），要么走回环代理（cwx2）。
- 未验证：Host 侧（Node/Electron 主进程）直连**是否**需要伪造 `Origin`。Node 环境不触发浏览器预检，理论上不带 Origin 也能发，但服务端可能校验。→ 先带上，若 403 /「使用环境异常」再换组合。
- 【推测】TLS/HTTP2 指纹与真实浏览器不同可能被判自动化（有插件为此专门切 Chromium 网络栈），但**对「列表/读取」是否触发未验证**；写入类操作（发消息）风险显著更高。

### F.3 账号与运营风险（工程视角）

- 同一账号**并发生成会被拒**；实测多开并发可能触发 1 天临时限制（`user is muted`，登录态仍有效）。→ 列表/读取虽是只读，仍应串行 + 最小间隔，避免高频轮询。
- `userToken` 时效短 → 必须把 40002 / 40003 映射成明确的「重新登录 / 重新粘贴」，而不是笼统报错。
- 列表接口在多份实测中最多给 100 条 → **UI 必须显式说明「只显示最近 100 条」**，否则用户会以为数据丢了。

---

## G. 来源清单

**一手接口证据（可 grep 的代码/类型）**
- `deepseek-driver@0.1.0`（npm；含 `/api/v0/` 全量路径、`CLIENT_HEADERS`、PoW、类型声明）：<https://cdn.jsdelivr.net/npm/deepseek-driver@0.1.0/dist/deepseek-driver.es.js>、<https://cdn.jsdelivr.net/npm/deepseek-driver@0.1.0/dist/index.d.ts>、<https://cdn.jsdelivr.net/npm/deepseek-driver@0.1.0/README.md>
- 本地安装的 DSH 官方包（信封 / 账号 token / 导出格式）：`node_modules/@deepseek-ai/dsh-deepseek-account/src/protocol.ts`、`node_modules/@deepseek-ai/dsh-deepseek-chat-import/src/format.ts`、`node_modules/@deepseek-ai/dsh-web-deepseek-api/src/transport.ts`

**现有 DSH 插件实现（同类需求，最值得抄）**
- `CwavGuy/deepseek-web-import`（`fetch_page?count=100` + `history_messages` + fragments 取正文 + 100 条上限）：<https://github.com/CwavGuy/deepseek-web-import/blob/4318049c584dc2dff0470d5d58de6c976a578208/README.md>
- `wpc0323/deepseek-web-import`（上游原版）：<https://github.com/wpc0323/deepseek-web-import>
- `dsh-deepseek-web-login`（登录捕获、`x-hif-*`、PoW、错误码表、风控实测）：<https://fastly.jsdelivr.net/npm/dsh-deepseek-web-login@1.0.3/README.md>
- `cwx2/dsh-deepseek-web-panel`（回环代理 + 手机号登录 + 微信 OAuth 限制）：<https://raw.githubusercontent.com/cwx2/dsh-deepseek-web-panel/main/README.md>
- `loyalchiiina/dsh-deepseek-web-free`（`localStorage.userToken` 注入 + `users/current` 校验后写凭据库）：<https://raw.githubusercontent.com/loyalchiiina/dsh-deepseek-web-free/main/README.md>
- `y-wi/dsh-deepseek-web`（同类，描述「网页端模型、对话历史接入 DSH」）：<https://github.com/y-wi/dsh-deepseek-web>
- ⚠️ `nai-loong/dsh-webchat-bridge` 经 GitHub API 查询 **404 不存在**（复核于 2026-11-21），不要引用。
- 端点独立佐证（转发白名单）：<https://zread.ai/TQZHR/deepseek2api/7-native-proxy-layer>

**官方文档 / 公告**
- 全家桶 API 公告：<https://api-docs.deepseek.com/news/news261113.md>
- 官方文档索引（确认无「对话历史」端点）：<https://api-docs.deepseek.com/llms.txt>
- chat-demo（官方开源前端：API Key + IndexedDB，无服务端历史）：<https://raw.githubusercontent.com/deepseek-ai/chat-demo/main/README.md>；历史 ZIP 格式：<https://raw.githubusercontent.com/deepseek-ai/chat-demo/main/src/services/chat/history/README.md>

**错误码 / 行为实测**
- 40003 = token 失效：<https://github.com/cheaper-inference/OmniRoute/issues/10993>
- 分页退化（带参数只回 50 条、`has_more` 恒 true）：<https://scriptcat.org/de/script-show-page/6432/issue/1840>
- 100 条上限复述：<http://dsh.pub/zh/plugins/cwavguy-deepseek-web-import/>
- 响应驼峰兜底历史：<https://github.com/zhu1090093659/deepseek-pp/commit/276008ddd0345a9b3930a2c626b830b595054f68>
- token 取法（F12 / Network 面板）：<https://pypi.org/project/p2d-deepseek/0.1.3/>
