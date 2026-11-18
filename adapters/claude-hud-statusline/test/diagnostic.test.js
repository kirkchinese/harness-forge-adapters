import test from 'node:test'
import assert from 'node:assert/strict'
import { isDiagnosticEnabled } from '../index.js'

test('the diagnostic is off unless someone asks for it', () => {
  assert.equal(isDiagnosticEnabled({}), false)
  assert.equal(isDiagnosticEnabled({ DEEPSEEK_API_KEY: 'sk-a-real-deepseek-key' }), false)
})

test("the user's opt-in turns it on in DSH's truthy spellings", () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) {
    assert.equal(isDiagnosticEnabled({ CLAUDE_HUD_STATUSLINE_LAST_RENDER: value }), true, JSON.stringify(value))
  }
  for (const value of ['', '0', 'false', 'off', 'no', ' ']) {
    assert.equal(isDiagnosticEnabled({ CLAUDE_HUD_STATUSLINE_LAST_RENDER: value }), false, JSON.stringify(value))
  }
})

test('the port trial marker turns it on, and only the value 1', () => {
  assert.equal(isDiagnosticEnabled({ HARNESS_FORGE_TRIAL: '1' }), true)
  assert.equal(isDiagnosticEnabled({ HARNESS_FORGE_TRIAL: '0' }), false)
  assert.equal(isDiagnosticEnabled({ HARNESS_FORGE_TRIAL: 'true' }), false)
})

test('no credential turns the diagnostic on', () => {
  // Regression: an earlier version read `DEEPSEEK_API_KEY === 'harness-forge-trial'`, a coincidence
  // of one trial run rather than a contract. Only HARNESS_FORGE_TRIAL=1 marks the trial harness.
  assert.equal(isDiagnosticEnabled({ DEEPSEEK_API_KEY: 'harness-forge-trial' }), false)
})

test('an opted-in user stays opted in when the trial marker is off', () => {
  assert.equal(isDiagnosticEnabled({ CLAUDE_HUD_STATUSLINE_LAST_RENDER: '1', HARNESS_FORGE_TRIAL: '0' }), true)
})
