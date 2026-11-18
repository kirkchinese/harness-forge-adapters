import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { isSupportedNodeVersion, parseNodeVersion, resolveNode, runHud } from '../index.js'

function probe(source) {
  const dir = mkdtempSync(join(tmpdir(), 'hud-run-'))
  const file = join(dir, 'probe.mjs')
  writeFileSync(file, source)
  return file
}

test('exit 0 is success', async () => {
  const lines = await runHud(probe('process.stdout.write("hello\\nworld\\n")'), {}, 80)
  assert.deepEqual(lines, ['hello', 'world'])
})

test('a nonzero exit code is a failure even with stdout', async () => {
  await assert.rejects(runHud(probe('process.stdout.write("partial output\\n"); process.exit(3)'), {}, 80), /exited with code 3/)
})

test('a signal with a null exit code is a failure (POSIX)', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(runHud(probe('process.kill(process.pid, "SIGTERM")'), {}, 80), /killed by SIGTERM/)
})

test('a wedged child is killed at the timeout', async () => {
  const started = Date.now()
  await assert.rejects(runHud(probe('setTimeout(() => {}, 60000)'), {}, 80, { timeoutMs: 300 }), /did not answer within 300 ms/)
  assert.ok(Date.now() - started < 5000, 'timeout aborted quickly')
})

test('the turn wait can abort an outstanding render', async () => {
  const controller = new AbortController()
  const started = Date.now()
  const rendering = runHud(probe('setTimeout(() => {}, 60000)'), {}, 80, { signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(rendering, (error) => error.name === 'AbortError')
  assert.ok(Date.now() - started < 5000, 'abort ended the render')
})

test('Node version parsing and support follow the 22.18 floor', () => {
  assert.deepEqual(parseNodeVersion('v22.18.0'), [22, 18, 0])
  assert.deepEqual(parseNodeVersion('24.1.2'), [24, 1, 2])
  assert.equal(parseNodeVersion('nope'), undefined)
  assert.equal(isSupportedNodeVersion([22, 17, 9]), false)
  assert.equal(isSupportedNodeVersion([22, 18, 0]), true)
  assert.equal(isSupportedNodeVersion([23, 0, 0]), true)
  assert.equal(isSupportedNodeVersion(undefined), false)
})

test('resolveNode finds a real Node, not Electron', () => {
  const node = resolveNode()
  assert.equal(node.error, undefined)
  assert.equal(node.electron, false)
  assert.equal(typeof node.exe, 'string')
  assert.match(node.version, /^\d+\.\d+\.\d+$/)
})

test('under Electron resolveNode skips process.execPath and uses Node from PATH', () => {
  const path = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`
  const node = resolveNode({
    execPath: 'C:\\fake\\electron.exe',
    versions: { electron: '35.0.0', node: '20.19.0' },
    env: { ...process.env, PATH: path },
  })
  assert.equal(node.error, undefined)
  assert.equal(node.electron, false)
  assert.notEqual(node.exe, 'C:\\fake\\electron.exe')
  assert.ok(isSupportedNodeVersion(parseNodeVersion(node.version)))
})

test('under Electron with no Node on PATH the message says what to install', () => {
  const node = resolveNode({
    execPath: 'C:\\fake\\electron.exe',
    versions: { electron: '35.0.0', node: '20.19.0' },
    env: { PATH: '' },
  })
  assert.equal(node.exe, undefined)
  assert.match(node.error.message, /Electron/)
  assert.match(node.error.message, /Node 22\.18\+/)
})

test('a supported non-Electron runtime is used as-is', () => {
  const node = resolveNode({ execPath: 'C:\\node.exe', versions: { node: '22.18.0' }, env: { PATH: '' } })
  assert.equal(node.exe, 'C:\\node.exe')
  assert.equal(node.version, '22.18.0')
})
