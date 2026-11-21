/**
 * With a Harness Forge older than 0.2.0 (no registerAdapterSurface) the adapter loads, publishes
 * nothing and says in the log which version the status line needs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx } from './helpers/harness.js'
import { apply } from '../index.js'

test('an older Harness Forge is named in the log, not a crash', (t) => {
  const h = makeCtx(new Map(), { harnessCompat: {} })
  assert.doesNotThrow(() => apply(h.ctx))
  t.after(() => h.dispose())
  assert.equal(h.surfaces.length, 0)
  assert.ok(h.warnings.some((line) => /needs @kirkchinese\/dsh-harness-compat 0\.2\.0 or later/.test(line)), h.warnings.join('\n'))
})
