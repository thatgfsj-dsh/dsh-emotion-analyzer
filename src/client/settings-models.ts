/**
 * dsh-emotion-analyzer — Settings → 情绪分析器 → 模型 section (issue #40).
 *
 * Rendered into the existing settings.section slot; no new route. The
 * component is intentionally defensive: every network call is wrapped in
 * try/catch and failures render an inline alert instead of throwing through
 * the slot renderer.
 */
import {
  MODEL_POLL_INTERVAL_MS,
  describeApiError,
  downloadPercent,
  formatBytes,
  formatProgress,
  getModelApi,
  isActiveDownloadStatus,
  type ModelApiClient,
  type ModelDownload,
  type ModelPreset,
  type ModelState,
  type ModelTestResult,
} from './model-api.ts'
import { createProviderSection } from './settings-provider.ts'

export interface ModelDisplayRow {
  key: string
  label: string
  color: string
  percent: number
  value: number
}

/** Order / labels / colours shared with the floating widget. */
export const UI_DIMENSIONS: ReadonlyArray<{ key: string; label: string; color: string }> = [
  { key: 'pleasant', label: '愉快', color: '#F5B301' },
  { key: 'sad', label: '悲伤', color: '#4C8DF6' },
  { key: 'angry', label: '愤怒', color: '#E5484D' },
  { key: 'anxious', label: '焦虑', color: '#A855F7' },
  { key: 'unwell', label: '反感', color: '#7C9A3B' },
  { key: 'confused', label: '疑问', color: '#0891B2' },
  { key: 'neutral', label: '平静', color: '#8A93A3' },
]

export type PresetActionKind = 'download' | 'cancel' | 'delete' | 'export' | 'none'

export interface PresetAction {
  kind: PresetActionKind
  label: string
  disabled: boolean
}

/** Locale-ish one-line preset summary. */
export function formatModelMeta(preset: ModelPreset | null | undefined): string {
  if (!preset) return ''
  const parts: string[] = []
  if (preset.languages > 0) {
    parts.push(preset.languageCodes && preset.languageCodes.length === 1 && preset.languageCodes[0] === 'zh'
      ? '中文'
      : preset.languages + ' 语言')
  }
  if (preset.labels > 0) parts.push(preset.labels + ' 标签')
  if (preset.sizeBytes !== undefined) parts.push(formatBytes(preset.sizeBytes))
  if (preset.license) parts.push(preset.license)
  return parts.join(' · ')
}

/** Badge labels rendered next to a preset name. */
export function modelBadges(preset: ModelPreset | null | undefined): string[] {
  if (!preset) return []
  const badges: string[] = []
  if (preset.default) badges.push('默认')
  if (preset.recommended) badges.push('推荐')
  if (preset.legacy) badges.push('回退默认')
  if (preset.languageCodes && preset.languageCodes.length === 1 && preset.languageCodes[0] === 'zh') badges.push('中文')
  if (preset.needsExport && !preset.installed) badges.push('需本地导出（建议大肥鱼帮助）')
  if (preset.installed) badges.push('已安装')
  return badges
}

/** True while any download is in progress (disables other actions). */
export function downloadIsActive(state: ModelState | null | undefined): boolean {
  return Boolean(state && state.download && isActiveDownloadStatus(state.download.status))
}

/** Action for the primary button of one preset card. */
export function presetAction(
  preset: ModelPreset,
  state: ModelState | null | undefined,
  busy: boolean,
): PresetAction {
  const download = state ? state.download : null
  const isThisDownload = Boolean(download && download.id === preset.id && isActiveDownloadStatus(download.status))
  if (isThisDownload) return { kind: 'cancel', label: '取消下载', disabled: busy }
  const blocked = busy || downloadIsActive(state)
  // Other cards stay recognizable while one download runs: show their own
  // action, disabled, instead of a global "处理中…" (issue #57).
  if (preset.installed) return { kind: 'delete', label: '删除', disabled: blocked }
  if (preset.needsExport) return { kind: 'export', label: '需本地导出', disabled: true }
  if (!preset.downloadable) return { kind: 'export', label: '不可在线下载', disabled: true }
  if (blocked) return { kind: 'none', label: '等待下载完成', disabled: true }
  return { kind: 'download', label: '下载', disabled: false }
}

/** Whether the radio input for a preset can be selected right now. */
export function canSelectPreset(
  preset: ModelPreset,
  state: ModelState | null | undefined,
  busy: boolean,
): boolean {
  if (busy || downloadIsActive(state)) return false
  if (!preset.installed) return false
  return !(state && state.activeModelId === preset.id)
}

export interface RuntimeSummary {
  /** Preset the user selected (host activeModelId). */
  selected: ModelPreset | null
  /** Preset that is actually loaded (host effectiveModelId / current). */
  effective: ModelPreset | null
  effectiveFallback: boolean
  runtimeError: string | null
  /** True when the host reports no usable runtime model. */
  noModel: boolean
}

/** Issue #62 H5: separate "selected" from "actually effective". */
export function runtimeSummary(state: ModelState | null | undefined): RuntimeSummary {
  if (!state) {
    return { selected: null, effective: null, effectiveFallback: false, runtimeError: null, noModel: false }
  }
  const selected =
    state.presets.find((preset) => preset.id === state.selectedModelId) ?? null
  const effective =
    state.current ??
    state.presets.find((preset) => preset.id === state.effectiveModelId) ??
    null
  return {
    selected,
    effective,
    effectiveFallback: state.effectiveFallback,
    runtimeError: state.runtimeError ?? null,
    noModel: effective === null,
  }
}

/** Issue #60: show explicit setup guidance instead of waiting silently. */
export function needsModelSetup(state: ModelState | null | undefined): boolean {
  if (!state) return false
  const summary = runtimeSummary(state)
  return summary.noModel || summary.runtimeError !== null
}

/** Default Horizon Small preset used by the one-click setup CTA. */
export function defaultDownloadPreset(state: ModelState | null | undefined): ModelPreset | null {
  if (!state) return null
  return (
    state.presets.find((preset) => preset.default) ??
    state.presets.find((preset) => preset.id === 'horizon-small') ??
    state.presets.find((preset) => preset.downloadable && !preset.needsExport) ??
    null
  )
}

/** Rows for the /test result bars, ordered by the 7 unified dimensions. */
export function scoreRows(scores: Record<string, number> | null | undefined): ModelDisplayRow[] {
  const source = scores ?? {}
  const rows: ModelDisplayRow[] = []
  const seen = new Set<string>()
  for (const dimension of UI_DIMENSIONS) {
    const value = normalizeScoreValue(source[dimension.key])
    seen.add(dimension.key)
    rows.push({ ...dimension, value, percent: Math.round(value * 100) })
  }
  const extras = Object.keys(source)
    .filter((key) => !seen.has(key))
    .sort()
  for (const key of extras) {
    const value = normalizeScoreValue(source[key])
    rows.push({ key, label: key, color: '#8A93A3', value, percent: Math.round(value * 100) })
  }
  return rows
}

function normalizeScoreValue(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.max(0, Math.min(1, numeric > 1 ? numeric / 100 : numeric))
}

/** Label for the download area under a preset (progress or failure). */
export function downloadLine(download: ModelDownload | null | undefined): string {
  if (!download) return ''
  const progress = formatProgress(download)
  if (download.status === 'complete') return '下载完成，可以切换到该模型。'
  if (download.status === 'failed') return '下载失败：' + (download.error ?? '请重试') + '（' + progress + '）'
  return progress
}

const styles = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    marginTop: '4px',
    paddingTop: '18px',
    borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))',
  },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },
  title: { margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
  description: {
    margin: 0,
    fontSize: '12px',
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-tertiary, inherit)',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '14px',
    borderRadius: '12px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22))',
    background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08))',
  },
  row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  spread: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
  modelName: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
  meta: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.5 },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 7px',
    borderRadius: '999px',
    fontSize: '11px',
    lineHeight: '18px',
    background: 'var(--dsw-alias-bg-mask-1, rgba(127,127,127,.14))',
    color: 'var(--dsw-alias-label-secondary, inherit)',
    whiteSpace: 'nowrap',
  },
  badgeAccent: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 7px',
    borderRadius: '999px',
    fontSize: '11px',
    lineHeight: '18px',
    background: 'var(--dsw-alias-button-primary-dimmed, rgba(79,124,255,.12))',
    color: 'var(--dsw-alias-brand-primary, #4f7cff)',
    whiteSpace: 'nowrap',
  },
  alert: {
    padding: '10px 12px',
    borderRadius: '10px',
    fontSize: '12px',
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-error, inherit)',
    background: 'var(--dsw-alias-bg-mask-2, rgba(229,72,77,.08))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(229,72,77,.25))',
  },
  info: {
    padding: '10px 12px',
    borderRadius: '10px',
    fontSize: '12px',
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-secondary, inherit)',
    background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22))',
  },
  warning: {
    margin: 0,
    fontSize: '12px',
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-secondary, inherit)',
  },
  button: {
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
    background: 'var(--dsw-alias-bg-base, #fff)',
    color: 'var(--dsw-alias-label-primary, inherit)',
    borderRadius: '8px',
    padding: '6px 12px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  primaryButton: {
    border: '1px solid var(--dsw-alias-button-primary-fill, #4f7cff)',
    background: 'var(--dsw-alias-button-primary-fill, #4f7cff)',
    color: 'var(--dsw-alias-label-primary-foreground, #fff)',
    borderRadius: '8px',
    padding: '6px 14px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  dangerButton: {
    border: '1px solid var(--dsw-alias-border-l2, rgba(229,72,77,.4))',
    background: 'transparent',
    color: 'var(--dsw-alias-label-error, inherit)',
    borderRadius: '8px',
    padding: '6px 12px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  progressTrack: {
    width: '100%',
    height: '6px',
    borderRadius: '999px',
    background: 'var(--dsw-alias-bg-mask-1, rgba(127,127,127,.18))',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: '999px',
    background: 'var(--dsw-alias-brand-primary, #4f7cff)',
    transition: 'width 300ms ease',
  },
  track: {
    flex: '1 1 140px',
    height: '6px',
    borderRadius: '999px',
    background: 'var(--dsw-alias-bg-mask-1, rgba(127,127,127,.18))',
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: '999px' },
  textarea: {
    width: '100%',
    minHeight: '64px',
    resize: 'vertical',
    padding: '8px 10px',
    borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
    background: 'var(--dsw-alias-bg-base, #fff)',
    color: 'var(--dsw-alias-label-primary, inherit)',
    fontSize: '13px',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  disabledButton: { opacity: 0.55, cursor: 'not-allowed' },
}

/**
 * Build the models section component with the host React runtime.
 * @param React - host React module.
 * @param options - optional injected API client (tests / harnesses).
 * @returns a React function component.
 */
export function createSettingsModels(
  React: any,
  options: { api?: ModelApiClient } = {},
): (props?: Record<string, unknown>) => any {
  const api = options.api
  const ProviderSection = createProviderSection(React)
  return function EmotionModelSettings(): any {
    const client = api ?? getModelApi()
    const [state, setState] = React.useState(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState('')
    const [busy, setBusy] = React.useState(null)
    const [reloadToken, setReloadToken] = React.useState(0)
    const [testText, setTestText] = React.useState('今天心情不错，谢谢你！')
    const [testing, setTesting] = React.useState(false)
    const [testResult, setTestResult] = React.useState(null)
    const [testError, setTestError] = React.useState('')

    React.useEffect(() => {
      let alive = true
      setLoading(true)
      setError('')
      client
        .getState()
        .then((next: ModelState) => {
          if (!alive) return
          setState(next)
          setLoading(false)
        })
        .catch((failure: unknown) => {
          if (!alive) return
          setError(describeApiError(failure))
          setLoading(false)
        })
      return () => {
        alive = false
      }
    }, [client, reloadToken])

    const activeDownload = state && state.download && isActiveDownloadStatus(state.download.status) ? state.download : null
    const polling = Boolean(activeDownload)
    const downloadId = activeDownload ? activeDownload.id : undefined
    React.useEffect(() => {
      if (!polling) return undefined
      const stop = client.watchDownload(
        (next: ModelState) => setState(next),
        (failure: unknown) => setError(describeApiError(failure)),
        MODEL_POLL_INTERVAL_MS,
      )
      return stop
    }, [client, polling, downloadId])

    const runAction = async (key: string, action: () => Promise<ModelState>): Promise<void> => {
      if (busy !== null) return
      setBusy(key)
      setError('')
      try {
        const next = await action()
        setState(next)
        try {
          window.dispatchEvent(new CustomEvent('emotion-analyzer-model-changed'))
        } catch {
          // non-browser harnesses
        }
        if (key.startsWith('download:')) {
          // The 202 body can race the manager's first progress update; pull
          // once more shortly after so the progress bar starts even when the
          // response carried no `download` block (issue #57).
          window.setTimeout(() => {
            void client
              .getState()
              .then((fresh: ModelState) => setState(fresh))
              .catch(() => undefined)
          }, 1200)
        }
      } catch (failure) {
        setError(describeApiError(failure))
      } finally {
        setBusy(null)
      }
    }

    const runTest = async (): Promise<void> => {
      const text = testText.trim()
      if (testing || text.length === 0) return
      setTesting(true)
      setTestError('')
      try {
        const result = await client.testModel(text)
        setTestResult(result)
      } catch (failure) {
        setTestError(describeApiError(failure))
      } finally {
        setTesting(false)
      }
    }

    const presets: ModelPreset[] = state && Array.isArray(state.presets) ? state.presets : []
    const actionBusy = busy !== null
    const summary = runtimeSummary(state)
    const setupNeeded = needsModelSetup(state)
    const defaultPreset = defaultDownloadPreset(state)

    const renderPreset = (preset: ModelPreset): any => {
      const action = presetAction(preset, state, actionBusy)
      const selected = Boolean(state && state.selectedModelId === preset.id)
      const effective = Boolean(state && state.effectiveModelId === preset.id)
      const isDownloading = Boolean(activeDownload && activeDownload.id === preset.id)
      const percent = isDownloading && activeDownload ? downloadPercent(activeDownload) : 0
      const failedHere = Boolean(
        state && state.download && state.download.id === preset.id && state.download.status === 'failed',
      )
      const buttonStyle =
        action.kind === 'cancel' || action.kind === 'delete'
          ? styles.dangerButton
          : action.kind === 'download'
            ? styles.primaryButton
            : styles.button
      return React.createElement(
        'div',
        { key: preset.id, style: styles.card, 'data-emotion-model-preset': preset.id },
        React.createElement(
          'div',
          { style: styles.spread },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0 } },
            React.createElement('input', {
              type: 'radio',
              name: 'emotion-analyzer-model',
              checked: selected,
              disabled: !canSelectPreset(preset, state, actionBusy),
              onChange: () => {
                if (!canSelectPreset(preset, state, actionBusy)) return
                void runAction('select:' + preset.id, () => client.selectModel(preset.id))
              },
              'aria-label': '使用模型 ' + preset.name,
              style: { marginTop: '3px' },
            }),
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 } },
              React.createElement(
                'div',
                { style: styles.row },
                React.createElement('span', { style: styles.modelName }, preset.name),
                ...modelBadges(preset).map((badge, index) =>
                  React.createElement(
                    'span',
                    { key: badge + index, style: index === 0 && preset.recommended ? styles.badgeAccent : styles.badge },
                    badge,
                  ),
                ),
                selected ? React.createElement('span', { style: styles.badgeAccent }, '已选择') : null,
                effective ? React.createElement('span', { style: styles.badge }, '实际生效') : null,
              ),
              React.createElement('span', { style: styles.meta }, formatModelMeta(preset)),
              preset.description ? React.createElement('span', { style: styles.meta }, preset.description) : null,
              preset.id ? React.createElement('span', { style: styles.meta }, 'ID: ' + preset.id) : null,
            ),
          ),
          React.createElement(
            'div',
            { style: { flex: '0 0 auto' } },
            React.createElement(
              'button',
              {
                type: 'button',
                style: action.disabled ? { ...buttonStyle, ...styles.disabledButton } : buttonStyle,
                disabled: action.disabled,
                onClick: () => {
                  if (action.disabled) return
                  if (action.kind === 'download') {
                    void runAction('download:' + preset.id, () => client.downloadModel(preset.id))
                  } else if (action.kind === 'cancel' || action.kind === 'delete') {
                    void runAction('remove:' + preset.id, () => client.removeModel(preset.id))
                  }
                },
              },
              action.label,
            ),
          ),
        ),
        isDownloading && activeDownload
          ? React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              React.createElement(
                'div',
                {
                  style: styles.progressTrack,
                  role: 'progressbar',
                  'aria-valuemin': 0,
                  'aria-valuemax': 100,
                  'aria-valuenow': percent,
                  'aria-label': '下载进度',
                },
                React.createElement('div', { style: { ...styles.progressFill, width: percent + '%' } }),
              ),
              React.createElement('span', { style: styles.meta }, downloadLine(activeDownload)),
            )
          : null,
        failedHere && state && state.download
          ? React.createElement('div', { style: styles.alert, role: 'alert' }, downloadLine(state.download))
          : null,
        preset.needsExport && !preset.installed
          ? React.createElement(
              'p',
              { style: styles.warning },
              '中文模型需要本地导出（建议大肥鱼帮助）：运行 python3 scripts/export_model.py 生成 ' +
                (preset.expectedExportPath ?? 'assets/model.onnx') +
                '，然后刷新本页。',
            )
          : null,
      )
    }

    const children: any[] = [
      React.createElement(
        'div',
        { key: 'header', style: styles.header },
        React.createElement('h3', { style: styles.title }, '模型'),
        React.createElement(
          'p',
          { style: styles.description },
          '本地 ONNX 情绪模型：下载、切换、删除与测试。所有推理都在本机完成，不联网调用第三方 API。',
        ),
      ),
    ]

    if (loading && !state) {
      children.push(React.createElement('p', { key: 'loading', style: styles.meta }, '正在读取模型列表…'))
    }

    if (error) {
      children.push(
        React.createElement(
          'div',
          { key: 'error', style: styles.alert, role: 'alert' },
          React.createElement('div', null, error),
          React.createElement(
            'button',
            {
              type: 'button',
              style: { ...styles.button, marginTop: '8px' },
              onClick: () => {
                setError('')
                setReloadToken((token: number) => token + 1)
              },
            },
            '重试',
          ),
        ),
      )
    }

    if (state && state.source === 'mock') {
      children.push(
        React.createElement(
          'div',
          { key: 'mock', style: styles.info },
          '演示模式：已通过 ?emotionModelMock=1 显式启用',
          state.mockReason ? '（' + state.mockReason + '）' : '',
          '。以下数据仅用于界面演示，不代表真实下载或推理成功。',
        ),
      )
    }

    if (state && state.warnings && state.warnings.length > 0) {
      children.push(
        React.createElement(
          'div',
          { key: 'warnings', style: styles.info },
          ...state.warnings.map((warning: string, index: number) =>
            React.createElement('div', { key: 'warning-' + index }, warning),
          ),
        ),
      )
    }

    if (setupNeeded && state) {
      children.push(
        React.createElement(
          'div',
          { key: 'setup', style: styles.info, role: 'status' },
          React.createElement('div', { style: styles.modelName }, '没有可用的情绪模型'),
          React.createElement(
            'p',
            { style: styles.warning },
            '下载完成前，主模型的回复不会被打分，悬浮框只会显示等待状态。',
          ),
          defaultPreset
            ? React.createElement(
                'div',
                { style: styles.row },
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    style: actionBusy ? { ...styles.primaryButton, ...styles.disabledButton } : styles.primaryButton,
                    disabled: actionBusy,
                    onClick: () => {
                      void runAction('download:default', () => client.downloadModel(defaultPreset.id))
                    },
                  },
                  '一键下载默认模型 ' + defaultPreset.name,
                ),
                summary.selected && !summary.selected.installed && summary.selected.id !== defaultPreset.id
                  ? React.createElement(
                      'button',
                      {
                        type: 'button',
                        style: actionBusy ? { ...styles.button, ...styles.disabledButton } : styles.button,
                        disabled: actionBusy,
                        onClick: () => {
                          void runAction('download:' + summary.selected!.id, () =>
                            client.downloadModel(summary.selected!.id),
                          )
                        },
                      },
                      '改为下载已选择的 ' + summary.selected.name,
                    )
                  : null,
              )
            : React.createElement('p', { style: styles.warning }, '宿主没有返回预设模型；请检查插件后端日志后重试。'),
        ),
      )
    }

    children.push(
      React.createElement(
        'div',
        { key: 'current', style: styles.card },
        React.createElement('span', { style: styles.modelName }, '模型状态'),
        React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          React.createElement(
            'span',
            { style: styles.meta },
            '已选择：' + (summary.selected ? summary.selected.name : (state && state.selectedModelId) ?? '—') +
              (summary.selected && !summary.selected.installed ? '（未下载）' : ''),
          ),
          React.createElement(
            'span',
            { style: styles.meta },
            '实际生效：' + (summary.effective ? summary.effective.name : '无可用模型'),
          ),
          summary.effectiveFallback
            ? React.createElement('p', { style: styles.warning }, '已选择的模型不可用，当前自动回退到兼容模型。')
            : null,
          summary.selected && summary.effective && summary.selected.id !== summary.effective.id
            ? React.createElement(
                'p',
                { style: styles.warning },
                '已选择 ' + summary.selected.name + '，但实际运行的是 ' + summary.effective.name + '。',
              )
            : null,
          summary.runtimeError
            ? React.createElement('div', { style: styles.alert, role: 'alert' }, '运行时错误：' + summary.runtimeError)
            : null,
        ),
        summary.effective
          ? React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              React.createElement('span', { style: styles.meta }, '生效模型 ID: ' + summary.effective.id + (summary.effective.profile ? ' · profile: ' + summary.effective.profile : '')),
              React.createElement('span', { style: styles.meta }, formatModelMeta(summary.effective)),
            )
          : null,
      ),
    )

    if (state && (state.fallback || state.needsExport)) {
      children.push(
        React.createElement(
          'div',
          { key: 'state-warning', style: styles.info },
          state.fallback ? '当前处于兼容回退模式。' : '',
          state.needsExport ? ' 部分模型（如中文模型）需要本地导出（建议大肥鱼帮助）。' : '',
        ),
      )
    }

    children.push(
      React.createElement(
        'div',
        { key: 'presets-head', style: styles.row },
        React.createElement('span', { style: styles.modelName }, '预设模型'),
        presets.length > 0 ? React.createElement('span', { style: styles.meta }, presets.length + ' 个可用预设') : null,
        React.createElement(
          'span',
          { style: styles.row },
          React.createElement('span', { style: styles.badge }, state && state.source === 'mock' ? '演示数据' : '实时数据'),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => setReloadToken((value: number) => value + 1),
              style: styles.button,
              'aria-label': '刷新模型状态',
            },
            '刷新状态',
          ),
        ),
      ),
      ...presets.map(renderPreset),
    )

    if (state && presets.length === 0 && !error) {
      children.push(React.createElement('p', { key: 'empty', style: styles.meta }, '宿主没有返回预设模型。'))
    }

    children.push(
      React.createElement(
        'div',
        { key: 'test', style: { ...styles.card, marginTop: '4px' } },
        React.createElement('span', { style: styles.modelName }, '测试一句'),
        React.createElement(
          'p',
          { style: styles.meta },
          '用当前模型跑一次本地推理，不会写入会话记录；结果包含 7 维分数、耗时与模型 ID。',
        ),
        React.createElement('textarea', {
          value: testText,
          maxLength: 500,
          rows: 3,
          disabled: testing,
          onChange: (event: any) => setTestText(String(event && event.target ? event.target.value : '')),
          style: styles.textarea,
          'aria-label': '测试文本',
          placeholder: '例如：今天心情不错，谢谢你！',
        }),
        React.createElement(
          'div',
          { style: styles.row },
          React.createElement(
            'button',
            {
              type: 'button',
              style: testing || testText.trim().length === 0 ? { ...styles.primaryButton, ...styles.disabledButton } : styles.primaryButton,
              disabled: testing || testText.trim().length === 0,
              onClick: () => {
                void runTest()
              },
            },
            testing ? '测试中…' : '测试',
          ),
          React.createElement('span', { style: styles.meta }, testText.length + '/500'),
        ),
        testError ? React.createElement('div', { style: styles.alert, role: 'alert' }, testError) : null,
        testResult
          ? React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              React.createElement(
                'div',
                { style: styles.row },
                React.createElement('span', { style: styles.badgeAccent }, 'modelId: ' + testResult.modelId),
                React.createElement('span', { style: styles.meta }, '耗时 ' + testResult.latencyMs + 'ms'),
                testResult.language ? React.createElement('span', { style: styles.meta }, '语言 ' + testResult.language) : null,
              ),
              testResult.error
                ? React.createElement('div', { style: styles.alert, role: 'alert' }, testResult.error)
                : null,
              ...scoreRows(testResult.scores).map((row) =>
                React.createElement(
                  'div',
                  { key: 'test-score-' + row.key, style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                  React.createElement('span', { style: { ...styles.meta, width: '38px' } }, row.label),
                  React.createElement(
                    'div',
                    { style: styles.track },
                    React.createElement('div', {
                      style: { ...styles.fill, width: row.percent + '%', background: row.color },
                    }),
                  ),
                  React.createElement('span', { style: { ...styles.meta, width: '34px', textAlign: 'right' } }, row.percent + '%'),
                ),
              ),
            )
          : null,
      ),
    )

    children.push(
      React.createElement(ProviderSection, {
        key: 'provider',
        client,
        state,
        onStateChange: (next: ModelState) => setState(next),
        onError: (message: string) => setError(message),
      }),
    )

    return React.createElement('section', { 'data-emotion-analyzer-models': '', style: styles.section }, ...children)
  }
}
