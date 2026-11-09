/**
 * 设置持久化单测（v0.2 / issue #39）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_SETTINGS,
  apiKeyOf,
  dshHome,
  loadSettings,
  modelsDir,
  normalizeSettings,
  pluginConfigPath,
  pluginDataDir,
  saveSettings,
} from '../src/settings.ts'

async function tempBase(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-emotion-settings-'))
}

function silentLogger(): { warnings: string[]; logger: { warn(message: string): void; error(): void } } {
  const warnings: string[] = []
  return {
    warnings,
    logger: { warn: (message: string) => warnings.push(message), error: () => undefined },
  }
}

test('normalizeSettings：默认值、非法字段、provider 预留字段', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings([1, 2]), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({ activeModelId: '  ', provider: 'local' }), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({ activeModelId: 'legacy-tabularisai' }), {
    activeModelId: 'legacy-tabularisai',
    provider: { type: 'local' },
  })
  assert.deepEqual(normalizeSettings({ provider: { type: 'local', apiKeyEnv: 'EMO_KEY' } }), {
    activeModelId: DEFAULT_SETTINGS.activeModelId,
    provider: { type: 'local', apiKeyEnv: 'EMO_KEY' },
  })
  // 未知字段被丢弃
  assert.deepEqual(normalizeSettings({ activeModelId: 'horizon-base', extra: true }), {
    activeModelId: 'horizon-base',
    provider: { type: 'local' },
  })
})

test('路径约定：$DSH_HOME/emotion-analyzer/{config.json,models}', () => {
  const base = '/tmp/dsh-home-test'
  assert.equal(pluginDataDir(base), join(base, 'emotion-analyzer'))
  assert.equal(pluginConfigPath(base), join(base, 'emotion-analyzer', 'config.json'))
  assert.equal(modelsDir(base), join(base, 'emotion-analyzer', 'models'))
})

test('dshHome 优先读取 DSH_HOME，否则回退 ~/.dsh', () => {
  const previous = process.env['DSH_HOME']
  try {
    process.env['DSH_HOME'] = '/tmp/custom-dsh-home'
    assert.equal(dshHome(), '/tmp/custom-dsh-home')
    delete process.env['DSH_HOME']
    assert.match(dshHome(), /\.dsh$/)
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
  }
})

test('设置缺失时返回默认值', async () => {
  const base = await tempBase()
  try {
    assert.deepEqual(await loadSettings({ baseDir: base }), DEFAULT_SETTINGS)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('save → load 往返 + 原子写不留下 .tmp', async () => {
  const base = await tempBase()
  try {
    const settings = { activeModelId: 'horizon-base', provider: { type: 'local' as const, apiKeyEnv: 'KEY_X' } }
    await saveSettings(settings, { baseDir: base })
    assert.deepEqual(await loadSettings({ baseDir: base }), settings)
    const files = await readdir(join(base, 'emotion-analyzer'))
    assert.deepEqual(files, ['config.json'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('JSON 损坏时回退默认值并 warning', async () => {
  const base = await tempBase()
  try {
    const file = pluginConfigPath(base)
    await saveSettings(DEFAULT_SETTINGS, { baseDir: base })
    await writeFile(file, '{not json', 'utf8')
    const { logger, warnings } = silentLogger()
    assert.deepEqual(await loadSettings({ baseDir: base, logger }), DEFAULT_SETTINGS)
    assert.equal(warnings.length, 1)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})


test('provider 规范化：API 配置、非法回退本地、timeout 钳制', () => {
  const api = normalizeSettings({
    provider: {
      type: 'api',
      baseUrl: 'https://api.example.com/v1/',
      model: ' gpt-4o-mini ',
      apiKeyEnv: 'EMO_API_KEY',
      timeoutMs: 50,
    },
  })
  assert.deepEqual(api.provider, {
    type: 'api',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o-mini',
    apiKeyEnv: 'EMO_API_KEY',
    timeoutMs: 1000,
  })
  const upper = normalizeSettings({
    provider: { type: 'api', baseUrl: 'https://api.example.com/v1', model: 'm', timeoutMs: 999_999 },
  })
  assert.equal(upper.provider.type, 'api')
  assert.equal(upper.provider.type === 'api' ? upper.provider.timeoutMs : undefined, 60_000)
  // 非法配置回退 local（安全默认）
  assert.deepEqual(normalizeSettings({ provider: { type: 'api', baseUrl: 'ftp://x', model: 'm' } }).provider, { type: 'local' })
  assert.deepEqual(normalizeSettings({ provider: { type: 'api', baseUrl: 'https://x' } }).provider, { type: 'local' })
  assert.deepEqual(
    normalizeSettings({ provider: { type: 'api', baseUrl: 'https://x', model: 'm', apiKeyEnv: 'not a name' } }).provider,
    { type: 'local' },
  )
})

test('apiKeyOf 只从环境变量读取，不落盘', () => {
  const provider = { type: 'api' as const, baseUrl: 'https://x/v1', model: 'm', apiKeyEnv: 'EMO_KEY' }
  assert.equal(apiKeyOf(provider, { EMO_KEY: 'sk-1' }), 'sk-1')
  assert.equal(apiKeyOf(provider, { EMO_KEY: '   ' }), undefined)
  assert.equal(apiKeyOf(provider, {}), undefined)
  assert.equal(apiKeyOf({ type: 'api', baseUrl: 'https://x/v1', model: 'm' }, {}), undefined)
})
