import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { highlight } from '../../src/lib/highlighter/worker'

describe('highlight worker request cleanup', () => {
  it('releases handlers, listeners and timers on abort and completion', async () => {
    const previous = globalThis.Worker
    const workers: TestWorker[] = []
    class TestWorker {
      public onmessage: ((event: { data: object }) => void) | null = null
      public onerror: unknown = null
      public terminated = false
      public constructor() {
        workers.push(this)
      }
      public postMessage() {}
      public terminate() {
        this.terminated = true
      }
    }
    globalThis.Worker = TestWorker as unknown as typeof Worker
    try {
      const controller = new AbortController()
      const pending = highlight(
        ['print(1)'],
        'file.py',
        '.py',
        4,
        [0],
        controller.signal
      )
      const rejected = assert.rejects(pending, { name: 'AbortError' })
      controller.abort()
      await rejected
      assert(workers[0].terminated)
      assert.equal(workers[0].onmessage, null)
      assert.equal(workers[0].onerror, null)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      const done = new AbortController()
      const result = highlight(
        ['print(2)'],
        'file.py',
        '.py',
        4,
        [0],
        done.signal
      )
      const tokens = { 0: { 0: { length: 5, token: 'variable' } } }
      workers[1].onmessage!({ data: tokens })
      assert.equal(await result, tokens)
      assert.equal(workers[1].onmessage, null)
      assert.equal(workers[1].onerror, null)
      assert.equal(getEventListeners(done.signal, 'abort').length, 0)
      done.abort()
      assert.equal(
        workers[1].terminated,
        false,
        'Completed worker is reusable rather than retaining old cancellation'
      )
    } finally {
      globalThis.Worker = previous
    }
  })
})
