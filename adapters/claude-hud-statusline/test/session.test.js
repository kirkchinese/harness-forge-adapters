import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './load-client.js'

const { makeSessionTracker } = loadClient()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('clears lines immediately, never overlaps, and ignores responses after disposal', async () => {
  const seen = []
  let fetches = 0
  const inFlight = []
  const fetcher = (url, signal) => {
    fetches += 1
    return new Promise((resolve, reject) => { inFlight.push({ resolve, reject, signal }) })
  }
  const dispose = makeSessionTracker({
    sessionId: 's1',
    columns: () => 120,
    onLines: (lines) => seen.push(lines),
    fetcher,
    intervalMs: 10,
  })

  assert.deepEqual(seen, [[]], 'clears immediately')
  assert.equal(fetches, 1, 'first poll starts')

  await delay(60) // several intervals pass while the first fetch is still in flight
  assert.equal(fetches, 1, 'a second poll never overlaps the first')

  dispose()
  inFlight[0].resolve({ lines: ['stale'] })
  await delay(20)
  assert.equal(seen.length, 1, 'a response after disposal is ignored')
})

test('a new tracker for a new session is independent', async () => {
  const seenA = []
  const seenB = []
  const pendingA = []
  const pendingB = []
  const fetcher = (pending) => (url, signal) => new Promise((resolve, reject) => { pending.push({ resolve, reject, signal }) })

  const disposeA = makeSessionTracker({ sessionId: 'a', columns: () => 120, onLines: (l) => seenA.push(l), fetcher: fetcher(pendingA), intervalMs: 100_000 })
  const disposeB = makeSessionTracker({ sessionId: 'b', columns: () => 120, onLines: (l) => seenB.push(l), fetcher: fetcher(pendingB), intervalMs: 100_000 })

  assert.deepEqual(seenA, [[]])
  assert.deepEqual(seenB, [[]])

  pendingA[0].resolve({ lines: ['A'] })
  pendingB[0].resolve({ lines: ['B'] })
  await delay(10)
  assert.deepEqual(seenA.at(-1), ['A'])
  assert.deepEqual(seenB.at(-1), ['B'])

  disposeA()
  disposeB()
})

test('a response naming another session is ignored even on the same tracker', async () => {
  const seen = []
  let resolveFetch
  const dispose = makeSessionTracker({
    sessionId: 'mine',
    columns: () => 120,
    onLines: (lines) => seen.push(lines),
    fetcher: () => new Promise((resolve) => { resolveFetch = resolve }),
    intervalMs: 100_000,
  })
  resolveFetch({ sessionId: 'other', lines: ['not mine'] })
  await delay(10)
  assert.deepEqual(seen, [[]], 'the mismatched response never reaches the dock')
  dispose()
})
