/**
 * OpenAI-compatible chat 打分通道（#41）。
 *
 * 默认通道仍是本地 ONNX；这里提供可选的第三方 API：
 * - 请求 `POST {baseUrl}/chat/completions`（OpenAI chat 协议）；
 * - 要求模型只输出 7 个统一维度的严格 JSON 分数（0–1）；
 * - 超时 / HTTP 错误 / JSON 非法 / 维度非法 / 密钥缺失统一抛
 *   {@link ApiScorerError}，由 service 决定回退本地还是跳过本轮；
 * - 只发送助手回复文本（截断到 4000 字符），不发送用户输入、会话 id 或密钥；
 *   密钥只从 `apiKeyEnv` 指向的环境变量读取，不落盘。
 *
 * 记录用 `profileId: 'unified-7'`（identity 映射），projection 重放不需要网络。
 */
import { EMOTION_DIMENSIONS, type EmotionDimension } from '../mapping.ts'
import { apiKeyOf, type ApiProviderSettings } from '../settings.ts'
import { truncateForScoring } from '../text.ts'

/** API 通道对应的映射 profile id。 */
export const API_PROFILE_ID = 'unified-7' as const

/** 发送到 API 的最大字符数（控制成本；与本地推理的截断口径一致）。 */
export const API_MAX_CHARS = 4000

/** 7 个统一维度的中文名（写进提示词，帮助模型理解）。 */
const DIMENSION_LABELS: Readonly<Record<EmotionDimension, string>> = {
  pleasant: '愉快',
  sad: '悲伤',
  angry: '愤怒',
  anxious: '焦虑',
  unwell: '反感',
  confused: '疑问',
  neutral: '平静',
}

/** API 通道错误码。 */
export type ApiScorerErrorCode =
  | 'missing_api_key'
  | 'http_error'
  | 'invalid_response'
  | 'timeout'
  | 'network'

/** API 通道错误（service 用它决定降级策略）。 */
export class ApiScorerError extends Error {
  readonly code: ApiScorerErrorCode

  constructor(code: ApiScorerErrorCode, message: string) {
    super(message)
    this.name = 'ApiScorerError'
    this.code = code
  }
}

/** 打分结果（7 维统一分数 + 耗时 + 模型名）。 */
export interface ApiScoreOutcome {
  readonly scores: Record<string, number>
  readonly latencyMs: number
  readonly modelId: string
}

/** `ApiScorer` 依赖注入。 */
export interface ApiScorerOptions {
  readonly provider: ApiProviderSettings
  readonly logger?: Pick<Console, 'warn' | 'error'>
  /** 测试注入 fetch（默认全局 fetch）。 */
  readonly fetchImpl?: typeof fetch
  /** 测试注入环境变量表（默认 process.env）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 测试注入时钟。 */
  readonly now?: () => number
}

/** 提示词：只输出 7 维 JSON，不要解释。 */
export function scoringSystemPrompt(): string {
  const lines = EMOTION_DIMENSIONS.map(
    (dimension) => `- ${dimension}（${DIMENSION_LABELS[dimension]}）`,
  ).join('\n')
  return [
    '你是情绪分析器。请阅读下面这段 AI 助手回复，给出 7 个情绪维度的强度分数。',
    '维度（键名固定，必须全部出现）：',
    lines,
    '规则：',
    '1. 每个分数是 0 到 1 之间的数字（可以小数），0 表示完全没有，1 表示极强。',
    '2. 只输出一个 JSON 对象，不要输出解释、Markdown、代码围栏或多余文字。',
    '3. 示例：{"pleasant":0.9,"sad":0.0,"angry":0.0,"anxious":0.0,"unwell":0.0,"confused":0.0,"neutral":0.2}',
  ].join('\n')
}

/** 构造 chat/completions 请求。 */
export function buildApiRequest(
  provider: ApiProviderSettings,
  apiKey: string | undefined,
  text: string,
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  }
  if (apiKey !== undefined) headers['authorization'] = `Bearer ${apiKey}`
  const body = {
    model: provider.model,
    temperature: 0,
    max_tokens: 300,
    stream: false,
    messages: [
      { role: 'system', content: scoringSystemPrompt() },
      { role: 'user', content: `助手回复：\n\n${truncateForScoring(text, API_MAX_CHARS)}` },
    ],
  }
  return {
    url: `${provider.baseUrl.replace(/\/+$/u, '')}/chat/completions`,
    init: { method: 'POST', headers, body: JSON.stringify(body) },
  }
}

/** 从 chat/completions 响应体里取 assistant 文本。 */
function contentOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const choices = (payload as Record<string, unknown>)['choices']
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  if (first === null || typeof first !== 'object') return undefined
  const message = (first as Record<string, unknown>)['message']
  if (message === null || typeof message !== 'object') return undefined
  const content = (message as Record<string, unknown>)['content']
  if (typeof content === 'string') return content
  // 部分兼容实现返回 content parts 数组。
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (part !== null && typeof part === 'object' && typeof (part as Record<string, unknown>)['text'] === 'string') {
        parts.push((part as Record<string, unknown>)['text'] as string)
      }
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return undefined
}

/** 去掉 Markdown 代码围栏 / 前后杂字，取第一个 JSON 对象。 */
function extractJsonObject(content: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(content)
  const candidate = (fenced?.[1] ?? content).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  return candidate.slice(start, end + 1)
}

/**
 * 解析模型输出为 7 维分数。
 *
 * - 容忍代码围栏与前后文字；
 * - 只接受 7 个已知维度；未知键丢弃；
 * - 缺失维度按 0；出现的维度必须是 0–1 的有限数字，否则整体判为非法；
 * - 一个合法维度都没有时返回 undefined。
 *
 * @param content - assistant 文本。
 * @returns 7 维分数（缺失补 0），或 undefined。
 */
export function parseScoreContent(content: string): Record<string, number> | undefined {
  const json = extractJsonObject(content)
  if (json === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const scores: Record<string, number> = {}
  let valid = 0
  for (const dimension of EMOTION_DIMENSIONS) {
    if (!Object.prototype.hasOwnProperty.call(record, dimension)) continue
    const value = record[dimension]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return undefined
    scores[dimension] = value
    valid += 1
  }
  if (valid === 0) return undefined
  for (const dimension of EMOTION_DIMENSIONS) {
    if (scores[dimension] === undefined) scores[dimension] = 0
  }
  return scores
}

/** 判断一个错误是否是超时（AbortSignal.timeout 的 DOMException）。 */
function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  return name === 'TimeoutError' || name === 'AbortError'
}

/** OpenAI-compatible 打分器。 */
export class ApiScorer {
  private readonly provider: ApiProviderSettings
  private readonly logger: Pick<Console, 'warn' | 'error'>
  private readonly fetchImpl: typeof fetch
  private readonly env: Readonly<Record<string, string | undefined>>
  private readonly now: () => number

  constructor(options: ApiScorerOptions) {
    this.provider = options.provider
    this.logger = options.logger ?? console
    this.fetchImpl = options.fetchImpl ?? fetch
    this.env = options.env ?? process.env
    this.now = options.now ?? (() => Date.now())
  }

  /** 当前 provider 配置（只读）。 */
  get settings(): ApiProviderSettings {
    return this.provider
  }

  /**
   * 对文本打分。
   * @param text - 助手回复文本。
   * @returns 7 维分数与耗时。
   * @throws {ApiScorerError} 密钥缺失 / 超时 / HTTP 错误 / 响应非法。
   */
  async score(text: string): Promise<ApiScoreOutcome> {
    const apiKey = apiKeyOf(this.provider, this.env)
    if (this.provider.apiKeyEnv !== undefined && apiKey === undefined) {
      throw new ApiScorerError(
        'missing_api_key',
        `环境变量 ${this.provider.apiKeyEnv} 未设置（API 密钥只从环境变量读取，不落盘）`,
      )
    }
    const { url, init } = buildApiRequest(this.provider, apiKey, text)
    const timeoutMs = this.provider.timeoutMs ?? 8000
    const startedAt = this.now()
    let response: Response
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      if (isAbortError(error)) {
        throw new ApiScorerError('timeout', `API 请求超时（${timeoutMs}ms）`)
      }
      throw new ApiScorerError('network', `API 请求失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 200)
      } catch {
        // ignore body read failures
      }
      throw new ApiScorerError('http_error', `API 返回 HTTP ${response.status}${detail === '' ? '' : `：${detail}`}`)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new ApiScorerError('invalid_response', 'API 响应不是合法 JSON')
    }
    const content = contentOf(payload)
    if (content === undefined) {
      throw new ApiScorerError('invalid_response', 'API 响应缺少 choices[0].message.content')
    }
    const scores = parseScoreContent(content)
    if (scores === undefined) {
      throw new ApiScorerError('invalid_response', 'API 输出不是合法的 7 维分数 JSON')
    }
    return { scores, latencyMs: Math.max(0, this.now() - startedAt), modelId: this.provider.model }
  }
}
