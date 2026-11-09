/**
 * 模型运行时服务单测（v0.2 / issue #39）。
 *
 * 用假 manager + 假 scorer 验证：默认回退 legacy、切换、删除、needsExport、
 * state payload 形状，以及“下一轮生效”的 scorer 重建行为。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { EmotionModelService, ModelServiceError } from '../src/models/service.ts'
import type { ApiScorer } from '../src/models/api-scorer.ts'
import { ModelManagerError, type ModelStatus } from '../src/models/manager.ts'
import { MODEL_PRESETS, getModelPreset } from '../src/models/registry.ts'
import type { ModelManager } from '../src/models/manager.ts'
import type { EmotionScorer, EmotionScorerOptions } from '../src/inference.ts'
import type { PluginSettings } from '../src/settings.ts'

/** 假 manager：只实现 service 用到的接口。 */
class FakeManager {
  readonly downloaded = new Set<string>()
  readonly integrityErrors = new Map<string, string>()
  legacy = false
  readonly deleted: string[] = []
  readonly startedDownloads: string[] = []

  async inspectModel(id: string): Promise<{ downloaded: boolean; error?: string; errorCode?: string }> {
    const integrity = this.integrityErrors.get(id)
    if (integrity !== undefined) return { downloaded: false, error: integrity, errorCode: 'size_mismatch' }
    if (id === 'legacy-tabularisai') return { downloaded: this.legacy }
    return { downloaded: this.downloaded.has(id) }
  }

  isDownloaded(id: string): boolean {
    if (id === 'legacy-tabularisai') return this.legacy
    return this.downloaded.has(id)
  }

  legacyAvailable(): boolean {
    return this.legacy
  }

  modelDir(id: string): string {
    return `/tmp/fake-models/${id}`
  }

  async listStatuses(): Promise<ModelStatus[]> {
    return Promise.all(
      MODEL_PRESETS.map(async (preset) => {
        const integrity = await this.inspectModel(preset.id)
        return {
          preset,
          downloaded: integrity.downloaded,
          downloading: false,
          progress: { receivedBytes: 0, totalBytes: preset.sizeBytes, percent: 0 },
          ...(integrity.error === undefined ? {} : { error: integrity.error }),
          ...(integrity.errorCode === undefined ? {} : { errorCode: integrity.errorCode }),
          needsExport: preset.needsExport === true,
        } satisfies ModelStatus
      }),
    )
  }

  startDownload(id: string): void {
    const preset = getModelPreset(id)
    if (preset?.manual === true) throw new ModelManagerError('manual_install', 'manual install')
    if (preset?.needsExport === true) throw new ModelManagerError('needs_export', 'needs export')
    this.startedDownloads.push(id)
    this.downloaded.add(id)
  }

  async deleteModel(id: string): Promise<void> {
    if (id === 'legacy-tabularisai') throw new ModelManagerError('legacy_protected', 'legacy protected')
    this.downloaded.delete(id)
    this.deleted.push(id)
  }
}

/** 假 scorer：按标签数量返回不同 raw，便于断言 profile 选择。 */
class FakeScorer {
  readonly options: EmotionScorerOptions
  disposed = false

  constructor(options: EmotionScorerOptions) {
    this.options = options
  }

  async init(): Promise<boolean> {
    return true
  }

  async score(text: string): Promise<Record<string, number>> {
    if (text === 'fail') return {}
    const labels = this.options.labels ?? []
    if (labels.includes('joy') && labels.length === 28) {
      return { joy: 0.9, sadness: 0.05, neutral: 0.1 }
    }
    return { joy: 0.9, sadness: 0.05, neutral: 0.1 }
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

function setup(options: {
  settings?: Partial<PluginSettings>
  downloaded?: string[]
  legacy?: boolean
  env?: Readonly<Record<string, string | undefined>>
  apiScorerFactory?: () => ApiScorer
} = {}): {
  service: EmotionModelService
  manager: FakeManager
  scorers: FakeScorer[]
  saved: PluginSettings[]
  warnings: string[]
} {
  const manager = new FakeManager()
  manager.legacy = options.legacy ?? true
  for (const id of options.downloaded ?? []) manager.downloaded.add(id)
  const scorers: FakeScorer[] = []
  const saved: PluginSettings[] = []
  const warnings: string[] = []
  let settings: PluginSettings = {
    activeModelId: options.settings?.activeModelId ?? 'horizon-small',
    provider: options.settings?.provider ?? { type: 'local' },
  }
  const service = new EmotionModelService({
    manager: manager as unknown as ModelManager,
    logger: { warn: (message: string) => warnings.push(message), error: () => undefined },
    scorerFactory: (scorerOptions) => {
      const scorer = new FakeScorer(scorerOptions)
      scorers.push(scorer)
      return scorer as unknown as EmotionScorer
    },
    settingsLoader: async () => settings,
    settingsSaver: async (next) => {
      settings = next
      saved.push(next)
    },
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.apiScorerFactory === undefined ? {} : { apiScorerFactory: options.apiScorerFactory }),
  })
  return { service, manager, scorers, saved, warnings }
}

test('默认 horizon-small 未下载 → 回退 legacy assets 并 warning', async () => {
  const { service, warnings } = setup({ legacy: true })
  await service.initialize()
  assert.equal(service.activeRuntime?.preset.id, 'legacy-tabularisai')
  assert.equal(service.activeRuntime?.fallbackActive, true)
  assert.equal(warnings.length, 1)
  const result = await service.score('hello')
  assert.ok(result)
  assert.equal(result.modelId, 'legacy-tabularisai')
  assert.equal(result.profileId, 'legacy-11')
  assert.ok(result.latencyMs >= 0)
})

test('没有任何可用模型 → score undefined、testModel 503', async () => {
  const { service } = setup({ legacy: false })
  await service.initialize()
  assert.equal(service.activeRuntime, undefined)
  assert.equal(await service.score('hello'), undefined)
  await assert.rejects(() => service.testModel('hello'), (error: unknown) => {
    assert.ok(error instanceof ModelServiceError)
    assert.equal(error.code, 'model_unavailable')
    assert.equal(error.status, 503)
    return true
  })
})

test('select 已下载模型 → 写设置、dispose 旧 scorer、下一轮用新 profile', async () => {
  const { service, scorers, saved } = setup({
    settings: { activeModelId: 'legacy-tabularisai' },
    downloaded: ['horizon-small'],
  })
  await service.initialize()
  // 先以 legacy 打一轮，确保旧 scorer 被创建
  const before = await service.score('hello')
  assert.ok(before)
  assert.equal(scorers.length, 1)

  const state = await service.selectModel('horizon-small')
  assert.equal(state.activeModelId, 'horizon-small')
  assert.equal(state.fallbackActive, false)
  assert.equal(saved.length, 1)
  assert.equal(saved[0]?.activeModelId, 'horizon-small')
  assert.equal(scorers[0]?.disposed, true)

  const after = await service.score('hello')
  assert.ok(after)
  assert.equal(after.modelId, 'horizon-small')
  assert.equal(after.profileId, 'go-emotions-28')
  assert.equal(scorers.length, 2)
  // go-emotions 的 raw 用 28 标签，聚合出 pleasant
  assert.ok(after.raw['joy'] !== undefined)
  const tested = await service.testModel('hello')
  assert.equal(tested.modelId, 'horizon-small')
  assert.ok((tested.scores['pleasant'] ?? 0) > 0.5)
})

test('select 未下载 / needsExport / 未知模型分别报错', async () => {
  const { service } = setup({ legacy: true })
  await service.initialize()
  await assert.rejects(() => service.selectModel('horizon-base'), (error: unknown) => {
    assert.ok(error instanceof ModelServiceError)
    assert.equal(error.code, 'not_downloaded')
    assert.equal(error.status, 409)
    return true
  })
  await assert.rejects(() => service.selectModel('zh-johnson-small'), (error: unknown) => {
    assert.ok(error instanceof ModelServiceError)
    assert.equal(error.code, 'manual_install')
    return true
  })
  await assert.rejects(() => service.selectModel('nope'), (error: unknown) => {
    assert.ok(error instanceof ModelServiceError)
    assert.equal(error.code, 'unknown_model')
    assert.equal(error.status, 404)
    return true
  })
})

test('delete：legacy 受保护；删除当前模型后回退 legacy', async () => {
  const { service, manager } = setup({ downloaded: ['horizon-small'] })
  await service.initialize()
  await service.selectModel('horizon-small')
  await assert.rejects(() => service.deleteModel('legacy-tabularisai'), (error: unknown) => {
    assert.ok(error instanceof ModelServiceError)
    assert.equal(error.code, 'legacy_protected')
    return true
  })
  const state = await service.deleteModel('horizon-small')
  assert.equal(manager.deleted.includes('horizon-small'), true)
  assert.equal(service.activeRuntime?.preset.id, 'legacy-tabularisai')
  // 设置仍是 horizon-small，但回退标记为 true
  assert.equal(state.activeModelId, 'horizon-small')
  assert.equal(state.fallbackActive, true)
})

test('download：needsExport / 未知模型错误映射；成功启动下载', async () => {
  const { service, manager } = setup({ legacy: false })
  await service.initialize()
  await assert.rejects(() => service.downloadModel('zh-johnson-small'), (error: unknown) => {
    assert.ok(error instanceof ModelServiceError)
    assert.equal(error.code, 'manual_install')
    assert.equal(error.status, 409)
    return true
  })
  await assert.rejects(() => service.downloadModel('nope'), (error: unknown) => {
    assert.ok(error instanceof ModelServiceError)
    assert.equal(error.code, 'unknown_model')
    return true
  })
  const state = await service.downloadModel('horizon-small')
  assert.equal(manager.downloaded.has('horizon-small'), true)
  const entry = state.models.find((model) => model.id === 'horizon-small')
  assert.ok(entry)
})

test('state payload 形状：4 个模型 + provider + 必需字段', async () => {
  const { service } = setup({ legacy: true, settings: { activeModelId: 'horizon-small', provider: { type: 'local', apiKeyEnv: 'EMO_KEY' } } })
  const state = await service.getState()
  assert.equal(state.activeModelId, 'horizon-small')
  assert.equal(state.fallbackActive, true)
  assert.equal(state.provider.type, 'local')
  assert.equal(state.provider.apiKeyEnv, 'EMO_KEY')
  assert.equal(state.models.length, 4)
  for (const model of state.models) {
    for (const key of ['id', 'name', 'license', 'sizeBytes', 'languages', 'labels', 'downloaded', 'downloading', 'progress', 'error', 'needsExport']) {
      assert.ok(key in model, `state model 缺少字段 ${key}`)
    }
    assert.equal(typeof model.progress.percent, 'number')
  }
  assert.equal(state.models.find((model) => model.id === 'zh-johnson-small')?.manual, true)
})

test('reload 重新读取设置并重建运行时', async () => {
  const { service } = setup({ legacy: true })
  await service.initialize()
  assert.equal(service.settings.activeModelId, 'horizon-small')
  await service.reload()
  assert.equal(service.activeRuntime?.preset.id, 'legacy-tabularisai')
  await service.dispose()
  assert.equal(service.activeRuntime, undefined)
})


/* ------------------------------------------------------------------------- */
/* 自定义 API 通道（#41）                                                     */
/* ------------------------------------------------------------------------- */

const API_PROVIDER = {
  type: 'api' as const,
  baseUrl: 'http://127.0.0.1:1/v1',
  model: 'gpt-test',
}

/** 假 API scorer：成功返回固定 7 维，失败抛错。 */
function fakeApiScorer(impl: { scores?: Record<string, number>; error?: Error } = {}): ApiScorer {
  return {
    async score() {
      if (impl.error !== undefined) throw impl.error
      return {
        scores: impl.scores ?? {
          pleasant: 0.9,
          sad: 0.05,
          angry: 0,
          anxious: 0,
          unwell: 0,
          confused: 0.1,
          neutral: 0.2,
        },
        latencyMs: 7,
        modelId: 'gpt-test',
      }
    },
  } as unknown as ApiScorer
}

test('API provider：没有本地模型也能打分，记录 profile=unified-7', async () => {
  const { service, scorers } = setup({
    legacy: false,
    settings: { provider: API_PROVIDER },
    apiScorerFactory: () => fakeApiScorer(),
  })
  await service.initialize()
  assert.equal(service.activeRuntime, undefined)
  assert.equal(await service.ensureReady(), true)
  const result = await service.score('hello')
  assert.ok(result)
  assert.equal(result.modelId, 'api:gpt-test')
  assert.equal(result.profileId, 'unified-7')
  assert.equal(result.fallbackActive, false)
  assert.equal(result.raw['pleasant'], 0.9)
  assert.equal(result.raw['neutral'], 0.2)
  assert.equal(scorers.length, 0, 'API 通道不应创建本地 scorer')
  const state = await service.getState()
  assert.equal(state.provider.type, 'api')
  assert.equal(state.providerStatus.ready, true)
  assert.equal(state.providerStatus.error, null)
})

test('API provider：失败时回退本地并标记 fallbackActive', async () => {
  const { service } = setup({
    legacy: true,
    settings: { provider: API_PROVIDER },
    apiScorerFactory: () => fakeApiScorer({ error: new Error('boom') }),
  })
  await service.initialize()
  const result = await service.score('hello')
  assert.ok(result)
  assert.equal(result.modelId, 'legacy-tabularisai')
  assert.equal(result.fallbackActive, true)
  const state = await service.getState()
  assert.equal(state.providerStatus.ready, false)
  assert.match(String(state.providerStatus.error), /boom/u)
})

test('API provider：缺少 apiKeyEnv 环境变量 → 未就绪并回退本地', async () => {
  const { service, warnings } = setup({
    legacy: true,
    env: {},
    settings: { provider: { ...API_PROVIDER, apiKeyEnv: 'EMO_MISSING_KEY' } },
    apiScorerFactory: () => fakeApiScorer({ error: new Error('环境变量 EMO_MISSING_KEY 未设置') }),
  })
  await service.initialize()
  const state = await service.getState()
  assert.equal(state.providerStatus.ready, false)
  assert.match(String(state.providerStatus.error), /EMO_MISSING_KEY/u)
  // API 未就绪 → ensureReady 回退本地通道（legacy 可用，因此为 true）。
  assert.equal(await service.ensureReady(), true)
  assert.ok(warnings.some((message) => /API 通道未就绪/u.test(message)))
  const result = await service.score('hello')
  assert.ok(result)
  assert.equal(result.modelId, 'legacy-tabularisai')
  assert.equal(result.fallbackActive, true)
})

test('API provider：testModel 走 API，失败映射为 api_failed 502', async () => {
  const okService = setup({
    legacy: false,
    settings: { provider: API_PROVIDER },
    apiScorerFactory: () => fakeApiScorer({ scores: { pleasant: 0.8 } }),
  }).service
  const tested = await okService.testModel('hello')
  assert.equal(tested.modelId, 'api:gpt-test')
  assert.equal(tested.scores['pleasant'], 0.8)

  const failing = setup({
    legacy: false,
    settings: { provider: API_PROVIDER },
    apiScorerFactory: () => fakeApiScorer({ error: new Error('timeout') }),
  }).service
  await assert.rejects(() => failing.testModel('hello'), (error: unknown) => {
    assert.ok(error instanceof ModelServiceError)
    assert.equal(error.code, 'api_failed')
    assert.equal(error.status, 502)
    return true
  })
})

test('selectProvider：校验、持久化、切回本地重建运行时', async () => {
  const { service, saved } = setup({ legacy: true })
  await service.initialize()
  const apiState = await service.selectProvider({ ...API_PROVIDER, timeoutMs: 5000 })
  assert.equal(apiState.provider.type, 'api')
  assert.equal(saved.length, 1)
  assert.equal(saved[0]?.provider.type, 'api')

  const localState = await service.selectProvider({ type: 'local' })
  assert.equal(localState.provider.type, 'local')
  assert.equal(saved.length, 2)
  assert.equal(service.activeRuntime?.preset.id, 'legacy-tabularisai')

  await assert.rejects(() => service.selectProvider({ type: 'api', baseUrl: 'ftp://x', model: 'm' }), (error: unknown) => {
    assert.ok(error instanceof ModelServiceError)
    assert.equal(error.code, 'invalid_provider')
    assert.equal(error.status, 400)
    return true
  })
})
