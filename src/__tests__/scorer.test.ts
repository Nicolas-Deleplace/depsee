import { describe, it, expect } from 'vitest'
import { computeScore, deriveStatus, computeGlobalScore } from '../scorer.js'
import type { Vulnerability } from '../types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString()
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

const vuln = (severity: Vulnerability['severity']): Vulnerability => ({
  id: 'CVE-TEST',
  title: 'Test vuln',
  severity,
  url: 'https://example.com',
  fixAvailable: true,
})

// ─── computeScore ─────────────────────────────────────────────────────────────

describe('computeScore', () => {
  it('returns a high score for a perfectly fresh package', () => {
    const score = computeScore({
      installedAt: daysAgo(30),
      gapDays: 0,
      missedVersions: 0,
      publishFrequency: 6,
      vulnerabilities: [],
    })
    expect(score).toBeGreaterThanOrEqual(90)
  })

  it('returns a low score for a very stale package', () => {
    const score = computeScore({
      installedAt: daysAgo(1500),
      gapDays: 730,
      missedVersions: 25,
      publishFrequency: 0.2,
      vulnerabilities: [],
    })
    expect(score).toBeLessThan(40)
  })

  it('caps score at 20 when a critical vulnerability is present', () => {
    const score = computeScore({
      installedAt: daysAgo(10),
      gapDays: 0,
      missedVersions: 0,
      publishFrequency: 12,
      vulnerabilities: [vuln('critical')],
    })
    expect(score).toBeLessThanOrEqual(20)
  })

  it('caps score at 35 when a high vulnerability is present', () => {
    const score = computeScore({
      installedAt: daysAgo(10),
      gapDays: 0,
      missedVersions: 0,
      publishFrequency: 12,
      vulnerabilities: [vuln('high')],
    })
    expect(score).toBeLessThanOrEqual(35)
  })

  it('caps score at 60 for moderate vulnerabilities', () => {
    const score = computeScore({
      installedAt: daysAgo(10),
      gapDays: 0,
      missedVersions: 0,
      publishFrequency: 12,
      vulnerabilities: [vuln('moderate')],
    })
    expect(score).toBeLessThanOrEqual(60)
  })

  it('does not cap score for low / info vulnerabilities', () => {
    const score = computeScore({
      installedAt: daysAgo(10),
      gapDays: 0,
      missedVersions: 0,
      publishFrequency: 12,
      vulnerabilities: [vuln('low')],
    })
    expect(score).toBeGreaterThan(60)
  })

  it('uses the worst severity when multiple vulns are present', () => {
    const score = computeScore({
      installedAt: daysAgo(10),
      gapDays: 0,
      missedVersions: 0,
      publishFrequency: 12,
      vulnerabilities: [vuln('low'), vuln('critical'), vuln('moderate')],
    })
    expect(score).toBeLessThanOrEqual(20)
  })

  it('returns an integer', () => {
    const score = computeScore({
      installedAt: daysAgo(60),
      gapDays: 45,
      missedVersions: 3,
      publishFrequency: 4,
      vulnerabilities: [],
    })
    expect(Number.isInteger(score)).toBe(true)
  })
})

// ─── deriveStatus ─────────────────────────────────────────────────────────────

describe('deriveStatus', () => {
  it('returns "healthy" for a high-score, up-to-date, vuln-free package', () => {
    expect(deriveStatus(90, 0, 6, [])).toBe('healthy')
  })

  it('returns "stale" for a mid-range score without vulns', () => {
    expect(deriveStatus(55, 90, 4, [])).toBe('stale')
  })

  it('returns "outdated" for a low score without vulns', () => {
    expect(deriveStatus(30, 400, 2, [])).toBe('outdated')
  })

  it('returns "abandoned" when frequency < 0.5 and gap > 365 days', () => {
    expect(deriveStatus(40, 400, 0.3, [])).toBe('abandoned')
  })

  it('returns "vulnerable" when vulns are present regardless of score', () => {
    // Even a perfect score package should be "vulnerable" if it has CVEs
    expect(deriveStatus(98, 0, 12, [vuln('low')])).toBe('vulnerable')
    expect(deriveStatus(98, 0, 12, [vuln('critical')])).toBe('vulnerable')
  })

  it('prioritises "abandoned" over "vulnerable" for abandoned packages with vulns', () => {
    // An abandoned package with vulns should be marked abandoned
    expect(deriveStatus(20, 400, 0.2, [vuln('high')])).toBe('abandoned')
  })
})

// ─── computeGlobalScore ───────────────────────────────────────────────────────

describe('computeGlobalScore', () => {
  it('returns 100 for an empty list', () => {
    expect(computeGlobalScore([])).toBe(100)
  })

  it('returns the average of all scores', () => {
    expect(computeGlobalScore([80, 60, 40])).toBe(60)
  })

  it('rounds to an integer', () => {
    expect(Number.isInteger(computeGlobalScore([75, 80]))).toBe(true)
  })
})
