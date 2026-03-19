import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock node:fs so tests never touch disk
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn() }
})

import { readFileSync } from 'node:fs'
import { buildTransitiveGraph } from '../analyzer.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a minimal v2 package-lock.json string for the given packages map. */
function makeLockfile(
  pkgs: Record<string, { version: string; dependencies?: Record<string, string> }>,
): string {
  const packages: Record<string, unknown> = { '': { name: 'test', version: '1.0.0' } }
  for (const [name, info] of Object.entries(pkgs)) {
    packages[`node_modules/${name}`] = info
  }
  return JSON.stringify({ lockfileVersion: 2, packages })
}

const mockReadFileSync = vi.mocked(readFileSync)

beforeEach(() => vi.clearAllMocks())

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildTransitiveGraph', () => {
  it('returns an empty object when no lockfile is present', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    expect(buildTransitiveGraph('/fake', ['express'])).toEqual({})
  })

  it('returns an empty object for a v1 lockfile (no packages field)', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ lockfileVersion: 1, dependencies: {} }),
    )
    expect(buildTransitiveGraph('/fake', ['express'])).toEqual({})
  })

  it('builds a single-level tree for a dep with no children', () => {
    mockReadFileSync.mockReturnValue(
      makeLockfile({ zod: { version: '3.22.0' } }),
    )
    const graph = buildTransitiveGraph('/fake', ['zod'])
    expect(graph['zod']).toEqual({ name: 'zod', version: '3.22.0', children: [] })
  })

  it('builds a two-level tree correctly', () => {
    mockReadFileSync.mockReturnValue(
      makeLockfile({
        express: { version: '4.18.2', dependencies: { 'body-parser': '*' } },
        'body-parser': { version: '1.20.2' },
      }),
    )
    const graph = buildTransitiveGraph('/fake', ['express'])
    expect(graph['express']?.children).toHaveLength(1)
    expect(graph['express']?.children[0]).toMatchObject({
      name: 'body-parser',
      version: '1.20.2',
      children: [],
    })
  })

  it('only includes requested direct deps as root nodes', () => {
    mockReadFileSync.mockReturnValue(
      makeLockfile({
        express:  { version: '4.18.2' },
        vitest:   { version: '2.1.9' },
      }),
    )
    const graph = buildTransitiveGraph('/fake', ['express'])
    expect(Object.keys(graph)).toEqual(['express'])
    expect(graph['vitest']).toBeUndefined()
  })

  it('skips root nodes not present in the lockfile', () => {
    mockReadFileSync.mockReturnValue(makeLockfile({ zod: { version: '3.22.0' } }))
    const graph = buildTransitiveGraph('/fake', ['zod', 'missing-pkg'])
    expect(Object.keys(graph)).toEqual(['zod'])
  })

  it('prevents infinite loops caused by circular dependencies', () => {
    // a → b → a (cycle)
    mockReadFileSync.mockReturnValue(
      makeLockfile({
        a: { version: '1.0.0', dependencies: { b: '*' } },
        b: { version: '1.0.0', dependencies: { a: '*' } },
      }),
    )
    // Should not throw and should stop recursing on `a` when revisited
    const graph = buildTransitiveGraph('/fake', ['a'])
    expect(graph['a']).toBeDefined()
    const bNode = graph['a']?.children.find((c) => c.name === 'b')
    expect(bNode).toBeDefined()
    // `a` inside `b`'s children should have no children (cycle cut)
    const aAgain = bNode?.children.find((c) => c.name === 'a')
    expect(aAgain?.children).toEqual([])
  })

  it('respects maxDepth and stops recursing', () => {
    // chain: a → b → c → d → e
    mockReadFileSync.mockReturnValue(
      makeLockfile({
        a: { version: '1.0.0', dependencies: { b: '*' } },
        b: { version: '1.0.0', dependencies: { c: '*' } },
        c: { version: '1.0.0', dependencies: { d: '*' } },
        d: { version: '1.0.0', dependencies: { e: '*' } },
        e: { version: '1.0.0' },
      }),
    )
    // maxDepth=2: a(0) → b(1) → c(2) stops — c has no children rendered
    const graph = buildTransitiveGraph('/fake', ['a'], 2)
    const b = graph['a']?.children[0]
    const c = b?.children[0]
    expect(c?.children).toEqual([])
  })

  it('handles multiple direct deps independently', () => {
    mockReadFileSync.mockReturnValue(
      makeLockfile({
        react: { version: '18.2.0', dependencies: { 'loose-envify': '*' } },
        'loose-envify': { version: '1.4.0' },
        zod: { version: '3.22.0' },
      }),
    )
    const graph = buildTransitiveGraph('/fake', ['react', 'zod'])
    expect(graph['react']?.children).toHaveLength(1)
    expect(graph['zod']?.children).toHaveLength(0)
  })
})

// ─── yarn.lock tests ──────────────────────────────────────────────────────────

function makeYarnLock(
  pkgs: Record<string, { version: string; dependencies?: Record<string, string> }>,
): string {
  let out = '# yarn lockfile v1\n\n'
  for (const [name, info] of Object.entries(pkgs)) {
    out += `${name}@*:\n`
    out += `  version "${info.version}"\n`
    if (info.dependencies && Object.keys(info.dependencies).length > 0) {
      out += `  dependencies:\n`
      for (const dep of Object.keys(info.dependencies)) {
        out += `    ${dep} "*"\n`
      }
    }
    out += '\n'
  }
  return out
}

describe('buildTransitiveGraph — yarn.lock', () => {
  it('falls back to yarn.lock when no package-lock.json', () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (String(path).endsWith('package-lock.json')) throw new Error('ENOENT')
      if (String(path).endsWith('yarn.lock')) return makeYarnLock({ react: { version: '18.2.0' } })
      throw new Error('ENOENT')
    })
    const graph = buildTransitiveGraph('/fake', ['react'])
    expect(graph['react']).toMatchObject({ name: 'react', version: '18.2.0', children: [] })
  })

  it('parses transitive deps from yarn.lock', () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (String(path).endsWith('package-lock.json')) throw new Error('ENOENT')
      if (String(path).endsWith('yarn.lock')) return makeYarnLock({
        express:      { version: '4.18.2', dependencies: { 'body-parser': '*' } },
        'body-parser': { version: '1.20.2' },
      })
      throw new Error('ENOENT')
    })
    const graph = buildTransitiveGraph('/fake', ['express'])
    expect(graph['express']?.children).toHaveLength(1)
    expect(graph['express']?.children[0]).toMatchObject({ name: 'body-parser', version: '1.20.2' })
  })

  it('ignores yarn Berry lockfiles (has __metadata)', () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (String(path).endsWith('package-lock.json')) throw new Error('ENOENT')
      if (String(path).endsWith('yarn.lock')) return '__metadata:\n  version: 6\n'
      throw new Error('ENOENT')
    })
    expect(buildTransitiveGraph('/fake', ['react'])).toEqual({})
  })

  it('handles scoped packages in yarn.lock', () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (String(path).endsWith('package-lock.json')) throw new Error('ENOENT')
      if (String(path).endsWith('yarn.lock')) return makeYarnLock({
        '@babel/core': { version: '7.24.0' },
      })
      throw new Error('ENOENT')
    })
    const graph = buildTransitiveGraph('/fake', ['@babel/core'])
    expect(graph['@babel/core']).toMatchObject({ name: '@babel/core', version: '7.24.0' })
  })
})
