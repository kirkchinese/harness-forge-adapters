/**
 * Disposal must kill a render's child, not just forget map entries: a model-switch render, a
 * turn-boundary render and a dock read's render all outlive the agent or the plugin unless the adapter
 * aborts them. Each test starts a render whose hud.mjs writes its pid and then hangs, disposes the
 * agent or the plugin, and checks that the process is really gone (its 20 s render timeout aside).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isAlive, makeAgent, makeCtx, makeHangingHud, readPid, waitFor, withEnv,
} from './helpers/harness.js'
import { apply } from '../index.js'

const CANCEL_WITHIN_MS = 5_000

function setup(t) {
  const hud = makeHangingHud()
  const agent = makeAgent({ id: 's-cancel' })
  const agents = new Map([[agent.id, agent]])
  const h = makeCtx(agents)
  withEnv(t, {
    CLAUDE_HUD_ROOT: hud.root,
    CLAUDE_HUD_STATUSLINE_LAST_RENDER: '1',
    DSH_HOME: mkdtempSync(join(tmpdir(), 'hud-dsh-')),
  })
  apply(h.ctx)
  t.after(() => {
    h.dispose()
    const pid = readPid(hud.pidFile)
    if (pid !== undefined && isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  })
  return { hud, agent, agents, h }
}

/** Wait for the hanging hud to report its pid, and check it is really running. */
async function startedPid(hud) {
  const pid = await waitFor(() => readPid(hud.pidFile), { what: 'the hud child to start' })
  assert.equal(isAlive(pid), true, 'the hud child started and is running')
  return pid
}

async function assertKilled(pid, startedAt) {
  await waitFor(() => !isAlive(pid), { timeoutMs: CANCEL_WITHIN_MS, what: 'the hud child to exit' })
  assert.equal(isAlive(pid), false, 'the hud child is gone')
  assert.ok(Date.now() - startedAt < CANCEL_WITHIN_MS, 'killed at disposal, not left to its 20 s render timeout')
}

test('disposing the agent kills a model-switch render that is still running', async (t) => {
  const { hud, agent, agents, h } = setup(t)
  // The model-switch path passes no signal of its own: only the agent's controller links it.
  h.emit('session/event', agent.session, { type: 'model/selection', data: { model: 'switched' } })
  const pid = await startedPid(hud)
  const startedAt = Date.now()
  agents.delete(agent.id)
  h.emit('agent/disposed', { agent })
  await assertKilled(pid, startedAt)
})

test('disposing the plugin kills a model-switch render that is still running', async (t) => {
  const { hud, agent, h } = setup(t)
  h.emit('session/event', agent.session, { type: 'model/selection', data: { model: 'switched' } })
  const pid = await startedPid(hud)
  const startedAt = Date.now()
  h.dispose()
  await assertKilled(pid, startedAt)
})

test('disposing the agent kills a turn-boundary render that is still running', async (t) => {
  const { hud, agent, agents, h } = setup(t)
  const [rendering] = h.run('agent/turn-stopping', { agent })
  const pid = await startedPid(hud)
  const startedAt = Date.now()
  agents.delete(agent.id)
  h.emit('agent/disposed', { agent })
  await rendering
  await assertKilled(pid, startedAt)
})

test('disposing the agent kills a dock read\'s render that is still running', async (t) => {
  const { hud, agent, agents, h } = setup(t)
  const rendering = h.read(agent.id, 100)
  const pid = await startedPid(hud)
  const startedAt = Date.now()
  agents.delete(agent.id)
  h.emit('agent/disposed', { agent })
  await rendering
  await assertKilled(pid, startedAt)
})

test('disposing the plugin kills a dock read\'s render that is still running', async (t) => {
  const { hud, agent, h } = setup(t)
  const rendering = h.read(agent.id, 100)
  const pid = await startedPid(hud)
  const startedAt = Date.now()
  h.dispose()
  await rendering
  await assertKilled(pid, startedAt)
})
