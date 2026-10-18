import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import {
  SSHPreviewCache,
  SSHPreviewConcurrency,
} from '../../src/lib/ssh-preview-cache'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

describe('bounded SSH preview cache', () => {
  it('deduplicates a preload and foreground demand, and removes abort listeners after completion', async () => {
    const cache = new SSHPreviewCache()
    cache.activate('repo')
    const result = deferred<{ content: string }>()
    const controller = new AbortController()
    let calls = 0
    const load = async () => {
      calls++
      return result.promise
    }
    const preload = cache.get('repo', 'file', load, { background: true })
    const foreground = cache.get('repo', 'file', load, {
      signal: controller.signal,
    })
    assert.equal(calls, 1)
    result.resolve({ content: 'ready' })
    assert.equal(await preload, await foreground)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    assert.equal(
      cache.peek<{ content: string }>('repo', 'file')?.content,
      'ready'
    )
    cache.activate(null)
    assert.deepEqual(cache.stats, {
      entries: 0,
      bytes: 0,
      running: 0,
      queued: 0,
    })
  })

  it('retains a bounded preview until its status snapshot is invalidated', async () => {
    const cache = new SSHPreviewCache()
    cache.activate('repo')
    await cache.get('repo', 'file', async () => 'ready')
    const now = mock.method(Date, 'now', () => Number.MAX_SAFE_INTEGER)
    try {
      assert.equal(cache.peek('repo', 'file'), 'ready')
      cache.invalidate('repo')
      assert.equal(cache.peek('repo', 'file'), undefined)
    } finally {
      now.mock.restore()
    }
  })

  it('limits active loaders to five and prioritizes user selections over queued speculation', async () => {
    const cache = new SSHPreviewCache()
    cache.activate('repo')
    const gates = Array.from({ length: SSHPreviewConcurrency + 2 }, () =>
      deferred<string>()
    )
    const started: number[] = []
    const load = (n: number) => async () => {
      started.push(n)
      return gates[n].promise
    }
    const active = Array.from({ length: SSHPreviewConcurrency }, (_, n) =>
      cache.get('repo', `active-${n}`, load(n))
    )
    const background = cache.get(
      'repo',
      'background',
      load(SSHPreviewConcurrency),
      {
        background: true,
      }
    )
    const selected = cache.get(
      'repo',
      'selected',
      load(SSHPreviewConcurrency + 1)
    )
    assert.deepEqual(
      started,
      Array.from({ length: SSHPreviewConcurrency }, (_, n) => n)
    )
    assert.equal(cache.stats.running, SSHPreviewConcurrency)
    gates[0].resolve('released')
    await active[0]
    await tick()
    assert.deepEqual(started, [
      ...Array.from({ length: SSHPreviewConcurrency }, (_, n) => n),
      SSHPreviewConcurrency + 1,
    ])
    gates[SSHPreviewConcurrency + 1].resolve('selected')
    await selected
    for (let n = 1; n < SSHPreviewConcurrency; n++) {
      gates[n].resolve(`active-${n}`)
    }
    await Promise.all(active.slice(1))
    await tick()
    gates[SSHPreviewConcurrency].resolve('background')
    await background
    assert.equal(cache.stats.running, 0)
  })

  it('aborts active/queued reads and refuses late results after a worktree switch', async () => {
    const cache = new SSHPreviewCache()
    cache.activate('old')
    const gates = Array.from({ length: SSHPreviewConcurrency }, () =>
      deferred<string>()
    )
    const signals: AbortSignal[] = []
    const active = gates.map((gate, index) =>
      cache.get('old', `active-${index}`, signal => {
        signals.push(signal)
        return gate.promise
      })
    )
    let queuedStarted = false
    const queued = cache.get('old', 'queued', async () => {
      queuedStarted = true
      return 'queued'
    })
    const rejected = [...active, queued].map(p =>
      assert.rejects(p, { name: 'AbortError' })
    )
    cache.activate('new')
    await Promise.all(rejected)
    assert(signals.every(s => s.aborted))
    assert.equal(queuedStarted, false)
    gates.forEach((gate, index) => gate.resolve(`old ${index}`))
    await tick()
    assert.equal(cache.peek('new', 'active-0'), undefined)
    assert.equal(cache.stats.entries, 0)
    assert.equal(await cache.get('new', 'active-0', async () => 'new'), 'new')
    assert.equal(cache.peek('new', 'active-0'), 'new')
  })

  it('cancels a queued request without spawning it or retaining its listener', async () => {
    const cache = new SSHPreviewCache()
    cache.activate('repo')
    const gate = deferred<string>()
    const active = Array.from({ length: SSHPreviewConcurrency }, (_, n) =>
      cache.get('repo', `active-${n}`, () => gate.promise)
    )
    const controller = new AbortController()
    const queued = cache.get(
      'repo',
      'queued',
      async () => {
        assert.fail('Cancelled loader ran')
      },
      { signal: controller.signal }
    )
    const rejected = assert.rejects(queued, { name: 'AbortError' })
    controller.abort()
    await rejected
    assert.equal(cache.stats.queued, 0)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    gate.resolve('done')
    await Promise.all(active)
  })

  it('retries a demanded preview with normal limits after a speculative load fails', async () => {
    const cache = new SSHPreviewCache()
    cache.activate('repo')
    let fail!: (error: Error) => void
    const preloading = cache.get(
      'repo',
      'large-file',
      () =>
        new Promise<string>((_, no) => {
          fail = no
        }),
      { background: true }
    )
    const expected = assert.rejects(preloading, /speculative limit/)
    const demanded = cache.get(
      'repo',
      'large-file',
      async () => 'normal foreground result'
    )
    fail(new Error('speculative limit'))
    await expected
    assert.equal(await demanded, 'normal foreground result')
    assert.equal(cache.peek('repo', 'large-file'), 'normal foreground result')
  })

  it('bounds retained data and metadata over repeated scrolling and repository switches', async () => {
    const cache = new SSHPreviewCache(4096, 8)
    for (let scope = 0; scope < 10; scope++) {
      cache.activate(String(scope))
      for (let file = 0; file < 100; file++) {
        await cache.get(String(scope), String(file), async () => ({
          content: 'x'.repeat(100),
        }))
        assert(cache.stats.entries <= 8)
        assert(cache.stats.bytes <= 4096)
      }
    }
    cache.activate(null)
    assert.deepEqual(cache.stats, {
      entries: 0,
      bytes: 0,
      running: 0,
      queued: 0,
    })
  })

  it('expires mutable previews, invalidates even unchanged status codes, and never caches oversized values or failures', async () => {
    const cache = new SSHPreviewCache(4096, 8, 100)
    cache.activate('repo')
    let now = 1
    const clock = mock.method(Date, 'now', () => now)
    try {
      await cache.get('repo', 'file', async () => 'old')
      now = 102
      assert.equal(cache.peek('repo', 'file'), undefined)
      await cache.get('repo', 'file', async () => 'new')
      cache.invalidate('repo')
      assert.equal(cache.peek('repo', 'file'), undefined)
      assert.equal(
        await cache.get('repo', 'large', async () => 'x'.repeat(4096)),
        'x'.repeat(4096)
      )
      assert.equal(cache.stats.entries, 0)
      assert.equal(cache.stats.bytes, 0)
      await assert.rejects(
        cache.get('repo', 'failed', async () => {
          throw new Error('offline')
        }),
        /offline/
      )
      assert.equal(cache.peek('repo', 'failed'), undefined)
      assert.equal(cache.stats.bytes, 0)
    } finally {
      clock.mock.restore()
    }
  })
})
