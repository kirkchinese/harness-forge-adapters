/**
 * The dock's poll renders at most once every 5 s while a session keeps producing events. A render
 * that sees newer session events must not follow up immediately; the next poll renders them after
 * the window. A turn-boundary render is not delayed by that ceiling.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ROUTE, appendEvent, delay, freezeClock, makeAgent, makeCtx, makeCountingHud, spawnCount, withEnv,
} from './helpers/harness.js'
import { apply } from '../index.js'

const POLL_CEILING_MS = 5_000
const USAGE = { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }

function setup(t, { delayMs }) {
  const hud = makeCountingHud({ delayMs })
  const agent = makeAgent({ id: 's-pace' })
  const h = makeCtx(new Map([[agent.id, agent]]))
  withEnv(t, {
    CLAUDE_HUD_ROOT: hud.root,
    CLAUDE_HUD_STATUSLINE_LAST_RENDER: '1',
    DSH_HOME: mkdtempSync(join(tmpdir(), 'hud-dsh-')),
  })
  const clock = freezeClock(t)
  apply(h.ctx)
  t.after(() => h.dispose())
  return { hud, agent, h, clock }
}

const response = () => ({ writeHead() {}, end() {} })

/** One dock poll for the session at the given width. */
function poll(h, agent, cols = 100) {
  return h.route().handler({ url: `${ROUTE}?session=${agent.id}&cols=${cols}` }, response())
}

test('a render that sees newer session events does not follow up inside the 5 s ceiling', async (t) => {
  const { hud, agent, h, clock } = setup(t, { delayMs: 150 })

  const first = poll(h, agent)
  // While the render runs, DSH records an assistant message: after it, the session has advanced.
  await delay(30)
  appendEvent(agent, { type: 'assistant/message', data: { usage: USAGE } })
  await first

  assert.equal(spawnCount(hud.logFile), 1, 'the follow-up render waited for the ceiling')
  await delay(400)
  assert.equal(spawnCount(hud.logFile), 1, 'and it does not start on its own later either')

  // The next poll, after the window, renders the newer facts.
  clock.advance(POLL_CEILING_MS)
  await poll(h, agent)
  assert.equal(spawnCount(hud.logFile), 2, 'the poll after the ceiling rendered again')

  await delay(400)
  assert.equal(spawnCount(hud.logFile), 2, 'the second render did not loop either')
})

test('the turn-boundary render starts at once, inside the poll ceiling', async (t) => {
  const { hud, agent, h } = setup(t, { delayMs: 0 })

  await poll(h, agent)
  assert.equal(spawnCount(hud.logFile), 1)

  await Promise.all(h.run('agent/turn-stopping', { agent }))
  assert.equal(spawnCount(hud.logFile), 2, 'the turn-boundary render was not delayed by the ceiling')
})
