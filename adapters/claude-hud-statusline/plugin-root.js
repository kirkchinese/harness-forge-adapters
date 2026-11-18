/**
 * Where the user has claude-hud installed, looked up in this order:
 * 1. $CLAUDE_HUD_ROOT;
 * 2. a Harness Forge import of it in any DSH profile (<DSH home>/profiles/<profile>/.harness-forge/state.json);
 * 3. Claude Code's install (~/.claude/plugins/installed_plugins.json, the newest installPath);
 * 4. Codex's install (~/.codex/plugins/cache/<marketplace>/<plugin>/<version>, the newest);
 * 5. an OpenCode install (~/.config/opencode/plugins/<plugin>, ./.opencode/plugins/<plugin>).
 *
 * A candidate only counts when it really holds `hud.mjs` (a file, not a directory). A missing,
 * stale, malformed or unreadable source falls through to the next one, so a stale CLAUDE_HUD_ROOT
 * or Claude Code record never hides a valid install found later.
 *
 * @returns the plugin's root, or undefined when it is not installed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN = "claude-hud"

export function locatePlugin(name = PLUGIN, { env = process.env, home = homedir(), cwd = process.cwd() } = {}) {
  const root = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
  const holdsHud = (value) => {
    const dir = root(value)
    if (dir === undefined) return false
    try {
      return statSync(join(dir, 'hud.mjs')).isFile()
    } catch {
      return false
    }
  }

  const configured = root(env["CLAUDE_HUD_ROOT"])
  if (holdsHud(configured)) return configured

  const dshHome = root(env.DSH_HOME) ?? join(home, '.dsh')
  const profiles = join(dshHome, 'profiles')
  for (const profile of safeList(profiles)) {
    const state = readJson(join(profiles, profile, '.harness-forge', 'state.json'))
    const plugins = Array.isArray(state?.plugins) ? state.plugins : []
    for (const plugin of plugins) {
      if (plugin?.name === name && holdsHud(plugin.root)) return plugin.root
    }
  }

  const claudeConfigDir = root(env.CLAUDE_CONFIG_DIR) ?? join(home, '.claude')
  const claude = readJson(join(claudeConfigDir, 'plugins', 'installed_plugins.json'))
  const claudePlugins = claude !== null && typeof claude === 'object' && !Array.isArray(claude) && claude.plugins !== null && typeof claude.plugins === 'object' && !Array.isArray(claude.plugins)
    ? claude.plugins
    : {}
  const installs = []
  for (const [key, list] of Object.entries(claudePlugins)) {
    if (key !== name && !key.startsWith(`${name}@`)) continue
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (item !== null && typeof item === 'object' && holdsHud(item.installPath)) installs.push(item)
    }
  }
  installs.sort((a, b) => String(b.lastUpdated ?? '').localeCompare(String(a.lastUpdated ?? '')))
  if (installs[0] !== undefined) return installs[0].installPath

  const codexCache = join(root(env.CODEX_HOME) ?? join(home, '.codex'), 'plugins', 'cache')
  for (const market of safeList(codexCache)) {
    const pluginDir = join(codexCache, market, name)
    const candidates = []
    for (const version of safeList(pluginDir)) {
      const dir = join(pluginDir, version)
      if (!holdsHud(dir)) continue
      try {
        candidates.push({ dir, mtime: statSync(dir).mtimeMs })
      } catch {
        // Unreadable: not a candidate.
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    if (candidates[0] !== undefined) return candidates[0].dir
  }

  for (const dir of [join(home, '.config', 'opencode', 'plugins', name), join(cwd, '.opencode', 'plugins', name)]) {
    if (holdsHud(dir)) return dir
  }
  return undefined
}

function safeList(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}
