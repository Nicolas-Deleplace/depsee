import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseNpmAudit, parseYarnAudit } from '../auditor.js'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')

// ─── npm / pnpm audit parser (JSON v2 format) ─────────────────────────────────

describe('parseNpmAudit — npm fixtures', () => {
  const results = parseNpmAudit(fixture('npm-audit.json'))

  it('parses all 3 vulnerable packages', () => {
    expect(results.size).toBe(3)
  })

  it('parses a HIGH vulnerability for lodash', () => {
    const v = results.get('lodash')![0]!
    expect(v.severity).toBe('high')
    expect(v.title).toContain('Prototype Pollution')
    expect(v.url).toContain('GHSA-4xc9')
  })

  it('marks lodash fix as available with version', () => {
    const v = results.get('lodash')![0]!
    expect(v.fixAvailable).toBe(true)
    expect(v.fixedIn).toBe('4.17.21')
  })

  it('parses a CRITICAL vulnerability for minimatch', () => {
    const v = results.get('minimatch')![0]!
    expect(v.severity).toBe('critical')
  })

  it('marks minimatch fix as unavailable', () => {
    const v = results.get('minimatch')![0]!
    expect(v.fixAvailable).toBe(false)
  })

  it('parses a MODERATE vulnerability for qs', () => {
    const v = results.get('qs')![0]!
    expect(v.severity).toBe('moderate')
  })

  it('returns an empty Map for empty input', () => {
    const empty = parseNpmAudit(JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }))
    expect(empty.size).toBe(0)
  })

  it('returns an empty Map for invalid JSON', () => {
    // Should not throw — just return empty
    expect(() => parseNpmAudit('not json')).toThrow()
  })
})

describe('parseNpmAudit — pnpm fixtures (same JSON v2 format)', () => {
  const results = parseNpmAudit(fixture('pnpm-audit.json'))

  it('parses 2 vulnerable packages', () => {
    expect(results.size).toBe(2)
  })

  it('parses HIGH for lodash and LOW for elliptic', () => {
    expect(results.get('lodash')![0]!.severity).toBe('high')
    expect(results.get('elliptic')![0]!.severity).toBe('low')
  })
})

// ─── yarn audit parser (NDJSON v1 format) ────────────────────────────────────

describe('parseYarnAudit — yarn v1 NDJSON fixtures', () => {
  const results = parseYarnAudit(fixture('yarn-audit.ndjson'))

  it('parses 3 distinct vulnerable packages', () => {
    expect(results.size).toBe(3)
  })

  it('parses HIGH for lodash', () => {
    const v = results.get('lodash')![0]!
    expect(v.severity).toBe('high')
    expect(v.fixAvailable).toBe(true)
    expect(v.fixedIn).toBe('>=4.17.21')
  })

  it('parses CRITICAL for minimatch', () => {
    const v = results.get('minimatch')![0]!
    expect(v.severity).toBe('critical')
    // patched_versions = "<0.0.0" means no fix available
    expect(v.fixAvailable).toBe(false)
  })

  it('deduplicates advisories with the same id across multiple resolution paths', () => {
    // minimatch appears twice in NDJSON (two resolution paths, same advisory id)
    expect(results.get('minimatch')!.length).toBe(1)
  })

  it('parses LOW for qs', () => {
    const v = results.get('qs')![0]!
    expect(v.severity).toBe('low')
  })

  it('ignores non-auditAdvisory lines like auditSummary', () => {
    // Total packages should still be 3 — auditSummary line must be skipped
    expect(results.size).toBe(3)
  })

  it('returns empty Map for empty input', () => {
    expect(parseYarnAudit('').size).toBe(0)
  })

  it('skips malformed JSON lines without throwing', () => {
    const malformed = '{"type":"auditAdvisory"}\nnot-json\n{"type":"auditSummary","data":{}}'
    expect(() => parseYarnAudit(malformed)).not.toThrow()
  })
})

// ─── SEVERITY_ORDER / getHighestSeverity ─────────────────────────────────────

import { SEVERITY_ORDER, getHighestSeverity } from '../auditor.js'

describe('SEVERITY_ORDER', () => {
  it('critical > high > moderate > low > info', () => {
    expect(SEVERITY_ORDER.critical).toBeGreaterThan(SEVERITY_ORDER.high)
    expect(SEVERITY_ORDER.high).toBeGreaterThan(SEVERITY_ORDER.moderate)
    expect(SEVERITY_ORDER.moderate).toBeGreaterThan(SEVERITY_ORDER.low)
    expect(SEVERITY_ORDER.low).toBeGreaterThan(SEVERITY_ORDER.info)
  })
})

const mkVuln = (severity: Parameters<typeof getHighestSeverity>[0][number]['severity']) => ({
  id: 'x', title: 'x', severity, url: 'x', fixAvailable: false,
})

describe('getHighestSeverity', () => {
  it('returns the most severe level among a mixed list', () => {
    expect(getHighestSeverity([mkVuln('low'), mkVuln('critical'), mkVuln('moderate')])).toBe('critical')
  })

  it('returns the only severity when there is one', () => {
    expect(getHighestSeverity([mkVuln('moderate')])).toBe('moderate')
  })

  it('returns null for an empty list', () => {
    expect(getHighestSeverity([])).toBeNull()
  })
})
