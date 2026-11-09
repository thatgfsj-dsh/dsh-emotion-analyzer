import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canSelectPreset,
  downloadIsActive,
  downloadLine,
  formatModelMeta,
  modelBadges,
  presetAction,
  scoreRows,
} from '../src/client/settings-models.ts'
import {
  normalizeModelState,
  normalizePreset,
  type ModelPreset,
  type ModelState,
} from '../src/client/model-api.ts'

function preset(overrides: Partial<ModelPreset> = {}): ModelPreset {
  return {
    id: 'horizon-small',
    name: 'Horizon Small',
    languages: 36,
    labels: 28,
    sizeBytes: 256 * 1024 * 1024,
    license: 'Apache-2.0',
    legacy: false,
    fallback: false,
    installed: true,
    downloadable: true,
    needsExport: false,
    recommended: true,
    ...overrides,
  }
}

function state(overrides: Partial<ModelState> = {}): ModelState {
  return {
    current: preset(),
    presets: [preset()],
    selectedModelId: 'horizon-small',
    activeModelId: 'horizon-small',
    effectiveModelId: 'horizon-small',
    effectiveFallback: false,
    runtimeError: null,
    download: null,
    needsExport: false,
    fallback: false,
    warnings: [],
    source: 'live',
    provider: { type: 'local', ready: true, error: null },
    ...overrides,
  }
}

test('formatModelMeta: language/label/size/licence line', () => {
  assert.equal(formatModelMeta(preset()), '36 语言 · 28 标签 · 256 MiB · Apache-2.0')
  assert.equal(
    formatModelMeta(preset({ languages: 1, languageCodes: ['zh'], labels: 8, sizeBytes: 279 * 1024 * 1024, license: 'MIT' })),
    '中文 · 8 标签 · 279 MiB · MIT',
  )
  assert.equal(formatModelMeta(preset({ languages: 0, labels: 0, sizeBytes: undefined, license: '' })), '')
  assert.equal(formatModelMeta(null), '')
})

test('modelBadges: recommended/legacy/fallback/export/installed', () => {
  assert.deepEqual(modelBadges(preset()), ['推荐', '已安装'])
  assert.deepEqual(modelBadges(preset({ recommended: false })), ['已安装'])
  assert.deepEqual(modelBadges(preset({ default: true, recommended: false })), ['默认', '已安装'])
  assert.deepEqual(
    modelBadges(preset({ recommended: false, legacy: true, fallback: true, installed: false })),
    ['回退默认'],
  )
  assert.deepEqual(
    modelBadges(preset({ recommended: false, installed: false, needsExport: true })),
    ['需本地导出（建议大肥鱼帮助）'],
  )
  assert.deepEqual(modelBadges(null), [])
})

test('downloadIsActive: queued/downloading/verifying/installing', () => {
  assert.equal(downloadIsActive(null), false)
  assert.equal(downloadIsActive(state()), false)
  for (const status of ['queued', 'downloading', 'verifying', 'installing'] as const) {
    assert.equal(downloadIsActive(state({ download: { status, percent: 10 } })), true, status)
  }
  for (const status of ['complete', 'failed', 'cancelled', 'idle'] as const) {
    assert.equal(downloadIsActive(state({ download: { status, percent: 10 } })), false, status)
  }
})

test('presetAction: download / cancel / delete / export / disabled', () => {
  const installed = preset()
  assert.deepEqual(presetAction(installed, state(), false), { kind: 'delete', label: '删除', disabled: false })

  const notInstalled = preset({ id: 'horizon-base', installed: false })
  assert.deepEqual(presetAction(notInstalled, state(), false), { kind: 'download', label: '下载', disabled: false })

  const downloadingState = state({
    download: { id: 'horizon-base', status: 'downloading', percent: 30 },
  })
  assert.deepEqual(presetAction(notInstalled, downloadingState, false), { kind: 'cancel', label: '取消下载', disabled: false })
  assert.deepEqual(presetAction(installed, downloadingState, false), { kind: 'delete', label: '删除', disabled: true })

  const exportPreset = preset({ id: 'zh', installed: false, downloadable: false, needsExport: true })
  assert.deepEqual(presetAction(exportPreset, state(), false), { kind: 'export', label: '需本地导出', disabled: true })
  assert.deepEqual(presetAction(preset({ downloadable: false, installed: false }), state(), false), {
    kind: 'export',
    label: '不可在线下载',
    disabled: true,
  })
  assert.deepEqual(presetAction(notInstalled, state(), true), { kind: 'none', label: '等待下载完成', disabled: true })
})

test('canSelectPreset: only installed + not active + idle', () => {
  assert.equal(canSelectPreset(preset(), state(), false), false, 'active model is not re-selectable')
  assert.equal(canSelectPreset(preset({ id: 'other', installed: true }), state(), false), true)
  assert.equal(canSelectPreset(preset({ id: 'other', installed: false }), state(), false), false)
  assert.equal(canSelectPreset(preset({ id: 'other', installed: true }), state(), true), false)
  assert.equal(
    canSelectPreset(preset({ id: 'other', installed: true }), state({ download: { id: 'x', status: 'downloading', percent: 1 } }), false),
    false,
  )
})

test('scoreRows: seven unified rows in order, percent/clamp, extras', () => {
  const rows = scoreRows({ pleasant: 0.8, sad: -1, angry: 45, anxious: 0.4, neutral: 1, weird: 0.5 })
  assert.deepEqual(
    rows.map((row) => row.key),
    ['pleasant', 'sad', 'angry', 'anxious', 'unwell', 'confused', 'neutral', 'weird'],
  )
  assert.equal(rows[0]?.label, '愉快')
  assert.equal(rows[0]?.percent, 80)
  assert.equal(rows[1]?.percent, 0)
  assert.equal(rows[2]?.percent, 45)
  assert.equal(rows[6]?.percent, 100)
  assert.equal(rows[7]?.label, 'weird')
  assert.equal(rows[7]?.color, '#8A93A3')
  assert.deepEqual(scoreRows(null).map((row) => row.percent), [0, 0, 0, 0, 0, 0, 0])
})

test('downloadLine: progress, completion and failure copy', () => {
  assert.match(downloadLine({ status: 'downloading', percent: 42, bytesDone: 168, bytesTotal: 400 }), /下载中 42%/)
  assert.equal(downloadLine({ status: 'complete', percent: 100 }), '下载完成，可以切换到该模型。')
  assert.match(downloadLine({ status: 'failed', percent: 30, error: '校验失败' }), /下载失败：校验失败/)
  assert.equal(downloadLine(null), '')
})

test('normalized state feeds the UI helpers', () => {
  const normalized = normalizeModelState({
    current: { id: 'horizon-small', installed: true },
    models: [
      { id: 'horizon-small', installed: true },
      { id: 'horizon-base', installed: false },
    ],
    activeModelId: 'horizon-small',
  })
  assert.equal(formatModelMeta(normalized.current).includes('未标注'), true)
  assert.equal(downloadIsActive(normalized), false)
  assert.equal(presetAction(normalizePreset({ id: 'horizon-base' })!, normalized, false).kind, 'download')
})
