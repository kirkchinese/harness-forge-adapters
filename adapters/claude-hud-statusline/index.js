/**
 * claude-hud: the status line, in DSH.
 *
 * In Claude Code, the plugin's `statusLine` command is `node hud.mjs`: Claude Code writes a JSON
 * payload about the session to its stdin, and it prints the coloured status lines to stdout. This
 * adapter keeps that arrangement and only replaces the transport:
 *
 *   DSH session facts  →  the payload Claude Code would have written  →  `node <plugin>/hud.mjs`
 *                      ←  its stdout, ANSI colour and all              ←
 *
 * so claude-hud computes the lines and their ANSI styling. The adapter maps that styling to the
 * browser (client.js) and lays the lines out below the composer. The dock reads them through Harness
 * Forge's harnessCompat Remote namespace, which needs Harness Forge 0.2.0 or later:
 *
 *   registerAdapterSurface('claude-hud-statusline', { read(session, { cols }) → { lines: string[], at: number } })
 *
 * A render only happens where a DSH window (webServer) exists, or when the opt-in diagnostic is on
 * (or the port trial harness runs the session); headless DSH renders nothing by default. The
 * diagnostic writes `last-render.json` in the adapter's data directory, which harness_port_trial
 * reads.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { locatePlugin } from './plugin-root.js'

export const name = 'claude-hud-statusline'

// What the dock shows when this machine has no claude-hud to run: one line, naming both ways out.
export const NOT_FOUND_LINE = 'claude-hud: not installed. Install it for Claude Code, or set CLAUDE_HUD_ROOT to its folder (the one holding hud.mjs).'
// The dock has a little padding, and a desktop window is about this wide.
const DEFAULT_COLUMNS = 120
const MIN_COLUMNS = 40
const MAX_COLUMNS = 240
// hud.mjs's own cage wall is 10 s; this only stops a wedged child on renders outside the turn wait.
const RENDER_TIMEOUT_MS = 20_000
// Same ceiling hud.mjs puts on the cage's output.
const MAX_OUTPUT_BYTES = 64 * 1024
// A turn must not be held open by the HUD's redraw for longer than this. This is the turn wait,
// not how long a render normally takes.
const TURN_STOP_DEADLINE_MS = 8_000
// The dock polls every 2 s. A render that only follows newer session events waits this long since
// the render it follows started, and the poll only starts one when the cached render is this old.
const POLL_REFRESH_MS = 5_000
// The user's opt-in: turning this on writes `last-render.json` and renders in headless DSH.
const DIAGNOSTIC_ENV = 'CLAUDE_HUD_STATUSLINE_LAST_RENDER'
// The port trial harness sets this for the trial session only; the adapter never sees it elsewhere.
const TRIAL_ENV = 'HARNESS_FORGE_TRIAL'
// Keep one current-width entry per live session; this is only a backstop against a session leak.
const MAX_CACHED_SESSIONS = 64

// Session events that change what the line shows outside a turn's stop boundary.
export const RENDER_EVENTS = ['model/selection']
// Events after which the line the dock holds is out of date.
const LIVE_EVENTS = new Set(['turn/start', 'assistant/message', 'request/context', 'model/selection'])

const isTruthy = (value) => {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return !!text && !['0', 'false', 'off', 'no'].includes(text)
}

/**
 * Whether the `last-render.json` diagnostic is on for an environment. Two things turn it on:
 * - `CLAUDE_HUD_STATUSLINE_LAST_RENDER`, the user's opt-in, in any truthy spelling;
 * - `HARNESS_FORGE_TRIAL=1`, which harness_port_trial sets for its own scratch session so it can
 *   read what the adapter rendered. It is not set in a normal DSH.
 * Nothing else does — no credential, no other variable — so a real API key cannot switch on a
 * diagnostic the user did not ask for.
 */
export function isDiagnosticEnabled(env = process.env) {
  if (isTruthy(env?.[DIAGNOSTIC_ENV])) return true
  return String(env?.[TRIAL_ENV] ?? '').trim() === '1'
}

/**
 * Where claude-hud is installed on the user's own machine, or undefined when it is not installed.
 * plugin-root.js's locatePlugin() looks in $CLAUDE_HUD_ROOT, then at Harness Forge imports recorded
 * in any DSH profile, then at Claude Code's, Codex's and OpenCode's own installs. A root only counts
 * when it really holds the status line (`hud.mjs`), so a stale install record falls through to a
 * later valid install instead of a spawn error.
 */
export function pluginRoot() {
  const root = locatePlugin()
  if (typeof root !== 'string' || root === '') return undefined
  return existsSync(join(root, 'hud.mjs')) ? root : undefined
}

// ---------------------------------------------------------------------------
// Node resolution. claude-hud's cage re-runs `process.execPath`; in DSH Desktop
// that is the Electron binary, so the HUD must be started with a real Node.
// ---------------------------------------------------------------------------
const MIN_NODE_MAJOR = 22
const MIN_NODE_MINOR = 18

export function parseNodeVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text).trim())
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isSupportedNodeVersion(version) {
  if (!Array.isArray(version)) return false
  const [major, minor] = version
  return Number.isInteger(major) && Number.isInteger(minor)
    && (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR))
}

function samePath(left, right, platform = process.platform) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  let a = left
  let b = right
  try { a = realpathSync(left) } catch { /* keep the given path */ }
  try { b = realpathSync(right) } catch { /* keep the given path */ }
  if (platform === 'win32') {
    a = a.toLowerCase()
    b = b.toLowerCase()
  }
  return a === b
}

function pathDirs(env) {
  return String(env.PATH ?? '')
    .split(delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '')
}

function nodeCandidates({ env, platform }) {
  const names = platform === 'win32' ? ['node.exe', 'node'] : ['node']
  const found = []
  for (const dir of pathDirs(env)) {
    for (const leaf of names) {
      const exe = join(dir, leaf)
      if (existsSync(exe)) found.push(exe)
    }
  }
  return found
}

/**
 * Ask a candidate what it is without letting it open a window: `ELECTRON_RUN_AS_NODE` makes an
 * Electron binary answer like Node, and `process.versions.electron` tells us to reject it.
 */
function probeNode(exe, env) {
  try {
    const result = spawnSync(exe, ['-p', 'process.versions.electron ? "electron" : process.versions.node'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    })
    if (result.error !== undefined || result.status !== 0) return undefined
    const text = String(result.stdout ?? '').trim()
    if (text === 'electron') return { electron: true }
    return { version: parseNodeVersion(text) }
  } catch {
    return undefined
  }
}

/**
 * The executable to run claude-hud with. Under Electron (DSH Desktop) `process.execPath` is the
 * Electron binary, and hud.mjs's cage would relaunch Electron instead of Node, so a real Node on
 * PATH is used. Never returns Electron; if no suitable Node exists, returns `{ error }` with a
 * message the dock can draw. The parameters exist so the Electron branch can be tested on a Node.
 */
export function resolveNode({
  execPath = process.execPath,
  versions = process.versions,
  env = process.env,
  platform = process.platform,
} = {}) {
  const inElectron = typeof versions.electron === 'string' && versions.electron !== ''
  if (!inElectron) {
    const current = parseNodeVersion(versions.node)
    if (isSupportedNodeVersion(current)) return { exe: execPath, version: current.join('.'), electron: false }
  }
  const tried = []
  const seen = new Set()
  for (const exe of nodeCandidates({ env, platform })) {
    const key = platform === 'win32' ? exe.toLowerCase() : exe
    if (seen.has(key)) continue
    seen.add(key)
    if (samePath(exe, execPath, platform)) {
      tried.push(`${exe} (the running ${inElectron ? 'Electron' : 'Node'} binary)`)
      continue
    }
    const probe = probeNode(exe, env)
    if (probe === undefined) {
      tried.push(`${exe} (not runnable)`)
      continue
    }
    if (probe.electron === true) {
      tried.push(`${exe} (Electron)`)
      continue
    }
    if (!isSupportedNodeVersion(probe.version)) {
      tried.push(`${exe} (${probe.version === undefined ? 'unknown version' : probe.version.join('.')})`)
      continue
    }
    return { exe, version: probe.version.join('.'), electron: false }
  }
  const need = 'claude-hud needs a real Node 22.18+'
  const why = inElectron
    ? 'DSH Desktop runs on Electron, and claude-hud re-launches process.execPath, which would be Electron here.'
    : 'the Node running DSH is older than 22.18.'
  const detail = tried.length === 0 ? ' No node executable is on PATH.' : ` Tried: ${tried.join(', ')}.`
  return { error: new Error(`${need}. ${why} Install Node 22.18+ (or put it on PATH) and try again.${detail}`) }
}

function abortError() {
  const error = new Error('render aborted')
  error.name = 'AbortError'
  return error
}

/** Kill the child and, where supported, its whole process tree. */
function killTree(child) {
  if (child === undefined || typeof child.pid !== 'number') return
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5_000,
      })
      if (result.error === undefined && result.status === 0) return
    } catch { /* fall through to the direct kill */ }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
    return
  } catch { /* not a process-group leader */ }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

function splitLines(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Runs the plugin's own status line for one payload, exactly as Claude Code runs it, and returns the
 * lines it printed. Its stdout already passed hud.mjs's terminalFilter (colour and safe links only).
 * Only exit code 0 is success; a signal (code null) or a nonzero code is a failure. Aborting or
 * timing out kills the child's process tree.
 */
export function runHud(entry, payload, columns, { signal, timeoutMs = RENDER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const node = resolveNode()
    if (node.error !== undefined) { reject(node.error); return }
    if (signal?.aborted) { reject(abortError()); return }

    const env = { ...process.env, COLUMNS: String(columns) }
    // A real Node ignores this, but leaving it out keeps an accidental Electron launch from
    // inheriting a Node-only mode.
    delete env.ELECTRON_RUN_AS_NODE

    const child = spawn(node.exe, [entry], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    let out = ''
    let err = ''
    let bytes = 0
    let settled = false
    let timer

    const finish = (error, lines) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error !== undefined) {
        killTree(child)
        reject(error)
      } else {
        resolve(lines)
      }
    }
    const onAbort = () => finish(abortError())
    timer = setTimeout(() => finish(new Error(`claude-hud did not answer within ${timeoutMs} ms`)), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_OUTPUT_BYTES) { finish(new Error('claude-hud printed more than 64 KB')); return }
      out += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-4096) })
    child.on('error', (error) => finish(error))
    child.on('close', (code, signalName) => {
      const excerpt = err.trim() === '' ? '' : `: ${err.trim().split('\n').pop().slice(0, 500)}`
      if (code === 0) return finish(undefined, splitLines(out))
      if (code === null) return finish(new Error(`claude-hud was killed by ${signalName ?? 'a signal'}${excerpt}`))
      return finish(new Error(`claude-hud exited with code ${code}${excerpt}`))
    })
    child.stdin.on('error', () => { /* the child may answer without reading everything */ })
    try { child.stdin.end(JSON.stringify(payload)) } catch { /* close/error reports it */ }
  })
}

const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

/**
 * The statusline payload Claude Code writes to stdin, built from what DSH recorded for the session.
 * Claude Code reports cache reads and cache writes beside the uncached input, and DSH's TokenUsage
 * counts are disjoint in exactly the same way, so both are passed through unmapped-but-renamed.
 * `used_percentage` is left out on purpose: claude-hud derives it from these counts itself.
 */
export function stdinPayload(facts) {
  const model = facts?.model ?? {}
  const usage = facts?.usage
  const contextWindow = {}
  if (typeof facts?.contextWindow === 'number' && facts.contextWindow > 0) contextWindow.context_window_size = facts.contextWindow
  contextWindow.current_usage = usage === undefined
    ? null
    : {
        input_tokens: count(usage.inputTokens),
        output_tokens: count(usage.outputTokens),
        cache_creation_input_tokens: count(usage.cacheWriteTokens),
        cache_read_input_tokens: count(usage.cacheReadTokens),
      }
  const payload = {
    session_id: facts?.sessionId,
    cwd: facts?.cwd,
    workspace: { current_dir: facts?.cwd, project_dir: facts?.cwd },
    model: { id: model.model, display_name: model.model },
    context_window: contextWindow,
  }
  // Claude Code reports the reasoning effort it asked for; DSH records the selected one.
  if (typeof model.reasoningEffort === 'string' && model.reasoningEffort.trim() !== '') payload.effort = { level: model.reasoningEffort.trim() }
  return payload
}

/** The columns to lay the line out for: what the client asked for, clamped, else the default. */
export function columnsOf(raw) {
  const value = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(value) && value > 0 ? Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, value)) : DEFAULT_COLUMNS
}

export function apply(ctx) {
  // One entry per session (its current width), one in-flight render per session, and one abort
  // controller per live agent: aborting that controller kills every render the agent still has
  // running, whatever started it.
  const latest = new Map()
  const pending = new Map()
  const controls = new Map()
  const lifetime = new AbortController()
  let hasWindow = false
  const dataDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'harness-forge', 'adapter-data', 'claude-hud-statusline')

  function diagnosticsEnabled() {
    return isDiagnosticEnabled(process.env)
  }

  function shouldRender() {
    return hasWindow || diagnosticsEnabled()
  }

  function agentSessionId(agent) {
    return agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id
  }

  function profileName() {
    const profile = ctx.get('profileContext')
    if (typeof profile?.name === 'string' && profile.name !== '') return profile.name
    return typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== '' ? process.env.DSH_PROFILE : null
  }

  /** The controller whose abort ends every render for this agent, created on first use. */
  function sessionControl(sessionId) {
    let control = controls.get(sessionId)
    if (control === undefined) {
      control = new AbortController()
      controls.set(sessionId, control)
    }
    return control
  }

  /**
   * Abort and forget one session: its agent's controller (which kills any render's child it still
   * has running), its in-flight render's own controller, and its cached and pending entries. Every
   * render is linked to the session controller in `refresh`, so this cancels renders that were
   * started from a model switch or a dock read with no signal of their own.
   */
  function forgetSession(sessionId) {
    if (sessionId === undefined) return
    const control = controls.get(sessionId)
    controls.delete(sessionId)
    control?.abort()
    const running = pending.get(sessionId)
    if (running !== undefined) running.controller.abort()
    latest.delete(sessionId)
    pending.delete(sessionId)
  }

  /** Drop cached and in-flight entries, and abort the renders, for sessions whose agent is gone. */
  function pruneGoneAgents() {
    const agents = ctx.get('agents')
    if (agents === undefined) return
    const known = new Set([...latest.keys(), ...pending.keys(), ...controls.keys()])
    for (const sessionId of known) if (agents.get(sessionId) === undefined) forgetSession(sessionId)
  }

  function trimCache() {
    if (latest.size <= MAX_CACHED_SESSIONS) return
    const oldest = [...latest.entries()].sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0))
    for (let index = 0; index < oldest.length - MAX_CACHED_SESSIONS; index++) latest.delete(oldest[index][0])
  }

  /**
   * The opt-in diagnostic. Written atomically, and it names the profile and the session it belongs
   * to so a shared DSH home cannot be mistaken for a render from another profile or session.
   */
  function writeLastRender(sessionId, entry) {
    try {
      mkdirSync(dataDir, { recursive: true })
      const body = JSON.stringify({ profile: profileName(), sessionId, ...entry }, null, 2)
      const tmp = join(dataDir, `last-render.${String(process.pid)}.${Math.random().toString(36).slice(2)}.tmp`)
      writeFileSync(tmp, body)
      renameSync(tmp, join(dataDir, 'last-render.json'))
    } catch (error) {
      ctx.logger?.warn?.('claude-hud-statusline: could not write last-render.json', error)
    }
  }

  function remember(sessionId, entry) {
    latest.set(sessionId, entry)
    trimCache()
    if (diagnosticsEnabled()) writeLastRender(sessionId, entry)
    return entry
  }

  /** Whether a live event happened at or after `seq`, so a render can follow the newest facts. */
  function advancedSince(sessionId, seq) {
    const agent = ctx.get('agents')?.get(sessionId)
    if (agent === undefined) return false
    const session = agent.session
    const end = Number(session?.seq)
    if (!Number.isFinite(end)) return false
    for (let s = Math.max(0, Number(seq) || 0); s < end; s++) {
      const event = session.eventAt(s)
      if (event !== undefined && LIVE_EVENTS.has(event.type)) return true
    }
    return false
  }

  /**
   * One render: the session's facts as they are now, through the plugin, into `latest` (and, when
   * the diagnostic is on, into last-render.json). The plugin root is looked up on every render, so a
   * claude-hud the user installs (or moves) later is picked up without restarting DSH; when none is
   * found, the item says so and nothing is spawned. Unexpected errors become a diagnostic line, never
   * a rejected cache entry; an aborted render is dropped so the previous line stays.
   */
  async function renderOnce(sessionId, columns, signal) {
    const started = Date.now()
    try {
      const agent = ctx.get('agents')?.get(sessionId)
      if (agent === undefined) return undefined
      const facts = sessionFacts(agent)
      const seenSeq = agent.session.seq
      const payload = stdinPayload(facts)
      const root = pluginRoot()
      if (root === undefined) {
        return {
          sessionId,
          lines: [NOT_FOUND_LINE],
          facts,
          stdin: payload,
          at: Date.now(),
          seq: seenSeq,
          durationMs: Date.now() - started,
          error: 'claude-hud is not installed on this machine',
          columns,
        }
      }
      try {
        const lines = await runHud(join(root, 'hud.mjs'), payload, columns, { signal })
        return { sessionId, lines, facts, stdin: payload, at: Date.now(), seq: seenSeq, durationMs: Date.now() - started, columns }
      } catch (error) {
        if (error?.name === 'AbortError') return undefined
        const message = error instanceof Error ? error.message : String(error)
        return {
          sessionId,
          lines: [`claude-hud: ${message.slice(0, 1000)}`],
          facts,
          stdin: payload,
          at: Date.now(),
          seq: seenSeq,
          durationMs: Date.now() - started,
          error: message,
          columns,
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError') return undefined
      const message = error instanceof Error ? error.message : String(error)
      const agent = ctx.get('agents')?.get(sessionId)
      return {
        sessionId,
        lines: [`claude-hud: ${message.slice(0, 1000)}`],
        at: Date.now(),
        seq: agent?.session?.seq ?? 0,
        durationMs: Date.now() - started,
        error: message,
        columns,
      }
    }
  }

  /**
   * Renders one session at one width. Every render is linked to three signals — the plugin's
   * lifetime, the session's agent controller, and the caller's own (the turn wait's deadline) — so
   * disposing the plugin, disposing the agent, or the caller giving up all kill the child, rather
   * than letting it run to its timeout.
   *
   * A render takes a moment and a turn can finish inside one, so when the session advances while
   * the render runs one more render would follow. That follow-up obeys the dock's 5 s ceiling: it
   * only runs when at least POLL_REFRESH_MS have passed since the render it follows started;
   * otherwise it is left to the next poll, so a session producing events cannot be re-rendered more
   * often than once every 5 s. A width change requested during a render is not a poll redraw and
   * does redraw at once. The pending entry is cleared in `finally` whether the render resolved,
   * aborted or threw.
   */
  function refresh(sessionId, columns = DEFAULT_COLUMNS, options = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve(undefined)
    if (lifetime.signal.aborted) return Promise.resolve(undefined)
    if (ctx.get('agents')?.get(sessionId) === undefined) { forgetSession(sessionId); return Promise.resolve(undefined) }
    const running = pending.get(sessionId)
    if (running !== undefined) {
      if (columns !== running.columns) { running.columns = columns; running.redraw = true }
      running.link(options.signal)
      return running.promise
    }
    const state = {
      columns,
      // A caller asked for a different width while this render ran: redraw at once at that width.
      redraw: false,
      // The session advanced while this render ran: follow up, subject to the 5 s ceiling.
      followUp: false,
      controller: new AbortController(),
      links: [],
      link: undefined,
      promise: undefined,
    }
    state.link = (signal) => {
      if (signal === undefined) return
      if (signal.aborted) { state.controller.abort(); return }
      const onAbort = () => state.controller.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      state.links.push(() => signal.removeEventListener('abort', onAbort))
    }
    state.link(lifetime.signal)
    state.link(sessionControl(sessionId).signal)
    state.link(options.signal)
    pending.set(sessionId, state)
    state.promise = (async () => {
      try {
        let entry
        for (;;) {
          state.redraw = false
          state.followUp = false
          const startedAt = Date.now()
          entry = await renderOnce(sessionId, state.columns, state.controller.signal)
          if (entry !== undefined) {
            // The agent may have been disposed while the render ran; do not cache a gone session.
            if (ctx.get('agents')?.get(sessionId) === undefined) { forgetSession(sessionId); return undefined }
            remember(sessionId, entry)
            // Keep a width change requested while the render ran, and follow the session only when
            // it actually advanced; a failing render retries on the next poll instead of looping.
            state.followUp = state.followUp || (entry.error === undefined && advancedSince(sessionId, entry.seq))
          }
          if (!state.redraw && !state.followUp) break
          if (state.controller.signal.aborted) break
          if (ctx.get('agents')?.get(sessionId) === undefined) { forgetSession(sessionId); break }
          // The poll's ceiling: a follow-up for newer session events waits until 5 s have passed
          // since the render it follows started, and otherwise is left to the next poll.
          if (!state.redraw && Date.now() - startedAt < POLL_REFRESH_MS) break
        }
        return latest.get(sessionId)
      } catch (error) {
        // A stack overflow, a bad facts shape: show a line, do not leave a rejected cache entry.
        const message = error instanceof Error ? error.message : String(error)
        if (ctx.get('agents')?.get(sessionId) !== undefined) {
          remember(sessionId, {
            sessionId,
            lines: [`claude-hud: ${message.slice(0, 1000)}`],
            at: Date.now(),
            seq: ctx.get('agents')?.get(sessionId)?.session?.seq ?? 0,
            error: message,
            columns: state.columns,
          })
        }
        return latest.get(sessionId)
      } finally {
        for (const unlink of state.links) unlink()
        pending.delete(sessionId)
      }
    })()
    return state.promise
  }

  function needsRender(sessionId, columns, cached) {
    if (cached === undefined) return true
    if (cached.columns !== columns) return true
    if (Date.now() - cached.at < POLL_REFRESH_MS) return false
    const agent = ctx.get('agents')?.get(sessionId)
    if (agent === undefined) return false
    const end = Number(agent.session.seq)
    if (!Number.isFinite(end)) return false
    const start = Number.isFinite(cached.seq) ? Math.max(0, cached.seq) : 0
    for (let seq = start; seq < end; seq++) {
      const event = agent.session.eventAt(seq)
      if (event !== undefined && LIVE_EVENTS.has(event.type)) return true
    }
    return false
  }

  // A model switch can happen between turns, when nothing else would redraw the line. The render is
  // linked inside refresh() to the plugin lifetime and this session's agent controller, so a
  // disposal kills it even though this path passes no signal of its own.
  ctx.on('session/event', (session, event) => {
    if (!RENDER_EVENTS.includes(event.type)) return
    if (!shouldRender()) return
    refresh(session.id).catch((error) => ctx.logger?.warn?.('claude-hud-statusline: render failed', error))
  })

  // The end of a turn is Claude Code's own trigger: this hook is awaited before the turn closes, so
  // the last render of a session — the one a headless trial keeps — carries the turn's own numbers.
  // A subagent's turn has no dock, so it costs nothing. The 8 s deadline cancels the render itself;
  // refresh() adds the plugin lifetime and the agent's controller, so a disposal cancels it too.
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (!shouldRender()) return
    const session = agent.session
    if ((session.header.delegationDepth ?? 0) > 0) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TURN_STOP_DEADLINE_MS)
    try {
      await refresh(session.header.id, DEFAULT_COLUMNS, { signal: controller.signal }).catch((error) => ctx.logger?.warn?.('claude-hud-statusline: render failed', error))
    } finally {
      clearTimeout(timer)
    }
  })

  // Disposing a session's agent aborts its controller, which kills a render the agent still has
  // running, and drops its cached and in-flight entries so memory stays bounded over long runs.
  ctx.on('agent/disposed', ({ agent }) => {
    forgetSession(agentSessionId(agent))
    pruneGoneAgents()
  })

  // Renders run where DSH serves a window (Web, Desktop); headless runs render only for the
  // diagnostic, and keep last-render.json in that case.
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => {
      hasWindow = true
      return () => { hasWindow = false }
    }, 'claude-hud-statusline: window')
  })

  // The dock reads the line through Harness Forge's harnessCompat Remote namespace (DSH's own Remote
  // carrier): one read per poll, for the dock's width. The adapter serves no HTTP route of its own.
  ctx.inject(['harnessCompat'], (scoped) => {
    const harnessCompat = scoped.get('harnessCompat')
    if (typeof harnessCompat?.registerAdapterSurface !== 'function') {
      ctx.logger?.('claude-hud-statusline')?.warn?.('Harness Forge in this profile is older than 0.2.0 (no registerAdapterSurface); the status line needs @kirkchinese/dsh-harness-compat 0.2.0 or later')
      return
    }
    scoped.effect(() => {
      const published = harnessCompat.registerAdapterSurface('claude-hud-statusline', {
        read: async (sessionId, request) => {
          const columns = columnsOf(request?.cols === undefined || request?.cols === null ? null : String(request.cols))
          pruneGoneAgents()
          const cached = latest.get(sessionId)
          if (needsRender(sessionId, columns, cached)) await refresh(sessionId, columns, { signal: lifetime.signal }).catch(() => undefined)
          return latest.get(sessionId) ?? { lines: [], at: 0, sessionId }
        },
      })
      return () => published.dispose()
    }, 'claude-hud-statusline: surface')
  })

  // Cancel outstanding renders when the plugin is disposed: every render is linked to the lifetime
  // signal, and the per-agent controllers are aborted as well so nothing waits for a render's own
  // timeout.
  ctx.effect(() => () => {
    lifetime.abort()
    for (const control of controls.values()) control.abort()
    for (const running of pending.values()) running.controller.abort()
    controls.clear()
    latest.clear()
    pending.clear()
  }, 'claude-hud-statusline: dispose')
}

/**
 * Facts DSH records about a session, for status surfaces:
 * - model: { provider, model, reasoningEffort } of the latest 'model/selection', or of the route the
 *   newest 'request/context' recorded when nobody switched models in this session;
 * - contextWindow: of the latest 'request/context';
 * - usage: the latest 'assistant/message' usage { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
 * - contextTokens: what that request held (input + cache read + cache write);
 * - totals: the session's summed usage; turns: completed turns; cwd; sessionId.
 */
export function sessionFacts(agent) {
  const session = agent.session
  const facts = { sessionId: session.header.id, cwd: session.header.cwd ?? process.cwd(), turns: 0, totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    const data = event.data ?? {}
    if (event.type === 'model/selection') facts.model = { provider: data.provider, model: data.model, reasoningEffort: data.reasoningEffort }
    if (event.type === 'request/context') facts.contextWindow = data.contextWindow
    if (event.type === 'turn/end') facts.turns += 1
    if (event.type === 'assistant/message' && data.usage !== undefined) {
      facts.usage = data.usage
      for (const key of Object.keys(facts.totals)) facts.totals[key] += Number(data.usage[key] ?? 0)
    }
  }
  if (facts.usage !== undefined) facts.contextTokens = Number(facts.usage.inputTokens ?? 0) + Number(facts.usage.cacheReadTokens ?? 0) + Number(facts.usage.cacheWriteTokens ?? 0)
  // A session nobody switched models in has no 'model/selection' event; the route the loop actually
  // prepared is recorded on every request and names the same provider and model.
  const route = typeof session.requestContext === 'function' ? session.requestContext() : undefined
  if (route !== undefined && route !== null) {
    if (typeof facts.model !== 'object') facts.model = { provider: route.provider, model: route.model }
    if (typeof facts.contextWindow !== 'number' && typeof route.contextWindow === 'number') facts.contextWindow = route.contextWindow
  }
  if (typeof facts.model === 'object') facts.modelName = facts.model.model
  return facts
}
