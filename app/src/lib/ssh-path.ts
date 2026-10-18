import { posix, join } from 'node:path'
import type { ISSHConnection } from './ssh-repository'

/** Persist remote identity in the existing unique repository-path field. */
export function sshRepositoryPath(connection: ISSHConnection): string {
  return `ssh://${encodeURIComponent(connection.host)}${connection.path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

export function parseSSHRepositoryPath(path: string): ISSHConnection | null {
  // path.join normalizes a URI's double slash when joining metadata paths.
  const match = /^ssh:\/{1,2}([^/]+)(\/.*)$/.exec(path)
  if (match === null) {
    return null
  }
  return {
    host: decodeURIComponent(match[1]),
    path: decodeURIComponent(match[2]),
  }
}

/** Join raw filesystem segments without decoding filenames as URI escapes. */
export function joinRepositoryPath(path: string, ...parts: string[]): string {
  const connection = parseSSHRepositoryPath(path)
  return connection === null
    ? join(path, ...parts)
    : sshRepositoryPath({
        ...connection,
        path: posix.join(connection.path, ...parts),
      })
}
