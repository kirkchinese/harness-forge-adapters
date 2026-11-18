import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locatePlugin } from '../plugin-root.js'

function makeHud(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'hud.mjs'), '// hud.mjs\n')
}

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('CLAUDE_HUD_ROOT is used only when it actually holds hud.mjs', () => {
  const home = freshDir('hud-home-')
  const valid = join(freshDir('hud-valid-'), 'root')
  makeHud(valid)
  assert.equal(locatePlugin('claude-hud', { env: { CLAUDE_HUD_ROOT: valid }, home, cwd: home }), valid)
})

test('a stale CLAUDE_HUD_ROOT falls through to a later valid source', () => {
  const home = freshDir('hud-home-')
  const stale = join(freshDir('hud-stale-'), 'root') // no hud.mjs
  mkdirSync(stale, { recursive: true })
  const valid = join(freshDir('hud-valid-'), 'import')
  makeHud(valid)
  const dshHome = join(home, '.dsh')
  const stateDir = join(dshHome, 'profiles', 'p1', '.harness-forge')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ plugins: [{ name: 'claude-hud', root: valid }] }))
  assert.equal(locatePlugin('claude-hud', { env: { CLAUDE_HUD_ROOT: stale, DSH_HOME: dshHome }, home, cwd: home }), valid)
})

test('a stale Claude Code record does not hide a valid Codex install', () => {
  const home = freshDir('hud-home-')
  const claudeDir = join(home, '.claude', 'plugins')
  mkdirSync(claudeDir, { recursive: true })
  // The Claude record's installPath has no hud.mjs.
  writeFileSync(join(claudeDir, 'installed_plugins.json'), JSON.stringify({
    plugins: { 'claude-hud': [{ installPath: join(home, 'stale-claude'), lastUpdated: '2026-01-02T00:00:00Z' }] },
  }))
  const codexDir = join(home, '.codex', 'plugins', 'cache', 'market', 'claude-hud', '0.15.1')
  makeHud(codexDir)
  assert.equal(locatePlugin('claude-hud', { env: { CODEX_HOME: join(home, '.codex') }, home, cwd: home }), codexDir)
})

test('malformed JSON and malformed shapes are skipped, not thrown', () => {
  const home = freshDir('hud-home-')
  const dshHome = join(home, '.dsh')
  const stateDir = join(dshHome, 'profiles', 'p1', '.harness-forge')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'state.json'), 'this is not json')
  const claudeDir = join(home, '.claude', 'plugins')
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(join(claudeDir, 'installed_plugins.json'), JSON.stringify({ plugins: 'not an object' }))
  const valid = join(freshDir('hud-valid-'), 'root')
  makeHud(valid)
  assert.equal(locatePlugin('claude-hud', { env: { CLAUDE_HUD_ROOT: valid, DSH_HOME: dshHome }, home, cwd: home }), valid)
})

test('a directory named hud.mjs is not a valid plugin', () => {
  const home = freshDir('hud-home-')
  const dir = join(freshDir('hud-dir-'), 'root')
  mkdirSync(join(dir, 'hud.mjs'), { recursive: true }) // a directory, not a file
  assert.equal(locatePlugin('claude-hud', { env: { CLAUDE_HUD_ROOT: dir }, home, cwd: home }), undefined)
})
