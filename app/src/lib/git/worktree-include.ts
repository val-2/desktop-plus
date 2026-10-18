import { joinRepositoryPath } from '../ssh-path'
import * as Fs from 'fs'
import * as Path from 'path'
import { copyFile, mkdir } from 'fs/promises'
import { readFile, copySSHFile } from '../ssh-files'
import { parseSSHRepositoryPath } from '../ssh-path'
import ignore from 'ignore'
import type { Repository } from '../../models/repository'
import { git } from './core'
import { addWorktree } from './worktree'

const WorktreeIncludeFile = '.worktreeinclude'

/**
 * Reads the patterns from the `.worktreeinclude` file at the root of the
 * given repository path.
 *
 * The file uses `.gitignore` syntax. Blank lines and lines starting with `#`
 * are ignored.
 *
 * Returns an empty array if the file does not exist.
 */
export async function readWorktreeIncludePatterns(
  repositoryPath: string
): Promise<ReadonlyArray<string>> {
  const filePath = Path.join(repositoryPath, WorktreeIncludeFile)

  let contents: string
  try {
    contents = await readFile(filePath, 'utf8')
  } catch {
    return []
  }

  return contents
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
}

/**
 * Returns the list of gitignored files in `repositoryPath` that match any of
 * the given patterns.
 *
 * Only files that are both gitignored **and** matched by a `.worktreeinclude`
 * pattern are returned — tracked files are never included.
 */
export async function getIgnoredFilesMatchingPatterns(
  repository: Repository,
  patterns: ReadonlyArray<string>
): Promise<ReadonlyArray<string>> {
  if (patterns.length === 0) {
    return []
  }

  const result = await git(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
    repository.path,
    'getIgnoredFiles'
  )

  // Files are NUL-separated; filter out empty entries from the split
  const ignoredFiles = result.stdout.split('\0').filter(f => f.length > 0)

  const ig = ignore().add(patterns)
  return ignoredFiles.filter(f => ig.ignores(f))
}

/**
 * Copies each file in `files` (relative paths) from `sourcePath` to
 * `destinationPath`, preserving the directory structure.
 *
 * Files that cannot be copied (e.g. because they no longer exist at the
 * source) are skipped silently — a failure to copy a single file never
 * prevents the others from being copied.
 */
export async function copyWorktreeIncludeFiles(
  sourcePath: string,
  destinationPath: string,
  files: ReadonlyArray<string>
): Promise<void> {
  for (const file of files) {
    const src = joinRepositoryPath(sourcePath, file)
    const dest = joinRepositoryPath(destinationPath, file)

    if (parseSSHRepositoryPath(sourcePath) !== null) {
      if (Path.posix.isAbsolute(file) || file.split('/').includes('..')) {
        continue
      }
      try {
        await copySSHFile(src, dest)
      } catch (e) {
        log.warn(
          '[worktree-include] Could not copy remote file',
          e instanceof Error ? e : undefined
        )
      }
      continue
    }

    // Guard against path traversal: the resolved destination must be
    // inside the worktree directory.
    const resolvedDest = Path.resolve(dest)
    const resolvedWorktreeRoot = Path.resolve(destinationPath)
    if (!resolvedDest.startsWith(resolvedWorktreeRoot + Path.sep)) {
      continue
    }

    try {
      // eslint-disable-next-line no-sync
      if (!Fs.existsSync(src)) {
        continue
      }

      await mkdir(Path.dirname(dest), { recursive: true })
      await copyFile(src, dest)
    } catch (e) {
      log.warn(
        `[worktree-include] Failed to copy '${file}' to worktree`,
        e instanceof Error ? e : undefined
      )
    }
  }
}

/**
 * Creates a new git worktree and then copies any gitignored files listed in
 * the `.worktreeinclude` file from the main worktree into the newly created
 * worktree.
 *
 * The copy step is best-effort: failures are logged but do not prevent the
 * worktree from being used.
 *
 * @param repository  The repository to create the worktree in.
 * @param path        The absolute path where the new worktree should be created.
 * @param options     Options forwarded to `addWorktree`.
 */
export async function addWorktreeWithIncludes(
  repository: Repository,
  path: string,
  options: Parameters<typeof addWorktree>[2] = {}
): Promise<void> {
  await addWorktree(repository, path, options)

  try {
    const patterns = await readWorktreeIncludePatterns(repository.path)

    if (patterns.length === 0) {
      return
    }

    const files = await getIgnoredFilesMatchingPatterns(repository, patterns)

    if (files.length > 0) {
      await copyWorktreeIncludeFiles(repository.path, path, files)
    }
  } catch (e) {
    log.warn(
      '[worktree-include] Failed to process .worktreeinclude; worktree was still created',
      e instanceof Error ? e : undefined
    )
  }
}
