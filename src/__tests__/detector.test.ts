import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectPackageManager, getUpdateCommand, getRemoveCommand, getAuditCommand, getPackageManagerLabel } from '../detector.js'

// Mock node:fs so we don't need real files on disk
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}))

import { existsSync } from 'node:fs'

const mockExists = (files: string[]) => {
  vi.mocked(existsSync).mockImplementation((p) =>
    files.some((f) => String(p).endsWith(f)),
  )
}

// ─── detectPackageManager ─────────────────────────────────────────────────────

describe('detectPackageManager', () => {
  beforeEach(() => vi.resetAllMocks())

  it('detects bun via bun.lockb', () => {
    mockExists(['bun.lockb'])
    expect(detectPackageManager('/project')).toBe('bun')
  })

  it('detects pnpm via pnpm-lock.yaml', () => {
    mockExists(['pnpm-lock.yaml'])
    expect(detectPackageManager('/project')).toBe('pnpm')
  })

  it('detects yarn via yarn.lock', () => {
    mockExists(['yarn.lock'])
    expect(detectPackageManager('/project')).toBe('yarn')
  })

  it('detects npm via package-lock.json', () => {
    mockExists(['package-lock.json'])
    expect(detectPackageManager('/project')).toBe('npm')
  })

  it('falls back to npm when no lockfile is found', () => {
    mockExists([])
    expect(detectPackageManager('/project')).toBe('npm')
  })

  it('prefers bun over pnpm when both lockfiles exist', () => {
    mockExists(['bun.lockb', 'pnpm-lock.yaml'])
    expect(detectPackageManager('/project')).toBe('bun')
  })

  it('prefers pnpm over yarn when both lockfiles exist', () => {
    mockExists(['pnpm-lock.yaml', 'yarn.lock'])
    expect(detectPackageManager('/project')).toBe('pnpm')
  })

  it('prefers yarn over npm when both lockfiles exist', () => {
    mockExists(['yarn.lock', 'package-lock.json'])
    expect(detectPackageManager('/project')).toBe('yarn')
  })
})

// ─── getUpdateCommand ─────────────────────────────────────────────────────────

describe('getUpdateCommand', () => {
  it('npm: uses npm install with --legacy-peer-deps', () => {
    expect(getUpdateCommand('npm', 'lodash')).toBe('npm install lodash@latest --legacy-peer-deps')
  })

  it('yarn: uses yarn add', () => {
    expect(getUpdateCommand('yarn', 'lodash')).toBe('yarn add lodash@latest')
  })

  it('pnpm: uses pnpm add', () => {
    expect(getUpdateCommand('pnpm', 'lodash')).toBe('pnpm add lodash@latest')
  })

  it('bun: uses bun add', () => {
    expect(getUpdateCommand('bun', 'lodash')).toBe('bun add lodash@latest')
  })
})

// ─── getRemoveCommand ─────────────────────────────────────────────────────────

describe('getRemoveCommand', () => {
  it('npm: uses npm uninstall', () => {
    expect(getRemoveCommand('npm', 'lodash')).toBe('npm uninstall lodash')
  })

  it('yarn: uses yarn remove', () => {
    expect(getRemoveCommand('yarn', 'lodash')).toBe('yarn remove lodash')
  })

  it('pnpm: uses pnpm remove', () => {
    expect(getRemoveCommand('pnpm', 'lodash')).toBe('pnpm remove lodash')
  })

  it('bun: uses bun remove', () => {
    expect(getRemoveCommand('bun', 'lodash')).toBe('bun remove lodash')
  })
})

// ─── getAuditCommand ─────────────────────────────────────────────────────────

describe('getAuditCommand', () => {
  it('npm uses npm audit --json', () => {
    expect(getAuditCommand('npm')).toBe('npm audit --json')
  })

  it('bun delegates to npm audit --json', () => {
    expect(getAuditCommand('bun')).toBe('npm audit --json')
  })

  it('yarn uses yarn audit --json (v1 NDJSON format)', () => {
    expect(getAuditCommand('yarn')).toBe('yarn audit --json')
  })

  it('pnpm uses pnpm audit --json', () => {
    expect(getAuditCommand('pnpm')).toBe('pnpm audit --json')
  })
})

// ─── getPackageManagerLabel ───────────────────────────────────────────────────

describe('getPackageManagerLabel', () => {
  it.each([
    ['npm',  'npm'],
    ['yarn', 'Yarn'],
    ['pnpm', 'pnpm'],
    ['bun',  'Bun'],
  ] as const)('%s → "%s"', (pm, label) => {
    expect(getPackageManagerLabel(pm)).toBe(label)
  })
})
