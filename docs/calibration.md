# DSH 宿主 API 校准（本机 0.2.2-rc.1）

提示词里的 `turn-stopping`、`ctx.session.projection`、`ev.getLastMessage()` 是示意写法；以下是本机安装包的**真实签名**（证据文件路径以 `$DSH/node_modules/@deepseek-ai/` 为根；0.2.2-rc.1 于 2026-11-10 复测）。

| 提示词写法 | 实际 API | 证据 |
|---|---|---|
| `turn-stopping` | `agent/turn-stopping`，payload `{ agent, turn, signal }`，`serial` | `dsh-agent/lib/types/runtime-types.d.ts` |
| `ctx.session.projection.emotion` | `ctx.sessionProjections.register({ key, stateSchema, init, apply, wire, stateVersion })`；**0.2.2 起返回 Promise，调用方必须 await** | `dsh-session-projection/lib/types/index.d.ts`、`lib/index.js`（`register()` 返回 thenable handle） |
| `ev.getLastMessage()` | `event.agent.session.deriveMessages()` 取最后一条 assistant 消息 | `dsh-agent/lib/types/runtime-types.d.ts`（runtime `Agent.session`） |
| 新增事件类型 | `appendPluginRecord(session, 'plugin:<name>/<action>', data)`（`ignorable`，插件记录）；**内部用 `session.#appendRecord()` 做品牌检查，必须传宿主模块实例创建的 Session** | `dsh-session/lib/types/index.d.ts`、`lib/index.js`（`commitPluginRecord = (session, ...) => session.#appendRecord(...)`） |
| 前端 `document.body.appendChild` | 注册 `shell.overlay`（root list slot），React portal 到 `document.body`；现有插件采用同一模式 | `dsh-client-ui-layout/lib/types/client/index.d.ts` |
| 前端事件总线 | session 标准 prop `useProjection('emotion')`（session 作用域），全局 `useSessions` | `dsh-client-ui-session/lib/types/client/index.d.ts` |
| Host HTTP 路由 | `ctx.connection.fetch.register({ path: '/api/<feature>', methods, requestBody: 'buffered', fetch })`；exact pathname 匹配、不支持 `:id` 参数；鉴权由 Connection 栅栏完成（非 owner → 403） | `dsh-client-connection/lib/types/rpc.d.ts`（0.2.1-rc.2 校准；0.2.2-rc.1 未逐字段复测） |
| 可选访问 connection 服务 | `ctx.inject(['connection'], cb)` 惰性回调；不要把它放进插件 `inject` 数组，否则 CLI/headless 无 Connection 时整个插件不加载 | `dsh-client-connection/lib/index.js` |
| 设置与模型目录 | 无宿主设置 API；插件自管 `$DSH_HOME/emotion-analyzer/config.json` 与 `models/<id>/` | `docs/models.md`；Node 进程的 `process.env.DSH_HOME` |

## 第三方插件的宿主模块解析（0.2.2 实测，阻断级）

**问题**：插件以 `link:` 装进 profile 时，Node 从插件真实路径解析 `@deepseek-ai/dsh-session`，会命中**插件自己的 `node_modules` 副本**（npm 为 `peerDependencies` 自动安装的那份），而宿主的 Session 由 dsh 安装里的那一份创建。`appendPluginRecord` 用私有字段做品牌检查，跨副本调用直接抛：

```
TypeError: Receiver must be an instance of class Session
```

**实测证据**（2026-11-10，DSH 0.2.2-rc.1）：

- 探针插件（`dsh --profile web --patch <overlay> --help`）打印 `import.meta.resolve('@deepseek-ai/dsh-session')` → `.../AIagent/dsh-emotion-analyzer/node_modules/@deepseek-ai/dsh-session/lib/index.js`（插件本地副本），不是宿主安装里的那一份。
- 用宿主 `Session.create()` 造 session，再调用本地副本的 `appendPluginRecord` → `TypeError: Receiver must be an instance of class Session`。
- 用 `realpath(process.argv[1])`（dsh bin）→ `createRequire` → `require.resolve('@deepseek-ai/dsh-session')` 解析到 `~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/...`（宿主副本），同一调用成功 append。

**本插件方案**（`src/host-modules.ts`）：`appendPluginRecord` 走惰性宿主解析——优先运行中的 dsh 安装（`process.argv[1]` 锚点），失败才回退本地副本（开发/单测）；解析结果缓存。只读的 `pluginRecordOf` 不涉及品牌检查，仍用静态 import。

## 0.2.2 与本插件相关的其它变化

| 主题 | 0.2.2 行为 | 对本插件影响 |
|---|---|---|
| session projection | `register()` 返回 Promise；帧形状改为每事件一帧含 `changes`；`snapshot()` 只算请求单元；`cachedSnapshot` 弃用 | `apply` 改为 async 并 await 注册；unit 定义（`init/apply/wire/stateVersion`）不变 |
| 客户端资源 | 活动客户端包走带内容修订的 `./assets/*` 导出 | 本插件没有包内静态资源，仍用 `exports["./client"]`，无需改动 |
| `dsh.bundle` | 新增 `platforms` / `listedByDefault`（可选） | 未使用；缺省不限制平台 |
| 补丁/Include 写入 | `EntryTree.write()` 移除、运行期自我修改不跨重启保留 | 本插件不写 patch，无影响 |
| 文件工具策略 | 与插件无关 | — |

## 说明

- projection 的 `apply` **必须同步且纯**，因此推理结果不能直接在 fold 里跑模型：改为先把每轮分数写入 `plugin:` 记录，再让 projection 纯 fold 该记录。这样自然满足"重启恢复"。
- 不使用 `Session.append()` 自定义新事件类型（`Session.append` 写不出 `ignorable: true`，会让会话打不开）。
- 客户端不 `require` 任何 `@deepseek-ai/dsh-client-*` 运行时；只使用 `react`/`react-dom` 平台种子与 `ctx.slots` 服务。
- **原生模块必须惰性加载**：`onnxruntime-node` 的 InferenceSession 会持有工作线程，插件激活时就加载模型会让 CLI `dsh --help` / 一次性 headless 进程无法退出。这里改到第一次 `agent/turn-stopping` 才 `init()`（仍为单例）。
- **DELETE 路由风险**：`ConnectionFetchMethod` 类型只声明 `GET | HEAD | POST`；v0.2 的 `DELETE /model/{id}` 按契约注册（运行时只校验 path/method 唯一性），但尚未在真实 DSH 网页验证 HTTP 桥是否放行 DELETE。若被拒，需要改为 POST 变体（记录在 `docs/models.md` §8）。
