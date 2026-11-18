import test from 'node:test'
import assert from 'node:assert/strict'
import { columnsOf, stdinPayload } from '../index.js'

test('stdinPayload maps DSH facts to the payload Claude Code writes', () => {
  const facts = {
    sessionId: 'session-1',
    cwd: '/work',
    model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    contextWindow: 200_000,
    usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5 },
  }
  assert.deepEqual(stdinPayload(facts), {
    session_id: 'session-1',
    cwd: '/work',
    workspace: { current_dir: '/work', project_dir: '/work' },
    model: { id: 'deepseek-flash', display_name: 'deepseek-flash' },
    context_window: {
      context_window_size: 200_000,
      current_usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 4,
      },
    },
    effort: { level: 'high' },
  })
})

test('stdinPayload leaves current_usage null without usage and omits non-positive counts', () => {
  const facts = { sessionId: 'session-2', cwd: '/tmp', model: {}, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  const payload = stdinPayload(facts)
  assert.equal(payload.context_window.current_usage.input_tokens, 0)
  assert.equal(payload.context_window.current_usage.output_tokens, 0)
  assert.equal(payload.context_window.context_window_size, undefined)
  assert.equal(payload.effort, undefined)

  const withoutUsage = stdinPayload({ sessionId: 'session-3', cwd: '/tmp', model: {} })
  assert.equal(withoutUsage.context_window.current_usage, null)
})

test('columnsOf clamps and falls back to the default', () => {
  assert.equal(columnsOf(undefined), 120)
  assert.equal(columnsOf('80'), 80)
  assert.equal(columnsOf('5'), 40)
  assert.equal(columnsOf('99999'), 240)
  assert.equal(columnsOf('not-a-number'), 120)
})
