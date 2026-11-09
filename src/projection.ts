/**
 * The `emotion` session projection unit.
 *
 * DSH drives projection units with a PURE SYNCHRONOUS fold over committed
 * session events (DSH 0.2.1-rc.2: `ctx.sessionProjections.register`). Model
 * inference is async, so the host hook appends a plugin record
 * (`plugin:emotion-analyzer/turn`) first; this unit folds that record through
 * the mapping layer. Replay/restart therefore reconstructs the exact state
 * without ever calling the model again.
 */
import { z } from 'zod'
import { getMappingProfile } from './models/profiles.ts'
import {
  TREND_LIMIT,
  emptyEmotionState,
  type EmotionProjectionState,
  type EmotionTurnRecord,
  type ScoreMap,
} from './types.ts'

/** The plugin record type this unit owns. */
export const EMOTION_RECORD_TYPE = 'plugin:emotion-analyzer/turn' as const

const scoreSchema = z.record(z.string(), z.number().finite().min(0).max(1))

const trendPointSchema = z.object({
  turn: z.number().int().nonnegative(),
  scores: scoreSchema,
})

/** Validates persisted state before it seeds a fold, and the wire payload. */
export const emotionStateSchema = z
  .object({
    version: z.literal(1),
    turn: z.number().int().nonnegative(),
    scores: scoreSchema,
    dominant: z.string(),
    trend: z.array(trendPointSchema).max(TREND_LIMIT),
    latencyMs: z.number().finite().nonnegative(),
    language: z.enum(['zh', 'en']),
    updatedAt: z.number().finite().nonnegative(),
    totalTurns: z.number().int().nonnegative(),
    turnScores: scoreSchema,
    turnDominant: z.string(),
  })
  .strict()

const turnRecordShape = {
  turn: z.number().int().positive(),
  raw: scoreSchema,
  latencyMs: z.number().finite().nonnegative(),
  language: z.enum(['zh', 'en']),
  textHash: z.string(),
  chars: z.number().int().nonnegative(),
  timestamp: z.number().finite().nonnegative(),
} as const

/** v0.1 记录：没有 modelId/profileId，fold 时走 legacy-11。 */
const turnRecordV1Schema = z.object({ version: z.literal(1), ...turnRecordShape }).strict()

/** v0.2 记录：携带模型与映射 profile，历史可跨模型切换稳定重放。 */
const turnRecordV2Schema = z
  .object({
    version: z.literal(2),
    ...turnRecordShape,
    modelId: z.string().optional(),
    profileId: z.string().optional(),
  })
  .strict()

/** Validates one plugin-record payload before folding it (v1 or v2). */
export const emotionTurnRecordSchema = z.union([turnRecordV1Schema, turnRecordV2Schema])

/** Pick the highest unified dimension; empty/all-zero falls back to neutral. */
export function dominantOf(scores: ScoreMap): string {
  let best = 'neutral'
  let bestScore = 0
  for (const [dimension, value] of Object.entries(scores)) {
    if (value > bestScore) {
      bestScore = value
      best = dimension
    }
  }
  return best
}

/**
 * Apply one turn record to the accumulated state (pure, idempotent per turn).
 * @param state - projection state before the record.
 * @param record - validated plugin-record payload.
 * @returns the next state, or the same reference for duplicate/stale turns.
 */
export function applyEmotionTurn(
  state: EmotionProjectionState,
  record: EmotionTurnRecord,
): EmotionProjectionState {
  if (record.turn <= state.turn) return state
  // v0.2: 历史记录自带 profile；v0.1 记录 / 未知 profile 回退 legacy-11，
  // 因此切换模型不会改变旧轮次的投影结果。
  const profile = getMappingProfile(record.profileId)
  const scores = profile.updateProjection(state.scores, record.raw) as ScoreMap
  // Per-turn raw aggregate (no STEP_MAX accumulation): the widget's "本回合"
  // bars and emoji read this, so a single joyful reply shows ~0.9 instead of 0.25.
  const turnScores = profile.aggregate(record.raw) as ScoreMap
  const trend = [...state.trend, { turn: record.turn, scores }].slice(-TREND_LIMIT)
  return {
    version: 1,
    turn: record.turn,
    scores,
    dominant: dominantOf(scores),
    trend,
    latencyMs: record.latencyMs,
    language: record.language,
    updatedAt: record.timestamp,
    totalTurns: state.totalTurns + 1,
    turnScores,
    turnDominant: dominantOf(turnScores),
  }
}

/** The projection unit definition passed to `ctx.sessionProjections.register`. */
export interface EmotionProjectionDefinition {
  key: 'emotion'
  stateVersion: number
  stateSchema: unknown
  init: () => EmotionProjectionState
  apply: (state: EmotionProjectionState, event: unknown) => EmotionProjectionState
  wire: {
    viewSchema: unknown
    view: (state: EmotionProjectionState) => EmotionProjectionState
  }
}

/**
 * Build the unit. The event is read through `pluginRecordOf` by the caller so
 * this module stays import-light and testable; `makeEmotionProjection`
 * receives that reader.
 * @param readRecord - `pluginRecordOf` from `@deepseek-ai/dsh-session`.
 * @returns the projection definition.
 */
export function makeEmotionProjection(
  readRecord: (event: unknown) => { type: string; data: unknown } | undefined,
): EmotionProjectionDefinition {
  return {
    key: 'emotion',
    // 4: v0.2 pluggable mapping profiles (#39); records carry profileId so
    // replay stays correct across model switches. Old cache rows refold from log.
    stateVersion: 4,
    stateSchema: emotionStateSchema,
    init: emptyEmotionState,
    apply(state, event) {
      const record = readRecord(event)
      if (record === undefined || record.type !== EMOTION_RECORD_TYPE) return state
      const parsed = emotionTurnRecordSchema.safeParse(record.data)
      if (!parsed.success) return state
      return applyEmotionTurn(state, parsed.data as EmotionTurnRecord)
    },
    wire: {
      viewSchema: emotionStateSchema,
      view: (state) => state,
    },
  }
}

/** Minimal registry surface this plugin needs (calibrated 0.2.2-rc.1). */
export interface SessionProjectionsLike {
  register(definition: EmotionProjectionDefinition): unknown
}

/**
 * Register the `emotion` unit. Registration rides the calling fiber as an
 * effect (DSH contract), so no manual unregister is needed.
 *
 * 0.2.2 起 `register()` 返回 Promise，契约要求调用方 await 注册完成后再发布
 * 消费者；这里返回 Promise 让 `apply` 能正确等待。
 *
 * @param registry - `ctx.sessionProjections`.
 * @param readRecord - `pluginRecordOf` implementation.
 * @returns whatever the registry returned (handle/disposer), for tests.
 */
export async function registerEmotionProjection(
  registry: SessionProjectionsLike,
  readRecord: (event: unknown) => { type: string; data: unknown } | undefined,
): Promise<unknown> {
  return await registry.register(makeEmotionProjection(readRecord))
}
