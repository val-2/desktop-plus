/* eslint-disable no-sync */

import { app } from 'electron'
import * as Fs from 'fs'
import * as Path from 'path'

/** Base names of previous app versions to migrate from, in priority order. */
const LegacyAppNames = __APP_NAME__.endsWith(' SSH')
  ? ['Desktop Plus', 'GitHub Desktop Plus', 'GitHub Desktop']
  : ['GitHub Desktop Plus', 'GitHub Desktop']

const MigrationSentinel = '.config-migrated'

let migratedFromName: string | null = null

/**
 * Returns the name of the legacy app whose config directory was migrated to the
 * current location during this launch, or null if no migration happened.
 */
export function getConfigMigrationResult(): string | null {
  return migratedFromName
}

/**
 * Must run synchronously and early, before any window loads, so the new profile
 * is fully populated before the app reads from it.
 */
export function migrateLegacyConfigDir(): void {
  const newDir = app.getPath('userData')
  const sentinel = Path.join(newDir, MigrationSentinel)

  // Chromium creates the config directory during early startup, so we can't use
  // its existence to detect a first launch. The sentinel marks that we've
  // already run, and is written even when there was nothing to migrate.
  if (Fs.existsSync(sentinel)) {
    return
  }

  try {
    const legacy = findLegacyDir(newDir)

    if (legacy !== null) {
      log.info(`Migrating config directory from "${legacy.path}"`)
      copyProfile(legacy.path, newDir)
      migratedFromName = legacy.name
    }

    Fs.mkdirSync(newDir, { recursive: true })
    Fs.writeFileSync(sentinel, '')
  } catch (e) {
    log.error('Failed to migrate config directory', e)
  }
}

function findLegacyDir(newDir: string): { name: string; path: string } | null {
  const appData = app.getPath('appData')

  for (const name of LegacyAppNames) {
    const path = Path.join(appData, withDevSuffix(name))
    if (path !== newDir && isDirectory(path)) {
      return { name, path }
    }
  }

  return null
}

/** Development builds suffix the app name (and thus the config directory). */
function withDevSuffix(name: string): string {
  return __DEV__ ? `${name}-dev` : name
}

function isDirectory(path: string): boolean {
  try {
    return Fs.statSync(path).isDirectory()
  } catch {
    return false
  }
}

function copyProfile(src: string, dest: string): void {
  const tmp = dest + '.migrating'
  Fs.rmSync(tmp, { recursive: true, force: true })

  try {
    Fs.cpSync(src, tmp, { recursive: true })
    Fs.mkdirSync(dest, { recursive: true })

    for (const entry of Fs.readdirSync(tmp)) {
      const target = Path.join(dest, entry)
      if (!Fs.existsSync(target)) {
        Fs.renameSync(Path.join(tmp, entry), target)
      }
    }
  } finally {
    Fs.rmSync(tmp, { recursive: true, force: true })
  }
}
