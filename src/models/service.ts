/**
 * 模型运行时服务（v0.2 / issue #39；v0.2.2 修复 #60/#64/#65）。
 *
 * 把 registry（预设）、manager（下载）、profiles（映射）、settings（选择）
 * 与 EmotionScorer（推理）串起来：
 * - 默认 activeModelId = horizon-small；未下载时回退 legacy assets；
 * - 选择 / 首次初始化时真实加载一次 ONNX；失败自动回退 legacy，并把原因
 *   暴露到 `state.runtimeError`（review H3）；
 * - 中文 zh 预设是 manual/experimental：只接受手动放置的
 *   `$DSH_HOME/emotion-analyzer/models/zh-johnson-small/{model.onnx,tokenizer.json,config.json}`；
 * - 为 Host routes 提供 state / select / download / delete / test 所需方法。
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EmotionScorer, type EmotionScorerOptions } from '../inference.ts'
import { LEGACY_MODEL_ID, getModelPreset, type ModelPreset } from './registry.ts'
import { ModelManager, ModelManagerError, type ModelStatus } from './manager.ts'
import { getMappingProfile, type MappingProfile, type MappingProfileId } from './profiles.ts'
import { ApiScorer, API_PROFILE_ID, type ApiScorerOptions } from './api-scorer.ts'
import {
  DEFAULT_SETTINGS,
  apiKeyOf,
  loadSettings,
  saveSettings,
  validateApiProvider,
  type ApiProviderSettings,
  type PluginSettings,
  type ProviderSettings,
} from '../settings.ts'

/** 服务层错误：routes 直接映射成 `{error:{code,message}}`。 */
export class ModelServiceError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'ModelServiceError'
    this.code = code
    this.status = status
  }
}

/** 实际生效的模型运行时（可能是回退后的 legacy）。 */
export interface ActiveRuntime {
  readonly preset: ModelPreset
  readonly profile: MappingProfile
  readonly modelPath: string
  readonly tokenizerPath: string
  /** 用户选择与生效模型不一致（选择模型不可用 → legacy 回退）。 */
  readonly fallbackActive: boolean
}

/** `GET state` 的返回体（v0.2.2 增加 hasUsableModel / effective* / runtimeError）。 */
export interface ModelStatePayload {
  /** 用户配置里选择的模型 id（可能未安装）。 */
  readonly activeModelId: string
  /** 兼容旧客户端：等于 effectiveFallback。 */
  readonly fallbackActive: boolean
  /** 当前是否真的有一套可用的模型文件（看 active runtime，不做 ONNX 加载）。 */
  readonly hasUsableModel: boolean
  /** 实际生效的模型 id（回退后是 legacy），没有可用模型时为 null。 */
  readonly effectiveModelId: string | null
  /** 实际生效模型是否不同于 activeModelId（回退）。 */
  readonly effectiveFallback: boolean
  /** 最近一次加载失败 / 完整性错误原因；正常为 null。 */
  readonly runtimeError: string | null
  readonly models: readonly ModelStateEntry[]
  readonly provider: ProviderSettings
  /** API 通道是否就绪（本地通道恒为 true；错误原因用于设置页提示）。 */
  readonly providerStatus: ProviderStatus
}

/** provider 就绪状态。 */
export interface ProviderStatus {
  readonly ready: boolean
  readonly error: string | null
}

/** state.models[] 的条目。 */
export interface ModelStateEntry {
  readonly id: string
  readonly name: string
  readonly repo: string
  readonly license: string
  readonly sizeBytes: number
  readonly languages: readonly string[]
  readonly labels: readonly string[]
  readonly mappingProfile: MappingProfileId
  readonly downloaded: boolean
  readonly downloading: boolean
  readonly progress: { readonly receivedBytes: number; readonly totalBytes: number; readonly percent: number }
  readonly error: string | null
  readonly errorCode: string | null
  readonly needsExport: boolean
  readonly manual: boolean
  readonly experimental: boolean
  /** manual 预设的手动安装目录（其他模型为 null）。 */
  readonly installPath: string | null
  /** UI role badges. */
  readonly default: boolean
  readonly recommended: boolean
}

/** 一轮打分的原始结果（投影 fold 需要 raw + profileId）。 */
export interface ScoreResult {
  readonly raw: Record<string, number>
  readonly modelId: string
  readonly profileId: MappingProfileId
  readonly latencyMs: number
  readonly fallbackActive: boolean
}

/** `POST test` 的返回体。 */
export interface TestResult {
  readonly scores: Record<string, number>
  readonly modelId: string
  readonly latencyMs: number
}

/** 服务依赖注入（测试用）。 */
export interface EmotionModelServiceOptions {
  readonly baseDir?: string
  readonly manager?: ModelManager
  readonly logger?: Pick<Console, 'warn' | 'error'>
  /** 测试注入假 scorer / 假设置读写。 */
  readonly scorerFactory?: (options: EmotionScorerOptions) => EmotionScorer
  /** 测试注入 API 打分器（默认按 provider 构造）。 */
  readonly apiScorerFactory?: (options: ApiScorerOptions) => ApiScorer
  /** 测试注入 fetch（API 通道）。 */
  readonly fetchImpl?: typeof fetch
  /** 测试注入环境变量表（API 密钥读取）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly settingsLoader?: () => Promise<PluginSettings>
  readonly settingsSaver?: (settings: PluginSettings) => Promise<void>
}

/** 从预设找模型 / tokenizer 的本地路径（下载模型落在 modelDir 下）。 */
function runtimePaths(
  preset: ModelPreset,
  modelDir: string,
): { modelPath: string; tokenizerPath: string } | undefined {
  if (preset.local !== undefined) {
    return {
      modelPath: fileURLToPath(preset.local.model),
      tokenizerPath: fileURLToPath(preset.local.tokenizer),
    }
  }
  const model = preset.files.find((file) => file.role === 'model')
  const tokenizer = preset.files.find((file) => file.role === 'tokenizer')
  if (model === undefined || tokenizer === undefined) return undefined
  return { modelPath: join(modelDir, model.path), tokenizerPath: join(modelDir, tokenizer.path) }
}

interface ResolvedRuntime {
  readonly runtime?: ActiveRuntime
  /** 只有真正的完整性问题 / 无模型才设置；普通“未安装 → 回退”不算错误。 */
  readonly error?: string
}

/** 模型运行时服务。 */
export class EmotionModelService {
  private readonly options: EmotionModelServiceOptions
  private readonly manager: ModelManager
  private readonly logger: Pick<Console, 'warn' | 'error'>
  private settingsState: PluginSettings = DEFAULT_SETTINGS
  private active: ActiveRuntime | undefined
  private scorer: EmotionScorer | undefined
  private initialized = false
  private initPromise: Promise<void> | undefined
  private ready: 'idle' | 'ready' | 'failed' = 'idle'
  private readyPromise: Promise<boolean> | undefined
  private runtimeError: string | null = null
  private warnedFallback = false
  private apiScorer: ApiScorer | undefined
  private providerStatus: ProviderStatus = { ready: true, error: null }
  /** 最近一次 API 失败原因（成功一次即清空），用于 state 提示。 */
  private lastApiError: string | null = null

  constructor(options: EmotionModelServiceOptions = {}) {
    this.options = options
    this.logger = options.logger ?? console
    this.manager = options.manager ?? new ModelManager({ baseDir: options.baseDir, logger: this.logger })
  }

  /** 当前设置（只读快照）。 */
  get settings(): PluginSettings {
    return this.settingsState
  }

  /** 当前生效模型（未初始化 / 无可用模型时为 undefined）。 */
  get activeRuntime(): ActiveRuntime | undefined {
    return this.active
  }

  /** 运行时加载状态（测试 / 诊断用）。 */
  get runtimeState(): 'idle' | 'ready' | 'failed' {
    return this.ready
  }

  /** 当前 runtimeError（测试 / 诊断用）。 */
  get lastRuntimeError(): string | null {
    return this.runtimeError
  }

  /** 当前 manager（routes / 测试用）。 */
  get modelManager(): ModelManager {
    return this.manager
  }

  /** 读取设置并解析生效模型；可重复调用（幂等，不做 ONNX 加载）。 */
  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initPromise ??= this.doInitialize()
    await this.initPromise
  }

  private async doInitialize(): Promise<void> {
    this.settingsState = this.options.settingsLoader
      ? await this.options.settingsLoader()
      : await loadSettings({ baseDir: this.options.baseDir, logger: this.logger })
    const isApi = this.settingsState.provider.type === 'api'
    const resolved = await this.resolveRuntime(this.settingsState.activeModelId)
    this.active = resolved.runtime
    this.ready = 'idle'
    if (isApi) {
      // API 通道不要求本地模型；本地运行时只作为失败回退。
      this.runtimeError = null
      this.providerStatus = this.apiStatus()
      return
    }
    this.runtimeError = resolved.error ?? null
    this.providerStatus = { ready: true, error: null }
    if (this.active?.fallbackActive === true && !this.warnedFallback) {
      this.warnedFallback = true
      this.logger.warn?.(
        `[emotion] 模型 ${this.settingsState.activeModelId} 不可用，回退到 legacy assets；` +
          '可在设置页下载/安装默认模型后切换。',
      )
    }
    if (this.active === undefined && this.runtimeError === null) {
      this.runtimeError = `没有可用模型：${this.settingsState.activeModelId} 未安装，且 legacy assets 不存在。`
    }
  }

  /** 解析配置 id 对应的运行时；失败时尝试 legacy 回退。 */
  private async resolveRuntime(configuredId: string): Promise<ResolvedRuntime> {
    const configured = getModelPreset(configuredId)
    if (configured !== undefined) {
      const configuredResult = await this.resolvePreset(configured, false)
      if (configuredResult.runtime !== undefined) return configuredResult
      const legacy = await this.resolveLegacy()
      if (legacy !== undefined) {
        return {
          runtime: { ...legacy, fallbackActive: true },
          // 普通“尚未安装 → 回退”不报错；只有完整性/导出问题才暴露 runtimeError。
          ...(configuredResult.error === undefined ? {} : { error: configuredResult.error }),
        }
      }
      return { error: configuredResult.error ?? this.noModelMessage(configured) }
    }

    // 未知模型 id（例如旧配置 / 手改 config.json）：直接尝试 legacy。
    const legacy = await this.resolveLegacy()
    if (legacy !== undefined) {
      return { runtime: { ...legacy, fallbackActive: true }, error: `未知模型：${configuredId}` }
    }
    return { error: `未知模型：${configuredId}；且 legacy assets 不存在。` }
  }

  private noModelMessage(preset: ModelPreset): string {
    if (preset.manual === true) {
      return `${preset.name} 需要手动安装：把 model.onnx + tokenizer.json + config.json 放到 ` +
        `${this.manager.modelDir(preset.id)}/`
    }
    return `${preset.name} 尚未安装（下载后即可使用）。`
  }

  /** 解析单个预设（不包含 legacy 回退）。 */
  private async resolvePreset(preset: ModelPreset, fallback: boolean): Promise<ResolvedRuntime> {
    if (preset.needsExport === true) return { error: `${preset.name} 需要先导出 ONNX。` }
    const integrity = await this.manager.inspectModel(preset.id)
    if (!integrity.downloaded) {
      // 单纯“没下载”不是错误，交给上层决定是否回退；损坏/不完整才暴露错误。
      return integrity.error === undefined ? {} : { error: integrity.error }
    }
    const paths = runtimePaths(preset, this.manager.modelDir(preset.id))
    if (paths === undefined) return { error: `${preset.name} 缺少 model/tokenizer 文件。` }
    return {
      runtime: {
        preset,
        profile: getMappingProfile(preset.mappingProfile),
        modelPath: paths.modelPath,
        tokenizerPath: paths.tokenizerPath,
        fallbackActive: fallback || preset.id !== this.settingsState.activeModelId,
      },
    }
  }

  /** 解析 legacy 回退运行时。 */
  private async resolveLegacy(): Promise<ActiveRuntime | undefined> {
    const legacy = getModelPreset(LEGACY_MODEL_ID)
    if (legacy === undefined) return undefined
    const integrity = await this.manager.inspectModel(LEGACY_MODEL_ID)
    if (!integrity.downloaded) return undefined
    const paths = runtimePaths(legacy, this.manager.modelDir(LEGACY_MODEL_ID))
    if (paths === undefined) return undefined
    return {
      preset: legacy,
      profile: getMappingProfile(legacy.mappingProfile),
      modelPath: paths.modelPath,
      tokenizerPath: paths.tokenizerPath,
      fallbackActive: true,
    }
  }

  /** 重建运行时（切换 / 删除后）；不主动加载 ONNX。 */
  private async refreshRuntime(): Promise<void> {
    this.disposeScorer()
    this.ready = 'idle'
    this.readyPromise = undefined
    const resolved = await this.resolveRuntime(this.settingsState.activeModelId)
    this.active = resolved.runtime
    this.runtimeError = resolved.error ?? null
    if (this.active === undefined && this.runtimeError === null) {
      this.runtimeError = `没有可用模型：${this.settingsState.activeModelId} 未安装，且 legacy assets 不存在。`
    }
  }

  /**
   * 确保当前模型真的可以推理：必要时加载 ONNX。
   *
   * - 保留 lazy：只有第一次打分 / select / test 调用到这里；
   * - 加载失败自动回退 legacy，并把原因写进 runtimeError；
   * - 结果缓存（`ready`），避免每轮重复失败重试。
   */
  async ensureReady(): Promise<boolean> {
    await this.initialize()
    if (this.settingsState.provider.type === 'api') {
      const status = this.apiStatus()
      this.providerStatus = status
      if (status.ready) return true
      this.logger.warn?.(
        `[emotion] API 通道未就绪（${status.error ?? '未知原因'}），本轮回退本地模型。`,
      )
      return this.ensureLocalReady()
    }
    return this.ensureLocalReady()
  }

  /** 本地 ONNX 通道就绪：必要时加载模型（懒加载 + 失败回退）。 */
  private async ensureLocalReady(): Promise<boolean> {
    if (this.ready === 'ready') return true
    if (this.ready === 'failed') return false
    this.readyPromise ??= this.doEnsureReady()
    return this.readyPromise
  }

  private async doEnsureReady(): Promise<boolean> {
    const runtime = this.active
    if (runtime === undefined) {
      this.ready = 'failed'
      this.runtimeError ??= '没有可用模型'
      return false
    }
    const scorer = this.ensureScorer()
    if (scorer === undefined) {
      this.ready = 'failed'
      return false
    }
    if (await scorer.init()) {
      this.ready = 'ready'
      return true
    }

    const failedModel = runtime.preset.id
    this.runtimeError =
      `模型 ${failedModel} 加载失败（文件损坏或 ONNX 不受支持）` +
      (this.runtimeError === null ? '' : `；${this.runtimeError}`)
    this.disposeScorer()

    if (failedModel !== LEGACY_MODEL_ID) {
      const legacy = await this.resolveLegacy()
      if (legacy !== undefined) {
        this.active = { ...legacy, fallbackActive: true }
        this.scorer = undefined
        const fallbackScorer = this.ensureScorer()
        if (fallbackScorer !== undefined && (await fallbackScorer.init())) {
          this.ready = 'ready'
          this.runtimeError = `模型 ${failedModel} 加载失败，已自动回退 legacy；${this.runtimeError}`
          this.logger.warn?.(`[emotion] ${this.runtimeError}`)
          return true
        }
      }
    }
    this.active = undefined
    this.ready = 'failed'
    this.runtimeError = `${this.runtimeError}；legacy 回退也不可用`
    this.logger.error?.(`[emotion] ${this.runtimeError}`)
    return false
  }

  /** 惰性创建 scorer（第一次真正打分时才加载 ONNX）。 */
  private ensureScorer(): EmotionScorer | undefined {
    const runtime = this.active
    if (runtime === undefined) return undefined
    if (this.scorer === undefined) {
      const factory = this.options.scorerFactory ?? ((options: EmotionScorerOptions) => new EmotionScorer(options))
      this.scorer = factory({
        modelPath: runtime.modelPath,
        tokenizerPath: runtime.tokenizerPath,
        labels: runtime.preset.labels,
        logger: this.logger,
      })
    }
    return this.scorer
  }

  private disposeScorer(): void {
    const scorer = this.scorer
    this.scorer = undefined
    if (scorer !== undefined) void scorer.dispose()
  }

  /**
   * 对文本打分；通道不可用 / 失败返回 undefined（不抛）。
   *
   * API 通道失败（超时 / HTTP / JSON 非法 / 密钥缺失）时回退本地 ONNX，
   * 并把 `fallbackActive` 置 true；本地也不可用则本轮跳过。
   */
  async score(text: string): Promise<ScoreResult | undefined> {
    await this.initialize()
    if (this.settingsState.provider.type === 'api') {
      const viaApi = await this.scoreWithApi(text)
      if (viaApi !== undefined) return viaApi
      const viaLocal = await this.scoreWithLocal(text)
      if (viaLocal !== undefined) return { ...viaLocal, fallbackActive: true }
      return undefined
    }
    return this.scoreWithLocal(text)
  }

  /** API 通道打分；失败返回 undefined（原因写进 providerStatus）。 */
  private async scoreWithApi(text: string): Promise<ScoreResult | undefined> {
    const provider = this.settingsState.provider
    if (provider.type !== 'api') return undefined
    const scorer = this.ensureApiScorer(provider)
    try {
      const outcome = await scorer.score(text)
      this.lastApiError = null
      this.providerStatus = { ready: true, error: null }
      return {
        raw: outcome.scores,
        modelId: `api:${outcome.modelId}`,
        profileId: API_PROFILE_ID,
        latencyMs: outcome.latencyMs,
        fallbackActive: false,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastApiError = message
      this.providerStatus = { ready: false, error: message }
      this.logger.warn?.(`[emotion] API 打分失败，尝试本地回退：${message}`)
      return undefined
    }
  }

  /** 本地 ONNX 通道打分（原 v0.2 行为）。 */
  private async scoreWithLocal(text: string): Promise<ScoreResult | undefined> {
    if (!(await this.ensureLocalReady())) return undefined
    const runtime = this.active
    const scorer = this.scorer
    if (runtime === undefined || scorer === undefined) return undefined
    const startedAt = Date.now()
    const raw = await scorer.score(text)
    const latencyMs = Date.now() - startedAt
    if (Object.keys(raw).length === 0) return undefined
    return {
      raw,
      modelId: runtime.preset.id,
      profileId: runtime.profile.id,
      latencyMs,
      fallbackActive: runtime.fallbackActive,
    }
  }

  /** `POST test`：返回统一 7 维分数；没有可用通道时给出明确错误。 */
  async testModel(text: string): Promise<TestResult> {
    await this.initialize()
    if (this.settingsState.provider.type === 'api') {
      const provider = this.settingsState.provider
      const status = this.apiStatus()
      this.providerStatus = status
      if (!status.ready) {
        throw new ModelServiceError('provider_unavailable', status.error ?? 'API 通道未就绪', 503)
      }
      const scorer = this.ensureApiScorer(provider)
      try {
        const outcome = await scorer.score(text)
        return { scores: outcome.scores, modelId: `api:${outcome.modelId}`, latencyMs: outcome.latencyMs }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.providerStatus = { ready: false, error: message }
        throw new ModelServiceError('api_failed', message, 502)
      }
    }
    if (!(await this.ensureLocalReady())) {
      throw new ModelServiceError(
        'model_unavailable',
        this.runtimeError ?? '没有可用的本地模型，请先在设置页下载/安装模型。',
        503,
      )
    }
    const runtime = this.active
    const scorer = this.scorer
    if (runtime === undefined || scorer === undefined) {
      throw new ModelServiceError('model_unavailable', '没有可用的本地模型', 503)
    }
    const startedAt = Date.now()
    const raw = await scorer.score(text)
    const latencyMs = Date.now() - startedAt
    if (Object.keys(raw).length === 0) throw new ModelServiceError('inference_failed', '模型推理失败', 503)
    return { scores: runtime.profile.aggregate(raw), modelId: runtime.preset.id, latencyMs }
  }

  /** `GET state`。 */
  async getState(): Promise<ModelStatePayload> {
    await this.initialize()
    const statuses = await this.manager.listStatuses()
    const effectiveFallback = this.active?.fallbackActive ?? false
    return {
      activeModelId: this.settingsState.activeModelId,
      fallbackActive: effectiveFallback,
      hasUsableModel: this.active !== undefined && this.ready !== 'failed',
      effectiveModelId: this.active?.preset.id ?? null,
      effectiveFallback,
      runtimeError: this.runtimeError,
      models: statuses.map((status) => this.entryOf(status)),
      provider: this.settingsState.provider,
      providerStatus:
        this.settingsState.provider.type === 'api'
          ? this.apiStatus()
          : { ready: this.active !== undefined, error: this.runtimeError },
    }
  }

  private entryOf(status: ModelStatus): ModelStateEntry {
    const manual = status.preset.manual === true
    return {
      id: status.preset.id,
      name: status.preset.name,
      repo: status.preset.repo,
      license: status.preset.license,
      sizeBytes: status.preset.sizeBytes,
      languages: status.preset.languages,
      labels: status.preset.labels,
      mappingProfile: status.preset.mappingProfile,
      downloaded: status.downloaded,
      downloading: status.downloading,
      progress: status.progress,
      error: status.error ?? null,
      errorCode: status.errorCode ?? null,
      needsExport: status.needsExport,
      manual,
      experimental: status.preset.experimental === true,
      installPath: manual ? this.manager.modelDir(status.preset.id) : null,
      default: status.preset.default === true,
      recommended: status.preset.recommended === true,
    }
  }

  /** `POST model/select`：校验可用 → 写设置 → 加载一次（失败自动回退）。 */
  async selectModel(id: string): Promise<ModelStatePayload> {
    await this.initialize()
    const preset = this.requirePreset(id)
    if (preset.needsExport === true) {
      throw new ModelServiceError('needs_export', `${preset.name} 没有官方 ONNX，请先用导出脚本生成。`)
    }
    const integrity = await this.manager.inspectModel(preset.id)
    if (!integrity.downloaded) {
      if (preset.manual === true) {
        throw new ModelServiceError(
          'manual_install',
          integrity.error ??
            `${preset.name} 需要手动安装：把 model.onnx + tokenizer.json + config.json 放到 ` +
              `${this.manager.modelDir(preset.id)}/`,
          409,
        )
      }
      throw new ModelServiceError('not_downloaded', integrity.error ?? `${preset.name} 尚未下载。`, 409)
    }
    if (this.active?.preset.id === preset.id && this.settingsState.activeModelId === preset.id && this.ready === 'ready') {
      return this.getState()
    }
    const nextSettings: PluginSettings = { ...this.settingsState, activeModelId: preset.id }
    if (this.options.settingsSaver !== undefined) await this.options.settingsSaver(nextSettings)
    else await saveSettings(nextSettings, { baseDir: this.options.baseDir })
    this.settingsState = nextSettings
    await this.refreshRuntime()
    // H3：选择时真实加载一次；失败自动回退 legacy，并通过 state.runtimeError 暴露。
    await this.ensureReady()
    return this.getState()
  }

  /** `POST model/download`：启动下载并立即返回最新 state。 */
  async downloadModel(id: string): Promise<ModelStatePayload> {
    await this.initialize()
    const preset = this.requirePreset(id)
    if (preset.manual === true) {
      throw new ModelServiceError(
        'manual_install',
        `${preset.name} 不支持在线下载：请把 model.onnx + tokenizer.json + config.json 放到 ` +
          `${this.manager.modelDir(preset.id)}/ 后再选择。`,
        409,
      )
    }
    if (preset.needsExport !== true && (await this.manager.isDownloaded(preset.id))) {
      return this.getState()
    }
    try {
      this.manager.startDownload(preset.id)
    } catch (error) {
      throw this.mapManagerError(error)
    }
    return this.getState()
  }

  /** `DELETE model/{id}`：删除非 legacy 模型。 */
  async deleteModel(id: string): Promise<ModelStatePayload> {
    await this.initialize()
    this.requirePreset(id)
    try {
      await this.manager.deleteModel(id)
    } catch (error) {
      throw this.mapManagerError(error)
    }
    if (this.active?.preset.id === id || this.settingsState.activeModelId === id) {
      await this.refreshRuntime()
    }
    return this.getState()
  }

  /** 切换打分通道（设置页 / Host API）。 */
  async selectProvider(provider: ProviderSettings): Promise<ModelStatePayload> {
    await this.initialize()
    let nextProvider: ProviderSettings
    if (provider.type === 'api') {
      const validated = validateApiProvider(provider)
      if (validated.settings === undefined) {
        throw new ModelServiceError('invalid_provider', validated.error ?? 'API 配置非法', 400)
      }
      nextProvider = validated.settings
    } else {
      nextProvider = { type: 'local' }
    }
    const nextSettings: PluginSettings = { ...this.settingsState, provider: nextProvider }
    if (this.options.settingsSaver !== undefined) await this.options.settingsSaver(nextSettings)
    else await saveSettings(nextSettings, { baseDir: this.options.baseDir })
    this.settingsState = nextSettings
    this.disposeApiScorer()
    this.lastApiError = null
    this.ready = 'idle'
    this.readyPromise = undefined
    this.runtimeError = null
    this.warnedFallback = false
    if (nextProvider.type === 'api') {
      this.providerStatus = this.apiStatus()
    } else {
      await this.refreshRuntime()
      this.providerStatus = { ready: this.active !== undefined, error: this.runtimeError }
    }
    return this.getState()
  }

  /** 计算 API 通道就绪状态（配置 + 密钥环境变量）。 */
  private apiStatus(): ProviderStatus {
    const provider = this.settingsState.provider
    if (provider.type !== 'api') return { ready: true, error: null }
    const validated = validateApiProvider(provider)
    if (validated.settings === undefined) {
      return { ready: false, error: validated.error ?? 'API 配置非法' }
    }
    const settings = validated.settings
    if (settings.apiKeyEnv !== undefined && apiKeyOf(settings, this.options.env ?? process.env) === undefined) {
      return { ready: false, error: `环境变量 ${settings.apiKeyEnv} 未设置` }
    }
    if (this.lastApiError !== null) return { ready: false, error: this.lastApiError }
    return { ready: true, error: null }
  }

  /** 惰性创建 API 打分器（provider 切换时丢弃）。 */
  private ensureApiScorer(provider: ApiProviderSettings): ApiScorer {
    if (this.apiScorer === undefined) {
      const factory = this.options.apiScorerFactory ?? ((options: ApiScorerOptions) => new ApiScorer(options))
      this.apiScorer = factory({
        provider,
        logger: this.logger,
        ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
        ...(this.options.env === undefined ? {} : { env: this.options.env }),
      })
    }
    return this.apiScorer
  }

  private disposeApiScorer(): void {
    this.apiScorer = undefined
  }

  /** 重新读取设置并重建映射（settings 变更后下一轮生效）。 */
  async reload(): Promise<void> {
    this.initialized = false
    this.initPromise = undefined
    this.warnedFallback = false
    this.ready = 'idle'
    this.readyPromise = undefined
    this.runtimeError = null
    this.providerStatus = { ready: true, error: null }
    this.disposeApiScorer()
    this.settingsState = DEFAULT_SETTINGS
    await this.initialize()
    await this.refreshRuntime()
  }

  /** 释放底层 ONNX session。 */
  async dispose(): Promise<void> {
    const scorer = this.scorer
    this.scorer = undefined
    this.active = undefined
    this.initialized = false
    this.initPromise = undefined
    this.ready = 'idle'
    this.readyPromise = undefined
    this.providerStatus = { ready: true, error: null }
    this.disposeApiScorer()
    if (scorer !== undefined) await scorer.dispose()
  }

  private requirePreset(id: string): ModelPreset {
    const preset = getModelPreset(id)
    if (preset === undefined) throw new ModelServiceError('unknown_model', `未知模型：${id}`, 404)
    return preset
  }

  private mapManagerError(error: unknown): Error {
    if (error instanceof ModelManagerError) {
      const status = error.code === 'unknown_model' ? 404 : error.code === 'legacy_protected' ? 400 : 409
      return new ModelServiceError(error.code, error.message, status)
    }
    return error instanceof Error ? error : new Error(String(error))
  }
}
