/**
 * 设置页「打分通道」卡片（#41）。
 *
 * 默认本地 ONNX；切到「自定义 API」时把 baseUrl / model / apiKeyEnv / timeoutMs
 * 交给 Host 的 `POST /provider`。密钥只以**环境变量名**形式保存，输入框从不
 * 接收密钥本身；API 模式会把助手回复文本发送到用户配置的端点并按对方计费，
 * 因此卡片内常驻隐私/成本提示。
 */
import type { ModelApiClient, ModelState, ProviderConfig } from './model-api.ts'

/** 表单输入（全部为受控字符串）。 */
export interface ProviderFormInput {
  readonly mode: 'local' | 'api'
  readonly baseUrl: string
  readonly model: string
  readonly apiKeyEnv: string
  readonly timeoutMs: string
}

/** 默认表单值。 */
export const EMPTY_PROVIDER_FORM: ProviderFormInput = {
  mode: 'local',
  baseUrl: '',
  model: '',
  apiKeyEnv: '',
  timeoutMs: '8000',
}

/** 环境变量名允许的字符集。 */
const API_KEY_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** 把已保存的 provider 转成表单值。 */
export function formFromProvider(state: ModelState | null): ProviderFormInput {
  const provider = state?.provider
  if (provider === undefined || provider.type !== 'api') return EMPTY_PROVIDER_FORM
  return {
    mode: 'api',
    baseUrl: provider.baseUrl ?? '',
    model: provider.model ?? '',
    apiKeyEnv: provider.apiKeyEnv ?? '',
    timeoutMs: String(provider.timeoutMs ?? 8000),
  }
}

/**
 * 校验表单并生成 `POST /provider` 请求体（与 Host 侧规则一致）。
 * @param input - 表单值。
 * @returns 合法配置，或用户可读错误。
 */
export function validateProviderForm(input: ProviderFormInput): { config?: ProviderConfig; error?: string } {
  if (input.mode === 'local') return { config: { type: 'local' } }
  const baseUrl = input.baseUrl.trim().replace(/\/+$/u, '')
  if (baseUrl.length === 0) return { error: '请填写 baseUrl（例如 https://api.example.com/v1）' }
  if (!/^https?:\/\//u.test(baseUrl)) return { error: 'baseUrl 只支持 http/https' }
  const model = input.model.trim()
  if (model.length === 0) return { error: '请填写模型名（例如 gpt-4o-mini）' }
  if (model.length > 200) return { error: '模型名过长（>200）' }
  const apiKeyEnv = input.apiKeyEnv.trim()
  if (apiKeyEnv.length > 0 && !API_KEY_ENV_RE.test(apiKeyEnv)) {
    return { error: 'apiKeyEnv 必须是合法的环境变量名（字母/数字/下划线）' }
  }
  const rawTimeout = input.timeoutMs.trim()
  let timeoutMs: number | undefined
  if (rawTimeout.length > 0) {
    const parsed = Number(rawTimeout)
    if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 60_000) {
      return { error: '超时需在 1000–60000 毫秒之间' }
    }
    timeoutMs = Math.round(parsed)
  }
  return {
    config: {
      type: 'api',
      baseUrl,
      model,
      ...(apiKeyEnv.length === 0 ? {} : { apiKeyEnv }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  }
}

/** provider 状态的一句话摘要（设置页 / 诊断）。 */
export function providerSummary(state: ModelState | null): string {
  const provider = state?.provider
  if (provider === undefined || provider.type !== 'api') return '本地 ONNX（推理不联网）'
  const target = provider.model.length > 0 ? provider.model : '未命名模型'
  const ready = provider.ready ? '已就绪' : '未就绪'
  return `自定义 API · ${target} · ${ready}`
}

/** 组件 props。 */
export interface ProviderSectionProps {
  readonly client: ModelApiClient
  readonly state: ModelState | null
  readonly onStateChange: (state: ModelState) => void
  readonly onError: (message: string) => void
}

const styles = {
  card: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
    padding: '12px',
    border: '1px solid var(--dsw-alias-border-secondary, #e5e7eb)',
    borderRadius: '8px',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
  },
  title: { fontSize: '13px', fontWeight: 600 as const },
  meta: { fontSize: '12px', opacity: 0.75 },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const },
  label: { fontSize: '12px', width: '84px', opacity: 0.8 },
  input: {
    flex: 1,
    minWidth: '180px',
    padding: '4px 6px',
    fontSize: '12px',
    borderRadius: '4px',
    border: '1px solid var(--dsw-alias-border-secondary, #d1d5db)',
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
    color: 'inherit',
  },
  button: {
    padding: '4px 10px',
    fontSize: '12px',
    borderRadius: '4px',
    border: '1px solid var(--dsw-alias-border-secondary, #d1d5db)',
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
    color: 'inherit',
    cursor: 'pointer',
  },
  primary: {
    padding: '4px 12px',
    fontSize: '12px',
    borderRadius: '4px',
    border: 'none',
    background: 'var(--dsw-alias-label-primary, #2563eb)',
    color: 'var(--dsw-alias-label-primary-foreground, #fff)',
    cursor: 'pointer',
  },
  alert: { fontSize: '12px', color: 'var(--dsw-alias-label-error, #dc2626)' },
  ok: { fontSize: '12px', color: 'var(--dsw-alias-label-success, #16a34a)' },
  note: { fontSize: '12px', opacity: 0.8, lineHeight: 1.5 },
} as const

/**
 * 创建「打分通道」卡片组件。
 * @param React - 宿主提供的 React。
 * @returns 组件函数（props: {@link ProviderSectionProps}）。
 */
export function createProviderSection(React: any): (props: ProviderSectionProps) => any {
  return function EmotionProviderSection(props: ProviderSectionProps): any {
    const { client, state, onStateChange, onError } = props
    const [form, setForm] = React.useState(() => formFromProvider(state))
    const [busy, setBusy] = React.useState(false)
    const [message, setMessage] = React.useState('')
    const [failure, setFailure] = React.useState('')

    // Host 刷新后同步「已保存」的配置（保存成功也会走这里）。
    React.useEffect(() => {
      setForm(formFromProvider(state))
    }, [state])

    const update = (patch: Partial<ProviderFormInput>): void => {
      setForm((previous: ProviderFormInput) => ({ ...previous, ...patch }))
      setMessage('')
      setFailure('')
    }

    const save = async (): Promise<void> => {
      if (busy) return
      const validated = validateProviderForm(form)
      if (validated.config === undefined) {
        setFailure(validated.error ?? '配置非法')
        return
      }
      setBusy(true)
      setFailure('')
      setMessage('')
      try {
        const next = await client.saveProvider(validated.config)
        onStateChange(next)
        setMessage(validated.config.type === 'local' ? '已切回本地 ONNX。' : '已保存，下一轮生效。')
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        setFailure(text)
        onError(text)
      } finally {
        setBusy(false)
      }
    }

    const apiMode = form.mode === 'api'
    const provider = state?.provider
    const statusLine =
      provider !== undefined && !provider.ready && provider.error !== null
        ? `通道未就绪：${provider.error}（打分将回退本地模型）`
        : providerSummary(state)

    return React.createElement(
      'div',
      { style: styles.card, 'data-emotion-provider': '' },
      React.createElement('span', { style: styles.title }, '打分通道'),
      React.createElement('span', { style: styles.meta }, statusLine),
      React.createElement(
        'div',
        { style: styles.row },
        React.createElement(
          'label',
          { style: styles.meta },
          React.createElement('input', {
            type: 'radio',
            name: 'emotion-provider-mode',
            checked: !apiMode,
            disabled: busy,
            onChange: () => update({ mode: 'local' }),
          }),
          ' 本地 ONNX（默认，不联网）',
        ),
        React.createElement(
          'label',
          { style: styles.meta },
          React.createElement('input', {
            type: 'radio',
            name: 'emotion-provider-mode',
            checked: apiMode,
            disabled: busy,
            onChange: () => update({ mode: 'api' }),
          }),
          ' 自定义 OpenAI-compatible API',
        ),
      ),
      apiMode
        ? React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            React.createElement(
              'div',
              { style: styles.row },
              React.createElement('span', { style: styles.label }, 'baseUrl'),
              React.createElement('input', {
                style: styles.input,
                value: form.baseUrl,
                placeholder: 'https://api.example.com/v1',
                disabled: busy,
                onChange: (event: any) => update({ baseUrl: String(event?.target?.value ?? '') }),
              }),
            ),
            React.createElement(
              'div',
              { style: styles.row },
              React.createElement('span', { style: styles.label }, 'model'),
              React.createElement('input', {
                style: styles.input,
                value: form.model,
                placeholder: 'gpt-4o-mini',
                disabled: busy,
                onChange: (event: any) => update({ model: String(event?.target?.value ?? '') }),
              }),
            ),
            React.createElement(
              'div',
              { style: styles.row },
              React.createElement('span', { style: styles.label }, 'apiKeyEnv'),
              React.createElement('input', {
                style: styles.input,
                value: form.apiKeyEnv,
                placeholder: 'EMOTION_API_KEY（环境变量名，不保存密钥）',
                disabled: busy,
                onChange: (event: any) => update({ apiKeyEnv: String(event?.target?.value ?? '') }),
              }),
            ),
            React.createElement(
              'div',
              { style: styles.row },
              React.createElement('span', { style: styles.label }, '超时 ms'),
              React.createElement('input', {
                style: styles.input,
                value: form.timeoutMs,
                placeholder: '8000',
                disabled: busy,
                onChange: (event: any) => update({ timeoutMs: String(event?.target?.value ?? '') }),
              }),
            ),
            React.createElement(
              'p',
              { style: styles.note },
              '隐私/成本：API 模式会把**助手回复文本**发送到你填写的第三方端点，并按对方价格计费；' +
                '密钥只从 apiKeyEnv 指向的环境变量读取，不写入配置文件。默认本地模式不发送任何内容。',
            ),
          )
        : React.createElement(
            'p',
            { style: styles.note },
            '本地 ONNX 推理，数据不出本机；模型未安装时回退 legacy assets。',
          ),
      React.createElement(
        'div',
        { style: styles.row },
        React.createElement(
          'button',
          {
            type: 'button',
            style: busy ? { ...styles.primary, opacity: 0.6 } : styles.primary,
            disabled: busy,
            onClick: () => {
              void save()
            },
          },
          busy ? '保存中…' : '保存通道设置',
        ),
        message.length > 0 ? React.createElement('span', { style: styles.ok }, message) : null,
      ),
      failure.length > 0 ? React.createElement('div', { style: styles.alert, role: 'alert' }, failure) : null,
    )
  }
}
