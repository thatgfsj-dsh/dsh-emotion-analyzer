/**
 * Host routes：`/api/emotion-analyzer/v1/*`（v0.2 / issue #39）。
 *
 * 路由通过 `ctx.connection.fetch.register` 注册在 Connection 的鉴权栅栏内
 * （Host 只把 owner Peer 的请求交给 exact route，其他 principal 直接 403），
 * 因此这里不再重复鉴权。
 *
 * 契约：
 *   GET    /api/emotion-analyzer/v1/state              → ModelStatePayload
 *   POST   /api/emotion-analyzer/v1/model/select       { id } → ModelStatePayload
 *   POST   /api/emotion-analyzer/v1/model/download     { id } → ModelStatePayload（202，立即返回）
 *   DELETE /api/emotion-analyzer/v1/model/{id}         → ModelStatePayload
 *   POST   /api/emotion-analyzer/v1/provider           { type:'local' } | { type:'api', ... } → ModelStatePayload
 *   POST   /api/emotion-analyzer/v1/test               { text } → { scores, modelId, latencyMs }
 *
 * 错误统一为 `{ error: { code, message } }`。
 *
 * 注意：Connection 的 exact Fetch route 以完整 pathname 匹配，不支持路径参数，
 * 因此 DELETE 按预设 id 预注册 4 条路由（v0.2 预设固定）。
 */
import { MODEL_PRESET_IDS } from './registry.ts'
import { ModelServiceError, type ModelStatePayload, type TestResult } from './service.ts'
import type { ProviderSettings } from '../settings.ts'

/** 所有路由的公共前缀。 */
export const API_PREFIX = '/api/emotion-analyzer/v1'

/** API 路径常量。 */
export const ROUTES = {
  state: `${API_PREFIX}/state`,
  select: `${API_PREFIX}/model/select`,
  download: `${API_PREFIX}/model/download`,
  provider: `${API_PREFIX}/provider`,
  test: `${API_PREFIX}/test`,
  model: (id: string): string => `${API_PREFIX}/model/${encodeURIComponent(id)}`,
} as const

/** Host `ctx.connection.fetch` 的最小结构契约。 */
export interface ConnectionFetchLike {
  register(route: {
    readonly path: string
    readonly methods: readonly string[]
    readonly requestBody: 'buffered' | 'streaming'
    readonly fetch: (request: Request) => Promise<Response>
  }): () => Promise<void> | void
}

/** Host `ctx.connection` 的最小结构契约。 */
export interface ConnectionLike {
  readonly fetch: ConnectionFetchLike
}

/** routes 需要的 service 子集（测试可注入假实现）。 */
export interface EmotionRoutesService {
  getState(): Promise<ModelStatePayload>
  selectModel(id: string): Promise<ModelStatePayload>
  downloadModel(id: string): Promise<ModelStatePayload>
  deleteModel(id: string): Promise<ModelStatePayload>
  selectProvider(provider: ProviderSettings): Promise<ModelStatePayload>
  testModel(text: string): Promise<TestResult>
}

/** 路由层错误。 */
export class RouteError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'RouteError'
    this.code = code
    this.status = status
  }
}

/** 返回 JSON 响应。 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** 统一错误响应。 */
function errorResponse(error: unknown): Response {
  if (error instanceof RouteError) {
    return json({ error: { code: error.code, message: error.message } }, error.status)
  }
  if (error instanceof ModelServiceError) {
    return json({ error: { code: error.code, message: error.message } }, error.status)
  }
  const message = error instanceof Error ? error.message : String(error)
  return json({ error: { code: 'internal', message } }, 500)
}

/** 读取并校验 JSON body。 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new RouteError('invalid_body', '请求体必须是合法 JSON', 400)
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RouteError('invalid_body', '请求体必须是 JSON 对象', 400)
  }
  return body as Record<string, unknown>
}

/** 从 body 取必填字符串字段。 */
function requireString(body: Record<string, unknown>, key: string, maxLength: number): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RouteError('invalid_body', `缺少字符串字段 ${key}`, 400)
  }
  if (value.length > maxLength) {
    throw new RouteError('invalid_body', `字段 ${key} 超过最大长度 ${maxLength}`, 400)
  }
  return value
}

/** test 接口允许的最大文本长度（字符，tokenizer 仍会截断到 512 token）。 */
const MAX_TEST_TEXT_CHARS = 20_000

/**
 * 注册全部模型 API 路由。
 * @param connection - `ctx.connection`。
 * @param service - 模型运行时服务。
 * @returns 每个 route 的 disposer（注册在 calling fiber 上，通常无需手动调用）。
 */
export function registerEmotionRoutes(
  connection: ConnectionLike,
  service: EmotionRoutesService,
): Array<() => Promise<void> | void> {
  const disposers: Array<() => Promise<void> | void> = []
  const register = (
    path: string,
    methods: readonly string[],
    fetch: (request: Request) => Promise<Response>,
  ): void => {
    disposers.push(connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }))
  }

  register(ROUTES.state, ['GET'], async () => {
    try {
      return json(await service.getState())
    } catch (error) {
      return errorResponse(error)
    }
  })

  register(ROUTES.select, ['POST'], async (request) => {
    try {
      const body = await readJsonBody(request)
      const id = requireString(body, 'id', 200)
      return json(await service.selectModel(id))
    } catch (error) {
      return errorResponse(error)
    }
  })

  register(ROUTES.download, ['POST'], async (request) => {
    try {
      const body = await readJsonBody(request)
      const id = requireString(body, 'id', 200)
      // 下载在后台进行，立即返回 202 + 当前 state；客户端轮询 GET state。
      return json(await service.downloadModel(id), 202)
    } catch (error) {
      return errorResponse(error)
    }
  })

  register(ROUTES.provider, ['POST'], async (request) => {
    try {
      const body = await readJsonBody(request)
      const type = body['type']
      if (type !== 'local' && type !== 'api') {
        throw new RouteError('invalid_body', "type 必须是 'local' 或 'api'", 400)
      }
      if (type === 'local') {
        return json(await service.selectProvider({ type: 'local' }))
      }
      const provider: ProviderSettings = {
        type: 'api',
        baseUrl: typeof body['baseUrl'] === 'string' ? body['baseUrl'] : '',
        model: typeof body['model'] === 'string' ? body['model'] : '',
        ...(typeof body['apiKeyEnv'] === 'string' ? { apiKeyEnv: body['apiKeyEnv'] } : {}),
        ...(typeof body['timeoutMs'] === 'number' ? { timeoutMs: body['timeoutMs'] } : {}),
      }
      return json(await service.selectProvider(provider))
    } catch (error) {
      return errorResponse(error)
    }
  })

  register(ROUTES.test, ['POST'], async (request) => {
    try {
      const body = await readJsonBody(request)
      const text = requireString(body, 'text', MAX_TEST_TEXT_CHARS)
      return json(await service.testModel(text))
    } catch (error) {
      return errorResponse(error)
    }
  })

  for (const id of MODEL_PRESET_IDS) {
    register(ROUTES.model(id), ['DELETE'], async () => {
      try {
        return json(await service.deleteModel(id))
      } catch (error) {
        return errorResponse(error)
      }
    })
  }

  return disposers
}
