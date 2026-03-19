import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PackageManager } from './types.js'

/**
 * Auto-detects the package manager used in a project by looking for
 * lock files in the given directory.
 *
 * Detection order:
 * 1. bun.lockb       → Bun
 * 2. pnpm-lock.yaml  → pnpm
 * 3. yarn.lock       → Yarn
 * 4. package-lock.json → npm
 * 5. fallback        → npm
 */
export function detectPackageManager(cwd: string): PackageManager {
  const checks: Array<[string, PackageManager]> = [
    ['bun.lockb', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ]

  for (const [lockFile, pm] of checks) {
    if (existsSync(join(cwd, lockFile))) {
      return pm
    }
  }

  return 'npm'
}

/**
 * Returns the install command for updating a specific package.
 */
export function getUpdateCommand(pm: PackageManager, packageName: string): string {
  switch (pm) {
    case 'bun':  return `bun add ${packageName}@latest`
    case 'pnpm': return `pnpm add ${packageName}@latest`
    case 'yarn': return `yarn add ${packageName}@latest`
    case 'npm':  return `npm install ${packageName}@latest --legacy-peer-deps`
  }
}

/**
 * Returns the remove command for a specific package.
 */
export function getRemoveCommand(pm: PackageManager, packageName: string): string {
  switch (pm) {
    case 'bun':  return `bun remove ${packageName}`
    case 'pnpm': return `pnpm remove ${packageName}`
    case 'yarn': return `yarn remove ${packageName}`
    case 'npm':  return `npm uninstall ${packageName}`
  }
}

/**
 * Returns the audit command for the detected package manager.
 * Note: Bun delegates to npm audit for compatibility.
 */
export function getAuditCommand(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm': return 'pnpm audit --json'
    case 'yarn': return 'yarn audit --json'  // works for both Yarn v1 and v2+
    case 'bun':
    case 'npm':  return 'npm audit --json'
  }
}

/** Human-readable label for display in the UI. */
export function getPackageManagerLabel(pm: PackageManager): string {
  switch (pm) {
    case 'bun':  return 'Bun'
    case 'pnpm': return 'pnpm'
    case 'yarn': return 'Yarn'
    case 'npm':  return 'npm'
  }
}
