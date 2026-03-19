import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock the registry module so tests never hit the network
vi.mock('../registry.js', () => ({
  fetchPackagesBatch: vi.fn(),
  getDescription: vi.fn().mockReturnValue(''),
  getLatestVersion: vi.fn(),
  getReleaseDate: vi.fn(),
  countMissedVersions: vi.fn(),
  getPublishFrequency: vi.fn(),
}))

// Mock the auditor so tests don't spawn npm/yarn
vi.mock('../auditor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auditor.js')>()
  return {
    ...actual,
    runAudit: vi.fn().mockResolvedValue(new Map()),
  }
})

// Mock node:fs for package.json reading
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  }
})

import { readFileSync, existsSync } from 'node:fs'
import {
  fetchPackagesBatch,
  getDescription,
  getLatestVersion,
  getReleaseDate,
  countMissedVersions,
  getPublishFrequency,
} from '../registry.js'
import { runAudit } from '../auditor.js'
import { analyze } from '../analyzer.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

import type { NpmPackageData } from '../registry.js'

/** Build a minimal fake registry data object (opaque — only used by mocked fns) */
const fakeRegistryData = (): NpmPackageData => ({
  name: 'fake',
  'dist-tags': { latest: '1.0.0' },
  time: { '1.0.0': new Date().toISOString() },
  versions: {},
})

/** Set up a project with the given deps and PM lockfile */
function setupProject(
  deps: Record<string, string>,
  devDeps: Record<string, string> = {},
  lockfile = 'package-lock.json',
) {
  vi.mocked(readFileSync).mockReturnValue(
    JSON.stringify({ name: 'my-app', version: '1.0.0', dependencies: deps, devDependencies: devDeps }),
  )
  vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith(lockfile))
}

/** Set up registry mock responses for a list of packages */
function setupRegistry(packages: Array<{ name: string; installedAt: string; latestAt: string; latest: string; missed?: number; freq?: number }>) {
  const registryMap = new Map(packages.map(({ name }) => [name, fakeRegistryData()]))
  vi.mocked(fetchPackagesBatch).mockResolvedValue(registryMap)

  vi.mocked(getLatestVersion).mockImplementation(() => '99.0.0')
  vi.mocked(getReleaseDate).mockImplementation((_data, version) => {
    // Return installedAt for installed version, latestAt otherwise
    const pkg = packages.find((p) => version === p.latest || version === '0.0.0')
    return pkg?.latestAt ?? daysAgo(0)
  })
  vi.mocked(countMissedVersions).mockImplementation(() => 0)
  vi.mocked(getPublishFrequency).mockImplementation(() => 6)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => vi.resetAllMocks())

describe('analyze — basic package parsing', () => {
  it('returns all direct dependencies', async () => {
    setupProject({ react: '^18.0.0', lodash: '^4.0.0' })
    setupRegistry([
      { name: 'react', installedAt: daysAgo(30), latestAt: daysAgo(0), latest: '18.2.0' },
      { name: 'lodash', installedAt: daysAgo(60), latestAt: daysAgo(0), latest: '4.17.21' },
    ])

    const report = await analyze({ cwd: '/project', audit: false })
    const names = report.packages.map((p) => p.name)
    expect(names).toContain('react')
    expect(names).toContain('lodash')
  })

  it('includes devDependencies by default', async () => {
    setupProject({}, { vitest: '^1.0.0' })
    setupRegistry([
      { name: 'vitest', installedAt: daysAgo(10), latestAt: daysAgo(0), latest: '1.0.0' },
    ])

    const report = await analyze({ cwd: '/project', audit: false })
    expect(report.packages.find((p) => p.name === 'vitest')?.type).toBe('devDependency')
  })

  it('excludes devDependencies when includeDevDeps = false', async () => {
    setupProject({ react: '^18.0.0' }, { vitest: '^1.0.0' })
    setupRegistry([
      { name: 'react', installedAt: daysAgo(10), latestAt: daysAgo(0), latest: '18.2.0' },
    ])

    const report = await analyze({ cwd: '/project', audit: false, includeDevDeps: false })
    expect(report.packages.find((p) => p.name === 'vitest')).toBeUndefined()
    expect(report.packages.find((p) => p.name === 'react')).toBeDefined()
  })

  it('ignores packages listed in the ignore option', async () => {
    setupProject({ react: '^18.0.0', lodash: '^4.0.0' })
    setupRegistry([
      { name: 'react', installedAt: daysAgo(10), latestAt: daysAgo(0), latest: '18.2.0' },
    ])

    const report = await analyze({ cwd: '/project', audit: false, ignore: ['lodash'] })
    expect(report.packages.find((p) => p.name === 'lodash')).toBeUndefined()
  })
})

describe('analyze — package manager detection', () => {
  it('detects npm via package-lock.json', async () => {
    setupProject({ react: '^18.0.0' }, {}, 'package-lock.json')
    setupRegistry([{ name: 'react', installedAt: daysAgo(10), latestAt: daysAgo(0), latest: '18.2.0' }])
    const report = await analyze({ cwd: '/project', audit: false })
    expect(report.summary.packageManager).toBe('npm')
  })

  it('detects yarn via yarn.lock', async () => {
    setupProject({ react: '^18.0.0' }, {}, 'yarn.lock')
    setupRegistry([{ name: 'react', installedAt: daysAgo(10), latestAt: daysAgo(0), latest: '18.2.0' }])
    const report = await analyze({ cwd: '/project', audit: false })
    expect(report.summary.packageManager).toBe('yarn')
  })

  it('detects pnpm via pnpm-lock.yaml', async () => {
    setupProject({ react: '^18.0.0' }, {}, 'pnpm-lock.yaml')
    setupRegistry([{ name: 'react', installedAt: daysAgo(10), latestAt: daysAgo(0), latest: '18.2.0' }])
    const report = await analyze({ cwd: '/project', audit: false })
    expect(report.summary.packageManager).toBe('pnpm')
  })

  it('detects bun via bun.lockb', async () => {
    setupProject({ react: '^18.0.0' }, {}, 'bun.lockb')
    setupRegistry([{ name: 'react', installedAt: daysAgo(10), latestAt: daysAgo(0), latest: '18.2.0' }])
    const report = await analyze({ cwd: '/project', audit: false })
    expect(report.summary.packageManager).toBe('bun')
  })
})

describe('analyze — vulnerabilities integration', () => {
  it('marks packages as vulnerable when audit results are present', async () => {
    setupProject({ lodash: '^4.0.0' })
    setupRegistry([{ name: 'lodash', installedAt: daysAgo(200), latestAt: daysAgo(0), latest: '4.17.21' }])
    vi.mocked(runAudit).mockResolvedValue(
      new Map([['lodash', [{ id: 'GHSA-test', title: 'Prototype Pollution', severity: 'high', url: 'https://gh.com', fixAvailable: true }]]])
    )

    const report = await analyze({ cwd: '/project', audit: true })
    const lodash = report.packages.find((p) => p.name === 'lodash')
    expect(lodash?.status).toBe('vulnerable')
    expect(lodash?.vulnerabilities).toHaveLength(1)
    expect(lodash?.vulnerabilities[0]?.severity).toBe('high')
  })

  it('adds transitive packages found in audit but not in direct deps', async () => {
    setupProject({ express: '^4.0.0' })
    // Only express in registry for direct deps; then transitive fetch for qs
    vi.mocked(fetchPackagesBatch)
      .mockResolvedValueOnce(new Map([['express', fakeRegistryData()]]))  // direct
      .mockResolvedValueOnce(new Map([['qs', fakeRegistryData()]]))        // transitive
    vi.mocked(getLatestVersion).mockReturnValue('6.15.0')
    vi.mocked(getReleaseDate).mockReturnValue(daysAgo(10))
    vi.mocked(countMissedVersions).mockReturnValue(0)
    vi.mocked(getPublishFrequency).mockReturnValue(4)

    vi.mocked(runAudit).mockResolvedValue(
      new Map([
        ['express', []],
        ['qs', [{ id: 'GHSA-qs', title: 'Prototype Poisoning', severity: 'moderate', url: 'https://gh.com', fixAvailable: true }]],
      ])
    )

    const report = await analyze({ cwd: '/project', audit: true })
    const qs = report.packages.find((p) => p.name === 'qs')!
    expect(qs).toBeDefined()
    expect(qs.type).toBe('transitive')
    expect(qs.status).toBe('vulnerable')
  })

  it('counts vulnerable packages correctly in summary', async () => {
    setupProject({ react: '^18.0.0', lodash: '^4.0.0' })
    setupRegistry([
      { name: 'react', installedAt: daysAgo(10), latestAt: daysAgo(0), latest: '18.2.0' },
      { name: 'lodash', installedAt: daysAgo(200), latestAt: daysAgo(0), latest: '4.17.21' },
    ])
    vi.mocked(runAudit).mockResolvedValue(
      new Map([['lodash', [{ id: 'x', title: 'x', severity: 'high' as const, url: 'x', fixAvailable: true }]]])
    )

    const report = await analyze({ cwd: '/project', audit: true })
    expect(report.summary.vulnerable).toBe(1)
    expect(report.summary.total).toBe(2)
  })
})

describe('analyze — summary', () => {
  it('computes a global score', async () => {
    setupProject({ react: '^18.0.0' })
    setupRegistry([{ name: 'react', installedAt: daysAgo(10), latestAt: daysAgo(0), latest: '18.2.0' }])
    const report = await analyze({ cwd: '/project', audit: false })
    expect(report.summary.score).toBeGreaterThan(0)
    expect(report.summary.score).toBeLessThanOrEqual(100)
  })

  it('exposes the project name from package.json', async () => {
    setupProject({ react: '^18.0.0' })
    setupRegistry([{ name: 'react', installedAt: daysAgo(10), latestAt: daysAgo(0), latest: '18.2.0' }])
    const report = await analyze({ cwd: '/project', audit: false })
    expect(report.summary.projectName).toBe('my-app')
  })
})
