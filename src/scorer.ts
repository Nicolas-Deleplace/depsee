import type { DepStatus, Vulnerability } from './types.js'
import { SEVERITY_ORDER } from './auditor.js'

// ─── Score weights ────────────────────────────────────────────────────────────

const WEIGHTS = {
  age: 0.30,         // age of installed version
  staleness: 0.30,   // gap vs latest (days)
  missed: 0.20,      // number of missed versions
  frequency: 0.20,   // publish frequency (active vs abandoned)
} as const

// ─── Individual signal scores (0–100, higher = healthier) ─────────────────────

/** Score based on how old the installed version is. */
function ageScore(installedAt: string): number {
  const ageMs  = Date.now() - new Date(installedAt).getTime()
  const ageDays = ageMs / (1000 * 60 * 60 * 24)

  if (ageDays < 90)  return 100
  if (ageDays < 180) return 90
  if (ageDays < 365) return 75
  if (ageDays < 730) return 50
  if (ageDays < 1095) return 25
  return 10
}

/** Score based on how far behind latest the installed version is. */
function stalenessScore(gapDays: number): number {
  if (gapDays <= 0)   return 100
  if (gapDays < 30)   return 95
  if (gapDays < 90)   return 85
  if (gapDays < 180)  return 70
  if (gapDays < 365)  return 50
  if (gapDays < 730)  return 25
  return 10
}

/** Score based on how many versions have been missed. */
function missedVersionsScore(missed: number): number {
  if (missed === 0)  return 100
  if (missed <= 2)   return 90
  if (missed <= 5)   return 75
  if (missed <= 10)  return 55
  if (missed <= 20)  return 35
  return 15
}

/**
 * Score based on publish frequency.
 * Very active (>12/yr) and completely abandoned (<0.5/yr) are both penalized;
 * steady activity is rewarded.
 */
function frequencyScore(releasesPerYear: number): number {
  if (releasesPerYear === 0)     return 20  // never updated
  if (releasesPerYear < 0.5)     return 30  // < 1 release per 2 years
  if (releasesPerYear < 1)       return 55
  if (releasesPerYear < 4)       return 85
  if (releasesPerYear <= 24)     return 100
  return 85 // very high churn
}

// ─── Security cap ─────────────────────────────────────────────────────────────

/** Cap the final score when critical/high vulnerabilities are present. */
function applySeverityCap(score: number, vulns: Vulnerability[]): number {
  if (vulns.length === 0) return score

  const maxSeverity = Math.max(...vulns.map((v) => SEVERITY_ORDER[v.severity]))

  if (maxSeverity >= SEVERITY_ORDER.critical) return Math.min(score, 20)
  if (maxSeverity >= SEVERITY_ORDER.high)     return Math.min(score, 35)
  if (maxSeverity >= SEVERITY_ORDER.moderate) return Math.min(score, 60)
  return score
}

// ─── Status derivation ────────────────────────────────────────────────────────

export function deriveStatus(
  score: number,
  gapDays: number,
  publishFrequency: number,
  vulnerabilities: Vulnerability[] = [],
): DepStatus {
  if (publishFrequency < 0.5 && gapDays > 365) return 'abandoned'
  if (vulnerabilities.length > 0) return 'vulnerable'
  if (score >= 75) return 'healthy'
  if (score >= 45) return 'stale'
  return 'outdated'
}

// ─── Main scorer ──────────────────────────────────────────────────────────────

export interface ScoreInput {
  installedAt: string
  gapDays: number
  missedVersions: number
  publishFrequency: number
  vulnerabilities: Vulnerability[]
}

/**
 * Computes a composite health score (0–100) for a dependency.
 * Higher is healthier.
 */
export function computeScore(input: ScoreInput): number {
  const raw =
    ageScore(input.installedAt)            * WEIGHTS.age +
    stalenessScore(input.gapDays)          * WEIGHTS.staleness +
    missedVersionsScore(input.missedVersions) * WEIGHTS.missed +
    frequencyScore(input.publishFrequency) * WEIGHTS.frequency

  const capped = applySeverityCap(raw, input.vulnerabilities)
  return Math.round(capped)
}

/** Computes a global score from all package scores. */
export function computeGlobalScore(scores: number[]): number {
  if (scores.length === 0) return 100
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length
  return Math.round(avg)
}
