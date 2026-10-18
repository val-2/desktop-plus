import { parseSSHRepositoryPath } from '../../lib/ssh-path'
import * as Path from 'path'

import { IMenuItem } from '../../lib/menu-item'
import { writeClipboardText } from '../main-process-proxy'

interface IWorktreeContextMenuConfig {
  readonly path: string
  readonly isMainWorktree: boolean
  readonly isLocked: boolean
  readonly onRenameWorktree?: (path: string) => void
  readonly onRemoveWorktree?: (path: string) => void
  readonly onOpenInNewWindow?: () => void
}

export function generateWorktreeContextMenuItems(
  config: IWorktreeContextMenuConfig
): ReadonlyArray<IMenuItem> {
  const {
    path,
    isMainWorktree,
    isLocked,
    onRenameWorktree,
    onRemoveWorktree,
    onOpenInNewWindow,
  } = config
  const remotePath = parseSSHRepositoryPath(path)?.path ?? path
  const name = Path.basename(remotePath)
  const items = new Array<IMenuItem>()

  if (onOpenInNewWindow !== undefined) {
    items.push({
      label: __DARWIN__
        ? 'Open Worktree in New Window'
        : 'Open worktree in new window',
      action: () => onOpenInNewWindow(),
    })
    items.push({ type: 'separator' })
  }

  if (onRenameWorktree !== undefined) {
    items.push({
      label: 'Rename…',
      action: () => onRenameWorktree(path),
      enabled: !isMainWorktree && !isLocked,
    })
  }

  items.push({
    label: __DARWIN__ ? 'Copy Worktree Name' : 'Copy worktree name',
    action: () => writeClipboardText(name),
  })

  items.push({
    label: __DARWIN__ ? 'Copy Worktree Path' : 'Copy worktree path',
    action: () => writeClipboardText(remotePath),
  })

  if (onRemoveWorktree !== undefined) {
    items.push({ type: 'separator' })
    items.push({
      label: 'Delete…',
      action: () => onRemoveWorktree(path),
      enabled: !isMainWorktree && !isLocked,
    })
  }

  return items
}
