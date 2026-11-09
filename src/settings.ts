/**
 * 插件设置持久化（v0.2 / issue #39）。
 *
 * 设置存放在 `$DSH_HOME/emotion-analyzer/config.json`（DSH_HOME 未设置时
 * 回退 `~/.dsh`）。模型文件放在同目录的 `models/<modelId>/`。
 * 写入使用“写临时文件 → rename”的原子替换，避免进程中断留下半个 JSON。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_MODEL_ID } from './models/registry.ts'

/** 本地 ONNX 打分通道（默认）。 */
export interface LocalProviderSettings {
  readonly type: 'local'
  /** @deprecated v0.2 预留字段，保留兼容读取；本地通道不使用。 */
  readonly apiKeyEnv?: string
}

/** OpenAI-compatible chat 打分通道（#41）。 */
export interface ApiProviderSettings {
  readonly type: 'api'
  /** API 根地址，例如 `https://api.example.com/v1`（不含 `/chat/completions`）。 */
  readonly baseUrl: string
  /** 模型名，原样放进请求体。 */
  readonly model: string
  /** 读取密钥的环境变量名；不落盘密钥本身。 */
  readonly apiKeyEnv?: string
  /** 单次请求超时（毫秒），1000–60000，默认 8000。 */
  readonly timeoutMs?: number
}

/** 当前 provider 形态：本地 ONNX 或自定义 API。 */
export type ProviderSettings = LocalProviderSettings | ApiProviderSettings

/** API 通道默认 / 边界超时。 */
export const DEFAULT_API_TIMEOUT_MS = 8000
export const MIN_API_TIMEOUT_MS = 1000
export const MAX_API_TIMEOUT_MS = 60_000

/** 环境变量名允许的字符集（不读取值）。 */
const API_KEY_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** 校验并规范化 API provider 配置。 */
export function validateApiProvider(value: unknown): { settings?: ApiProviderSettings; error?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'provider 必须是 JSON 对象' }
  }
  const record = value as Record<string, unknown>
  const rawBaseUrl = record['baseUrl']
  if (typeof rawBaseUrl !== 'string' || rawBaseUrl.trim().length === 0) {
    return { error: 'API 模式需要 baseUrl' }
  }
  const baseUrl = rawBaseUrl.trim().replace(/\/+$/u, '')
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return { error: 'baseUrl 不是合法 URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'baseUrl 只支持 http/https' }
  }
  const rawModel = record['model']
  if (typeof rawModel !== 'string' || rawModel.trim().length === 0) {
    return { error: 'API 模式需要 model' }
  }
  const model = rawModel.trim()
  if (model.length > 200) return { error: 'model 名称过长（>200）' }

  let apiKeyEnv: string | undefined
  const rawKeyEnv = record['apiKeyEnv']
  if (rawKeyEnv !== undefined && rawKeyEnv !== null && rawKeyEnv !== '') {
    if (typeof rawKeyEnv !== 'string' || !API_KEY_ENV_RE.test(rawKeyEnv.trim())) {
      return { error: 'apiKeyEnv 必须是合法的环境变量名' }
    }
    apiKeyEnv = rawKeyEnv.trim()
  }

  let timeoutMs: number | undefined
  const rawTimeout = record['timeoutMs']
  if (rawTimeout !== undefined && rawTimeout !== null) {
    if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout)) {
      return { error: 'timeoutMs 必须是数字' }
    }
    timeoutMs = Math.min(MAX_API_TIMEOUT_MS, Math.max(MIN_API_TIMEOUT_MS, Math.round(rawTimeout)))
  }

  return {
    settings: {
      type: 'api',
      baseUrl,
      model,
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  }
}

/**
 * 读取 API 密钥：只从环境变量取，不落盘。
 * @param provider - API provider 配置。
 * @param env - 环境变量表（测试可注入）。
 * @returns 密钥值；未配置 apiKeyEnv 或变量为空时 undefined。
 */
export function apiKeyOf(
  provider: ApiProviderSettings,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (provider.apiKeyEnv === undefined) return undefined
  const value = env[provider.apiKeyEnv]
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  return value.trim()
}

/** 插件设置。 */
export interface PluginSettings {
  /** 用户选择的模型 id（可能尚未下载，service 会回退 legacy）。 */
  readonly activeModelId: string
  readonly provider: ProviderSettings
}

/** 默认设置：默认模型是 Horizon small（下载缺失时回退 legacy）。 */
export const DEFAULT_SETTINGS: PluginSettings = {
  activeModelId: DEFAULT_MODEL_ID,
  provider: { type: 'local' },
}

/** DSH 数据根目录。 */
export function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 插件数据目录（设置 + 模型）。 */
export function pluginDataDir(baseDir: string = dshHome()): string {
  return join(baseDir, 'emotion-analyzer')
}

/** 配置文件路径。 */
export function pluginConfigPath(baseDir: string = dshHome()): string {
  return join(pluginDataDir(baseDir), 'config.json')
}

/** 模型下载根目录（`models/<id>/`）。 */
export function modelsDir(baseDir: string = dshHome()): string {
  return join(pluginDataDir(baseDir), 'models')
}

/** 设置读写选项；测试可注入临时目录和静音 logger。 */
export interface SettingsOptions {
  /** DSH_HOME 等价根目录，默认 {@link dshHome}。 */
  readonly baseDir?: string
  /** 日志出口，默认 console。 */
  readonly logger?: Pick<Console, 'warn' | 'error'> | undefined
}

/**
 * 把任意 JSON 规范化为合法设置；非法字段回退默认值，未知字段丢弃。
 * @param raw - `JSON.parse` 的结果。
 * @returns 完整、安全的设置对象。
 */
export function normalizeSettings(raw: unknown): PluginSettings {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_SETTINGS
  const record = raw as Record<string, unknown>
  const activeModelId =
    typeof record['activeModelId'] === 'string' && record['activeModelId'].trim().length > 0
      ? record['activeModelId'].trim()
      : DEFAULT_SETTINGS.activeModelId

  const rawProvider = record['provider']
  const providerRecord =
    rawProvider !== null && typeof rawProvider === 'object' && !Array.isArray(rawProvider)
      ? (rawProvider as Record<string, unknown>)
      : {}

  let provider: ProviderSettings = { type: 'local' }
  if (providerRecord['type'] === 'api') {
    // 非法 API 配置回退本地（安全默认）：不让一个坏配置把插件锁死。
    const validated = validateApiProvider(providerRecord)
    provider = validated.settings ?? { type: 'local' }
  } else {
    const apiKeyEnv =
      typeof providerRecord['apiKeyEnv'] === 'string' && providerRecord['apiKeyEnv'].trim().length > 0
        ? providerRecord['apiKeyEnv'].trim()
        : undefined
    provider = apiKeyEnv === undefined ? { type: 'local' } : { type: 'local', apiKeyEnv }
  }

  return { activeModelId, provider }
}

/**
 * 读取设置文件；文件缺失 / JSON 损坏 / 字段非法时返回默认值并打 warning。
 * @param options - 目录与 logger 覆盖。
 * @returns 设置对象（永不抛异常）。
 */
export async function loadSettings(options: SettingsOptions = {}): Promise<PluginSettings> {
  const file = pluginConfigPath(options.baseDir)
  if (!existsSync(file)) return DEFAULT_SETTINGS
  try {
    const text = await readFile(file, 'utf8')
    return normalizeSettings(JSON.parse(text))
  } catch (error) {
    options.logger?.warn?.(`[emotion] 读取设置失败，使用默认值：${String(error)}`)
    return DEFAULT_SETTINGS
  }
}

/**
 * 原子写入设置文件。
 * @param settings - 设置对象（会先规范化）。
 * @param options - 目录覆盖。
 */
export async function saveSettings(settings: PluginSettings, options: SettingsOptions = {}): Promise<void> {
  const normalized = normalizeSettings(settings)
  const file = pluginConfigPath(options.baseDir)
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const temp = join(dir, `config.json.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}
