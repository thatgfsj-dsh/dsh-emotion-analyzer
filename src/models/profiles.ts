/**
 * 模型输出标签 → 7 个统一维度的映射 profile（v0.2 / issue #39）。
 *
 * 不同模型的标签空间完全不同：
 * - `legacy-11`：tabularisai 的 11 标签（v0.1 行为，保持不变）；
 * - `go-emotions-28`：GoEmotions 的 28 标签（Horizon small/base）；
 * - `zh-8`：Johnson8187/Chinese-Emotion-Small 的 8 个中文标签。
 *
 * profile 是纯数据 + 纯函数：projection 重放只需要 `profileId`，不需要访问磁盘
 * 或 ONNX，因此历史记录可以跨模型切换稳定重建。
 */
import {
  EMOTION_DIMENSIONS,
  EMOTION_MAP,
  RAW_EMOTION_LABELS,
  aggregateWithRules,
  updateProjectionWithRules,
  type EmotionDimension,
  type EmotionRule,
  type EmotionScores,
  type RawScores,
  type RuleMap,
} from '../mapping.ts'

/** 支持的映射 profile id。 */
export const MAPPING_PROFILE_IDS = ['legacy-11', 'go-emotions-28', 'zh-8', 'unified-7'] as const
/** 映射 profile id。 */
export type MappingProfileId = (typeof MAPPING_PROFILE_IDS)[number]

/** GoEmotions 28 标签，顺序必须与模型 config.json 的 id2label 完全一致。 */
export const GO_EMOTION_LABELS = [
  'admiration',
  'amusement',
  'anger',
  'annoyance',
  'approval',
  'caring',
  'confusion',
  'curiosity',
  'desire',
  'disappointment',
  'disapproval',
  'disgust',
  'embarrassment',
  'excitement',
  'fear',
  'gratitude',
  'grief',
  'joy',
  'love',
  'nervousness',
  'optimism',
  'pride',
  'realization',
  'relief',
  'remorse',
  'sadness',
  'surprise',
  'neutral',
] as const

/**
 * Johnson8187/Chinese-Emotion-Small 的 8 个标签。
 * 上游 config.json 只有 LABEL_0..7；语义来自模型卡：
 * 0 平淡 / 1 关切 / 2 开心 / 3 愤怒 / 4 悲伤 / 5 疑问 / 6 惊奇 / 7 厌恶。
 */
export const ZH_EMOTION_LABELS = [
  'LABEL_0',
  'LABEL_1',
  'LABEL_2',
  'LABEL_3',
  'LABEL_4',
  'LABEL_5',
  'LABEL_6',
  'LABEL_7',
] as const

/** 中文标签的可读语义（文档 / UI 用；不参与推理）。 */
export const ZH_LABEL_NAMES: Readonly<Record<string, string>> = {
  LABEL_0: '平淡',
  LABEL_1: '关切',
  LABEL_2: '开心',
  LABEL_3: '愤怒',
  LABEL_4: '悲伤',
  LABEL_5: '疑问',
  LABEL_6: '惊奇',
  LABEL_7: '厌恶',
}

/** 一个模型的完整映射 profile。 */
export interface MappingProfile {
  readonly id: MappingProfileId
  /** 人类可读名称（日志 / 设置页）。 */
  readonly label: string
  /** 模型输出标签顺序（必须与 id2label 一致）。 */
  readonly labels: readonly string[]
  /** 标签 → 7 维规则。 */
  readonly rules: RuleMap
  /** 用本 profile 聚合原始分数。 */
  aggregate(raw: RawScores | null | undefined): EmotionScores
  /** 用本 profile 更新累积投影。 */
  updateProjection(current: Record<string, number>, raw: Record<string, number>): Record<string, number>
}

/** 构造一个 `max` 规则。 */
function maxRule(...labels: string[]): EmotionRule {
  return { kind: 'max', terms: labels.map((label) => [label, 1] as const) }
}

/** 校验规则只引用模型标签或白名单里的派生信号。 */
function defineProfile(options: {
  id: MappingProfileId
  label: string
  labels: readonly string[]
  derivedLabels: readonly string[]
  rules: RuleMap
}): MappingProfile {
  const known = new Set([...options.labels, ...options.derivedLabels])
  for (const dimension of EMOTION_DIMENSIONS) {
    for (const [label] of options.rules[dimension].terms) {
      if (!known.has(label)) {
        throw new Error(`mapping profile ${options.id}: 维度 ${dimension} 引用了未知标签 ${label}`)
      }
    }
  }
  return {
    id: options.id,
    label: options.label,
    labels: options.labels,
    rules: options.rules,
    aggregate: (raw) => aggregateWithRules(options.rules, raw),
    updateProjection: (current, raw) => updateProjectionWithRules(options.rules, current, raw),
  }
}

const legacyProfile = defineProfile({
  id: 'legacy-11',
  label: 'tabularisai 11 标签（v0.1 兼容）',
  labels: RAW_EMOTION_LABELS,
  derivedLabels: ['doubt'],
  rules: EMOTION_MAP,
})

/**
 * GoEmotions 28 标签 → 7 维初版映射（issue #39）。
 *
 * 任务给定的分组基础上补了 `desire`（正向愿望，归 pleasant），保证 28 个
 * 标签全部有归属；`doubt` 仍作为宿主文本启发式并入 confused。
 */
const goEmotionsProfile = defineProfile({
  id: 'go-emotions-28',
  label: 'GoEmotions 28 标签（Horizon small/base）',
  labels: GO_EMOTION_LABELS,
  derivedLabels: ['doubt'],
  rules: {
    pleasant: maxRule(
      'joy',
      'amusement',
      'admiration',
      'approval',
      'caring',
      'gratitude',
      'love',
      'optimism',
      'pride',
      'excitement',
      'relief',
      'desire',
    ),
    sad: maxRule('sadness', 'disappointment', 'grief', 'remorse'),
    angry: maxRule('anger', 'annoyance', 'disapproval'),
    anxious: maxRule('fear', 'nervousness'),
    unwell: maxRule('disgust', 'embarrassment'),
    confused: maxRule('confusion', 'curiosity', 'surprise', 'realization', 'doubt'),
    neutral: maxRule('neutral'),
  },
})

/**
 * 中文 8 标签 → 7 维映射：
 * 平淡→neutral、关切→anxious（在意/担忧）、开心→pleasant、愤怒→angry、
 * 悲伤→sad、疑问+惊奇→confused、厌恶→unwell；`doubt` 同样并入 confused。
 */
const zhProfile = defineProfile({
  id: 'zh-8',
  label: '中文 8 标签（Johnson8187/Chinese-Emotion-Small）',
  labels: ZH_EMOTION_LABELS,
  derivedLabels: ['doubt'],
  rules: {
    pleasant: maxRule('LABEL_2'),
    sad: maxRule('LABEL_4'),
    angry: maxRule('LABEL_3'),
    anxious: maxRule('LABEL_1'),
    unwell: maxRule('LABEL_7'),
    confused: maxRule('LABEL_5', 'LABEL_6', 'doubt'),
    neutral: maxRule('LABEL_0'),
  },
})

/**
 * 统一 7 维（自定义 API 直出，#41）。
 *
 * API 通道让模型直接输出 7 个统一维度分数，因此这里是 identity 映射：
 * 每个维度只由同名标签驱动。记录带 `profileId: 'unified-7'`，projection
 * 重放不需要访问网络或模型。
 */
const unifiedProfile = defineProfile({
  id: 'unified-7',
  label: '统一 7 维（自定义 API 直出）',
  labels: EMOTION_DIMENSIONS,
  derivedLabels: [],
  rules: {
    pleasant: maxRule('pleasant'),
    sad: maxRule('sad'),
    angry: maxRule('angry'),
    anxious: maxRule('anxious'),
    unwell: maxRule('unwell'),
    confused: maxRule('confused'),
    neutral: maxRule('neutral'),
  },
})

/** 所有内置 profile。 */
export const MAPPING_PROFILES: Readonly<Record<MappingProfileId, MappingProfile>> = {
  'legacy-11': legacyProfile,
  'go-emotions-28': goEmotionsProfile,
  'zh-8': zhProfile,
  'unified-7': unifiedProfile,
}

/** 判断任意字符串是否是已知 profile id。 */
export function isMappingProfileId(value: unknown): value is MappingProfileId {
  return typeof value === 'string' && (MAPPING_PROFILE_IDS as readonly string[]).includes(value)
}

/**
 * 取 profile；未知 id 回退 legacy-11（旧记录没有 profileId 时也走这里）。
 * @param id - profile id，可空。
 * @returns 对应的纯函数 profile。
 */
export function getMappingProfile(id: string | null | undefined): MappingProfile {
  return isMappingProfileId(id) ? MAPPING_PROFILES[id] : legacyProfile
}

/** 每个统一维度在指定 profile 下由哪些标签驱动（测试 / 文档用）。 */
export function termsOf(profile: MappingProfile, dimension: EmotionDimension): readonly string[] {
  return profile.rules[dimension].terms.map(([label]) => label)
}
