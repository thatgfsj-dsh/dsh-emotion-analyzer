/**
 * 映射 profile 单测（v0.2 / issue #39）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GO_EMOTION_LABELS,
  MAPPING_PROFILE_IDS,
  MAPPING_PROFILES,
  ZH_EMOTION_LABELS,
  ZH_LABEL_NAMES,
  getMappingProfile,
  isMappingProfileId,
  termsOf,
  type MappingProfileId,
} from '../src/models/profiles.ts'
import { EMOTION_DIMENSIONS, RAW_EMOTION_LABELS, emptyProjection, type EmotionScores } from '../src/mapping.ts'

function close(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} ≈ ${expected}`)
}

/** 每个标签单独输入时，至少点亮一个统一维度。 */
function everyLabelHasHome(profileId: MappingProfileId): void {
  const profile = MAPPING_PROFILES[profileId]
  for (const label of profile.labels) {
    const scores = profile.aggregate({ [label]: 1 })
    const total = EMOTION_DIMENSIONS.reduce((sum, dimension) => sum + scores[dimension], 0)
    assert.ok(total > 0, `profile ${profileId} 的标签 ${label} 没有映射到任何维度`)
  }
}

test('profile 注册表：四个 profile、标签顺序与 lib 常量一致', () => {
  assert.deepEqual([...MAPPING_PROFILE_IDS], ['legacy-11', 'go-emotions-28', 'zh-8', 'unified-7'])
  assert.deepEqual(MAPPING_PROFILES['legacy-11'].labels, [...RAW_EMOTION_LABELS])
  assert.deepEqual(MAPPING_PROFILES['go-emotions-28'].labels, [...GO_EMOTION_LABELS])
  assert.deepEqual(MAPPING_PROFILES['zh-8'].labels, [...ZH_EMOTION_LABELS])
  assert.deepEqual(MAPPING_PROFILES['unified-7'].labels, ['pleasant', 'sad', 'angry', 'anxious', 'unwell', 'confused', 'neutral'])
  assert.equal(GO_EMOTION_LABELS.length, 28)
  assert.equal(ZH_EMOTION_LABELS.length, 8)
  assert.equal(ZH_LABEL_NAMES['LABEL_2'], '开心')
  assert.equal(isMappingProfileId('go-emotions-28'), true)
  assert.equal(isMappingProfileId('nope'), false)
})

test('未知 / 缺失 profileId 回退 legacy-11（旧记录重放兼容）', () => {
  assert.equal(getMappingProfile(undefined).id, 'legacy-11')
  assert.equal(getMappingProfile(null).id, 'legacy-11')
  assert.equal(getMappingProfile('unknown-profile').id, 'legacy-11')
  assert.equal(getMappingProfile('zh-8').id, 'zh-8')
})

test('所有 profile 的每个标签都有归属', () => {
  everyLabelHasHome('legacy-11')
  everyLabelHasHome('go-emotions-28')
  everyLabelHasHome('zh-8')
  everyLabelHasHome('unified-7')
})

test('go-emotions-28 分组：pleasant/sad/angry/anxious/unwell/confused/neutral', () => {
  const profile = MAPPING_PROFILES['go-emotions-28']
  close(profile.aggregate({ joy: 0.9 }).pleasant, 0.9)
  close(profile.aggregate({ desire: 0.7 }).pleasant, 0.7)
  close(profile.aggregate({ admiration: 0.6 }).pleasant, 0.6)
  close(profile.aggregate({ grief: 0.8 }).sad, 0.8)
  close(profile.aggregate({ remorse: 0.5 }).sad, 0.5)
  close(profile.aggregate({ annoyance: 0.75 }).angry, 0.75)
  close(profile.aggregate({ disapproval: 0.4 }).angry, 0.4)
  close(profile.aggregate({ nervousness: 0.65 }).anxious, 0.65)
  close(profile.aggregate({ disgust: 0.55 }).unwell, 0.55)
  close(profile.aggregate({ embarrassment: 0.45 }).unwell, 0.45)
  close(profile.aggregate({ confusion: 0.9 }).confused, 0.9)
  close(profile.aggregate({ curiosity: 0.3 }).confused, 0.3)
  close(profile.aggregate({ neutral: 0.8 }).neutral, 0.8)
  // GoEmotions 的 28 标签互不重叠地归属（desire 补进 pleasant）
  assert.deepEqual(termsOf(profile, 'sad'), ['sadness', 'disappointment', 'grief', 'remorse'])
  assert.equal(termsOf(profile, 'angry').includes('disgust'), false)
  assert.equal(termsOf(profile, 'unwell').includes('disgust'), true)
})

test('zh-8 分组：8 个中文标签语义映射', () => {
  const profile = MAPPING_PROFILES['zh-8']
  close(profile.aggregate({ LABEL_0: 0.9 }).neutral, 0.9)
  close(profile.aggregate({ LABEL_1: 0.9 }).anxious, 0.9)
  close(profile.aggregate({ LABEL_2: 0.9 }).pleasant, 0.9)
  close(profile.aggregate({ LABEL_3: 0.9 }).angry, 0.9)
  close(profile.aggregate({ LABEL_4: 0.9 }).sad, 0.9)
  close(profile.aggregate({ LABEL_5: 0.9 }).confused, 0.9)
  close(profile.aggregate({ LABEL_6: 0.9 }).confused, 0.9)
  close(profile.aggregate({ LABEL_7: 0.9 }).unwell, 0.9)
})

test('profile.updateProjection 使用各自的规则（不会把 28 标签当 11 标签）', () => {
  const go = MAPPING_PROFILES['go-emotions-28']
  const legacy = MAPPING_PROFILES['legacy-11']
  const base: EmotionScores = emptyProjection()
  // go-emotions 的 joy 与 legacy 的 joy 都能推高 pleasant
  assert.ok((go.updateProjection(base, { joy: 0.95 })['pleasant'] ?? 0) > 0)
  assert.ok((legacy.updateProjection(base, { joy: 0.95 })['pleasant'] ?? 0) > 0)
  // legacy 不认识的 GoEmotions 标签不产生任何维度变化（视为无输入 → 衰减）
  assert.deepEqual(legacy.updateProjection({ ...base, sad: 0.5 }, { grief: 0.95 }), { ...base, sad: 0.5 * 0.85 })
  // zh profile 只认 LABEL_*
  assert.equal(zhProjectionHasEffect('LABEL_4'), true)
  assert.equal(zhProjectionHasEffect('sadness'), false)
})

function zhProjectionHasEffect(label: string): boolean {
  const profile = MAPPING_PROFILES['zh-8']
  const next = profile.updateProjection(emptyProjection(), { [label]: 0.9 })
  return EMOTION_DIMENSIONS.some((dimension) => (next[dimension] as number) > 0)
}

test('doubt 派生信号进入模型 profile 的 confused 维度（unified-7 直出 7 维，无 doubt）', () => {
  for (const id of ['legacy-11', 'go-emotions-28', 'zh-8'] as const) {
    const profile = MAPPING_PROFILES[id]
    close(profile.aggregate({ doubt: 0.5 }).confused, 0.5)
  }
  // unified-7 是 identity 映射：doubt 不属于 7 维，必须被忽略。
  close(MAPPING_PROFILES['unified-7'].aggregate({ doubt: 0.5 }).confused, 0)
})
