import {
  sshPreviewCache,
  sshDiffKey,
  sshContentsKey,
} from '../../src/lib/ssh-preview-cache'
import { SSHDiffPreloader } from '../../src/ui/diff/ssh-diff-preloader'
import {
  getFileContents,
  peekHighlightContents,
  getLineFilters,
} from '../../src/ui/diff/syntax-highlighting'
import { getTextDiffWithBottomDummyHunk } from '../../src/ui/diff/text-diff-expansion'
import { SeamlessDiffSwitcher } from '../../src/ui/diff/seamless-diff-switcher'
import { SideBySideDiff } from '../../src/ui/diff/side-by-side-diff'
import type * as React from 'react'
import type { GitHubRepository } from '../../src/models/github-repository'
import { RepositoriesStore } from '../../src/lib/stores/repositories-store'
import { TestRepositoriesDatabase } from '../helpers/databases'
import { createCommit } from '../../src/lib/git/commit'
import {
  createBranch,
  renameBranch,
  deleteLocalBranch,
} from '../../src/lib/git/branch'
import { checkoutBranch } from '../../src/lib/git/checkout'
import { fetch } from '../../src/lib/git/fetch'
import { pull } from '../../src/lib/git/pull'
import { push } from '../../src/lib/git/push'
import { git as nativeGit } from '../../src/lib/git/core'
import { stat, readFile as readRepositoryFile } from '../../src/lib/ssh-files'
import {
  DiffSelection,
  DiffSelectionType,
  DiffType,
} from '../../src/models/diff'
import {
  applyPatchToIndex,
  discardChangesFromSelection,
} from '../../src/lib/git/apply'
import {
  appendIgnoreFile,
  readGitIgnoreAtRoot,
} from '../../src/lib/git/gitignore'
import { pathExists } from '../../src/lib/path-exists'
import { addWorktreeWithIncludes } from '../../src/lib/git/worktree-include'
/* eslint-disable no-sync -- Synchronous Git is used only to prepare and verify isolated test fixtures. */
import { after, before, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import {
  mkdtemp,
  readFile,
  chmod,
  readdir,
  symlink,
  writeFile,
  appendFile,
  rm,
  realpath,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SSHRepositoryReader } from '../../src/lib/ssh-repository'
import { executeSSHGit } from '../../src/lib/ssh-repository'
import {
  sshRepositoryPath,
  parseSSHRepositoryPath,
  joinRepositoryPath,
} from '../../src/lib/ssh-path'
import { Repository } from '../../src/models/repository'
import { getStatus } from '../../src/lib/git/status'
import { getBranches } from '../../src/lib/git/for-each-ref'
import { getRepositoryType } from '../../src/lib/git/rev-parse'
import {
  moveWorktree,
  removeWorktree,
  listWorktrees,
} from '../../src/lib/git/worktree'
import { getWorkingDirectoryDiff, getCommitDiff } from '../../src/lib/git/diff'
import { GitStore } from '../../src/lib/stores/git-store'
import type { IAppShell } from '../../src/lib/app-shell'
import type { IStatsStore } from '../../src/lib/stats'
import { getAuthors } from '../../src/lib/git/log'
import {
  createDesktopStashEntry,
  renameStashEntry,
  applyStashEntry,
  popStashEntry,
  getStashes,
  getStashedFiles,
} from '../../src/lib/git/stash'

// Exercise the exact remote POSIX command against real Git, replacing only the SSH transport.
describe('SSH repository native operations', () => {
  let root: string
  let repo: string
  let reader: SSHRepositoryReader
  let sshCalls = 0
  const originalExecFile = childProcess.execFile
  const git = (...args: string[]) =>
    childProcess.execFileSync('/usr/bin/git', ['-C', repo, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'SSH test',
        GIT_AUTHOR_EMAIL: 'ssh@example.invalid',
        GIT_COMMITTER_NAME: 'SSH test',
        GIT_COMMITTER_EMAIL: 'ssh@example.invalid',
      },
    })
  const unusual = "new ' $(touch SHOULD_NOT_EXIST) [x]\n.txt"

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "desktop-ssh-' ")))
    repo = join(root, 'repo')
    childProcess.execFileSync('/usr/bin/git', ['init', '-b', 'main', repo])
    await writeFile(join(repo, 'tracked.txt'), 'base\n')
    await writeFile(join(repo, 'rename me.txt'), 'rename\n')
    git('config', 'user.name', 'SSH test')
    git('config', 'user.email', 'ssh@example.invalid')
    git('add', '.')
    git('commit', '-m', 'initial')
    git('remote', 'add', 'origin', 'https://example.invalid/repository.git')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    git('branch', 'feature/test')
    git('worktree', 'add', '-b', 'worktree/test', join(root, 'linked tree'))
    await writeFile(join(repo, 'tracked.txt'), 'saved tracked\n')
    await writeFile(join(repo, 'saved untracked.txt'), 'saved new\n')
    git('stash', 'push', '-u', '-m', 'reader fixture')
    await writeFile(join(repo, 'tracked.txt'), 'staged\n')
    git('add', 'tracked.txt')
    await appendFile(join(repo, 'tracked.txt'), 'unstaged\n')
    git('mv', 'rename me.txt', 'renamed [one].txt')
    await writeFile(join(repo, unusual), 'untracked contents\n')
    mock.method(childProcess, 'execFile', ((
      file: string,
      args: string[],
      options: object,
      callback: (...args: any[]) => void
    ) => {
      if (file !== '/usr/bin/ssh') {
        assert(!('cwd' in options) || !String(options.cwd).startsWith('ssh:'))
        return originalExecFile(file, args, options, callback)
      }
      sshCalls++
      assert(args.includes('StrictHostKeyChecking=yes'))
      assert(args.includes('BatchMode=yes'))
      return originalExecFile(
        '/bin/sh',
        ['-c', args.at(-1)!],
        options,
        callback
      )
    }) as typeof childProcess.execFile)
    syncBuiltinESMExports()
    reader = new SSHRepositoryReader({ host: 'test-alias', path: repo })
  })

  after(async () => {
    mock.restoreAll()
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  })

  it('feeds the original Desktop Plus status, branch, diff, worktree and stash pipelines', async () => {
    const beforeIndex = await readFile(join(repo, '.git/index'))
    const path = sshRepositoryPath({ host: 'test-alias', path: repo })
    assert.equal(parseSSHRepositoryPath(path)?.path, repo)
    assert.equal(
      new Repository(
        path,
        1,
        { name: 'provider-name' } as GitHubRepository,
        false
      ).name,
      'provider-name · SSH'
    )
    const type = await getRepositoryType(path)
    assert.equal(type.kind, 'regular')
    const repository = new Repository(path, 1, null, false)
    const status = await getStatus(repository)
    assert(status)
    assert.equal(status.currentBranch, 'main')
    assert((await getBranches(repository)).some(b => b.name === 'feature/test'))
    const worktrees = await listWorktrees(repository)
    assert(worktrees.every(w => parseSSHRepositoryPath(w.path) !== null))
    const file = status.workingDirectory.files.find(
      f => f.path === 'tracked.txt'
    )!
    const diff = await getWorkingDirectoryDiff(repository, file)
    assert.equal(diff.kind, 0)
    const untracked = status.workingDirectory.files.find(
      f => f.path === unusual
    )!
    assert(untracked)
    const untrackedDiff = await getWorkingDirectoryDiff(repository, untracked)
    assert.equal(untrackedDiff.kind, 0)
    assert(
      'text' in untrackedDiff &&
        untrackedDiff.text.includes('+untracked contents')
    )
    assert.deepEqual(await readFile(join(repo, '.git/index')), beforeIndex)
    assert.equal(
      (await reader.readWorkingFile(unusual)).toString(),
      'untracked contents\n'
    )

    const store = new GitStore(repository, {} as IAppShell, {} as IStatsStore)
    const errors: Error[] = []
    store.onDidError(error => errors.push(error))
    await store.loadStatus()
    await store.loadRemotes()
    await Promise.all([
      store.loadBranches(),
      store.loadWorktrees(),
      store.loadStashEntries(),
    ])
    assert.equal(
      store.currentRemote?.url,
      'https://example.invalid/repository.git'
    )
    assert.equal(store.allWorktrees.length, 2)
    assert.deepEqual(errors, [])
    assert.equal(store.currentBranchStashEntries.length, 1)
    assert.equal(
      (
        await getAuthors(repository, [
          git('rev-parse', 'HEAD').toString().trim(),
        ])
      ).length,
      1
    )
    const stashes = await getStashes(repository)
    assert.equal(stashes.desktopEntries.length, 1)
    const stashFiles = await getStashedFiles(
      repository,
      stashes.desktopEntries[0].stashSha
    )
    assert(stashFiles.some(f => f.path === 'saved untracked.txt'))
    for (const saved of stashFiles) {
      const patch = await getCommitDiff(repository, saved, saved.commitish)
      assert.equal(patch.kind, 0)
      assert('hunks' in patch && patch.hunks.length > 0)
    }
  })

  it('progressively warms native diffs, contents and tokens without caching mutation reads or retaining workers', async () => {
    const workers: {
      onmessage: ((event: { data: object }) => void) | null
      onerror: unknown
      terminate: () => void
    }[] = []
    const previousWorker = globalThis.Worker
    class PreviewWorker {
      public onmessage: ((event: { data: object }) => void) | null = null
      public onerror: unknown = null
      private timer: ReturnType<typeof setTimeout> | null = null
      public constructor() {
        workers.push(this)
      }
      public postMessage(request: { lines: number[] }) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.onmessage?.({
            data: Object.fromEntries(
              request.lines.map(line => [
                line,
                { 0: { length: 1, token: 'test-token' } },
              ])
            ),
          })
        }, 1)
      }
      public terminate() {
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
      }
    }
    globalThis.Worker = PreviewWorker as unknown as typeof Worker
    const path = sshRepositoryPath({ host: 'test-alias', path: repo })
    const repository = new Repository(path, 1, null, false)
    const file = (await getStatus(repository))!.workingDirectory.files.find(
      f => f.path === 'tracked.txt'
    )!
    const previous = await readFile(join(repo, file.path))
    const preloader = new SSHDiffPreloader()
    sshPreviewCache.activate(path)
    const before = sshCalls
    try {
      preloader.schedule(repository, [file], false)
      const deadline = Date.now() + 5000
      let ready = false
      while (Date.now() < deadline) {
        const diff = sshPreviewCache.peek<
          Awaited<ReturnType<typeof getWorkingDirectoryDiff>>
        >(path, sshDiffKey(file.id, false))
        const contents = sshPreviewCache.peek<
          Awaited<ReturnType<typeof getFileContents>>
        >(path, sshContentsKey(file.id))
        if (diff?.kind === DiffType.Text && contents !== undefined) {
          const prepared =
            getTextDiffWithBottomDummyHunk(
              diff,
              diff.hunks,
              contents.oldContents.length,
              contents.newContents.length
            ) ?? diff
          const tokens = peekHighlightContents(
            contents,
            4,
            getLineFilters(prepared.hunks)
          )
          if (tokens !== undefined) {
            assert(Object.keys(tokens.newTokens).length > 0)
            const callsBeforeSelection = sshCalls
            const cachedDiff = await sshPreviewCache.get(
              path,
              sshDiffKey(file.id, false),
              async () => {
                assert.fail('Ready diff was fetched again')
              }
            )
            assert.equal(cachedDiff, diff)
            assert.equal(await getFileContents(repository, file), contents)
            const props = { repository, file, diff } as React.ComponentProps<
              typeof SeamlessDiffSwitcher
            >
            const switcher = new SeamlessDiffSwitcher(props)
            assert.equal(switcher.state.isLoadingDiff, false)
            const viewer = new SideBySideDiff({
              diff: prepared,
              fileContents: contents,
            } as React.ComponentProps<typeof SideBySideDiff>)
            assert.equal(viewer.state.afterTokens, tokens.newTokens)
            assert.equal(
              sshCalls,
              callsBeforeSelection,
              'Warm selection performs no SSH requests'
            )
            await writeFile(
              join(repo, file.path),
              'cache must not affect write operations\n'
            )
            const uncached = await getWorkingDirectoryDiff(repository, file)
            assert(
              'text' in uncached &&
                uncached.text.includes('cache must not affect write operations')
            )
            sshPreviewCache.invalidate(path)
            const nextState = SeamlessDiffSwitcher.getDerivedStateFromProps(
              props,
              switcher.state
            )
            assert.equal(nextState.isLoadingDiff, true)
            const externalContents = {
              ...contents,
              sshScope: undefined,
              sshGeneration: undefined,
            }
            const externalState = SeamlessDiffSwitcher.getDerivedStateFromProps(
              { ...props, externalFileContents: externalContents },
              { ...switcher.state, fileContents: externalContents }
            )
            assert.equal(
              externalState.isLoadingDiff,
              false,
              'Externally supplied contents do not depend on the SSH cache lifetime'
            )
            ready = true
            break
          }
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert(ready, 'Preloader did not finish warming the preview')
      assert(sshCalls > before)
      assert(
        workers.every(
          worker => worker.onmessage === null && worker.onerror === null
        ),
        'Idle workers retain no request handlers'
      )
    } finally {
      preloader.dispose()
      sshPreviewCache.activate(null)
      globalThis.Worker = previousWorker
      await writeFile(join(repo, file.path), previous)
    }
  })

  it('runs native commits, branch checkout, stash lifecycle, worktree lifecycle, and network progress', async () => {
    const writable = join(root, "write repo ' [one]")
    childProcess.execFileSync('/usr/bin/git', [
      'clone',
      '--no-local',
      repo,
      writable,
    ])
    const path = sshRepositoryPath({ host: 'test-alias', path: writable })
    const repository = new Repository(path, 3, null, false)
    const run = (args: string[]) => nativeGit(args, path, 'sshParityTest')
    await run(['config', 'user.name', 'SSH test'])
    await run(['config', 'user.email', 'ssh@example.invalid'])
    const upstream = join(root, 'upstream.git')
    childProcess.execFileSync('/usr/bin/git', [
      'clone',
      '--bare',
      repo,
      upstream,
    ])
    await run(['remote', 'set-url', 'origin', upstream])
    const remote = { name: 'origin', url: upstream }

    const tracked = join(writable, 'tracked.txt')
    await writeFile(
      tracked,
      'base\nfirst selected line\nsecond unselected line\n'
    )
    const partialFile = (await getStatus(repository))!.workingDirectory.files[0]
    const partialDiff = await getWorkingDirectoryDiff(repository, partialFile)
    assert.equal(partialDiff.kind, DiffType.Text)
    const selection = DiffSelection.fromInitialSelection(
      DiffSelectionType.None
    ).withLineSelection(2, true)
    await applyPatchToIndex(repository, partialFile.withSelection(selection))
    const staged = (await run(['show', ':tracked.txt'])).stdout
    assert(staged.includes('first selected line'))
    assert(!staged.includes('second unselected line'))
    await run(['reset', 'HEAD'])
    if (partialDiff.kind === DiffType.Text) {
      await discardChangesFromSelection(
        repository,
        partialFile.path,
        partialDiff,
        DiffSelection.fromInitialSelection(DiffSelectionType.All)
      )
    }
    assert.equal(await readFile(tracked, 'utf8'), 'base\n')
    await appendIgnoreFile(repository, 'ignore [daily].tmp')
    assert(
      (await readGitIgnoreAtRoot(repository))!.includes(
        'ignore \\[daily\\].tmp'
      )
    )
    await run(['clean', '-fd'])
    await symlink(tracked, join(writable, '.gitignore'))
    await assert.rejects(appendIgnoreFile(repository, 'must-not-write'))
    assert.equal(await readFile(tracked, 'utf8'), 'base\n')
    await run(['clean', '-fd'])
    const percentFile = joinRepositoryPath(path, 'file 100%.txt')
    await writeFile(join(writable, 'file 100%.txt'), 'literal percent\n')
    assert.equal(
      await readRepositoryFile(percentFile, 'utf8'),
      'literal percent\n'
    )
    await run(['clean', '-fd'])
    await writeFile(tracked, 'daily commit\n')
    let status = await getStatus(repository)
    assert(status)
    const sha = await createCommit(
      repository,
      "Daily ' commit",
      status.workingDirectory.files
    )
    assert.match(sha, /^[0-9a-f]+$/)
    assert.equal(
      (await getStatus(repository))!.workingDirectory.files.length,
      0
    )
    // Hooks run on the server and their failures must reach the normal Git error path.
    await writeFile(
      join(writable, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\necho server-hook-refused >&2\nexit 1\n'
    )
    await chmod(join(writable, '.git', 'hooks', 'pre-commit'), 0o755)
    await writeFile(tracked, 'hook must preserve this\n')
    await assert.rejects(
      createCommit(
        repository,
        'Refused commit',
        (await getStatus(repository))!.workingDirectory.files
      ),
      /server-hook-refused/
    )
    assert.equal(await readFile(tracked, 'utf8'), 'hook must preserve this\n')
    await rm(join(writable, '.git', 'hooks', 'pre-commit'))
    await run(['reset', '--hard', 'HEAD'])
    const pushed: number[] = []
    await push(repository, remote, 'main', 'main', null, undefined, p =>
      pushed.push(p.value)
    )
    assert(pushed.length > 1, 'native parser receives streamed SSH progress')
    assert(
      childProcess
        .execFileSync('/usr/bin/git', [
          '--git-dir',
          upstream,
          'rev-parse',
          'main',
        ])
        .toString()
        .trim()
        .startsWith(sha)
    )

    await createBranch(repository, 'daily/test', null)
    let branch = (await getBranches(repository)).find(
      b => b.name === 'daily/test'
    )!
    assert(branch)
    await checkoutBranch(repository, branch, remote)
    assert.equal((await getStatus(repository))!.currentBranch, 'daily/test')
    await renameBranch(repository, branch, 'daily/renamed')
    assert.equal((await getStatus(repository))!.currentBranch, 'daily/renamed')

    await writeFile(tracked, 'saved daily change\n')
    await writeFile(join(writable, unusual), 'saved untracked daily\n')
    status = await getStatus(repository)
    assert(status)
    await createDesktopStashEntry(
      repository,
      'daily/renamed',
      status.workingDirectory.files.filter(f => f.path === unusual),
      null
    )
    assert.equal(
      (await getStatus(repository))!.workingDirectory.files.length,
      0
    )
    let entry = (await getStashes(repository)).desktopEntries[0]
    const createdAt = entry.createdAt.getTime()
    entry = await renameStashEntry(repository, entry, "Daily stash ' renamed")
    assert.equal(entry.createdAt.getTime(), createdAt)
    assert.equal(
      (await getStashes(repository)).desktopEntries[0].customName,
      "Daily stash ' renamed"
    )
    assert.equal(
      (await getStashes(repository)).desktopEntries[0].createdAt.getTime(),
      createdAt
    )
    await applyStashEntry(repository, entry.stashSha)
    assert.equal(await readFile(tracked, 'utf8'), 'saved daily change\n')
    assert.equal(
      await readFile(join(writable, unusual), 'utf8'),
      'saved untracked daily\n'
    )
    await run(['reset', '--hard', 'HEAD'])
    await popStashEntry(repository, entry.stashSha)
    assert.equal((await getStashes(repository)).desktopEntries.length, 0)
    await run(['reset', '--hard', 'HEAD'])
    await run(['clean', '-fd'])

    await writeFile(tracked, 'discard me\n')
    const store = new GitStore(repository, {} as IAppShell, {} as IStatsStore)
    await store.discardChanges(
      (await getStatus(repository))!.workingDirectory.files
    )
    assert.equal(await readFile(tracked, 'utf8'), 'daily commit\n')

    const worktree = sshRepositoryPath({
      host: 'test-alias',
      path: join(root, "daily tree ' one"),
    })
    await writeFile(join(writable, '.gitignore'), 'ignored-dir/\n')
    await writeFile(join(writable, '.worktreeinclude'), 'ignored-dir/\n')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(writable, 'ignored-dir'))
    await writeFile(join(writable, 'ignored-dir', 'secret'), 'copied on host\n')
    await addWorktreeWithIncludes(repository, worktree, {
      createBranch: 'daily/worktree',
    })
    assert((await listWorktrees(repository)).some(w => w.path === worktree))
    const linked = new Repository(worktree, 4, null, false)
    assert.equal((await getStatus(linked))!.currentBranch, 'daily/worktree')
    assert.equal(
      await readRepositoryFile(join(worktree, 'ignored-dir', 'secret'), 'utf8'),
      'copied on host\n'
    )
    const linkedType = await getRepositoryType(worktree)
    assert.equal(linkedType.kind, 'regular')
    if (linkedType.kind === 'regular') {
      const linkedWithMetadata = new Repository(
        worktree,
        4,
        null,
        false,
        null,
        null,
        null,
        {},
        null,
        false,
        null,
        linkedType.gitDir
      )
      const linkedDiskPath = parseSSHRepositoryPath(worktree)!.path
      await writeFile(
        join(linkedDiskPath, 'tracked.txt'),
        'recover after worktree removal\n'
      )
      await new GitStore(
        linkedWithMetadata,
        {} as IAppShell,
        {} as IStatsStore
      ).discardChanges(
        (await getStatus(linkedWithMetadata))!.workingDirectory.files
      )
    }
    const moved = sshRepositoryPath({
      host: 'test-alias',
      path: join(root, 'daily tree moved'),
    })
    await moveWorktree(repository, worktree, moved)
    assert((await listWorktrees(repository)).some(w => w.path === moved))
    await removeWorktree(path, moved, true)
    assert.equal((await listWorktrees(repository)).length, 1)
    const trash = join(writable, '.git', 'desktop-trash')
    const preserved = await Promise.all(
      (
        await readdir(trash)
      ).map(entry => readFile(join(trash, entry, 'contents'), 'utf8'))
    )
    assert(preserved.includes('recover after worktree removal\n'))
    await run(['reset', '--hard', 'HEAD'])
    await run(['clean', '-fd'])
    branch = (await getBranches(repository)).find(b => b.name === 'main')!
    await checkoutBranch(repository, branch, remote)
    await deleteLocalBranch(repository, 'daily/renamed')

    // A different checkout pushes a commit. Fetch must update behind counts;
    // pull must then use the original pipeline to fast-forward the worktree.
    const peer = join(root, 'peer')
    childProcess.execFileSync('/usr/bin/git', ['clone', upstream, peer])
    childProcess.execFileSync('/usr/bin/git', [
      '-C',
      peer,
      'config',
      'user.name',
      'Peer',
    ])
    childProcess.execFileSync('/usr/bin/git', [
      '-C',
      peer,
      'config',
      'user.email',
      'peer@example.invalid',
    ])
    await writeFile(join(peer, 'remote.txt'), 'from upstream\n')
    childProcess.execFileSync('/usr/bin/git', ['-C', peer, 'add', '.'])
    childProcess.execFileSync('/usr/bin/git', [
      '-C',
      peer,
      'commit',
      '-m',
      'upstream commit',
    ])
    childProcess.execFileSync('/usr/bin/git', ['-C', peer, 'push'])
    const fetched: number[] = []
    await fetch(repository, remote, p => fetched.push(p.value))
    assert(fetched.length > 1)
    assert.equal((await getStatus(repository))!.branchAheadBehind?.behind, 1)
    await pull(repository, remote)
    assert.equal((await getStatus(repository))!.branchAheadBehind?.behind, 0)
    assert.equal(
      await readFile(join(writable, 'remote.txt'), 'utf8'),
      'from upstream\n'
    )
    const type = await getRepositoryType(path)
    assert.equal(type.kind, 'regular')
    if (type.kind === 'regular') {
      assert((await stat(join(type.gitDir, 'FETCH_HEAD'))).size > 0)
      assert(await pathExists(join(type.gitDir, 'FETCH_HEAD')))
    }
    assert.equal(await pathExists(join(path, 'missing-file')), false)
    await run(['branch', 'conflict-test'])
    await writeFile(tracked, 'main version\n')
    await createCommit(
      repository,
      'Main conflict',
      (await getStatus(repository))!.workingDirectory.files
    )
    await run(['checkout', 'conflict-test'])
    await writeFile(tracked, 'other version\n')
    await createCommit(
      repository,
      'Other conflict',
      (await getStatus(repository))!.workingDirectory.files
    )
    await run(['checkout', 'main'])
    await assert.rejects(run(['merge', 'conflict-test']))
    const conflict = (await getStatus(repository))!
    assert(conflict.mergeHeadFound)
    assert(conflict.doConflictedFilesExist)
    assert(
      conflict.workingDirectory.files.some(
        f =>
          'conflictMarkerCount' in f.status && f.status.conflictMarkerCount > 0
      )
    )
    await run(['merge', '--abort'])
    assert.equal((await getStatus(repository))!.mergeHeadFound, false)
  })

  it('keeps independent SSH entries when switching worktrees and removing a test repository', async () => {
    const db = new TestRepositoriesDatabase()
    await db.reset()
    try {
      const store = new RepositoriesStore(db)
      const mainPath = sshRepositoryPath({
        host: 'host',
        path: '/home/example/project',
      })
      const temporaryPath = sshRepositoryPath({
        host: 'host',
        path: '/tmp/test',
      })
      const main = await store.addRepository(mainPath, mainPath + '/.git', null)
      const temporary = await store.addRepository(
        temporaryPath,
        temporaryPath + '/.git',
        null
      )
      assert.notEqual(main.id, temporary.id)
      const linked = sshRepositoryPath({ host: 'host', path: '/tmp/linked' })
      const switched = await store.switchWorktree(
        temporary,
        linked,
        false,
        temporaryPath + '/.git/worktrees/linked',
        temporaryPath
      )
      assert.equal(switched.repository.id, temporary.id)
      await store.removeRepository(switched.repository)
      const remaining = await store.getAll()
      assert.equal(remaining.length, 1)
      assert.equal(remaining[0].path, mainPath)
      assert.equal(remaining[0].id, main.id)
    } finally {
      db.close()
    }
  })

  it('rejects host options, relative roots and escaping file paths', async () => {
    assert.throws(
      () => new SSHRepositoryReader({ host: '-oProxyCommand=evil', path: repo })
    )
    assert.throws(
      () => new SSHRepositoryReader({ host: 'host;command', path: repo })
    )
    assert.throws(
      () => new SSHRepositoryReader({ host: 'host', path: 'relative' })
    )
    await assert.rejects(reader.readWorkingFile('../outside'))
  })

  it('reports a missing repository rather than presenting a clean working tree', async () => {
    const missing = new SSHRepositoryReader({
      host: 'test-alias',
      path: join(root, 'missing'),
    })
    await assert.rejects(
      getStatus(
        new Repository(sshRepositoryPath(missing.connection), 2, null, false)
      )
    )
  })

  it('cancels an in-flight request', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      executeSSHGit(reader.connection, ['status'], {
        signal: controller.signal,
      })
    )
  })
})
