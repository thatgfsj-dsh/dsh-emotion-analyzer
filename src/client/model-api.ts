/**
 * dsh-emotion-analyzer — client for the model-management HTTP API.
 *
 * Contract (issue #39, consumed by the settings UI in #40):
 *   GET    /api/emotion-analyzer/v1/state          -> ModelState
 *   POST   /api/emotion-analyzer/v1/model/select   { id } -> ModelState
 *   POST   /api/emotion-analyzer/v1/model/download { id } -> ModelState
 *   DELETE /api/emotion-analyzer/v1/model/{id}     -> ModelState
 *   POST   /api/emotion-analyzer/v1/test           { text } -> ModelTestResult
 *
 * All requests are same-origin with credentials: 'include'. Errors are
 * normalised to ModelApiError with a human-readable Chinese message.
 *
 * Production is strict live: a 404 / network error is surfaced to the UI and is
 * never replaced with fake success data (issue #62 H4). Mock data is available
 * only when explicitly requested with '?emotionModelMock=1' or
 * createModelApi({ mode: 'mock' }).
 */

export const MODEL_API_BASE = '/api/emotion-analyzer/v1'
export const MODEL_POLL_INTERVAL_MS = 1000

export type ModelSource = 'live' | 'mock'
export type ModelApiMode = 'live' | 'mock'

export type DownloadStatus =
  | 'idle'
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'complete'
  | 'failed'
  | 'cancelled'

export interface ModelDownload {
  id?: string
  status: DownloadStatus
  /** 0-100. */
  percent: number
  bytesDone?: number
  bytesTotal?: number
  speedBps?: number
  message?: string
  error?: string
}

export interface ModelPreset {
  id: string
  name: string
  description?: string
  /** Number of supported languages (array form is normalised). */
  languages: number
  languageCodes?: string[]
  /** Number of classification labels. */
  labels: number
  sizeBytes?: number
  license: string
  profile?: string
  legacy: boolean
  fallback: boolean
  installed: boolean
  downloadable: boolean
  needsExport: boolean
  /** Built-in default preset (Horizon Small). */
  default?: boolean
  recommended: boolean
  expectedExportPath?: string
}

/** 打分通道类型。 */
export type ProviderType = 'local' | 'api'

/** 设置页展示用的 provider 状态（密钥只暴露环境变量名，不暴露值）。 */
export type ProviderState =
  | { type: 'local'; ready: boolean; error: string | null }
  | {
      type: 'api'
      baseUrl: string
      model: string
      apiKeyEnv?: string
      timeoutMs?: number
      ready: boolean
      error: string | null
    }

/** `POST /provider` 的请求体。 */
export type ProviderConfig =
  | { type: 'local' }
  | { type: 'api'; baseUrl: string; model: string; apiKeyEnv?: string; timeoutMs?: number }

export interface ModelState {
  /** Currently effective runtime preset (null when no model is usable). */
  current: ModelPreset | null
  presets: ModelPreset[]
  /** User-selected preset id (host activeModelId); may differ from effective. */
  selectedModelId: string | null
  /** Legacy alias: selected preset id, not the effective one. */
  activeModelId: string | null
  /** Actually loaded runtime preset id (host effectiveModelId, #60). */
  effectiveModelId: string | null
  /** True when the selected model is missing/damaged and a legacy fallback runs. */
  effectiveFallback: boolean
  /** Host runtime failure (model load/checksum), shown instead of fake success. */
  runtimeError: string | null
  download: ModelDownload | null
  needsExport: boolean
  fallback: boolean
  warnings: string[]
  source: ModelSource
  /** 当前打分通道（本地 ONNX 或自定义 API）。 */
  provider: ProviderState
  mockReason?: string
}

export interface ModelTestResult {
  modelId: string
  latencyMs: number
  scores: Record<string, number>
  dominant?: string
  language?: string
  error?: string
}

export interface ModelApiOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  mode?: ModelApiMode
  now?: () => number
}

/** Error raised for a failed model API call. */
export class ModelApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail?: string

  constructor(message: string, status = 0, code = 'unknown', detail?: string) {
    super(message)
    this.name = 'ModelApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

/** Download statuses that mean the transfer is finished (success or not). */
export function isTerminalDownloadStatus(status: DownloadStatus): boolean {
  return status === 'complete' || status === 'failed' || status === 'cancelled' || status === 'idle'
}

/** True while a download is still making progress (used to drive polling). */
export function isActiveDownloadStatus(status: DownloadStatus): boolean {
  return status === 'queued' || status === 'downloading' || status === 'verifying' || status === 'installing'
}

/** Whether the client should keep polling /state for download progress. */
export function shouldPollModelState(state: ModelState | null | undefined): boolean {
  if (!state || !state.download) return false
  return isActiveDownloadStatus(state.download.status)
}

/** Human label for a download status. */
export function downloadStatusLabel(status: DownloadStatus): string {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'downloading':
      return '下载中'
    case 'verifying':
      return '校验中'
    case 'installing':
      return '安装中'
    case 'complete':
      return '下载完成'
    case 'failed':
      return '下载失败'
    case 'cancelled':
      return '已取消'
    default:
      return '空闲'
  }
}

/** 0-100 integer progress, tolerant of fraction / byte-only payloads. */
export function downloadPercent(download: ModelDownload | null | undefined): number {
  if (!download) return 0
  const bytePercent =
    download.bytesTotal && download.bytesTotal > 0 && download.bytesDone !== undefined
      ? (download.bytesDone / download.bytesTotal) * 100
      : Number.NaN
  let percent = bytePercent
  if (!Number.isFinite(percent)) {
    percent = Number.isFinite(download.percent) ? download.percent : 0
    if (percent > 0 && percent <= 1) percent *= 100
  }
  return Math.max(0, Math.min(100, Math.round(percent)))
}

/** Binary byte formatting for the UI (B / KiB / MiB / GiB). */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return Math.round(bytes) + ' B'
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[unit]
}

/** One-line download summary used next to the progress bar. */
export function formatProgress(download: ModelDownload | null | undefined): string {
  if (!download) return ''
  const percent = downloadPercent(download)
  let text = downloadStatusLabel(download.status) + ' ' + percent + '%'
  if (download.bytesTotal && download.bytesTotal > 0) {
    text += ' · ' + formatBytes(download.bytesDone) + ' / ' + formatBytes(download.bytesTotal)
  }
  if (download.error) text += ' · ' + download.error
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value
  }
  return undefined
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function countOf(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value)
  if (Array.isArray(value)) return value.length
  if (isRecord(value)) return Object.keys(value).length
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed)
  }
  return fallback
}

function sizeFrom(raw: Record<string, unknown>): number | undefined {
  const direct = firstNumber(raw.sizeBytes, raw.size, raw.bytes, raw.diskSizeBytes)
  if (direct !== undefined) return direct
  const mib = firstNumber(raw.sizeMiB, raw.sizeMB, raw.sizeMib)
  if (mib !== undefined) return Math.round(mib * 1024 * 1024)
  const gib = firstNumber(raw.sizeGiB, raw.sizeGB)
  if (gib !== undefined) return Math.round(gib * 1024 * 1024 * 1024)
  return undefined
}

/** Normalise one preset payload; returns null when it has no usable id. */
export function normalizePreset(raw: unknown): ModelPreset | null {
  if (!isRecord(raw)) return null
  const id = firstString(raw.id, raw.modelId, raw.model, raw.slug, raw.key, raw.name)
  if (!id) return null
  const languageCodes = stringList(
    raw.languageCodes ?? raw.languagesList ?? raw.locales ?? (Array.isArray(raw.languages) ? raw.languages : undefined),
  )
  const languages = countOf(raw.languageCount ?? raw.languages ?? raw.languageTotal ?? languageCodes, languageCodes.length)
  const labels = countOf(raw.labelCount ?? raw.labels ?? raw.numLabels ?? raw.outputLabels)
  const profile = firstString(raw.profile, raw.mappingProfile)
  const status = firstString(raw.status, raw.state)
  const legacy = firstBoolean(raw.legacy, raw.isLegacy) === true || profile === 'legacy-11'
  const installed =
    firstBoolean(raw.installed, raw.downloaded, raw.isInstalled) === true ||
    status === 'installed' ||
    status === 'ready'
  return {
    id,
    name: firstString(raw.name, raw.title, raw.displayName, raw.modelId) ?? id,
    description: firstString(raw.description, raw.summary, raw.notes),
    languages,
    ...(languageCodes.length > 0 ? { languageCodes } : {}),
    labels,
    ...(sizeFrom(raw) !== undefined ? { sizeBytes: sizeFrom(raw) } : {}),
    license: firstString(raw.license, raw.licence, raw.licenseName) ?? '未标注',
    ...(profile ? { profile } : {}),
    legacy,
    fallback: firstBoolean(raw.fallback, raw.isFallback) === true || legacy,
    installed,
    downloadable: firstBoolean(raw.downloadable, raw.canDownload) !== false,
    needsExport: firstBoolean(raw.needsExport, raw.requiresExport) === true,
    default: firstBoolean(raw.default, raw.isDefault) === true,
    recommended: firstBoolean(raw.recommended) === true,
    expectedExportPath: firstString(raw.expectedExportPath, raw.exportPath),
  }
}

/** Normalise a download/progress payload. */
export function normalizeDownload(raw: unknown, fallbackId?: string): ModelDownload | null {
  if (!isRecord(raw)) return null
  const statusRaw = (firstString(raw.status, raw.state, raw.phase) ?? '').toLowerCase()
  let status: DownloadStatus = 'idle'
  if (statusRaw === 'queued' || statusRaw === 'pending' || statusRaw === 'waiting') status = 'queued'
  else if (statusRaw === 'downloading' || statusRaw === 'in_progress' || statusRaw === 'running' || statusRaw === 'active') status = 'downloading'
  else if (statusRaw === 'verifying' || statusRaw === 'checksum') status = 'verifying'
  else if (statusRaw === 'installing' || statusRaw === 'extracting') status = 'installing'
  else if (statusRaw === 'complete' || statusRaw === 'completed' || statusRaw === 'done' || statusRaw === 'success') status = 'complete'
  else if (statusRaw === 'failed' || statusRaw === 'error') status = 'failed'
  else if (statusRaw === 'cancelled' || statusRaw === 'canceled' || statusRaw === 'aborted') status = 'cancelled'
  const bytesDone = firstNumber(raw.bytesDone, raw.downloadedBytes, raw.receivedBytes)
  const bytesTotal = firstNumber(raw.bytesTotal, raw.totalBytes, raw.sizeBytes)
  let percent = firstNumber(raw.percent, raw.progress, raw.percentage, raw.pct) ?? 0
  if (percent > 0 && percent <= 1 && (raw.percent !== undefined || raw.percentage !== undefined)) percent *= 100
  if (bytesTotal && bytesTotal > 0 && bytesDone !== undefined) percent = (bytesDone / bytesTotal) * 100
  if (status === 'complete') percent = 100
  percent = Math.max(0, Math.min(100, Math.round(percent)))
  const download: ModelDownload = { status, percent }
  const id = firstString(raw.id, raw.modelId, raw.presetId) ?? fallbackId
  if (id) download.id = id
  if (bytesDone !== undefined) download.bytesDone = bytesDone
  if (bytesTotal !== undefined && bytesTotal > 0) download.bytesTotal = bytesTotal
  const speed = firstNumber(raw.speedBps, raw.bytesPerSecond, raw.speed)
  if (speed !== undefined) download.speedBps = speed
  const message = firstString(raw.message, raw.detail, raw.stage)
  if (message) download.message = message
  const error = firstString(raw.error, raw.errorMessage, raw.failureReason)
  if (error) download.error = error
  return download
}

/** Normalise the /state payload into the UI-facing shape. */
export function normalizeModelState(raw: unknown, source: ModelSource = 'live', mockReason?: string): ModelState {
  const record = isRecord(raw) ? raw : {}
  const presetSource = record.models ?? record.presets ?? record.available ?? record.catalog
  const rawPresets = Array.isArray(presetSource) ? presetSource : []
  const presets = rawPresets
    .map((entry) => normalizePreset(entry))
    .filter((entry): entry is ModelPreset => entry !== null)
  const legacyCurrent = normalizePreset(record.current ?? record.activeModel ?? record.selectedModel)
  const selectedModelId =
    firstString(record.activeModelId, record.selectedModelId, record.currentModelId, record.selectedId) ??
    (legacyCurrent ? legacyCurrent.id : null)

  // Issue #60 adds effectiveModelId / effectiveFallback / runtimeError. Older
  // host builds (#39) only expose activeModelId + fallbackActive; keep working.
  const hasRuntimeFields =
    Object.prototype.hasOwnProperty.call(record, 'effectiveModelId') ||
    Object.prototype.hasOwnProperty.call(record, 'effectiveFallback') ||
    Object.prototype.hasOwnProperty.call(record, 'runtimeError')
  let effectiveModelId: string | null
  let effectiveFallback: boolean
  let runtimeError: string | null
  if (hasRuntimeFields) {
    effectiveFallback = firstBoolean(record.effectiveFallback) === true
    runtimeError = firstString(record.runtimeError, record.runtimeErrorMessage) ?? null
    effectiveModelId = firstString(record.effectiveModelId) ?? null
  } else {
    effectiveFallback = firstBoolean(record.fallbackActive, record.fallback) === true
    runtimeError = null
    effectiveModelId = selectedModelId ?? (legacyCurrent ? legacyCurrent.id : null)
  }
  if (!effectiveModelId && effectiveFallback) {
    const legacy = presets.find((preset) => preset.installed && (preset.legacy || /legacy/i.test(preset.id)))
    if (legacy) effectiveModelId = legacy.id
  }
  let current: ModelPreset | null = effectiveModelId
    ? presets.find((preset) => preset.id === effectiveModelId) ?? null
    : null
  if (!current && !hasRuntimeFields && legacyCurrent) {
    current = legacyCurrent
    effectiveModelId = legacyCurrent.id
  }

  const downloadId = firstString(record.downloadingId, record.pendingModelId)
  let downloadRaw = record.download ?? record.downloadState ?? record.progress
  if (downloadRaw === undefined && Array.isArray(presetSource)) {
    // Host #39 state carries per-model transfer fields, not a top-level
    // download. H2: error:null is a healthy installed model, not a failure.
    const active = (presetSource as Record<string, unknown>[]).find((entry) => {
      if (!isRecord(entry)) return false
      return entry.downloading === true || (entry.error !== null && entry.error !== undefined && entry.error !== '')
    })
    if (isRecord(active)) {
      const progress = isRecord(active.progress) ? active.progress : {}
      downloadRaw = {
        id: firstString(active.id, active.modelId),
        status: active.downloading === true ? 'downloading' : 'failed',
        percent: firstNumber(progress.percent),
        receivedBytes: firstNumber(progress.receivedBytes),
        totalBytes: firstNumber(progress.totalBytes),
        error: active.downloading === true ? undefined : firstString(active.error),
      }
    }
  }
  const download = normalizeDownload(downloadRaw, downloadId)
  const warnings = stringList(record.warnings ?? record.notices)
  if (runtimeError && !warnings.includes(runtimeError)) warnings.push(runtimeError)
  const fallback = effectiveFallback || (current ? current.fallback : false)
  const needsExport =
    firstBoolean(record.needsExport, record.requiresExport) === true ||
    presets.some((preset) => preset.needsExport && !preset.installed)
  return {
    current,
    presets,
    selectedModelId,
    activeModelId: selectedModelId,
    effectiveModelId,
    effectiveFallback,
    runtimeError,
    download,
    needsExport,
    fallback,
    warnings,
    source,
    provider: normalizeProvider(record.provider, record.providerStatus),
    ...(mockReason ? { mockReason } : {}),
  }
}

/** Normalise the /state provider block (secrets never leave the host). */
export function normalizeProvider(raw: unknown, status: unknown): ProviderState {
  const record = isRecord(raw) ? raw : {}
  const statusRecord = isRecord(status) ? status : {}
  const ready = firstBoolean(statusRecord.ready)
  const error = firstString(statusRecord.error) ?? null
  if (record.type !== 'api') {
    return { type: 'local', ready: ready ?? true, error }
  }
  return {
    type: 'api',
    baseUrl: firstString(record.baseUrl) ?? '',
    model: firstString(record.model) ?? '',
    apiKeyEnv: firstString(record.apiKeyEnv),
    timeoutMs: firstNumber(record.timeoutMs),
    ready: ready ?? true,
    error,
  }
}

/** Normalise the /test payload. */
export function normalizeTestResult(raw: unknown, fallbackModelId = ''): ModelTestResult {
  const record = isRecord(raw) ? raw : {}
  const rawScores = record.scores ?? record.dimensions ?? record.result
  const scores: Record<string, number> = {}
  if (isRecord(rawScores)) {
    for (const [key, value] of Object.entries(rawScores)) {
      const numeric = firstNumber(value)
      if (numeric === undefined) continue
      scores[key] = Math.max(0, Math.min(1, numeric > 1 ? numeric / 100 : numeric))
    }
  }
  return {
    modelId: firstString(record.modelId, record.model, record.id) ?? fallbackModelId,
    latencyMs: Math.max(0, Math.round(firstNumber(record.latencyMs, record.latency, record.elapsedMs) ?? 0)),
    scores,
    dominant: firstString(record.dominant, record.topLabel),
    language: firstString(record.language, record.lang),
    error: firstString(record.error, record.message),
  }
}

/** Turn a thrown value into a user-facing Chinese sentence. */
export function describeApiError(error: unknown): string {
  if (error instanceof ModelApiError) return error.message
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '请求已取消。'
    if (error.name === 'TypeError') return '无法连接模型服务，请确认 DSH 宿主 API 是否已就绪。'
    return error.message
  }
  return String(error)
}

function errorInfoFromBody(body: unknown): { message?: string; code?: string } {
  if (typeof body === 'string') return { message: body.trim() || undefined }
  if (!isRecord(body)) return {}
  const nested = isRecord(body.error) ? body.error : undefined
  return {
    message: firstString(
      nested?.message,
      body.message,
      typeof body.error === 'string' ? body.error : undefined,
      body.detail,
      body.reason,
    ),
    code: firstString(nested?.code, body.code),
  }
}

/** Build the error for a non-2xx HTTP response. */
export function errorFromResponse(status: number, body: unknown): ModelApiError {
  const info = errorInfoFromBody(body)
  const serverMessage = info.message
  const fallback =
    status === 404
      ? '模型 API 不可用（404），宿主后端可能尚未就绪。'
      : status === 409
        ? '当前有下载任务进行中，请完成或取消后再试。'
        : status === 422
          ? '请求参数无效，请检查所选模型。'
          : status >= 500
            ? '模型服务内部错误，请稍后重试。'
            : '模型请求失败（HTTP ' + status + '）。'
  return new ModelApiError(
    serverMessage ?? fallback,
    status,
    info.code ?? (status === 404 ? 'api-unavailable' : 'http-error'),
    serverMessage,
  )
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    throw new ModelApiError(describeApiError(error), 0, 'network')
  }
  let body: unknown
  const text = await response.text().catch(() => '')
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!response.ok) throw errorFromResponse(response.status, body)
  return body
}

function mockPresets(): ModelPreset[] {
  return [
    {
      id: 'horizon-small',
      name: 'Horizon Small（推荐）',
      description: '多语言小模型，36 语言 / 28 标签，原生 confusion，Apache-2.0。',
      languages: 36,
      labels: 28,
      sizeBytes: 256 * 1024 * 1024,
      license: 'Apache-2.0',
      profile: 'go-emotions-28',
      legacy: false,
      fallback: false,
      installed: true,
      downloadable: true,
      needsExport: false,
      recommended: true,
    },
    {
      id: 'horizon-base',
      name: 'Horizon Base',
      description: '同系列更大版本，精度更高但体积 612 MiB。',
      languages: 36,
      labels: 28,
      sizeBytes: 612 * 1024 * 1024,
      license: 'Apache-2.0',
      profile: 'go-emotions-28',
      legacy: false,
      fallback: false,
      installed: false,
      downloadable: true,
      needsExport: false,
      recommended: false,
    },
    {
      id: 'tabularisai-11',
      name: 'tabularisai（legacy）',
      description: '当前内置模型：23 语言 / 11 标签，CC-BY-NC-4.0，仅作为兼容回退。',
      languages: 23,
      labels: 11,
      sizeBytes: 267 * 1024 * 1024,
      license: 'CC-BY-NC-4.0',
      profile: 'legacy-11',
      legacy: true,
      fallback: true,
      installed: true,
      downloadable: true,
      needsExport: false,
      recommended: false,
    },
    {
      id: 'johnson8187-zh',
      name: 'Chinese Emotion（中文）',
      description: '中文专用 8 标签小模型，需在本地运行导出脚本。',
      languages: 1,
      languageCodes: ['zh'],
      labels: 8,
      sizeBytes: 279 * 1024 * 1024,
      license: 'MIT',
      profile: 'zh-8',
      legacy: false,
      fallback: false,
      installed: false,
      downloadable: false,
      needsExport: true,
      recommended: false,
      expectedExportPath: 'assets/models/johnson8187-zh/model.onnx',
    },
  ]
}

interface MockDownload {
  id: string
  startedAt: number
  durationMs: number
  cancelled: boolean
}

class MockBackend {
  private readonly now: () => number
  private readonly presets: ModelPreset[]
  private activeId: string
  private download: MockDownload | null = null
  private lastFailure: string | undefined
  private completedAt = 0
  private completedId: string | null = null
  private provider: ProviderState = { type: 'local', ready: true, error: null }

  constructor(now: () => number) {
    this.now = now
    this.presets = mockPresets()
    this.activeId = 'horizon-small'
  }

  private find(id: string): ModelPreset | undefined {
    return this.presets.find((preset) => preset.id === id)
  }

  private currentProgress(): number {
    if (!this.download) return 0
    if (this.download.cancelled) return 0
    const elapsed = this.now() - this.download.startedAt
    return Math.max(0, Math.min(100, Math.round((elapsed / this.download.durationMs) * 100)))
  }

  private settle(): void {
    if (!this.download) return
    const percent = this.currentProgress()
    if (this.download.cancelled) {
      this.download = null
      return
    }
    if (percent < 100) return
    const preset = this.find(this.download.id)
    if (preset) preset.installed = true
    this.completedId = this.download.id
    this.completedAt = this.now()
    this.download = null
  }

  getState(): ModelState {
    this.settle()
    const current = this.find(this.activeId) ?? this.presets[0] ?? null
    const download = this.download
      ? normalizeDownload({
          id: this.download.id,
          status: 'downloading',
          percent: this.currentProgress(),
          bytesTotal: this.find(this.download.id)?.sizeBytes,
          bytesDone: Math.round(((this.find(this.download.id)?.sizeBytes ?? 0) * this.currentProgress()) / 100),
        })
      : null
    return {
      current,
      presets: this.presets,
      selectedModelId: this.activeId,
      activeModelId: this.activeId,
      effectiveModelId: current ? current.id : null,
      effectiveFallback: false,
      runtimeError: null,
      download,
      needsExport: this.presets.some((preset) => preset.needsExport && !preset.installed),
      fallback: current ? current.fallback : false,
      warnings: [],
      source: 'mock',
      provider: this.provider,
    }
  }

  saveProvider(config: ProviderConfig): ModelState {
    if (config.type === 'api') {
      const baseUrl = config.baseUrl.trim().replace(/\/+$/u, '')
      const model = config.model.trim()
      if (!/^https?:\/\//u.test(baseUrl) || model.length === 0) {
        throw new ModelApiError('API 配置不完整：需要 http(s) baseUrl 与 model。', 422, 'invalid-provider')
      }
      this.provider = {
        type: 'api',
        baseUrl,
        model,
        ...(config.apiKeyEnv ? { apiKeyEnv: config.apiKeyEnv } : {}),
        ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
        ready: true,
        error: null,
      }
    } else {
      this.provider = { type: 'local', ready: true, error: null }
    }
    return this.getState()
  }

  selectModel(id: string): ModelState {
    const preset = this.find(id)
    if (!preset) throw new ModelApiError('未找到模型：' + id, 404, 'not-found')
    if (!preset.installed) throw new ModelApiError('模型尚未下载，请先下载。', 409, 'not-installed')
    this.activeId = id
    return this.getState()
  }

  downloadModel(id: string): ModelState {
    const preset = this.find(id)
    if (!preset) throw new ModelApiError('未找到模型：' + id, 404, 'not-found')
    if (preset.needsExport) throw new ModelApiError('该模型需要本地导出后才能使用。', 422, 'needs-export')
    if (!preset.downloadable) throw new ModelApiError('该模型不支持在线下载。', 422, 'not-downloadable')
    if (this.download) throw new ModelApiError('已有下载任务进行中。', 409, 'download-busy')
    this.download = { id, startedAt: this.now(), durationMs: 6000, cancelled: false }
    this.lastFailure = undefined
    return this.getState()
  }

  removeModel(id: string): ModelState {
    if (this.download && this.download.id === id) {
      this.download.cancelled = true
      this.download = null
      this.lastFailure = undefined
      return this.getState()
    }
    const preset = this.find(id)
    if (!preset) throw new ModelApiError('未找到模型：' + id, 404, 'not-found')
    preset.installed = false
    if (this.activeId === id) {
      const fallback = this.presets.find((entry) => entry.installed && entry.id !== id && entry.legacy)
      this.activeId = fallback ? fallback.id : 'horizon-small'
    }
    return this.getState()
  }

  testModel(text: string): ModelTestResult {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new ModelApiError('请输入要测试的文本。', 422, 'empty-text')
    }
    const preset = this.find(this.activeId)
    if (!preset || !preset.installed) throw new ModelApiError('当前没有可用模型。', 409, 'no-model')
    let hash = 7
    for (const char of text) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1000003
    const dimensions = ['pleasant', 'sad', 'angry', 'anxious', 'unwell', 'confused', 'neutral']
    const scores: Record<string, number> = {}
    dimensions.forEach((dimension, index) => {
      const value = ((hash >> (index * 3)) % 100) / 100
      scores[dimension] = Math.max(0.01, Math.min(0.99, Number((0.15 + value * 0.8).toFixed(3))))
    })
    return {
      modelId: preset.id,
      latencyMs: 8 + (hash % 15),
      scores,
      dominant: dimensions[hash % dimensions.length] ?? 'neutral',
      language: /[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en',
    }
  }

  get completed(): { id: string | null; at: number } {
    return { id: this.completedId, at: this.completedAt }
  }

  get lastError(): string | undefined {
    return this.lastFailure
  }
}

/**
 * Model API client with live (same-origin fetch) and mock modes.
 * Auto mode falls back to mock when the host routes are not mounted yet.
 */
export class ModelApiClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly requestedMode: ModelApiMode
  private readonly now: () => number
  private readonly mock: MockBackend
  private resolvedMode: ModelSource | null = null
  private mockReason: string | undefined

  constructor(options: ModelApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? MODEL_API_BASE).replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.requestedMode = options.mode ?? 'live'
    this.now = options.now ?? (() => Date.now())
    this.mock = new MockBackend(this.now)
    if (this.requestedMode === 'mock') this.resolvedMode = 'mock'
  }

  get mode(): ModelSource | null {
    return this.resolvedMode
  }

  private mockState(): ModelState {
    const state = this.mock.getState()
    if (this.mockReason) state.mockReason = this.mockReason
    return state
  }

  private async liveState(path: string, init: RequestInit = {}): Promise<ModelState> {
    const body = await requestJson(this.fetchImpl, this.baseUrl + path, {
      credentials: 'include',
      ...init,
    })
    return normalizeModelState(body, 'live')
  }

  private isMock(): boolean {
    return this.resolvedMode === 'mock'
  }

  private async stateCall(path: string, init: RequestInit = {}): Promise<ModelState> {
    if (this.isMock()) return this.mockState()
    // Strict live (issue #62 H4): failures propagate to the UI; never fake a
    // successful mock state on 404 / network errors.
    const state = await this.liveState(path, init)
    this.resolvedMode = 'live'
    return state
  }

  /** GET /state. */
  async getState(): Promise<ModelState> {
    return this.stateCall('/state')
  }

  /** POST /model/select { id }. */
  async selectModel(id: string): Promise<ModelState> {
    if (this.isMock()) return this.mock.selectModel(id)
    return this.stateCall('/model/select', this.postBody({ id }))
  }

  /** POST /model/download { id }. */
  async downloadModel(id: string): Promise<ModelState> {
    if (this.isMock()) return this.mock.downloadModel(id)
    return this.stateCall('/model/download', this.postBody({ id }))
  }

  /** DELETE /model/{id} — also cancels an in-flight download. */
  async removeModel(id: string): Promise<ModelState> {
    if (this.isMock()) return this.mock.removeModel(id)
    return this.stateCall('/model/' + encodeURIComponent(id), { method: 'DELETE' })
  }

  /** POST /provider：切换本地 ONNX / 自定义 API（#41）。 */
  async saveProvider(config: ProviderConfig): Promise<ModelState> {
    if (this.isMock()) return this.mock.saveProvider(config)
    return this.stateCall('/provider', this.postBody(config as unknown as Record<string, unknown>))
  }

  /** POST /test { text }. */
  async testModel(text: string): Promise<ModelTestResult> {
    if (this.isMock()) return this.mock.testModel(text)
    const body = await requestJson(this.fetchImpl, this.baseUrl + '/test', {
      credentials: 'include',
      ...this.postBody({ text }),
    })
    return normalizeTestResult(body)
  }

  /**
   * Poll GET /state every second while a download is active.
   * Returns a cleanup function suitable for a React effect teardown.
   */
  watchDownload(
    onState: (state: ModelState) => void,
    onError?: (error: unknown) => void,
    intervalMs: number = MODEL_POLL_INTERVAL_MS,
  ): () => void {
    let stopped = false
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = (): void => {
      stopped = true
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const state = await this.getState()
        if (stopped) return
        onState(state)
        if (!shouldPollModelState(state)) stop()
      } catch (error) {
        if (stopped) return
        if (onError) onError(error)
        stop()
      }
    }
    timer = setInterval(() => {
      void tick()
    }, Math.max(250, intervalMs))
    return stop
  }

  private postBody(payload: Record<string, unknown>): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    }
  }
}

function readGlobalMode(): ModelApiMode {
  const globalObject = globalThis as { __EMOTION_MODEL_API_MODE__?: unknown }
  const explicit = globalObject.__EMOTION_MODEL_API_MODE__
  if (explicit === 'mock' || explicit === 'live') return explicit
  if (typeof window !== 'undefined' && typeof window.location !== 'undefined') {
    const search = window.location.search || ''
    if (search.indexOf('emotionModelMock=1') >= 0) return 'mock'
  }
  // Production default: strict live. Mock is opt-in only (issue #62 H4).
  return 'live'
}

let singleton: ModelApiClient | null = null

/** Shared client for the settings UI (host provides same-origin fetch). */
export function getModelApi(): ModelApiClient {
  if (singleton === null) {
    singleton = new ModelApiClient({ mode: readGlobalMode() })
  }
  return singleton
}

/** Create an isolated client (tests / storybook-like harnesses). */
export function createModelApi(options: ModelApiOptions = {}): ModelApiClient {
  return new ModelApiClient(options)
}

/** Reset the shared client (tests only). */
export function resetModelApi(): void {
  singleton = null
}
