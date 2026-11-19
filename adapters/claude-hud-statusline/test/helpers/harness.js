/**
 * A small stand-in for the parts of cordis `ctx` that the adapter uses, plus a fake agent and two
 * HUD stubs: one that hangs (so a test can watch the adapter kill it) and one that counts spawns
 * (so a test can watch the polling ceiling). Exports only; running it as a test file does nothing.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A live agent with DSH's session shape: header, seq, eventAt(), optional requestContext(). */
export function makeAgent({ id = 's1', cwd = process.cwd(), events = [], delegationDepth = 0 } = {}) {
  const session = {
    id,
    header: { id, cwd, delegationDepth },
    events,
    seq: events.length,
    eventAt: (seq) => events[seq],
    requestContext: () => undefined,
  }
  return { id, session }
}

/** Append a session event, as DSH does while a turn runs. */
export function appendEvent(agent, event) {
  agent.session.events.push(event)
  agent.session.seq = agent.session.events.length
}

/**
 * The fake ctx: `on` records handlers, `effect` keeps disposers (run last-in-first-out by
 * dispose()), `inject(['webServer'], …)` marks a window, `inject(['harnessCompat'], …)` records the
 * surface the adapter publishes. `agents` is a Map standing in for DSH's agent registry.
 */
export function makeCtx(agents) {
  const handlers = new Map()
  const disposers = []
  const surfaces = []
  const logger = { warn() {}, info() {}, debug() {} }
  const ctx = {
    logger,
    get(name) {
      if (name === 'agents') return agents
      return undefined
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    inject(names, callback) {
      if (!Array.isArray(names)) return
      const harnessCompat = {
        registerAdapterSurface(id, source) {
          const entry = { id, source }
          surfaces.push(entry)
          return {
            changed() {},
            dispose() {
              const index = surfaces.indexOf(entry)
              if (index >= 0) surfaces.splice(index, 1)
            },
          }
        },
      }
      const services = { webServer: {}, harnessCompat }
      if (!names.every((name) => name in services)) return
      callback({ get: (name) => services[name], effect: ctx.effect, logger })
    },
  }
  return {
    ctx,
    handlers,
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args)
    },
    run(event, ...args) {
      return (handlers.get(event) ?? []).map((handler) => handler(...args))
    },
    /** One dock read of the published surface, as the browser half makes it. */
    read(session, cols) {
      return surfaces[0].source.read(session, { adapter: surfaces[0].id, session, cols })
    },
    dispose() {
      while (disposers.length > 0) disposers.pop()()
    },
  }
}

/** Set environment variables for one test and restore them afterwards. */
export function withEnv(t, values) {
  const saved = new Map()
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key])
    process.env[key] = String(value)
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

/** Freeze Date.now() so a test can advance the adapter's clock without sleeping. */
export function freezeClock(t, start = 1_800_000_000_000) {
  const realNow = Date.now
  let now = start
  Date.now = () => now
  t.after(() => { Date.now = realNow })
  return {
    now: () => now,
    advance(ms) { now += ms },
  }
}

/** A hud.mjs that records its own pid and then hangs, so only a kill ends it. */
export function makeHangingHud() {
  const root = mkdtempSync(join(tmpdir(), 'hud-hang-'))
  const pidFile = join(root, 'pid.txt')
  const logFile = join(root, 'spawns.log')
  writeFileSync(join(root, 'hud.mjs'), [
    "import { appendFileSync, writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    `appendFileSync(${JSON.stringify(logFile)}, 'spawn\\n')`,
    "process.stdout.write('hanging\\n')",
    'setTimeout(() => {}, 600000)',
    '',
  ].join('\n'))
  return { root, pidFile, logFile }
}

/** A hud.mjs that logs one line per run and prints a line after delayMs, so runs are countable. */
export function makeCountingHud({ delayMs = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hud-count-'))
  const logFile = join(root, 'spawns.log')
  writeFileSync(join(root, 'hud.mjs'), [
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(logFile)}, 'spawn\\n')`,
    `setTimeout(() => { process.stdout.write('tick\\n') }, ${String(delayMs)})`,
    '',
  ].join('\n'))
  return { root, logFile }
}

/** How many hud.mjs runs have started. */
export function spawnCount(logFile) {
  try {
    return readFileSync(logFile, 'utf8').split('\n').filter((line) => line !== '').length
  } catch {
    return 0
  }
}

/** The pid the hanging hud wrote, or undefined while it has not started. */
export function readPid(pidFile) {
  try {
    const text = readFileSync(pidFile, 'utf8').trim()
    return text === '' ? undefined : Number(text)
  } catch {
    return undefined
  }
}

/** Whether the process is still there. */
export function isAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Poll until condition() is truthy, or fail after timeoutMs. */
export async function waitFor(condition, { timeoutMs = 10_000, intervalMs = 25, what = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    let value
    try {
      value = condition()
    } catch {
      value = false
    }
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await delay(intervalMs)
  }
}
