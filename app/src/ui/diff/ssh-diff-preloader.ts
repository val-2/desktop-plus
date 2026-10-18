import { Repository } from '../../models/repository'
import { WorkingDirectoryFileChange } from '../../models/status'
import { DiffType } from '../../models/diff'
import { getWorkingDirectoryDiff } from '../../lib/git/diff'
import {
  sshPreviewCache,
  sshDiffKey,
  SSHPreviewConcurrency,
} from '../../lib/ssh-preview-cache'
import {
  getFileContents,
  highlightContents,
  getLineFilters,
} from './syntax-highlighting'
import { getTextDiffWithBottomDummyHunk } from './text-diff-expansion'

/** Five progressive previews; the shared queue prioritizes foreground reads. */
export class SSHDiffPreloader {
  private timer: ReturnType<typeof setTimeout> | null = null
  private requests = new Set<AbortController>()
  private pending: WorkingDirectoryFileChange[] = []
  private running = false
  private disposed = false
  private key = ''
  private context: {
    repository: Repository
    hideWhitespace: boolean
    generation: number
  } | null = null

  public schedule(
    repository: Repository,
    files: ReadonlyArray<WorkingDirectoryFileChange>,
    hideWhitespace: boolean
  ) {
    if (
      this.disposed ||
      !repository.isSSH ||
      !sshPreviewCache.isCurrent(repository.path)
    ) {
      return
    }
    const candidates = files.slice(0, 40)
    const key = JSON.stringify([
      repository.path,
      sshPreviewCache.generation,
      hideWhitespace,
      candidates.map(f => f.id),
    ])
    if (key === this.key) {
      return
    }
    this.key = key
    this.context = {
      repository,
      hideWhitespace,
      generation: sshPreviewCache.generation,
    }
    this.pending = [...candidates]
    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.start()
    }, 80)
  }

  public dispose() {
    this.disposed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = []
    for (const request of this.requests) {
      request.abort()
    }
  }

  private start() {
    if (!this.running && !this.disposed && this.context !== null) {
      void this.run(this.context)
    }
  }

  private async run(context: NonNullable<SSHDiffPreloader['context']>) {
    this.running = true
    try {
      await Promise.all(
        Array.from({ length: SSHPreviewConcurrency }, () =>
          this.warmNext(context)
        )
      )
    } finally {
      this.running = false
      if (this.pending.length > 0 && this.context !== context) {
        this.start()
      }
    }
  }

  private async warmNext(context: NonNullable<SSHDiffPreloader['context']>) {
    const { repository, hideWhitespace, generation } = context
    while (
      !this.disposed &&
      this.context === context &&
      this.pending.length > 0 &&
      sshPreviewCache.isCurrent(repository.path, generation)
    ) {
      const file = this.pending.shift()!
      const request = new AbortController()
      this.requests.add(request)
      try {
        // Avoid speculative image decodes. Large/binary files retain the native on-demand path.
        if (/\.(png|jpe?g|gif|webp|ico|bmp|avif|svg|dds)$/i.test(file.path)) {
          continue
        }
        const diff = await sshPreviewCache.get(
          repository.path,
          sshDiffKey(file.id, hideWhitespace),
          signal =>
            getWorkingDirectoryDiff(repository, file, hideWhitespace, {
              signal,
              maxBuffer: 512 * 1024,
            }),
          { background: true, signal: request.signal }
        )
        if (
          this.context !== context ||
          request.signal.aborted ||
          !sshPreviewCache.isCurrent(repository.path, generation)
        ) {
          break
        }
        if (diff.kind !== DiffType.Text) {
          continue
        }
        const contents = await getFileContents(repository, file, {
          background: true,
          signal: request.signal,
        })
        if (
          this.context !== context ||
          request.signal.aborted ||
          !sshPreviewCache.isCurrent(repository.path, generation)
        ) {
          break
        }
        const prepared = contents.canBeExpanded
          ? getTextDiffWithBottomDummyHunk(
              diff,
              diff.hunks,
              contents.oldContents.length,
              contents.newContents.length
            ) ?? diff
          : diff
        await highlightContents(contents, 4, getLineFilters(prepared.hunks), {
          background: true,
          signal: request.signal,
        })
      } catch {
        // Speculation must not surface errors or interfere with normal on-demand reads.
      } finally {
        this.requests.delete(request)
      }
    }
  }
}
