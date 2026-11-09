/**
 * Host routes 单测（v0.2 / issue #39）。
 *
 * 用假 connection 捕获注册的 route，再直接调用 route.fetch(Request) 验证
 * 契约、状态码与统一错误形状。鉴权由 Connection 栅栏负责，不在本层测试。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  API_PREFIX,
  ROUTES,
  registerEmotionRoutes,
  type ConnectionLike,
  type EmotionRoutesService,
} from '../src/models/routes.ts'
import { ModelServiceError, type ModelStatePayload } from '../src/models/service.ts'
import { MODEL_PRESET_IDS } from '../src/models/registry.ts'

interface CapturedRoute {
  path: string
  methods: readonly string[]
  requestBody: 'buffered' | 'streaming'
  fetch: (request: Request) => Promise<Response>
}

function fakeConnection(): { connection: ConnectionLike; routes: CapturedRoute[] } {
  const routes: CapturedRoute[] = []
  return {
    routes,
    connection: {
      fetch: {
        register(route) {
          routes.push({ ...route, methods: [...route.methods] })
          return () => undefined
        },
      },
    },
  }
}

const STATE: ModelStatePayload = {
  activeModelId: 'horizon-small',
  fallbackActive: true,
  hasUsableModel: true,
  effectiveModelId: 'legacy-tabularisai',
  effectiveFallback: true,
  runtimeError: null,
  provider: { type: 'local' },
  providerStatus: { ready: true, error: null },
  models: [
    {
      id: 'horizon-small',
      name: 'Horizon small',
      repo: 'Horizon-Labs/multilingual-emotions-small',
      license: 'Apache-2.0',
      sizeBytes: 268449278,
      languages: ['en'],
      labels: ['joy'],
      mappingProfile: 'go-emotions-28',
      downloaded: false,
      downloading: false,
      progress: { receivedBytes: 0, totalBytes: 0, percent: 0 },
      error: null,
      errorCode: null,
      needsExport: false,
      manual: false,
      experimental: false,
      installPath: null,
      default: true,
      recommended: false,
    },
  ],
}

function stubService(): {
  service: EmotionRoutesService
  calls: { method: string; value?: string }[]
} {
  const calls: { method: string; value?: string }[] = []
  return {
    calls,
    service: {
      async getState() {
        calls.push({ method: 'getState' })
        return STATE
      },
      async selectModel(id: string) {
        calls.push({ method: 'selectModel', value: id })
        return STATE
      },
      async downloadModel(id: string) {
        calls.push({ method: 'downloadModel', value: id })
        return STATE
      },
      async deleteModel(id: string) {
        calls.push({ method: 'deleteModel', value: id })
        if (id === 'legacy-tabularisai') throw new ModelServiceError('legacy_protected', 'legacy 不允许删除', 400)
        return STATE
      },
      async selectProvider(provider) {
        calls.push({ method: 'selectProvider', value: provider.type })
        return STATE
      },
      async testModel(text: string) {
        calls.push({ method: 'testModel', value: text })
        return { scores: { pleasant: 0.6 }, modelId: 'horizon-small', latencyMs: 12 }
      },
    },
  }
}

function setup(): {
  routes: CapturedRoute[]
  calls: { method: string; value?: string }[]
} {
  const { connection, routes } = fakeConnection()
  const { service, calls } = stubService()
  registerEmotionRoutes(connection, service)
  return { routes, calls }
}

function routeOf(routes: CapturedRoute[], path: string, method: string): CapturedRoute {
  const route = routes.find((candidate) => candidate.path === path && candidate.methods.includes(method))
  assert.ok(route, `route not found: ${method} ${path}`)
  return route
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('注册全部路由：5 个 API + 4 个按预设预注册的 DELETE', () => {
  const { routes } = setup()
  assert.equal(routes.length, 9)
  assert.deepEqual(
    routes.filter((route) => route.methods.includes('GET')).map((route) => route.path),
    [ROUTES.state],
  )
  assert.ok(routeOf(routes, ROUTES.select, 'POST'))
  assert.ok(routeOf(routes, ROUTES.download, 'POST'))
  assert.ok(routeOf(routes, ROUTES.provider, 'POST'))
  assert.ok(routeOf(routes, ROUTES.test, 'POST'))
  for (const id of MODEL_PRESET_IDS) {
    const route = routeOf(routes, `${API_PREFIX}/model/${id}`, 'DELETE')
    assert.deepEqual(route.methods, ['DELETE'])
    assert.equal(route.requestBody, 'buffered')
  }
})

test('GET state → 200 JSON', async () => {
  const { routes } = setup()
  const response = await routeOf(routes, ROUTES.state, 'GET').fetch(new Request(`http://localhost${ROUTES.state}`))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type')?.includes('application/json'), true)
  assert.deepEqual(await response.json(), STATE)
})

test('POST select：合法 id → 200；坏 JSON / 缺字段 → 400 invalid_body', async () => {
  const { routes, calls } = setup()
  const route = routeOf(routes, ROUTES.select, 'POST')
  const ok = await route.fetch(postJson(ROUTES.select, { id: 'horizon-base' }))
  assert.equal(ok.status, 200)
  assert.deepEqual(calls.find((call) => call.method === 'selectModel'), { method: 'selectModel', value: 'horizon-base' })

  const badJson = await route.fetch(
    new Request(`http://localhost${ROUTES.select}`, { method: 'POST', body: '{oops' }),
  )
  assert.equal(badJson.status, 400)
  assert.deepEqual(await badJson.json(), { error: { code: 'invalid_body', message: '请求体必须是合法 JSON' } })

  const missing = await route.fetch(postJson(ROUTES.select, {}))
  assert.equal(missing.status, 400)
  const missingBody = (await missing.json()) as { error: { code: string } }
  assert.equal(missingBody.error.code, 'invalid_body')

  const tooLong = await route.fetch(postJson(ROUTES.select, { id: 'x'.repeat(201) }))
  assert.equal(tooLong.status, 400)
})

test('POST download：立即返回 202；service 抛 needs_export → 409', async () => {
  const { routes, calls } = setup()
  const route = routeOf(routes, ROUTES.download, 'POST')
  const ok = await route.fetch(postJson(ROUTES.download, { id: 'horizon-small' }))
  assert.equal(ok.status, 202)
  assert.deepEqual(calls.find((call) => call.method === 'downloadModel'), { method: 'downloadModel', value: 'horizon-small' })
})

test('POST download / select 上的 ModelServiceError 映射为错误形状', async () => {
  const service: EmotionRoutesService = {
    async getState() {
      return STATE
    },
    async selectModel() {
      throw new ModelServiceError('not_downloaded', '尚未下载', 409)
    },
    async downloadModel() {
      throw new ModelServiceError('needs_export', '需要导出', 409)
    },
    async deleteModel() {
      return STATE
    },
    async selectProvider() {
      return STATE
    },
    async testModel() {
      return { scores: {}, modelId: 'x', latencyMs: 0 }
    },
  }
  const { connection, routes } = fakeConnection()
  registerEmotionRoutes(connection, service)
  const select = await routeOf(routes, ROUTES.select, 'POST').fetch(postJson(ROUTES.select, { id: 'horizon-base' }))
  assert.equal(select.status, 409)
  assert.deepEqual(await select.json(), { error: { code: 'not_downloaded', message: '尚未下载' } })

  const download = await routeOf(routes, ROUTES.download, 'POST').fetch(postJson(ROUTES.download, { id: 'horizon-small' }))
  assert.equal(download.status, 409)
  assert.deepEqual(await download.json(), { error: { code: 'needs_export', message: '需要导出' } })
})

test('POST test：合法文本 → 200；空文本 → 400', async () => {
  const { routes, calls } = setup()
  const route = routeOf(routes, ROUTES.test, 'POST')
  const ok = await route.fetch(postJson(ROUTES.test, { text: '今天真开心' }))
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { scores: { pleasant: 0.6 }, modelId: 'horizon-small', latencyMs: 12 })
  assert.deepEqual(calls.find((call) => call.method === 'testModel'), { method: 'testModel', value: '今天真开心' })

  const empty = await route.fetch(postJson(ROUTES.test, { text: '   ' }))
  assert.equal(empty.status, 400)
  const body = (await empty.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_body')
})

test('DELETE model/{id}：按预设路径删除；legacy 返回 400', async () => {
  const { routes, calls } = setup()
  const horizon = await routeOf(routes, `${API_PREFIX}/model/horizon-small`, 'DELETE').fetch(
    new Request(`http://localhost${API_PREFIX}/model/horizon-small`, { method: 'DELETE' }),
  )
  assert.equal(horizon.status, 200)
  assert.deepEqual(calls.find((call) => call.method === 'deleteModel'), { method: 'deleteModel', value: 'horizon-small' })

  const legacy = await routeOf(routes, `${API_PREFIX}/model/legacy-tabularisai`, 'DELETE').fetch(
    new Request(`http://localhost${API_PREFIX}/model/legacy-tabularisai`, { method: 'DELETE' }),
  )
  assert.equal(legacy.status, 400)
  assert.deepEqual(await legacy.json(), { error: { code: 'legacy_protected', message: 'legacy 不允许删除' } })
})


test('POST provider：local / api / 非法 type', async () => {
  const { routes, calls } = setup()
  const route = routeOf(routes, ROUTES.provider, 'POST')

  const local = await route.fetch(postJson(ROUTES.provider, { type: 'local' }))
  assert.equal(local.status, 200)
  assert.deepEqual(calls.find((call) => call.method === 'selectProvider'), { method: 'selectProvider', value: 'local' })

  const api = await route.fetch(
    postJson(ROUTES.provider, { type: 'api', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini', apiKeyEnv: 'EMO_KEY', timeoutMs: 3000 }),
  )
  assert.equal(api.status, 200)
  assert.deepEqual(calls.filter((call) => call.method === 'selectProvider').at(-1), { method: 'selectProvider', value: 'api' })

  const bad = await route.fetch(postJson(ROUTES.provider, { type: 'nope' }))
  assert.equal(bad.status, 400)
  const body = (await bad.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_body')
})
