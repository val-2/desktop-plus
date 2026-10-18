import { parseSSHRepositoryPath } from './ssh-path'
import { remotePathExists } from './ssh-files'
import { access } from 'fs/promises'
import constant from 'lodash/constant'

/**
 * Returns a value indicating whether or not the provided path exists (as in
 * whether it's visible to the current process or not).
 */
export const pathExists = (path: string) =>
  parseSSHRepositoryPath(path) === null
    ? access(path).then(constant(true), constant(false))
    : remotePathExists(path)
