/**
 * claude-hud's status line, drawn below the DSH composer.
 *
 * The server half runs the plugin's own `hud.mjs` and serves the lines it printed; this half maps
 * claude-hud's ANSI styling to spans and lays them out in 'conversation.composer.dock'. Only SGR
 * colour survives the trip (claude-hud's own terminal filter drops OSC 8 links and every other
 * escape sequence), so each line is drawn as styled spans. The dock measures its own width and asks
 * the server to lay the line out for that many columns.
 */
window.__ModuleLoader__.load({ id: "@kirkchinese/dsh-adapter-claude-hud-statusline", factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  const React = require('react')
  const h = React.createElement
  const ROUTE = '/plugins/claude-hud-statusline/surface'

  // GitHub's tested terminal palettes. `muted` is a real colour (the DSH tertiary label when the
  // host defines it), never reduced opacity over an already-secondary label.
  const PALETTES = {
    dark: {
      colors: ['#6e7681', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#f0f6fc'],
      bright: ['#8b949e', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff'],
      muted: 'var(--dsw-alias-label-tertiary, #8b949e)',
    },
    light: {
      colors: ['#24292f', '#cf222e', '#1a7f37', '#9a6700', '#0969da', '#8250df', '#1b7c83', '#6e7781'],
      bright: ['#57606a', '#a40e26', '#2da44e', '#bf8700', '#218bff', '#a475f9', '#3192aa', '#8c959f'],
      muted: 'var(--dsw-alias-label-tertiary, #57606a)',
    },
  }

  /**
   * DSH stores the active colour scheme on `body[data-ds-dark-theme]` and on the root
   * `color-scheme`. `prefers-color-scheme` only follows the OS, so it is a last resort: a user who
   * picked light in DSH while the OS is dark must still get the light palette.
   */
  function isDarkTheme() {
    if (typeof document !== 'undefined') {
      const body = document.body
      if (body !== null && body !== undefined && typeof body.hasAttribute === 'function' && body.hasAttribute('data-ds-dark-theme')) return true
      const root = document.documentElement
      if (root !== null && root !== undefined) {
        let scheme
        if (typeof getComputedStyle === 'function') {
          try { scheme = getComputedStyle(root).colorScheme } catch { /* no computed style here */ }
        }
        if (scheme === undefined && root.style !== undefined) scheme = root.style.colorScheme
        if (typeof scheme === 'string' && scheme.trim() !== '') return scheme.trim().startsWith('dark')
      }
    }
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: dark)').matches
  }

  function resolvePalette() {
    return isDarkTheme() ? PALETTES.dark : PALETTES.light
  }

  // A 256-colour cube, for the SGR 38;5 codes claude-hud can be configured to use.
  const CUBE = [0, 95, 135, 175, 215, 255]
  function xterm(n, palette) {
    if (n < 8) return palette.colors[n]
    if (n < 16) return palette.bright[n - 8]
    if (n < 232) return `rgb(${CUBE[Math.floor((n - 16) / 36)]},${CUBE[Math.floor((n - 16) / 6) % 6]},${CUBE[(n - 16) % 6]})`
    const gray = 8 + (n - 232) * 10
    return `rgb(${gray},${gray},${gray})`
  }

  /**
   * One line with ANSI SGR codes as `{ text, style }` parts; other escape sequences are dropped.
   * `dim` (SGR 2) is drawn as the palette's muted colour, not as reduced opacity, so the empty
   * context bar stays visible on light themes.
   */
  function spansToParts(line, palette) {
    const parts = []
    let style = {}
    const pattern = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g
    let last = 0
    let match
    const push = (text) => {
      if (text.length === 0) return
      let finalStyle = style
      if (style.dim === true) {
        const { dim, ...rest } = style
        finalStyle = { ...rest, color: palette.muted }
      }
      parts.push({ text, style: finalStyle })
    }
    while ((match = pattern.exec(line)) !== null) {
      push(line.slice(last, match.index))
      last = pattern.lastIndex
      if (match[1] === undefined) continue
      const codes = match[1] === '' ? [0] : match[1].split(';').map(Number)
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]
        if (code === 0) style = {}
        else if (code === 1) style = { ...style, fontWeight: 600 }
        else if (code === 2) style = { ...style, dim: true }
        else if (code === 3) style = { ...style, fontStyle: 'italic' }
        else if (code === 4) style = { ...style, textDecoration: 'underline' }
        else if (code === 22) { const { fontWeight, dim, ...rest } = style; style = rest }
        else if (code === 23) { const { fontStyle, ...rest } = style; style = rest }
        else if (code === 24) { const { textDecoration, ...rest } = style; style = rest }
        else if (code >= 30 && code <= 37) style = { ...style, color: palette.colors[code - 30] }
        else if (code >= 90 && code <= 97) style = { ...style, color: palette.bright[code - 90] }
        else if (code === 39) { const { color, ...rest } = style; style = rest }
        else if (code === 38 && codes[i + 1] === 2) { style = { ...style, color: `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})` }; i += 4 }
        else if (code === 38 && codes[i + 1] === 5) { style = { ...style, color: xterm(codes[i + 2], palette) }; i += 2 }
      }
    }
    push(line.slice(last))
    return parts
  }

  function spans(line, palette) {
    return spansToParts(line, palette).map((part, index) => h('span', { key: index, style: part.style }, part.text))
  }

  const MIN_COLS = 40
  const MAX_COLS = 240
  const DEFAULT_COLS = 120
  const CHAR_WIDTH = 7.2
  const RESIZE_DEBOUNCE_MS = 120

  /** Roughly how many monospace columns `widthPx` holds, clamped to the server's range. */
  function columnsForWidth(widthPx) {
    if (typeof widthPx !== 'number' || !Number.isFinite(widthPx) || widthPx <= 0) return DEFAULT_COLS
    return Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor(widthPx / CHAR_WIDTH)))
  }

  // The composer dock is a centred flex row shared with DSH's own statistics. The HUD is two lines
  // and must not be squeezed into a strip beside them: let the dock wrap, and give this entry a
  // full-width row of its own. Scoped to a dock that actually contains this adapter.
  const LAYOUT_CSS = '[data-composer-dock]:has([data-adapter="claude-hud-statusline"]){flex-wrap:wrap;row-gap:2px}' +
    '[data-composer-dock] [data-adapter="claude-hud-statusline"]{flex:1 0 100%;width:100%;min-width:0}'
  const STYLE_ID = 'claude-hud-statusline-layout'

  /** Install the one layout rule, returning its disposer. No-op outside a real document. */
  function installStyles() {
    if (typeof document === 'undefined' || document.head === undefined || document.head === null
      || typeof document.createElement !== 'function') return () => {}
    if (typeof document.getElementById === 'function' && document.getElementById(STYLE_ID) !== null) return () => {}
    const tag = document.createElement('style')
    tag.id = STYLE_ID
    tag.textContent = LAYOUT_CSS
    document.head.appendChild(tag)
    return () => { if (typeof tag.remove === 'function') tag.remove() }
  }

  /**
   * Coordinates one session's polling: clears the previous lines, never lets two polls overlap, and
   * ignores responses from an older request, an older session, or after disposal. Returns a disposer
   * that aborts the in-flight fetch and stops the interval.
   */
  function makeSessionTracker({ sessionId, columns, onLines, fetcher = defaultFetcher, intervalMs = 2000 }) {
    let disposed = false
    let controller = null
    let inFlight = false
    let requestId = 0

    onLines([], sessionId) // clear immediately (also on session switch)

    async function tick() {
      if (disposed || inFlight) return
      inFlight = true
      const myId = ++requestId
      controller = new AbortController()
      try {
        const data = await fetcher(`${ROUTE}?session=${encodeURIComponent(sessionId)}&cols=${columns()}`, controller.signal)
        if (disposed || myId !== requestId) return
        // The route can answer a request that started before a switch; never draw another session.
        if (data?.sessionId !== undefined && data.sessionId !== sessionId) return
        onLines(Array.isArray(data?.lines) ? data.lines : [], sessionId)
      } catch {
        // Aborted, or the next tick tries again.
      } finally {
        if (myId === requestId) inFlight = false
        controller = null
      }
    }

    void tick()
    const timer = setInterval(tick, intervalMs)
    return () => {
      disposed = true
      clearInterval(timer)
      controller?.abort()
    }
  }

  async function defaultFetcher(url, signal) {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`status ${response.status}`)
    return response.json()
  }

  function Surface({ sessionId }) {
    const [state, setState] = React.useState({ sessionId: undefined, lines: [] })
    const boxRef = React.useRef(null)
    const columnsRef = React.useRef(DEFAULT_COLS)
    const [dark, setDark] = React.useState(() => isDarkTheme())

    // The layout rule is installed from apply(); mount is a fallback for a host that loaded the
    // bundle before <head> existed. installStyles() is idempotent and returns a disposer.
    React.useEffect(() => installStyles(), [])

    // Follow DSH's theme switch as well as the OS scheme, so palette changes apply without a reload.
    React.useEffect(() => {
      if (typeof window === 'undefined') return undefined
      const update = () => setDark(isDarkTheme())
      const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined
      query?.addEventListener?.('change', update)
      const observer = typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body
        ? new MutationObserver(update)
        : undefined
      observer?.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
      return () => {
        query?.removeEventListener?.('change', update)
        observer?.disconnect()
      }
    }, [])

    // Measure the dock's own width (minus its padding) with a ref and ResizeObserver, debounced.
    React.useEffect(() => {
      const el = boxRef.current
      if (el === null || el === undefined) return undefined
      const measure = () => {
        const rect = el.getBoundingClientRect()
        let padding = 0
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
          const computed = window.getComputedStyle(el)
          padding = (parseFloat(computed.paddingLeft) || 0) + (parseFloat(computed.paddingRight) || 0)
        }
        columnsRef.current = columnsForWidth(rect.width - padding)
      }
      measure()
      if (typeof ResizeObserver === 'undefined') return undefined
      let timer = null
      const schedule = (width) => {
        clearTimeout(timer)
        timer = setTimeout(() => { columnsRef.current = columnsForWidth(width) }, RESIZE_DEBOUNCE_MS)
      }
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          // contentRect is already the content box, so its width has no padding to subtract.
          schedule(entry.contentRect?.width ?? 0)
        }
      })
      observer.observe(el)
      return () => { observer.disconnect(); clearTimeout(timer) }
    }, [])

    React.useEffect(() => {
      if (sessionId === undefined) return undefined
      return makeSessionTracker({
        sessionId,
        columns: () => columnsRef.current,
        onLines: (lines, from) => setState({ sessionId: from, lines }),
      })
    }, [sessionId])

    // While the effect has not caught up with a session switch, draw nothing for the old session.
    const lines = state.sessionId === sessionId ? state.lines : []
    const palette = dark ? PALETTES.dark : PALETTES.light
    const empty = lines.length === 0
    return h('div', {
      ref: boxRef,
      'data-adapter': "claude-hud-statusline",
      style: {
        display: 'block',
        width: '100%',
        minWidth: 0,
        flex: '1 0 100%',
        boxSizing: 'border-box',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: '18px',
        padding: empty ? '0 12px' : '2px 12px',
        height: empty ? '0' : undefined,
        overflowX: empty ? 'hidden' : 'auto',
        overflowY: 'hidden',
        whiteSpace: 'pre',
        color: 'var(--dsw-alias-label-secondary, #57606a)',
      },
    }, lines.map((line, index) => h('div', { key: index }, spans(line, palette))))
  }

  exports.PALETTES = PALETTES
  exports.isDarkTheme = isDarkTheme
  exports.resolvePalette = resolvePalette
  exports.xterm = xterm
  exports.spansToParts = spansToParts
  exports.columnsForWidth = columnsForWidth
  exports.makeSessionTracker = makeSessionTracker
  exports.inject = ['slots']
  exports.apply = function apply(ctx) {
    if (typeof ctx.effect === 'function') ctx.effect(() => installStyles(), 'claude-hud-statusline: layout style')
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: "claude-hud-statusline", order: 50 }, Surface))
  }
  exports.Surface = Surface
  return module.exports
} })
