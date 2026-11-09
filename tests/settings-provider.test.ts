/**
 * 设置页「打分通道」纯函数单测（#41）。
 *
 * 组件本身依赖 React，这里只测表单校验 / 回填 / 摘要，避免引入 DOM 运行时。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EMPTY_PROVIDER_FORM,
  formFromProvider,
  providerSummary,
  validateProviderForm,
  type ProviderFormInput,
} from '../src/client/settings-provider.ts'
import type { ModelState } from '../src/client/model-api.ts'

function form(overrides: Partial<ProviderFormInput> = {}): ProviderFormInput {
  return { ...EMPTY_PROVIDER_FORM, ...overrides }
}

test('validateProviderForm：local 直接通过', () => {
  assert.deepEqual(validateProviderForm(form({ mode: 'local' })), { config: { type: 'local' } })
})

test('validateProviderForm：API 必填、URL、环境变量名、超时范围', () => {
  assert.equal(validateProviderForm(form({ mode: 'api' })).error, '请填写 baseUrl（例如 https://api.example.com/v1）')
  assert.equal(validateProviderForm(form({ mode: 'api', baseUrl: 'ftp://x', model: 'm' })).error, 'baseUrl 只支持 http/https')
  assert.equal(
    validateProviderForm(form({ mode: 'api', baseUrl: 'https://api.example.com/v1' })).error,
    '请填写模型名（例如 gpt-4o-mini）',
  )
  assert.equal(
    validateProviderForm(form({ mode: 'api', baseUrl: 'https://x/v1', model: 'm', apiKeyEnv: 'not a name' })).error,
    'apiKeyEnv 必须是合法的环境变量名（字母/数字/下划线）',
  )
  assert.equal(
    validateProviderForm(form({ mode: 'api', baseUrl: 'https://x/v1', model: 'm', timeoutMs: '10' })).error,
    '超时需在 1000–60000 毫秒之间',
  )
  assert.deepEqual(
    validateProviderForm(
      form({ mode: 'api', baseUrl: 'https://api.example.com/v1/', model: ' gpt-4o-mini ', apiKeyEnv: 'EMO_KEY', timeoutMs: '5000' }),
    ),
    {
      config: {
        type: 'api',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o-mini',
        apiKeyEnv: 'EMO_KEY',
        timeoutMs: 5000,
      },
    },
  )
  // 空 apiKeyEnv / 空超时都不进 payload
  assert.deepEqual(validateProviderForm(form({ mode: 'api', baseUrl: 'https://x/v1', model: 'm', apiKeyEnv: '', timeoutMs: '' })), {
    config: { type: 'api', baseUrl: 'https://x/v1', model: 'm' },
  })
})

test('formFromProvider / providerSummary：本地与 API 状态', () => {
  assert.deepEqual(formFromProvider(null), EMPTY_PROVIDER_FORM)
  const localState = {
    provider: { type: 'local', ready: true, error: null },
  } as unknown as ModelState
  assert.deepEqual(formFromProvider(localState), EMPTY_PROVIDER_FORM)
  assert.equal(providerSummary(localState), '本地 ONNX（推理不联网）')

  const apiState = {
    provider: {
      type: 'api',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      apiKeyEnv: 'EMO_KEY',
      timeoutMs: 5000,
      ready: false,
      error: '环境变量 EMO_KEY 未设置',
    },
  } as unknown as ModelState
  assert.deepEqual(formFromProvider(apiState), {
    mode: 'api',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o-mini',
    apiKeyEnv: 'EMO_KEY',
    timeoutMs: '5000',
  })
  assert.equal(providerSummary(apiState), '自定义 API · gpt-4o-mini · 未就绪')
})
