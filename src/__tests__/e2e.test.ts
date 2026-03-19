/**
 * End-to-end / integration tests for depsee.
 *
 * These tests exercise the full `analyze()` pipeline — package.json reading,
 * registry fetching, audit parsing, scoring — using a real temp project on
 * disk but a stubbed global `fetch` so the suite never hits the network.
 *
 * A handful of CLI smoke tests (--help, --version) run the built binary as a
 * real subprocess to verify the CLI layer independently.
 *
 * Prerequisites: `npm run build` must have been run before the subprocess
 * tests execute.  The CI workflow does this automatically.
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest'
import { analyze } from '../analyzer.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dirname, '../../')
const CLI       = join(REPO_ROOT, 'dist', 'cli.js')

/** Minimal valid registry response for a package. */
function mockRegistry(name: string, opts: {
  latest: string
  versions: Record<string, string>   // version → ISO date
}): object {
  const { latest, versions } = opts
  return {
    name,
    'dist-tags': { latest },
    time: { created: Object.values(versions)[0] ?? new Date().toISOString(), modified: new Date().toISOString(), ...versions },
    versions: Object.fromEntries(Object.keys(versions).map((v) => [v, {}])),
  }
}

/** Builds a stubbed fetch that returns the given registry map. */
function buildFetch(registry: Record<string, object>) {
  return async (url: string | URL, _init?: RequestInit): Promise<Response> => {
    const name = String(url).replace('https://registry.npmjs.org/', '').split('?')[0]
    const decoded = decodeURIComponent(name ?? '')
    const data = registry[decoded ?? ''] ?? registry[name ?? '']
    if (!data) {
      return new Response('Not found', { status: 404 })
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

// ─── Shared fixture project ───────────────────────────────────────────────────

let tmpDir: string

// Registry stubs — two-year-old packages so scoring is deterministic
const NOW   = new Date()
const TWO_YEARS_AGO = new Date(NOW.getFullYear() - 2, NOW.getMonth(), NOW.getDate()).toISOString()
const ONE_YEAR_AGO  = new Date(NOW.getFullYear() - 1, NOW.getMonth(), NOW.getDate()).toISOString()

const REGISTRY_STUB: Record<string, object> = {
  ms: mockRegistry('ms', {
    latest: '2.1.3',
    versions: {
      '2.0.0': TWO_YEARS_AGO,
      '2.1.0': ONE_YEAR_AGO,
      '2.1.1': ONE_YEAR_AGO,
      '2.1.2': ONE_YEAR_AGO,
      '2.1.3': ONE_YEAR_AGO,
    },
  }),
  semver: mockRegistry('semver', {
    latest: '7.6.0',
    versions: {
      '7.3.8': TWO_YEARS_AGO,
      '7.4.0': ONE_YEAR_AGO,
      '7.5.0': ONE_YEAR_AGO,
      '7.6.0': ONE_YEAR_AGO,
    },
  }),
  chalk: mockRegistry('chalk', {
    latest: '5.3.0',
    versions: {
      '4.1.2': TWO_YEARS_AGO,
      '5.0.0': ONE_YEAR_AGO,
      '5.3.0': ONE_YEAR_AGO,
    },
  }),
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'depsee-e2e-'))

  writeFileSync(
    join(tmpDir, 'package.json'),
    JSON.stringify(
      {
        name: 'depsee-e2e-fixture',
        version: '1.0.0',
        private: true,
        dependencies: {
          ms:     '2.0.0',
          semver: '7.3.8',
        },
        devDependencies: {
          chalk: '4.1.2',
        },
      },
      null,
      2,
    ),
  )

  // Minimal lock file so detectPackageManager returns 'npm'
  writeFileSync(join(tmpDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 2 }))
})

afterAll(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// Stub global fetch before each test, restore after
beforeEach(() => {
  vi.stubGlobal('fetch', buildFetch(REGISTRY_STUB))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ─── analyze() integration tests ─────────────────────────────────────────────

describe('analyze() — integration (stubbed registry)', () => {
  it('returns a report with summary and packages', async () => {
    const report = await analyze({ cwd: tmpDir, audit: false })
    expect(report).toHaveProperty('summary')
    expect(report).toHaveProperty('packages')
    expect(Array.isArray(report.packages)).toBe(true)
  })

  it('detects all declared dependencies', async () => {
    const { packages } = await analyze({ cwd: tmpDir, audit: false })
    const names = packages.map((p) => p.name)
    expect(names).toContain('ms')
    expect(names).toContain('semver')
  })

  it('includes devDependencies by default', async () => {
    const { packages } = await analyze({ cwd: tmpDir, audit: false })
    const chalk = packages.find((p) => p.name === 'chalk')
    expect(chalk).toBeDefined()
    expect(chalk!.type).toBe('devDependency')
  })

  it('excludes devDependencies when includeDevDeps = false', async () => {
    const { packages } = await analyze({ cwd: tmpDir, audit: false, includeDevDeps: false })
    const chalk = packages.find((p) => p.name === 'chalk')
    expect(chalk).toBeUndefined()
  })

  it('ignores listed packages', async () => {
    const { packages } = await analyze({ cwd: tmpDir, audit: false, ignore: ['ms'] })
    const ms = packages.find((p) => p.name === 'ms')
    expect(ms).toBeUndefined()
  })

  it('summary.total matches packages.length', async () => {
    const { summary, packages } = await analyze({ cwd: tmpDir, audit: false })
    expect(summary.total).toBe(packages.length)
  })

  it('summary.projectName matches the fixture name', async () => {
    const { summary } = await analyze({ cwd: tmpDir, audit: false })
    expect(summary.projectName).toBe('depsee-e2e-fixture')
  })

  it('detects npm as the package manager', async () => {
    const { summary } = await analyze({ cwd: tmpDir, audit: false })
    expect(summary.packageManager).toBe('npm')
  })

  it('global score is between 0 and 100', async () => {
    const { summary } = await analyze({ cwd: tmpDir, audit: false })
    expect(summary.score).toBeGreaterThanOrEqual(0)
    expect(summary.score).toBeLessThanOrEqual(100)
  })

  it('ms@2.0.0 is not "healthy" — it is behind the latest version', async () => {
    const { packages } = await analyze({ cwd: tmpDir, audit: false })
    const ms = packages.find((p) => p.name === 'ms')
    expect(ms).toBeDefined()
    expect(ms!.status).not.toBe('healthy')
    expect(ms!.gapDays).toBeGreaterThan(0)
  })

  it('each package has all required fields', async () => {
    const { packages } = await analyze({ cwd: tmpDir, audit: false })
    for (const pkg of packages) {
      expect(pkg).toHaveProperty('name')
      expect(pkg).toHaveProperty('type')
      expect(pkg).toHaveProperty('installed')
      expect(pkg).toHaveProperty('latest')
      expect(pkg).toHaveProperty('score')
      expect(pkg).toHaveProperty('status')
      expect(pkg).toHaveProperty('vulnerabilities')
      expect(Array.isArray(pkg.vulnerabilities)).toBe(true)
      expect(pkg.score).toBeGreaterThanOrEqual(0)
      expect(pkg.score).toBeLessThanOrEqual(100)
    }
  })

  it('packages are sorted worst score first', async () => {
    const { packages } = await analyze({ cwd: tmpDir, audit: false })
    for (let i = 1; i < packages.length; i++) {
      expect(packages[i]!.score).toBeGreaterThanOrEqual(packages[i - 1]!.score)
    }
  })

  it('ms installed version is 2.0.0 and latest is 2.1.3', async () => {
    const { packages } = await analyze({ cwd: tmpDir, audit: false })
    const ms = packages.find((p) => p.name === 'ms')
    expect(ms!.installed).toBe('2.0.0')
    expect(ms!.latest).toBe('2.1.3')
  })
})

// ─── CLI binary smoke tests (no network needed) ───────────────────────────────

describe('depsee CLI — binary smoke tests', () => {
  it('--help exits with code 0 and prints usage', () => {
    const result = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', timeout: 10_000 })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/depsee/)
    expect(result.stdout).toMatch(/--serve/)
  })

  it('--version exits with code 0 and prints a version string', () => {
    const result = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8', timeout: 10_000 })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/depsee v\d+\.\d+\.\d+/)
  })
})
