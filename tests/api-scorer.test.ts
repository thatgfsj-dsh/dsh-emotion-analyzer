/**
 * OpenAI-compatible API 打分器单测（#41）。
 *
 * 用本机回环 HTTP server 验证真实 fetch 路径（而不是 mock fetch）：
 * 请求构造、Authorization、严格 JSON 解析、超时、HTTP 错误、密钥缺失。
 */
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import {
  API_MAX_CHARS,
  ApiScorer,
  ApiScorerError,
  buildApiRequest,
  parseScoreContent,
  scoringSystemPrompt,
} from '../src/models/api-scorer.ts'
import type { ApiProviderSettings } from '../src/settings.ts'

interface Captured {
  readonly body: Record<string, unknown>
  readonly authorization: string | undefined
  readonly path: string
}

interface Loopback {
  readonly baseUrl: string
  readonly captured: Captured[]
  close(): Promise<void>
}

/** 起一个回环 server；handler 决定响应内容。 */
async function loopback(
  handler: (request: IncomingMessage, response: ServerResponse, captured: Captured) => void,
): Promise<Loopback> {
  const captured: Captured[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const record: Captured = {
        body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
        authorization: request.headers['authorization'],
        path: request.url ?? '',
      }
      captured.push(record)
      handler(request, response, record)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** 组装 chat/completions 响应体。 */
function completion(content: string): string {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] })
}

function provider(overrides: Partial<ApiProviderSettings> = {}): ApiProviderSettings {
  return {
    type: 'api',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'gpt-test',
    timeoutMs: 2000,
    ...overrides,
  }
}

const VALID_JSON = JSON.stringify({
  pleasant: 0.9,
  sad: 0.05,
  angry: 0,
  anxious: 0,
  unwell: 0,
  confused: 0.1,
  neutral: 0.2,
})

test('buildApiRequest：URL 拼接、Authorization、model 与提示词', () => {
  const { url, init } = buildApiRequest(provider({ baseUrl: 'https://api.example.com/v1/' }), 'sk-test', 'hello')
  assert.equal(url, 'https://api.example.com/v1/chat/completions')
  assert.equal((init.headers as Record<string, string>)['authorization'], 'Bearer sk-test')
  const body = JSON.parse(String(init.body)) as Record<string, unknown>
  assert.equal(body['model'], 'gpt-test')
  assert.equal(body['temperature'], 0)
  const messages = body['messages'] as Array<{ role: string; content: string }>
  assert.equal(messages[0]?.role, 'system')
  assert.match(messages[0]?.content ?? '', /pleasant/u)
  assert.equal(messages[1]?.role, 'user')
  assert.ok((messages[1]?.content ?? '').includes('hello'))
  // 无 apiKey 时不带 Authorization
  const noKey = buildApiRequest(provider(), undefined, 'x')
  assert.equal((noKey.init.headers as Record<string, string>)['authorization'], undefined)
})

test('parseScoreContent：严格 7 维、围栏、未知键、缺失补 0', () => {
  assert.deepEqual(parseScoreContent(VALID_JSON), JSON.parse(VALID_JSON))
  const fenced = '```json\n' + VALID_JSON + '\n```'
  assert.deepEqual(parseScoreContent(fenced), JSON.parse(VALID_JSON))
  const noisy = '好的，结果如下：' + VALID_JSON + ' 希望有帮助'
  assert.deepEqual(parseScoreContent(noisy), JSON.parse(VALID_JSON))
  // 未知键被丢弃
  const unknown = parseScoreContent(JSON.stringify({ pleasant: 0.5, banana: 1 }))
  assert.deepEqual(unknown, { pleasant: 0.5, sad: 0, angry: 0, anxious: 0, unwell: 0, confused: 0, neutral: 0 })
  // 越界 / 非数字 / 空对象都判非法
  assert.equal(parseScoreContent(JSON.stringify({ pleasant: 1.5 })), undefined)
  assert.equal(parseScoreContent(JSON.stringify({ pleasant: 'high' })), undefined)
  assert.equal(parseScoreContent('{}'), undefined)
  assert.equal(parseScoreContent('not json'), undefined)
})

test('ApiScorer：真实回环请求成功并解析 7 维', async () => {
  const server = await loopback((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(completion(VALID_JSON))
  })
  try {
    const scorer = new ApiScorer({
      provider: provider({ baseUrl: server.baseUrl, apiKeyEnv: 'EMO_TEST_KEY' }),
      env: { EMO_TEST_KEY: 'sk-loopback' },
    })
    const outcome = await scorer.score('今天心情不错')
    assert.equal(outcome.modelId, 'gpt-test')
    assert.equal(outcome.scores['pleasant'], 0.9)
    assert.equal(outcome.scores['neutral'], 0.2)
    assert.ok(outcome.latencyMs >= 0)
    assert.equal(server.captured.length, 1)
    assert.equal(server.captured[0]?.path, '/v1/chat/completions')
    assert.equal(server.captured[0]?.authorization, 'Bearer sk-loopback')
    assert.equal(server.captured[0]?.body['model'], 'gpt-test')
    assert.match(JSON.stringify(server.captured[0]?.body['messages']), /今天心情不错/u)
  } finally {
    await server.close()
  }
})

test('ApiScorer：缺少 apiKeyEnv 环境变量时抛 missing_api_key 且不发请求', async () => {
  let requests = 0
  const server = await loopback((_request, response) => {
    requests += 1
    response.end(completion(VALID_JSON))
  })
  try {
    const scorer = new ApiScorer({
      provider: provider({ baseUrl: server.baseUrl, apiKeyEnv: 'EMO_TEST_MISSING' }),
      env: {},
    })
    await assert.rejects(() => scorer.score('x'), (error: unknown) => {
      assert.ok(error instanceof ApiScorerError)
      assert.equal(error.code, 'missing_api_key')
      return true
    })
    assert.equal(requests, 0)
  } finally {
    await server.close()
  }
})

test('ApiScorer：HTTP 非 2xx → http_error', async () => {
  const server = await loopback((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'boom' } }))
  })
  try {
    const scorer = new ApiScorer({ provider: provider({ baseUrl: server.baseUrl }) })
    await assert.rejects(() => scorer.score('x'), (error: unknown) => {
      assert.ok(error instanceof ApiScorerError)
      assert.equal(error.code, 'http_error')
      assert.match(error.message, /500/u)
      return true
    })
  } finally {
    await server.close()
  }
})

test('ApiScorer：响应不是合法分数 JSON → invalid_response', async () => {
  const server = await loopback((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(completion('我觉得这段回复很开心'))
  })
  try {
    const scorer = new ApiScorer({ provider: provider({ baseUrl: server.baseUrl }) })
    await assert.rejects(() => scorer.score('x'), (error: unknown) => {
      assert.ok(error instanceof ApiScorerError)
      assert.equal(error.code, 'invalid_response')
      return true
    })
  } finally {
    await server.close()
  }
})

test('ApiScorer：超时 → timeout', async () => {
  const server = await loopback((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(completion(VALID_JSON))
    }, 400)
  })
  try {
    const scorer = new ApiScorer({ provider: provider({ baseUrl: server.baseUrl, timeoutMs: 50 }) })
    await assert.rejects(() => scorer.score('x'), (error: unknown) => {
      assert.ok(error instanceof ApiScorerError)
      assert.equal(error.code, 'timeout')
      return true
    })
  } finally {
    await server.close()
  }
})

test('提示词与截断口径：7 维齐全、发送长度受限', () => {
  const prompt = scoringSystemPrompt()
  for (const dimension of ['pleasant', 'sad', 'angry', 'anxious', 'unwell', 'confused', 'neutral']) {
    assert.ok(prompt.includes(dimension), `提示词缺少 ${dimension}`)
  }
  const long = 'a'.repeat(API_MAX_CHARS + 500)
  const { init } = buildApiRequest(provider(), undefined, long)
  const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> }
  const userContent = body.messages[1]?.content ?? ''
  assert.ok(userContent.length < long.length, '超长文本必须被截断')
  assert.ok(userContent.length <= API_MAX_CHARS + 20)
})
