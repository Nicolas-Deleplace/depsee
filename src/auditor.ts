import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { PackageManager } from './types.js'
import type { Vulnerability } from './types.js'
import { getAuditCommand } from './detector.js'

// ─── npm audit v2 schema (npm 7+) ─────────────────────────────────────────────

const ViaAdvisorySchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  severity: z.enum(['critical', 'high', 'moderate', 'low', 'info']).optional(),
}).passthrough()

const ViaItemSchema = z.union([z.string(), ViaAdvisorySchema])

const NpmAuditVulnSchema = z.object({
  name: z.string(),
  severity: z.enum(['critical', 'high', 'moderate', 'low', 'info']),
  via: z.array(ViaItemSchema).default([]),
  fixAvailable: z
    .union([z.boolean(), z.object({ name: z.string(), version: z.string() }).passthrough()])
    .optional(),
}).passthrough()

const NpmAuditOutputSchema = z.object({
  vulnerabilities: z.record(z.string(), NpmAuditVulnSchema).optional(),
  auditReportVersion: z.number().optional(),
}).passthrough()

// ─── yarn audit v1 schema (NDJSON format) ─────────────────────────────────────

const YarnAdvisoryLineSchema = z.object({
  type: z.literal('auditAdvisory'),
  data: z.object({
    resolution: z.object({
      path: z.string(),
      dev: z.boolean().optional(),
    }),
    advisory: z.object({
      module_name: z.string(),
      severity: z.enum(['critical', 'high', 'moderate', 'low', 'info']),
      title: z.string(),
      url: z.string().optional(),
      patched_versions: z.string().optional(),
      id: z.number().optional(),
    }),
  }),
})

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuditResults = Map<string, Vulnerability[]>

// ─── Parsers ──────────────────────────────────────────────────────────────────

export function parseNpmAudit(stdout: string, debug = false): AuditResults {
  const results: AuditResults = new Map()

  const raw = JSON.parse(stdout)
  const parsed = NpmAuditOutputSchema.safeParse(raw)

  if (!parsed.success || !parsed.data.vulnerabilities) {
    if (debug) console.log('[depsee debug] npm: Zod parse failed or no vulnerabilities field')
    return results
  }

  if (debug) {
    const keys = Object.keys(parsed.data.vulnerabilities)
    console.log(`[depsee debug] npm: ${keys.length} vulnerabilities (${keys.slice(0, 5).join(', ')})`)
  }

  for (const [, vuln] of Object.entries(parsed.data.vulnerabilities)) {
    const advisory = vuln.via.find(
      (v): v is z.infer<typeof ViaAdvisorySchema> => typeof v === 'object',
    )
    const fixAvailable = typeof vuln.fixAvailable === 'boolean'
      ? vuln.fixAvailable
      : vuln.fixAvailable !== undefined
    const fixedIn = typeof vuln.fixAvailable === 'object' && vuln.fixAvailable !== null
      ? vuln.fixAvailable.version
      : undefined

    const vulnerability: Vulnerability = {
      id: vuln.name,
      title: advisory?.title ?? `Vulnerability in ${vuln.name}`,
      severity: vuln.severity,
      url: advisory?.url ?? `https://www.npmjs.com/package/${vuln.name}`,
      fixAvailable,
      ...(fixedIn !== undefined ? { fixedIn } : {}),
    }

    const existing = results.get(vuln.name) ?? []
    existing.push(vulnerability)
    results.set(vuln.name, existing)
  }

  return results
}

export function parseYarnAudit(stdout: string, debug = false): AuditResults {
  const results: AuditResults = new Map()

  // Yarn v1 outputs NDJSON — one JSON object per line
  const lines = stdout.trim().split('\n')
  let count = 0

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const json = JSON.parse(line)
      const parsed = YarnAdvisoryLineSchema.safeParse(json)
      if (!parsed.success) continue

      const { advisory } = parsed.data.data
      const vulnerability: Vulnerability = {
        id: String(advisory.id ?? advisory.module_name),
        title: advisory.title,
        severity: advisory.severity,
        url: advisory.url ?? `https://www.npmjs.com/package/${advisory.module_name}`,
        fixAvailable: advisory.patched_versions !== '<0.0.0',
        ...(advisory.patched_versions ? { fixedIn: advisory.patched_versions } : {}),
      }

      const existing = results.get(advisory.module_name) ?? []
      // Avoid duplicates (same advisory may appear for multiple resolution paths)
      if (!existing.some((v) => v.id === vulnerability.id)) {
        existing.push(vulnerability)
      }
      results.set(advisory.module_name, existing)
      count++
    } catch { /* skip malformed lines */ }
  }

  if (debug) console.log(`[depsee debug] yarn: ${count} advisories parsed`)
  return results
}

// ─── Run audit ────────────────────────────────────────────────────────────────

export function runAudit(cwd: string, pm: PackageManager, debug = false): Promise<AuditResults> {
  return new Promise((resolve) => {
    const empty: AuditResults = new Map()

    try {
      const cmd = getAuditCommand(pm)
      const [bin, ...args] = cmd.split(' ') as [string, ...string[]]

      if (debug) console.log(`\n[depsee debug] Running: ${cmd} in ${cwd}`)

      const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: string[] = []
      const errChunks: string[] = []

      proc.stdout.on('data', (d: Buffer) => chunks.push(d.toString()))
      proc.stderr.on('data', (d: Buffer) => errChunks.push(d.toString()))

      proc.on('close', (code) => {
        const stdout = chunks.join('')
        const stderr = errChunks.join('')

        if (debug) {
          console.log(`[depsee debug] Exit code: ${code}`)
          console.log(`[depsee debug] stdout (first 500): ${stdout.slice(0, 500) || '(empty)'}`)
          console.log(`[depsee debug] stderr (first 300): ${stderr.slice(0, 300) || '(empty)'}`)
        }

        if (!stdout.trim()) { resolve(empty); return }

        // Yarn v1 uses NDJSON; npm/pnpm use standard JSON
        if (pm === 'yarn') {
          resolve(parseYarnAudit(stdout, debug))
        } else {
          resolve(parseNpmAudit(stdout, debug))
        }
      })

      proc.on('error', (err) => {
        if (debug) console.log(`[depsee debug] runAudit spawn error: ${String(err)}`)
        resolve(empty)
      })

    } catch (err) {
      if (debug) console.log(`[depsee debug] runAudit exception: ${String(err)}`)
      resolve(empty)
    }
  })
}

// ─── Severity helpers ─────────────────────────────────────────────────────────

export const SEVERITY_ORDER: Record<Vulnerability['severity'], number> = {
  critical: 5,
  high: 4,
  moderate: 3,
  low: 2,
  info: 1,
}

export function getHighestSeverity(vulns: Vulnerability[]): Vulnerability['severity'] | null {
  if (vulns.length === 0) return null
  return vulns.reduce((max, v) =>
    SEVERITY_ORDER[v.severity] > SEVERITY_ORDER[max.severity] ? v : max,
  ).severity
}
