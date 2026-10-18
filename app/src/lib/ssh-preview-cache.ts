/** Bounded, disposable cache for SSH display data. Never used for Git writes. */
type Entry = {
  key: string
  controller: AbortController
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  load: ((signal: AbortSignal) => Promise<unknown>) | null
  background: boolean
  value?: unknown
  bytes: number
  expires: number
}

export const sshPreviewAborted = () =>
  Object.assign(new Error('SSH preview superseded'), { name: 'AbortError' })

export const sshDiffKey = (fileID: string, hideWhitespace: boolean) =>
  JSON.stringify(['diff', fileID, hideWhitespace])
export const sshContentsKey = (fileID: string) =>
  JSON.stringify(['contents', fileID])

export class SSHPreviewCache {
  private scope: string | null = null
  private version = 0
  private entries = new Map<string, Entry>()
  private queue: Entry[] = []
  private running = 0
  private bytes = 0

  public constructor(
    private readonly maxBytes = 24 * 1024 * 1024,
    private readonly maxEntries = 48,
    private readonly ttl = 15000
  ) {}

  public get generation() {
    return this.version
  }
  public isCurrent(scope: string, generation = this.version) {
    return this.scope === scope && generation === this.version
  }
  public get stats() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      running: this.running,
      queued: this.queue.length,
    }
  }

  public activate(scope: string | null) {
    if (this.scope !== scope) {
      this.clear()
      this.scope = scope
    }
  }

  public invalidate(scope: string) {
    if (this.scope === scope) {
      this.clear()
    }
  }

  private clear() {
    this.version++
    for (const entry of this.entries.values()) {
      this.remove(entry)
    }
    this.queue = []
  }

  private remove(entry: Entry) {
    if (this.entries.get(entry.key) !== entry) {
      return
    }
    this.entries.delete(entry.key)
    this.bytes -= entry.bytes
    this.queue = this.queue.filter(e => e !== entry)
    entry.controller.abort()
    entry.reject(sshPreviewAborted())
    entry.load = null
  }

  public peek<T>(scope: string, key: string): T | undefined {
    if (scope !== this.scope) {
      return undefined
    }
    const entry = this.entries.get(key)
    if (entry === undefined || entry.value === undefined) {
      return undefined
    }
    if (entry.expires <= Date.now()) {
      this.remove(entry)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value as T
  }

  public get<T>(
    scope: string,
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    options: { background?: boolean; signal?: AbortSignal } = {}
  ): Promise<T> {
    if (scope !== this.scope || options.signal?.aborted) {
      return Promise.reject(sshPreviewAborted())
    }
    const cached = this.peek<T>(scope, key)
    if (cached !== undefined) {
      return Promise.resolve(cached)
    }
    let entry = this.entries.get(key)
    const retryDemand = entry?.background === true && !options.background
    const generation = this.version
    if (entry === undefined) {
      while (this.entries.size >= this.maxEntries) {
        // Evict completed data first; an obsolete queued read can also be dropped.
        const victim =
          [...this.entries.values()].find(e => e.value !== undefined) ??
          this.queue.find(e => e.background) ??
          this.queue[0]
        if (victim === undefined) {
          return Promise.reject(sshPreviewAborted())
        }
        this.remove(victim)
      }
      let resolve!: Entry['resolve']
      let reject!: Entry['reject']
      const promise = new Promise<unknown>((yes, no) => {
        resolve = yes
        reject = no
      })
      const bytes = key.length * 2 + 256
      if (bytes > this.maxBytes) {
        return Promise.reject(sshPreviewAborted())
      }
      while (this.bytes + bytes > this.maxBytes) {
        const victim =
          [...this.entries.values()].find(e => e.value !== undefined) ??
          this.queue[0]
        if (victim === undefined) {
          return Promise.reject(sshPreviewAborted())
        }
        this.remove(victim)
      }
      entry = {
        key,
        controller: new AbortController(),
        promise,
        resolve,
        reject,
        load,
        background: options.background ?? false,
        bytes,
        expires: 0,
      }
      this.entries.set(key, entry)
      this.bytes += bytes
      if (entry.background) {
        this.queue.push(entry)
      } else {
        this.queue.unshift(entry)
      }
    } else if (!options.background) {
      entry.background = false
      const index = this.queue.indexOf(entry)
      if (index >= 0) {
        this.queue.splice(index, 1)
        this.queue.unshift(entry)
      }
    }
    const current = entry
    const abort = () => {
      this.remove(current)
      this.drain()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    const cleanup = () => options.signal?.removeEventListener('abort', abort)
    current.promise.then(cleanup, cleanup)
    this.drain()
    const result = current.promise as Promise<T>
    return retryDemand
      ? result.catch(error => {
          if (options.signal?.aborted || !this.isCurrent(scope, generation)) {
            throw error
          }
          return this.get(scope, key, load, options)
        })
      : result
  }

  private drain() {
    while (this.running < 2 && this.queue.length > 0) {
      const entry = this.queue.shift()!
      const load = entry.load
      entry.load = null
      if (load === null || entry.controller.signal.aborted) {
        continue
      }
      this.running++
      void this.run(entry, load)
    }
  }

  private async run(
    entry: Entry,
    load: (signal: AbortSignal) => Promise<unknown>
  ) {
    try {
      const value = await load(entry.controller.signal)
      if (
        this.entries.get(entry.key) !== entry ||
        entry.controller.signal.aborted
      ) {
        return
      }
      // Conservative retained-size estimate, including object/array overhead.
      // It is a cache budget, not a claim about the JavaScript heap's exact size.
      const bytes =
        JSON.stringify(value).length * 4 + entry.key.length * 2 + 256
      if (bytes <= Math.min(this.maxBytes, 8 * 1024 * 1024)) {
        entry.value = value
        this.bytes += bytes - entry.bytes
        entry.bytes = bytes
        entry.expires = Date.now() + this.ttl
        while (this.bytes > this.maxBytes) {
          const victim = [...this.entries.values()].find(
            e => e !== entry && e.value !== undefined
          )
          if (victim === undefined) {
            this.entries.delete(entry.key)
            this.bytes -= entry.bytes
            entry.value = undefined
            break
          }
          this.remove(victim)
        }
      } else {
        this.entries.delete(entry.key)
        this.bytes -= entry.bytes
      }
      entry.resolve(value)
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)))
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key)
        this.bytes -= entry.bytes
      }
    } finally {
      this.running--
      this.drain()
    }
  }
}

export const sshPreviewCache = new SSHPreviewCache()
