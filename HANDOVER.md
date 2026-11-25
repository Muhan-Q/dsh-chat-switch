# HANDOVER — dsh-chat-switch

> 交接说明：给"换到电脑上继续改"的人（也就是你）。读完这份就能跑起来、改起来。
> 打包时间：2026-11-21 15:45（Asia/Shanghai）· 版本 `0.2.0`（npm latest）/ `0.2.1`（仓库与 npm 暂存待批）

---

## 1. 这是什么

给 **DeepSeek Harness（DSH / DSHM）** 做的插件：在左侧栏顶部加一个 **Chat ⇄ Harness** 切换器。

- **Harness**：原样使用 DSH 的工作区 / 会话浏览区；
- **Chat**：左侧栏的工作区位置被 **chat.deepseek.com 的对话目录**接管（置顶/今天/7天/30天/年月分组、搜索、重命名、置顶、多选批量删除），主列变成可对话界面（流式回答、深度思考折叠、智能搜索开关、图片/文件附件、Markdown 渲染）。

登录态复用同一个 DeepSeek 账号：网页端登录一次、把 `userToken` 交给插件，Host 保存（0600），之后所有 chat 请求由 Host 转发，浏览器端不受 CORS 限制，token 不回传页面。

**验证平台**：华为鸿蒙手机 DSHM（host `0.2.2-rc.5+dshm.1`，ArkWeb WebView）。
**未验证**：Windows / macOS / Linux 桌面版 DSH、Android / iOS 手机版 —— 这次去电脑上要验的就是它。

---

## 2. 包里的东西

```
dsh-chat-switch/               完整工程（含 .git 历史，可继续提交）
├── lib/index.js               Host 半：/chat-switch/api/* 全部路由
├── lib/client.js              客户端半：槽位注册 + 全部 UI（window.__ModuleLoader__ 形态）
├── assets/sha3_wasm_bg.wasm   DeepSeekHashV1 求解器（页面内跑）
├── src/smoke-host.mjs         Host 冒烟测试（真网络，需要已登录 token）
├── src/smoke-client.mjs       客户端冒烟测试（假 React/DOM，验证槽位注册与 token 提取）
├── docs/notes-chat-api.md     网页端私有接口记录（端点/头/响应字段）
├── docs/screenshots/          三张演示图
├── install.sh                 装进端侧 profile（写 dependencies + bundles + 权限）
├── cordis.patch.yml           bundle patch（插入 chat-switch 行）
├── package.json               清单：dsh.bundle / dsh.client / files / publishConfig
└── HANDOVER.md                本文件
session/session-24cd35b7-….jsonl.zstd   本次全部对话记录（zstd 压缩）
```

会话记录的读法（电脑上装了 zstd）：

```sh
zstd -d session/*.jsonl.zstd -o session.jsonl
```

里面是逐事件的 JSONL（user/assistant/tool/result），可用来回溯每一步决策与验证数据。

---

## 3. 在电脑上怎么验（三条路，从易到难）

### A. 只跑冒烟测试（无需 DSH，1 分钟）

```sh
node --check lib/index.js && node --check lib/client.js
node src/smoke-client.mjs        # 期望最后输出 ok（槽位注册 / token 提取 / markdown 渲染）
```

Host 冒烟测试会真连 chat.deepseek.com，需要本机已有登录态：

```sh
# 先把 DSH_HOME 指到一台已登录 chat 的机器目录，或手动准备 state.json：
#   { "token": "<chat.deepseek.com 的 userToken>", "chatOrigin": "https://chat.deepseek.com" }
DSH_HOME=/path/to/dsh-home node src/smoke-host.mjs
```

期望：`status 200 signedIn true`、`/pow/challenge` 返回 `DeepSeekHashV1`、`/sessions` 能列出对话。

### B. 装进桌面版 DSH（验证 UI 槽位）

```sh
dsh plugin --profile <profile> add dsh-chat-switch     # 或 github:Muhan-Q/dsh-chat-switch#v0.2.1
# 重启 dsh 并刷新页面
```

桌面版与端侧的差异要重点看三处（每处都可能要适配）：

1. **槽位**：`sidebar.session.action`(hoc，需 `id`)、`main`(keyed, `key:'chat'`)、`sidebar.workspaces`(single，抢占要 `priority:-1`)；
2. **抽屉判定**：`closeDrawerIfOpen()` 依赖 `[data-sidebar-drawer]` 与 `[data-sidebar-collapsed]`，桌面宽屏不会走 drawer，行为应等价于"不收起"；
3. **PoW**：`WebAssembly` 在页内跑；桌面 WebView/浏览器都支持，注意 `--jitless` 只影响 Host 进程，不影响页面。

### C. 装回鸿蒙手机（回归）

```sh
sh install.sh          # 默认写到 $DSH_HOME/profiles/ondevice
# 重启 DSHM
```

---

## 4. 架构与关键实现（改代码前先看这节）

### Host 半（`lib/index.js`，零 npm 依赖）

| 路由 | 说明 |
| --- | --- |
| `GET /status` | 登录态、chat 用户、Harness 账号比对（**只读本机凭据，不要在这里加网络请求**，曾经因为查 platform profile 把接口拖到 30s，导致界面"掉登录"） |
| `POST /token` | 校验并保存 `userToken`（调 `/api/v0/users/current`） |
| `GET /sessions` `GET /messages` | 目录与消息；消息正文在 `fragments[]`（`REQUEST`/`RESPONSE`/`THINK`/`FILE`） |
| `POST /session/create|title|pinned|delete` | 会话管理 |
| `POST /pow/challenge` | 取 `DeepSeekHashV1` 挑战（`target_path` 决定用途） |
| `POST /chat/send` | 发送并把上游 SSE 原样透传 |
| `POST /file/upload` `GET /file/status` | 附件上传与就绪轮询（必须先 `SUCCESS` 再发送，否则 chat 拒收） |
| `POST /client-probe` | 客户端自检上报，回显在 `/status.client`（排障用） |

所有 chat 请求统一加客户端头（`x-client-platform/version/locale/timezone`），token 放 `authorization: Bearer`。

### 客户端半（`lib/client.js`）

- **注册**：`sidebar.session.action`（切换器 + 新网页对话）、`main:chat`（聊天面板）、`sidebar.workspaces`（Chat 模式下抢占目录，`priority:-1`）、`shell.overlay`（兜底切换器 + 确认弹层）。
- **PoW**：内嵌 wasm（base64，26KB），`wasm_solve(retptr, challenge, prefix, difficulty)`，prefix = `${salt}_${expire_at}_`；求解 10–25 秒，串行排队。
- **SSE 协议**（实测）：
  - `{v:{response}}` 全量快照（fragments 带 `THINK`/`RESPONSE`）；
  - `{p:"response/fragments/-1/content", o:"APPEND", v:"…"}` 与裸 `{v:"…"}` 都是**当前片段**增量；
  - `{p:"…/elapsed_secs", o:"SET"}` = 思考结束（用它切到回答片段，并显示"已思考（用时 X 秒）"）；
  - `{p:"response/status", o:"SET", v:"FINISHED"}` = 结束。
- **确认弹层**：`react-dom.createPortal` 到 `document.body` + **内联样式**（这套壳里 body 级节点吃不到 class 样式，且 ArkWeb 不认 `inset` 简写）。

---

## 5. 已经踩过的坑（照这个清单排错）

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 插件装了没反应 / 面板空 | profile 每次启动重拼 `cordis.patch.yml`，手写挂载行被丢弃 | 走 `dsh.profile.bundles`（bundle patch）+ `dependencies` |
| 切换器不显示 | `hoc` 槽位注册缺 `id` | `{ name:'sidebar.session.action', id:'chat-switch' }` |
| Chat 模式左栏仍是工作区 | single 槽位同 priority 抢不到 | `priority: -1`（"lowest renders"） |
| 状态接口很慢、界面像掉登录 | `/status` 里串了 platform 请求 | 只读本机凭据 + 前端 8s 超时 |
| 思考内容混进正文 | 推理片段类型是 `THINK`（不是 `THINKING`），且切换信号是 `elapsed_secs` | 统一 `isThinkingType()` + `elapsed_secs` 切段 |
| 弹层挤在左上角 / 被侧栏盖住 | `inset:0` 在 ArkWeb 不生效；class 样式作用不到 body 级 portal | 四方向逐写 + 内联样式 + `z-index:2147483000` |
| 点删除没反应 | ArkWeb 吞掉 `window.confirm/prompt` | 全部改自建弹层 |
| 消息正文不显示 | 正文在 `fragments[]`，不是 `content` | 按 fragment 类型拼接 |
| 带附件发送无响应 | 上传后文件仍 `PENDING` 就发送 | 轮询 `/file/status` 到 `SUCCESS` |
| 整块 `renderMarkdown is not defined` | 重写 `ChatDirectory` 时把相邻的渲染器一起覆盖了 | 渲染器已移到 `ChatBoundary` 之前，改动时注意替换区间 |

---

## 6. 待办 / 可以继续做的

1. **桌面版适配**：确认三个槽位在桌面宽度下的落位、`closeDrawerIfOpen` 的等价行为、标题行与 Harness 顶栏对齐；
2. **npm `0.2.1` 待批准**：去 npm 包页面点 Approve，之后 latest 才变 0.2.1（README 的 npm 安装说明随之生效）；
3. 上传预览的多图并排、更大缩略图；文件点击预览（已用 `signed_path` 打开浏览器）；
4. 会话标题行完全并入顶栏（目前是等高对齐）；
5. 可选：把 PoW 结果缓存池化（当前每次发送重算 10–25 秒）；
6. 可选：多平台 CI（GitHub Actions 跑 `node --check` + 两个 smoke 测试）。

---

## 7. 安全提醒（重要）

本次会话中出现过的凭据都应视为**已泄露**，请在电脑上逐一处理：

- GitHub PAT（`ghp_…`）→ GitHub Settings → Developer settings → Tokens 撤销；
- npm 令牌（`npm_…`，两个）→ <https://www.npmjs.com/settings/qiumuhan/tokens> 撤销；
- npm 账号密码、邮箱账号密码 → 改密；
- chat.deepseek.com 的 `userToken` 存在于 `$DSH_HOME/chat-switch/state.json`（0600），不要把该文件带进任何仓库。

---

## 8. 常用命令

```sh
# 本地检查
node --check lib/index.js && node --check lib/client.js
node src/smoke-client.mjs

# 发版（会走 npm 暂存审批）
#   1) 改 package.json version
#   2) 打包 + PUT 见 .tmp/publish.py（未入库，可自行实现：npm publish）

# 装到端侧
sh install.sh
```

仓库：<https://github.com/Muhan-Q/dsh-chat-switch> · npm：<https://www.npmjs.com/package/dsh-chat-switch>
