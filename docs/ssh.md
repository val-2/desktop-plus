# SSH working-tree repositories

This fork keeps the original Desktop Plus interface and runs Git operations on an existing server-side working tree through SSH. It does not clone that working tree to your computer.

## Setup

The tested client platform is macOS Apple Silicon. The transport currently invokes `/usr/bin/ssh` and targets POSIX servers with Git, Python 3, and `head` available. No agent or service is installed on the server. Other client platforms have not been validated.

Configure SSH access first, including the server's verified host key. The app uses your existing SSH configuration, agent, and `known_hosts`; it requires noninteractive authentication and strict host-key checking. It does not enroll new host keys automatically.

Choose **File → Add Local Repository → Connect over SSH**, enter an SSH alias or `user@hostname`, and enter an absolute repository path, for example `/srv/projects/example`.

The repository appears in the regular list with an SSH suffix, retained even after GitHub metadata is recognized. Existing local repositories continue to use the original local Git pipeline.

## Supported operations

- Native status, branch and worktree selectors, changes list, history, text/image diffs, syntax highlighting, and file/line selection.
- Native Fetch/Pull/Push toolbar, ahead/behind counts, progress animation, errors, and concurrent network-operation guard.
- Commit/amend, including partial commits, and ordinary branch management.
- Create, switch, move, and remove worktrees; `.worktreeinclude` files are copied on the server.
- Create selective stashes, inspect them, rename them, apply/pop them, and drop them. CLI-created stashes and their saved untracked files can also be inspected.
- Discard changes and update the root `.gitignore`, with protection against following a symlink for `.gitignore` reads/writes.
- Read server-side merge/rebase/cherry-pick state and conflict markers through the original status pipeline.

During initial loading, the toolbar and empty changes panel display loading feedback instead of incorrectly suggesting Publish repository. Publish branch remains appropriate for a branch without an upstream.

## Progressive SSH previews

The changes list progressively prepares diffs, source contents, and syntax tokens for up to 12 nearby/visible files. Scrolling and selection reprioritize that window; cold foreground reads have priority over queued speculation. Ready previews initialize the original diff components synchronously, without fetching their contents again.

The display cache is limited to 48 entries and an estimated retained-data budget of 24 MiB (8 MiB per entry), with at most two preview loaders active. This is a cache budget, not a cap on the entire Electron process or exact JavaScript heap size. A content loader may read its two sides in parallel. Completed previews expire after 15 seconds; status refreshes and repository/worktree changes invalidate them, including changes that leave the same Git status code.

Large speculative diffs are capped at 512 KiB and image decodes are not speculatively warmed. If a user selects a file whose speculative read failed, the normal foreground read is retried with its normal limits. Cold, large, or uncached files can still have SSH latency.

Git mutation helpers never use this display cache. Commit/staging/discard operations read current data through the original pipeline. Superseded requests are cancelled; late results cannot repopulate an invalidated scope. Components cancel their content/highlighting reads on unmount, and worker handlers, abort listeners, and request timers are removed on completion or cancellation. The existing pool retains at most two idle highlighting workers.

An isolated cache stress check exercised 15,000 reads over 30 repository scopes. Its final ten heap samples after explicit garbage collection stayed around 7 MiB, with zero cache entries, queued loaders, or active loaders after release. That measures the isolated check, not Electron's total memory. Reproduce it with:

```sh
node --expose-gc --import tsx script/test-ssh-preview-memory.ts
```

## Authentication, hooks, and discarded files

Fetch/pull/push authenticate from the server. Configure credentials, SSH keys, signing, submodules, and Git LFS there. Desktop's local OAuth tokens, proxy settings, authentication trampolines, and temporary paths are not forwarded. Interactive signing or credential prompts are not supported.

Hooks run on the server, and failures follow the normal Git error path. The local per-hook progress/override protocol is not replicated. Git progress on stderr is streamed to the native UI; the separate local LFS progress-file channel is not replicated.

Whole-file discards that request recoverable removal save originals under the common Git directory:

```text
<git-common-dir>/desktop-trash/<unique-id>/contents
<git-common-dir>/desktop-trash/<unique-id>/original-path
```

These copies are on the server, outside the working tree, and survive removal of a linked worktree. They are not in the Mac's Trash. Partial discards use the original `git apply` flow.

## Limits

- Local Finder, external editor, terminal, and external graphical tool integrations do not operate on server files. File context-menu actions requiring local programs are disabled for SSH.
- Interactive history editing, including squash/reorder through generated local todo files, is explicitly rejected before remote Git execution.
- This is not complete parity with provider APIs, pull requests, remote Copilot, every repository setting, or every Git extension.
- The transport defaults to a 64 MiB output cap, honors caller-specific buffer caps, and retains bounded diff-preview reads. There is no arbitrary wall-clock timeout on Git writes; SSH connection and keepalive options detect connection failures. A lost connection can still leave a server operation's outcome uncertain: inspect the repository before retrying a write.

The application uses a separate product name, bundle identifier, and profile. On first launch it copies an existing Desktop Plus profile when available; it leaves the original app/profile in place and does not register the original app's URL protocols.

## Build

The base is `desktop-plus/desktop-plus` tag `v3.6.7.2`, commit `dbba0b5934bf22a0fb24d965c86143fa93eaf9ee`.

Follow the upstream development prerequisites, initialize submodules, and install dependencies with the vendored Yarn version:

```sh
git submodule update --init --recursive
node vendor/yarn-1.21.1.js install --frozen-lockfile --non-interactive
```

Have `yarn` available on PATH, then use the normal production build:

```sh
yarn build:prod
```

On the tested macOS build this produces `dist/Desktop Plus SSH-darwin-arm64/Desktop Plus SSH.app`. Locally packaged builds use an ad-hoc signature rather than Apple notarization. Builds do not include user profiles or credentials.

## Verification

153 tests passed across the SSH repository/toolbar tests and the original status, worktree, worktree-include, stash, commit, and apply suites. Tests exercise real Git with only the SSH transport replaced by a local POSIX shell, including partial commits, rejected hooks, merge conflicts, unusual paths, stdin, streamed progress, stash/worktree lifecycle, recoverable discards, symlink protection, repository identity, and loading-state parity.

```sh
NODE_OPTIONS=--no-experimental-webstorage node script/test.mjs \
  app/test/unit/ssh-preview-cache-test.ts \
  app/test/unit/ssh-highlighter-test.ts \
  app/test/unit/ssh-repository-test.ts \
  app/test/unit/ssh-toolbar-test.tsx \
  app/test/unit/git/status-test.ts \
  app/test/unit/git/worktree-test.ts \
  app/test/unit/git/worktree-include-test.ts \
  app/test/unit/git/stash-test.ts \
  app/test/unit/git/commit-test.ts \
  app/test/unit/git/apply-test.ts \
  app/test/unit/git/diff-test.ts
```

The Node 26 flag is needed by the existing jsdom test setup. TypeScript, ESLint, production compilation, and the macOS ad-hoc signature were checked. A separate temporary repository on a real Linux SSH host was used for commit, push/progress, checkout, stash, worktree, fetch, and pull smoke checks. Native UI checks covered pull-to-fetch transitions, loading feedback, worktree creation/selection, and stash creation/restoration. No production working tree was used for write tests.
