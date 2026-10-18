import * as Fs from 'fs/promises'
import type { Stats } from 'fs'
import { parseSSHRepositoryPath } from './ssh-path'
import { executeSSHCommand } from './ssh-repository'

// Python is invoked per operation; nothing is installed or persisted on the host.
const fileOperation = `
import os, sys, json, shutil, uuid, pathlib
op, path = sys.argv[1:3]
try:
    if op == 'read':
        with open(path, 'rb') as f:
            shutil.copyfileobj(f, sys.stdout.buffer)
    elif op in ('read-ignore', 'write-ignore'):
        import stat
        flags = os.O_RDONLY if op == 'read-ignore' else os.O_WRONLY | os.O_CREAT
        fd = os.open(path, flags | os.O_NOFOLLOW, 0o666)
        with os.fdopen(fd, 'rb' if op == 'read-ignore' else 'wb') as f:
            a, b = os.fstat(f.fileno()), os.lstat(path)
            if stat.S_ISLNK(b.st_mode) or (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
                raise OSError(40, 'Cannot use a symbolic link as the root .gitignore file')
            if op == 'read-ignore':
                shutil.copyfileobj(f, sys.stdout.buffer)
            else:
                f.truncate(0)
                shutil.copyfileobj(sys.stdin.buffer, f)
    elif op == 'stat':
        s = os.stat(path)
        print(json.dumps({'size': s.st_size, 'mtime': s.st_mtime * 1000}))
    elif op == 'exists':
        sys.exit(0 if os.path.exists(path) else 1)
    elif op == 'remove':
        os.unlink(path)
    elif op == 'copy':
        dest = sys.argv[3]
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(path, dest)
    elif op == 'trash':
        # Keep recoverable originals in Git's private metadata directory.
        metadata = sys.argv[3]
        common = os.path.join(metadata, 'commondir')
        if os.path.isfile(common):
            with open(common) as f:
                metadata = os.path.normpath(os.path.join(metadata, f.read().strip()))
        root = os.path.join(metadata, 'desktop-trash')
        os.makedirs(root, mode=0o700, exist_ok=True)
        entry = os.path.join(root, str(uuid.uuid4()))
        os.mkdir(entry, mode=0o700)
        with open(os.path.join(entry, 'original-path'), 'w') as f:
            f.write(path)
        shutil.move(path, os.path.join(entry, 'contents'))
except OSError as e:
    print(json.dumps({'code': e.errno, 'message': str(e)}), file=sys.stderr)
    sys.exit(2)
`

async function remoteFileOperation(
  path: string,
  operation: string,
  extra: string[] = [],
  stdin?: string
) {
  const connection = parseSSHRepositoryPath(path)
  if (connection === null) {
    throw new Error('An SSH file path is required.')
  }
  const result = await executeSSHCommand(
    { ...connection, path: '/' },
    ['python3', '-c', fileOperation, operation, connection.path, ...extra],
    { stdin }
  )
  if (
    result.exitCode > 1 ||
    (result.exitCode !== 0 && operation !== 'exists')
  ) {
    let code = 'EIO'
    try {
      const error = JSON.parse(result.stderr.toString('utf8'))
      code =
        (
          { 2: 'ENOENT', 13: 'EACCES', 20: 'ENOTDIR' } as Record<number, string>
        )[error.code] ?? code
    } catch {}
    throw Object.assign(
      new Error(
        result.stderr.toString('utf8').trim() ||
          'Remote filesystem operation failed.'
      ),
      { code }
    )
  }
  return result
}

export function readFile(path: string, encoding: 'utf8'): Promise<string>
export function readFile(path: string): Promise<Buffer>
export async function readFile(
  path: string,
  encoding?: 'utf8'
): Promise<string | Buffer> {
  if (parseSSHRepositoryPath(path) === null) {
    return encoding === undefined
      ? Fs.readFile(path)
      : Fs.readFile(path, encoding)
  }
  const { stdout } = await remoteFileOperation(path, 'read')
  return encoding === undefined ? stdout : stdout.toString(encoding)
}

export async function stat(
  path: string
): Promise<Pick<Stats, 'size' | 'mtime'>> {
  if (parseSSHRepositoryPath(path) === null) {
    return Fs.stat(path)
  }
  const { stdout } = await remoteFileOperation(path, 'stat')
  const result = JSON.parse(stdout.toString('utf8'))
  return { size: result.size, mtime: new Date(result.mtime) }
}

export async function remotePathExists(path: string): Promise<boolean> {
  return (await remoteFileOperation(path, 'exists')).exitCode === 0
}

export async function removeSSHFile(path: string): Promise<void> {
  await remoteFileOperation(path, 'remove')
}

export async function trashSSHFile(
  path: string,
  gitDir: string
): Promise<void> {
  const source = parseSSHRepositoryPath(path)
  const destination = parseSSHRepositoryPath(gitDir)
  if (
    source === null ||
    destination === null ||
    source.host !== destination.host
  ) {
    throw new Error('The trash must be on the same SSH host.')
  }
  await remoteFileOperation(path, 'trash', [destination.path])
}

export async function copySSHFile(
  source: string,
  destination: string
): Promise<void> {
  const from = parseSSHRepositoryPath(source)
  const to = parseSSHRepositoryPath(destination)
  if (from === null || to === null || from.host !== to.host) {
    throw new Error('Worktree files must be copied on the same SSH host.')
  }
  await remoteFileOperation(source, 'copy', [to.path])
}

export async function readSSHGitIgnore(path: string): Promise<string | null> {
  try {
    return (await remoteFileOperation(path, 'read-ignore')).stdout.toString(
      'utf8'
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function writeSSHGitIgnore(
  path: string,
  contents: string
): Promise<void> {
  await remoteFileOperation(path, 'write-ignore', [], contents)
}
