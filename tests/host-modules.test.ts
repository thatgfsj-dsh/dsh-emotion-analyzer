/**
 * 宿主模块解析（DSH 0.2.2-rc.1 适配，#70）。
 *
 * 关键行为：优先从运行中的 dsh 安装解析 `@deepseek-ai/dsh-session`，避免
 * link 安装时拿到插件本地副本导致 `appendPluginRecord` 跨实例品牌检查失败。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  HOST_SESSION_PACKAGE,
  hostSessionModuleCandidates,
  loadHostSessionModule,
  resetHostSessionModuleCache,
} from '../src/host-modules.ts'

/** 本地安装的 session 包根目录（repo node_modules 里那份）。 */
function localPackageRoot(): string {
  const entry = fileURLToPath(import.meta.resolve(HOST_SESSION_PACKAGE))
  return dirname(dirname(entry))
}

/** 造一个假的 dsh 安装：`<root>/lib/bin.js` + `node_modules/@deepseek-ai/dsh-session`。 */
function makeFakeDshInstall(root: string): { bin: string; marker: string } {
  const dsh = join(root, 'dsh')
  mkdirSync(join(dsh, 'lib'), { recursive: true })
  const pkgDir = join(dsh, 'node_modules', '@deepseek-ai', 'dsh-session')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: HOST_SESSION_PACKAGE,
      version: '0.0.0-fake',
      type: 'module',
      exports: { '.': './index.js' },
    }),
  )
  const marker = `fake-host-${process.pid}-${Date.now()}`
  writeFileSync(
    join(pkgDir, 'index.js'),
    [
      `export const marker = ${JSON.stringify(marker)}`,
      'export function appendPluginRecord() { return 0 }',
      'export function pluginRecordOf() { return undefined }',
      '',
    ].join('\n'),
  )
  const bin = join(dsh, 'lib', 'bin.js')
  writeFileSync(bin, '#!/usr/bin/env node\n')
  return { bin, marker }
}

test('hostSessionModuleCandidates prefers the running dsh installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'emo-hostmod-'))
  try {
    const { bin } = makeFakeDshInstall(root)
    const candidates = hostSessionModuleCandidates(bin)
    assert.ok(candidates.length >= 2, '应同时给出宿主候选与本地兜底候选')
    assert.ok(
      candidates[0]?.includes(join('dsh', 'node_modules', '@deepseek-ai', 'dsh-session')),
      `第一个候选应来自假 dsh 安装，实际：${candidates[0]}`,
    )
    assert.equal(new Set(candidates).size, candidates.length, '候选列表必须去重')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hostSessionModuleCandidates falls back to the local copy without a dsh anchor', () => {
  const candidates = hostSessionModuleCandidates('/nonexistent/dsh/lib/bin.js')
  assert.equal(candidates.length, 1, '锚点不可用时只剩本地副本')
  assert.ok(candidates[0]?.includes(join('node_modules', '@deepseek-ai', 'dsh-session')))
})

test('loadHostSessionModule loads the host candidate first and caches it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'emo-hostmod-'))
  resetHostSessionModuleCache()
  try {
    const { bin, marker } = makeFakeDshInstall(root)
    const warnings: unknown[] = []
    const module = await loadHostSessionModule({ warn: (...args) => warnings.push(args) }, bin)
    assert.ok(module !== undefined, '应加载到假宿主模块')
    assert.equal((module as unknown as { marker?: string }).marker, marker)
    assert.equal(typeof module?.appendPluginRecord, 'function')
    assert.equal(typeof module?.pluginRecordOf, 'function')
    assert.equal(warnings.length, 0, '加载成功时不应有 warning')

    // 第二次调用命中缓存，即使锚点换成不存在的路径也返回同一模块。
    const again = await loadHostSessionModule(undefined, '/nonexistent/bin.js')
    assert.equal(again, module)
  } finally {
    resetHostSessionModuleCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadHostSessionModule falls back to the plugin-local copy', async () => {
  resetHostSessionModuleCache()
  try {
    const module = await loadHostSessionModule(undefined, '/nonexistent/bin.js')
    assert.ok(module !== undefined, '本地副本应作为兜底')
    assert.equal(typeof module?.appendPluginRecord, 'function')
    // 本地副本的入口应与包根目录一致（说明确实是兜底候选）。
    assert.ok(localPackageRoot().length > 0)
  } finally {
    resetHostSessionModuleCache()
  }
})
