import { execFile, ChildProcess } from 'node:child_process'
import { posix } from 'node:path'
import { parseSSHRepositoryPath } from './ssh-path'

export interface ISSHConnection {
  readonly host: string
  readonly path: string
}

export interface ISSHExecutionOptions {
  readonly streamEncoding?: BufferEncoding
  readonly signal?: AbortSignal
  readonly stdin?: string | Buffer
  readonly maxBuffer?: number
  readonly processCallback?: (process: ChildProcess) => void
  readonly env?: { readonly [key: string]: string | undefined | null }
}

/** Native Git operations run on the host, using its Git configuration and credentials. */
export function executeSSHGit(
  connection: ISSHConnection,
  args: ReadonlyArray<string>,
  options: ISSHExecutionOptions = {}
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
  const remoteArgs = args.map(arg => {
    const remotePath = parseSSHRepositoryPath(arg)
    if (remotePath === null) {
      return arg
    }
    if (remotePath.host !== connection.host) {
      throw new Error('A Git operation cannot span different SSH hosts.')
    }
    return remotePath.path
  })
  let commandIndex = 0
  while (remoteArgs[commandIndex]?.startsWith('-')) {
    commandIndex += remoteArgs[commandIndex] === '-c' ? 2 : 1
  }
  if (
    ['diff', 'show', 'log', 'diff-index'].includes(remoteArgs[commandIndex])
  ) {
    remoteArgs.splice(commandIndex + 1, 0, '--no-ext-diff', '--no-textconv')
  }
  // Local authentication trampolines, proxies, editors and temporary paths do
  // not exist on the server. Forward only operation metadata, never credentials.
  const env = Object.entries(options.env ?? {})
    .filter(
      ([key, value]) =>
        value != null &&
        /^(GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)|GIT_REFLOG_ACTION)$/.test(
          key
        )
    )
    .map(([key, value]) => `${key}=${value}`)
  return executeSSHCommand(
    connection,
    [
      'env',
      'LC_ALL=C',
      'TERM=dumb',
      'GIT_TERMINAL_PROMPT=0',
      'GIT_PAGER=cat',
      'GIT_EDITOR=:',
      'GIT_SEQUENCE_EDITOR=false',
      ...env,
      'git',
      '--no-optional-locks',
      '--literal-pathspecs',
      ...remoteArgs,
    ],
    options
  )
}

/** No local shell; every argument to the remote shell is quoted separately. */
export function executeSSHCommand(
  connection: ISSHConnection,
  args: ReadonlyArray<string>,
  options: ISSHExecutionOptions = {}
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
  validateConnection(connection)
  const command = `cd ${quote(connection.path)} && ${args.map(quote).join(' ')}`
  return new Promise((resolve, reject) => {
    const child = execFile(
      '/usr/bin/ssh',
      [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=2',
        '--',
        connection.host,
        command,
      ],
      {
        encoding: 'buffer',
        // Do not time out and abandon a server-side Git write in an unknown state.
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (
          error !== null &&
          (typeof error.code !== 'number' || error.code === 255)
        ) {
          reject(new Error(stderr.toString('utf8').trim() || error.message))
        } else {
          resolve({
            stdout: Buffer.from(stdout),
            stderr: Buffer.from(stderr),
            exitCode: error === null ? 0 : Number(error.code),
          })
        }
      }
    )
    if (options.streamEncoding !== undefined) {
      child.stdout?.setEncoding(options.streamEncoding)
      child.stderr?.setEncoding(options.streamEncoding)
    }
    options.processCallback?.(child)
    child.stdin?.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        reject(error)
      }
    })
    child.stdin?.end(options.stdin)
  })
}

/** Quote one argument for the remote POSIX shell. Local execution never uses a shell. */
function quote(value: string): string {
  if (value.includes('\0')) {
    throw new Error('NUL characters are not allowed in SSH arguments.')
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function validateConnection(connection: ISSHConnection): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@:[\]-]*$/.test(connection.host)) {
    throw new Error(
      'Enter an SSH alias or user@hostname, without options or spaces.'
    )
  }
  if (!connection.path.startsWith('/') || /[\0\r\n]/.test(connection.path)) {
    throw new Error('The repository path must be an absolute POSIX path.')
  }
}

/** Reads remote file content for the existing diff renderer. */
export class SSHRepositoryReader {
  public constructor(public readonly connection: ISSHConnection) {
    validateConnection(connection)
  }

  public async readWorkingFile(
    path: string,
    length = 1024 * 1024,
    signal?: AbortSignal
  ): Promise<Buffer> {
    if (
      posix.isAbsolute(path) ||
      path.split('/').includes('..') ||
      path.includes('\0')
    ) {
      throw new Error('The file must be inside the remote repository.')
    }
    if (!Number.isInteger(length) || length < 1 || length > 8 * 1024 * 1024) {
      throw new Error('Invalid remote file read limit.')
    }
    const result = await executeSSHCommand(
      this.connection,
      ['head', '-c', String(length), '--', path],
      { signal }
    )
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString('utf8'))
    }
    return result.stdout
  }
}
