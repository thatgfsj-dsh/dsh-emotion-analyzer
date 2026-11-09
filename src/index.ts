/**
 * dsh-emotion-analyzer — Host entry（v0.2）。
 *
 * Flow (DSH 0.2.2-rc.1 calibrated):
 *   agent/turn-stopping { agent, turn, signal }   (serial)
 *     -> last assistant text
 *     -> EmotionModelService.score(text)           (active model, lazy ONNX)
 *     -> appendPluginRecord(plugin:emotion-analyzer/turn, v2 record)
 *     -> the `emotion` session projection folds the record with its profile
 *     -> wire view reaches the browser, which renders the floating widget.
 *
 * v0.2 (#39): 模型由 `src/models/*` 管理（registry / download / settings /
 * profiles），默认 horizon-small，未下载时回退 legacy assets；切换模型后
 * 下一轮生效；Host routes 挂在 `/api/emotion-analyzer/v1/*`。
 *
 * 0.2.2 适配（#70）：`appendPluginRecord` 必须来自**宿主那一份**
 * `@deepseek-ai/dsh-session`（品牌检查），因此写入走
 * `src/host-modules.ts` 的惰性宿主解析，本地副本只作为开发/单测兜底。
 */
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { EMOTION_RECORD_TYPE, registerEmotionProjection } from './projection.ts'
import { loadHostSessionModule, type HostModuleLogger } from './host-modules.ts'
import { EmotionModelService, type ScoreResult } from './models/service.ts'
import { registerEmotionRoutes, type ConnectionLike } from './models/routes.ts'
import { detectDoubt, detectLanguage, extractLastAssistantText, hashText, truncateForScoring } from './text.ts'
import type { EmotionTurnRecord } from './types.ts'

/** Plugin name (also the profile row id). */
export const name = 'dsh-emotion-analyzer'

/** The projection registry must exist before apply runs. */
export const inject = ['sessionProjections']

/** 冷启动 / 模型加载预算（第一次 turn 不占用单条推理预算，#61）。 */
export const INIT_TIMEOUT_MS = 10_000

/** 单条推理预算：模型已就绪后最多等 1.5s。 */
export const SCORE_TIMEOUT_MS = 1500

/** Minimal logger surface (Cordis provides `ctx.logger(name)`). */
interface HostLogger {
  debug?: (...args: unknown[]) => void
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

/** Structural slice of the Cordis context used by this plugin. */
interface HostContext {
  logger?: unknown
  effect?: (fn: () => (() => void) | void) => unknown
  on?: (event: string, listener: (payload: TurnStoppingPayload) => unknown) => unknown
  sessionProjections?: unknown
  /** Cordis 的惰性服务注入（可选服务用 inject 回调，不会阻塞插件加载）。 */
  inject?: (names: string[], callback: (ctx: HostContext) => void) => unknown
  connection?: ConnectionLike
}

interface TurnStoppingPayload {
  agent?: {
    session?: {
      id?: string
      deriveMessages?: () => readonly unknown[]
    }
  }
  turn?: number
}

/** Resolve a named logger without assuming it exists in every host build. */
function loggerOf(ctx: HostContext): HostLogger {
  try {
    const factory = ctx.logger as ((name: string) => HostLogger) | undefined
    if (typeof factory === 'function') return factory.call(ctx, name)
  } catch {
    // fall through to console
  }
  return console
}

/** Reject with a timeout so scoring can never hold the turn boundary forever. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** runEmotionTurn 需要的最小 service 契约（测试可注入 fake）。 */
export interface TurnServiceLike {
  ensureReady(): Promise<boolean>
  score(text: string): Promise<ScoreResult | undefined>
}

/** 追加 plugin record 的写入面：同步或异步均可（宿主解析是异步的）。 */
export type AppendRecordFn = (
  session: unknown,
  type: string,
  data: Record<string, unknown>,
) => unknown | Promise<unknown>

/** 一轮 turn 的依赖注入（#61 / #66 测试入口）。 */
export interface TurnDeps {
  readonly service: TurnServiceLike
  readonly appendRecord: AppendRecordFn
  readonly log: HostLogger
  readonly initTimeoutMs?: number
  readonly scoreTimeoutMs?: number
}

/**
 * 处理一次 `agent/turn-stopping`：提取最后一条 assistant 文本、等模型就绪、
 * 打分、追加 v2 plugin record。
 *
 * 冷启动（首次 init）走 INIT_TIMEOUT_MS；只有推理本身受 SCORE_TIMEOUT_MS 限制。
 *
 * @param payload - turn-stopping payload。
 * @param deps - service / append / logger（测试注入）。
 * @returns 是否成功追加了 plugin record。
 */
export async function runEmotionTurn(payload: TurnStoppingPayload, deps: TurnDeps): Promise<boolean> {
  const session = payload.agent?.session
  const turn = payload.turn
  if (session === undefined || typeof session.deriveMessages !== 'function' || typeof turn !== 'number') {
    return false
  }

  const text = extractLastAssistantText(session.deriveMessages())
  if (text.length === 0) return false

  const initTimeoutMs = deps.initTimeoutMs ?? INIT_TIMEOUT_MS
  const scoreTimeoutMs = deps.scoreTimeoutMs ?? SCORE_TIMEOUT_MS

  // 首次冷启动可能加载 200–270MB ONNX（实测 2.4s），不能算进 1.5s 单条预算。
  let ready = false
  try {
    ready = await withTimeout(deps.service.ensureReady(), initTimeoutMs, 'emotion init')
  } catch (error) {
    deps.log.error?.('[emotion-analyzer] model init failed:', error)
    return false
  }
  if (!ready) {
    deps.log.warn?.('[emotion-analyzer] model unavailable; turn left untouched')
    return false
  }

  let result: ScoreResult | undefined
  try {
    result = await withTimeout(
      deps.service.score(truncateForScoring(text)),
      scoreTimeoutMs,
      'emotion scoring',
    )
  } catch (error) {
    deps.log.warn?.('[emotion-analyzer] scoring failed or timed out:', error)
    return false
  }
  if (result === undefined) {
    deps.log.warn?.('[emotion-analyzer] empty score; turn left untouched')
    return false
  }

  // 宿主文本启发式：中文疑问句模型常不响应，`doubt` 与模型标签一起进入映射。
  const doubt = detectDoubt(text)
  const raw: Record<string, number> = doubt > 0 ? { ...result.raw, doubt } : result.raw

  const record: EmotionTurnRecord = {
    version: 2,
    turn,
    raw,
    modelId: result.modelId,
    profileId: result.profileId,
    latencyMs: result.latencyMs,
    language: detectLanguage(text),
    textHash: hashText(text),
    chars: text.length,
    timestamp: Date.now(),
  }

  try {
    await deps.appendRecord(session, EMOTION_RECORD_TYPE, record as unknown as Record<string, unknown>)
  } catch (error) {
    deps.log.error?.('[emotion-analyzer] append plugin record failed:', error)
    return false
  }
  deps.log.debug?.(`[emotion-analyzer] turn ${turn} scored by ${result.modelId} in ${result.latencyMs}ms`)
  return true
}

/**
 * 惰性 append：优先使用宿主那一份 `@deepseek-ai/dsh-session`（品牌检查要求与
 * 宿主共享实例），解析失败时回退插件本地副本（开发 / 单测；真实宿主下跨实例
 * 调用会抛 TypeError，由 runEmotionTurn 捕获并降级）。
 *
 * @param log - 宿主日志。
 * @returns 同步或异步追加函数（此处恒为异步）。
 */
export function createAppendRecord(log: HostLogger): AppendRecordFn {
  return async (session, type, data) => {
    const host = await loadHostSessionModule(log as HostModuleLogger)
    if (host !== undefined) {
      return host.appendPluginRecord(session, type as `plugin:${string}`, data)
    }
    return appendPluginRecord(
      session as Parameters<typeof appendPluginRecord>[0],
      type as Parameters<typeof appendPluginRecord>[1],
      data,
    )
  }
}

/** apply 的测试注入点（真实宿主不传）。 */
export interface ApplyOverrides {
  readonly service?: EmotionModelService
  readonly appendRecord?: AppendRecordFn
}

/** One-instance lifecycle shared by every turn. */
interface Runtime {
  service: EmotionModelService
  chains: Map<string, Promise<void>>
}

/**
 * Plugin entry.
 *
 * 0.2.2 起 `sessionProjections.register()` 返回 Promise，契约要求注册完成后再
 * 发布消费者，因此 apply 是 async 并 await 注册（Cordis 会 await 插件 apply）。
 *
 * @param ctx - Cordis host context。
 * @param overrides - 测试注入点。
 */
export async function apply(ctx: HostContext, overrides: ApplyOverrides = {}): Promise<void> {
  const log = loggerOf(ctx)
  const service =
    overrides.service ??
    new EmotionModelService({
      logger: log as Pick<Console, 'warn' | 'error'>,
    })
  const appendRecord = overrides.appendRecord ?? createAppendRecord(log)
  const runtime: Runtime = { service, chains: new Map<string, Promise<void>>() }

  const registry = ctx.sessionProjections
  if (registry === undefined || registry === null) {
    log.warn?.('[emotion-analyzer] sessionProjections service missing; emotion state will not persist')
    return
  }
  await registerEmotionProjection(
    registry as Parameters<typeof registerEmotionProjection>[0],
    pluginRecordOf as unknown as (event: unknown) => { type: string; data: unknown } | undefined,
  )

  // Model management API（鉴权由 Connection 的 exact route 栅栏负责）。
  // `connection` 是可选的 Web 服务：用 ctx.inject 惰性绑定，CLI/headless 下
  // 即使没有 Connection 也不影响 turn-stopping 打分。
  const registerRoutes = (connection: ConnectionLike): void => {
    try {
      registerEmotionRoutes(connection, service)
    } catch (error) {
      log.error?.('[emotion-analyzer] model routes registration failed:', error)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (connectionCtx) => {
      if (connectionCtx.connection !== undefined) registerRoutes(connectionCtx.connection)
    })
  } else if (ctx.connection !== undefined && typeof ctx.connection.fetch?.register === 'function') {
    registerRoutes(ctx.connection)
  } else {
    log.debug?.('[emotion-analyzer] connection service missing; model API routes disabled')
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void runtime.service.dispose()
      runtime.chains.clear()
    })
  }

  const handleTurn = (payload: TurnStoppingPayload): Promise<boolean> =>
    runEmotionTurn(payload, {
      service: runtime.service,
      appendRecord,
      log,
    })

  if (typeof ctx.on !== 'function') {
    log.warn?.('[emotion-analyzer] ctx.on missing; turn-stopping hook not installed')
    return
  }

  ctx.on('agent/turn-stopping', (payload: TurnStoppingPayload) => {
    const sessionId = payload.agent?.session?.id ?? 'unknown'
    const previous = runtime.chains.get(sessionId) ?? Promise.resolve()
    const next = previous
      .then(() => handleTurn(payload))
      .then(() => undefined)
      .catch((error: unknown) => {
        log.error?.('[emotion-analyzer] turn hook failed:', error)
      })
      .finally(() => {
        if (runtime.chains.get(sessionId) === next) runtime.chains.delete(sessionId)
      })
    runtime.chains.set(sessionId, next)
    return next
  })
}
