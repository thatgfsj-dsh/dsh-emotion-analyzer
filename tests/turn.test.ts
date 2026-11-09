/**
 * turn 处理链路回归（#70）。
 *
 * 覆盖 `runEmotionTurn` 的提取/打分/写入分支与超时降级，以及
 * `createAppendRecord` 对宿主 session 模块的解析与真实 append。
 *
 * 说明：单测环境没有运行中的 dsh 安装，宿主解析会回退到插件本地副本；
 * 本测试断言的是「同一份本地副本可以成功 append 到它自己创建的 Session」，
 * 即解析/缓存/写入接线正确。真实宿主共享实例的验证见 docs/e2e.md。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Session } from '@deepseek-ai/dsh-session'
import {
  createAppendRecord,
  runEmotionTurn,
  type TurnDeps,
  type TurnServiceLike,
} from '../src/index.ts'
import { resetHostSessionModuleCache } from '../src/host-modules.ts'
import { EMOTION_RECORD_TYPE } from '../src/projection.ts'
import type { ScoreResult } from '../src/models/service.ts'

interface CapturedLog {
  debug: unknown[][]
  warn: unknown[][]
  error: unknown[][]
}

function captureLog(): { log: TurnDeps['log']; captured: CapturedLog } {
  const captured: CapturedLog = { debug: [], warn: [], error: [] }
  return {
    captured,
    log: {
      debug: (...args: unknown[]) => captured.debug.push(args),
      warn: (...args: unknown[]) => captured.warn.push(args),
      error: (...args: unknown[]) => captured.error.push(args),
    },
  }
}

function payloadWithReply(text: string, turn = 1): Parameters<typeof runEmotionTurn>[0] {
  return {
    turn,
    agent: {
      session: {
        id: 'session-test',
        deriveMessages: () => [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'text', text }] },
        ],
      },
    },
  }
}

const SCORE: ScoreResult = {
  raw: { joy: 0.9, neutral: 0.05 },
  modelId: 'horizon-small',
  profileId: 'go-emotions-28',
  latencyMs: 12,
  fallbackActive: false,
}

function fakeService(overrides: Partial<TurnServiceLike> = {}): TurnServiceLike {
  return {
    ensureReady: async () => true,
    score: async () => SCORE,
    ...overrides,
  }
}

test('runEmotionTurn appends a v2 plugin record with the scored payload', async () => {
  const { log } = captureLog()
  const calls: Array<{ type: string; data: Record<string, unknown> }> = []
  const ok = await runEmotionTurn(payloadWithReply('I am really happy today'), {
    service: fakeService(),
    log,
    appendRecord: (_session, type, data) => {
      calls.push({ type, data })
      return 0
    },
  })
  assert.equal(ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.type, EMOTION_RECORD_TYPE)
  const record = calls[0]?.data as Record<string, unknown>
  assert.equal(record['version'], 2)
  assert.equal(record['modelId'], 'horizon-small')
  assert.equal(record['profileId'], 'go-emotions-28')
  assert.equal(record['language'], 'en')
  assert.equal(record['turn'], 1)
  assert.deepEqual(record['raw'], SCORE.raw)
})

test('runEmotionTurn awaits an asynchronous append before resolving', async () => {
  const { log } = captureLog()
  let appendSettled = false
  const ok = await runEmotionTurn(payloadWithReply('plain statement'), {
    service: fakeService(),
    log,
    appendRecord: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      appendSettled = true
    },
  })
  assert.equal(ok, true)
  assert.equal(appendSettled, true, 'runEmotionTurn 必须等 append 完成')
})

test('runEmotionTurn degrades when append rejects', async () => {
  const { log, captured } = captureLog()
  const ok = await runEmotionTurn(payloadWithReply('plain statement'), {
    service: fakeService(),
    log,
    appendRecord: async () => {
      throw new Error('append boom')
    },
  })
  assert.equal(ok, false)
  assert.equal(captured.error.length, 1)
  assert.match(String(captured.error[0]?.[0]), /append plugin record failed/u)
})

test('runEmotionTurn skips scoring when the model is unavailable', async () => {
  const { log, captured } = captureLog()
  let scored = false
  const ok = await runEmotionTurn(payloadWithReply('plain statement'), {
    service: fakeService({
      ensureReady: async () => false,
      score: async () => {
        scored = true
        return SCORE
      },
    }),
    log,
    appendRecord: () => 0,
  })
  assert.equal(ok, false)
  assert.equal(scored, false)
  assert.equal(captured.warn.length, 1)
})

test('runEmotionTurn leaves empty replies untouched', async () => {
  const { log } = captureLog()
  let appendCalls = 0
  const ok = await runEmotionTurn(
    { turn: 3, agent: { session: { id: 's', deriveMessages: () => [] } } },
    {
      service: fakeService(),
      log,
      appendRecord: () => {
        appendCalls += 1
      },
    },
  )
  assert.equal(ok, false)
  assert.equal(appendCalls, 0)
})

test('runEmotionTurn bounds a hung cold start with initTimeoutMs', async () => {
  const { log, captured } = captureLog()
  const ok = await runEmotionTurn(payloadWithReply('plain statement'), {
    service: fakeService({ ensureReady: () => new Promise<boolean>(() => {}) }),
    log,
    appendRecord: () => 0,
    initTimeoutMs: 10,
  })
  assert.equal(ok, false)
  assert.equal(captured.error.length, 1)
  assert.match(String(captured.error[0]?.[0]), /model init failed/u)
  assert.match(String((captured.error[0]?.[1] as Error).message), /emotion init timed out/u)
})

test('runEmotionTurn bounds a hung inference with scoreTimeoutMs', async () => {
  const { log, captured } = captureLog()
  const ok = await runEmotionTurn(payloadWithReply('plain statement'), {
    service: fakeService({ score: () => new Promise<ScoreResult | undefined>(() => {}) }),
    log,
    appendRecord: () => 0,
    scoreTimeoutMs: 10,
  })
  assert.equal(ok, false)
  assert.equal(captured.warn.length, 1)
  assert.match(String(captured.warn[0]?.[0]), /scoring failed or timed out/u)
})

test('createAppendRecord resolves a session module and appends to a real Session', async () => {
  resetHostSessionModuleCache()
  try {
    const { log, captured } = captureLog()
    const appendRecord = createAppendRecord(log)
    const session = Session.create('session-append-probe')
    const seq = await appendRecord(session, EMOTION_RECORD_TYPE, { version: 2, turn: 1 })
    assert.equal(seq, 0)
    const events = session.ownEvents()
    assert.equal(events.length, 1)
    assert.equal(events[0]?.type, EMOTION_RECORD_TYPE)
    assert.equal(events[0]?.ignorable, true)
    assert.equal(captured.error.length, 0)
  } finally {
    resetHostSessionModuleCache()
  }
})
