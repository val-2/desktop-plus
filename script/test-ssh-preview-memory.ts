import { SSHPreviewCache } from '../app/src/lib/ssh-preview-cache'
import assert from 'node:assert/strict'

async function main() {
  if (global.gc === undefined) {
    throw new Error(
      'Run with node --expose-gc --import tsx script/test-ssh-preview-memory.ts'
    )
  }
  const cache = new SSHPreviewCache()
  const samples: number[] = []
  let peakBytes = 0
  let peakEntries = 0
  for (let round = 0; round < 30; round++) {
    cache.activate(`repository-${round}`)
    for (let file = 0; file < 500; file++) {
      await cache.get(`repository-${round}`, `file-${file}`, async () => ({
        content: `${round}:${file}:` + 'x'.repeat(16384),
      }))
      peakBytes = Math.max(peakBytes, cache.stats.bytes)
      peakEntries = Math.max(peakEntries, cache.stats.entries)
    }
    cache.activate(null)
    await new Promise<void>(resolve => setImmediate(resolve))
    global.gc?.()
    samples.push(process.memoryUsage().heapUsed)
    assert.deepEqual(cache.stats, {
      entries: 0,
      bytes: 0,
      running: 0,
      queued: 0,
    })
  }
  console.log(
    JSON.stringify({
      iterations: 15000,
      repositories: 30,
      peakEstimatedCacheBytes: peakBytes,
      peakEntries,
      heapMiBAfterRelease: samples
        .slice(-10)
        .map(n => Math.round((n / 1048576) * 100) / 100),
      final: cache.stats,
    })
  )
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
