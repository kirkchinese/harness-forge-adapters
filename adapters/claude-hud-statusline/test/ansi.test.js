import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './load-client.js'

const { PALETTES, resolvePalette, spansToParts, columnsForWidth, xterm } = loadClient()

test('SGR colour maps to the theme palette', () => {
  const parts = spansToParts('\x1b[33mhello\x1b[0m', PALETTES.light)
  assert.equal(parts.length, 1)
  assert.equal(parts[0].text, 'hello')
  assert.equal(parts[0].style.color, PALETTES.light.colors[3])
})

test('dim is a muted colour, never reduced opacity', () => {
  const parts = spansToParts('\x1b[2mempty\x1b[0m', PALETTES.light)
  assert.equal(parts[0].style.color, PALETTES.light.muted)
  assert.equal(parts[0].style.opacity, undefined)
})

test('a coloured bar renders its empty (dim) portion muted', () => {
  const parts = spansToParts('\x1b[32m██\x1b[2m░░\x1b[0m', PALETTES.light)
  assert.equal(parts[0].text, '██')
  assert.equal(parts[0].style.color, PALETTES.light.colors[2])
  assert.equal(parts[1].text, '░░')
  assert.equal(parts[1].style.color, PALETTES.light.muted)
})

test('SGR 256-colour cube resolves to its standard rgb', () => {
  const parts = spansToParts('\x1b[38;5;208mx\x1b[0m', PALETTES.dark)
  assert.equal(parts[0].style.color, 'rgb(255,135,0)')
  assert.equal(xterm(208, PALETTES.dark), 'rgb(255,135,0)')
})

test('truecolor SGR 38;2 passes through as rgb', () => {
  const parts = spansToParts('\x1b[38;2;10;20;30mx\x1b[0m', PALETTES.light)
  assert.equal(parts[0].style.color, 'rgb(10,20,30)')
})

test('bold, italic, underline and reset are handled', () => {
  const parts = spansToParts('\x1b[1;3;4mstyled\x1b[0mplain', PALETTES.light)
  assert.equal(parts[0].text, 'styled')
  assert.equal(parts[0].style.fontWeight, 600)
  assert.equal(parts[0].style.fontStyle, 'italic')
  assert.equal(parts[0].style.textDecoration, 'underline')
  assert.equal(parts[1].text, 'plain')
  assert.deepEqual(parts[1].style, {})
})

test('resolvePalette defaults to light when prefers-color-scheme is unavailable', () => {
  assert.equal(resolvePalette(), PALETTES.light)
})

test('columnsForWidth converts and clamps', () => {
  assert.equal(columnsForWidth(0), 120)
  assert.equal(columnsForWidth(720), 100)
  assert.equal(columnsForWidth(10), 40)
  assert.equal(columnsForWidth(5000), 240)
})
