import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { AnalysisReport, AnalyzeOptions, DepInfo, DepNode, DepType, TransitiveGraph } from './types.js'
import { detectPackageManager } from './detector.js'
import {
  fetchPackagesBatch,
  getReleaseDate,
  getLatestVersion,
  countMissedVersions,
  getPublishFrequency,
} from './registry.js'
import { runAudit } from './auditor.js'
import { computeScore, computeGlobalScore, deriveStatus } from './scorer.js'
import { renderHTML } from './renderer.js'

// ─── package.json schema ──────────────────────────────────────────────────────

const PackageJsonSchema = z.object({
  name: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
})

// ─── Helper: parse installed version ─────────────────────────────────────────

/** Strips semver range prefixes (^, ~, >=, etc.) to get a plain version. */
function parseVersion(range: string): string {
  return range.replace(/^[\^~>=<]+/, '').trim()
}

/** Computes the gap in days between two ISO date strings. */
function daysBetween(from: string, to: string): number {
  const diff = new Date(to).getTime() - new Date(from).getTime()
  return Math.max(0, Math.round(diff / (1000 * 60 * 60 * 24)))
}

// ─── Transitive graph builder ─────────────────────────────────────────────────

/**
 * Parses `package-lock.json` (v2/v3) and builds a recursive dependency tree
 * for each direct dependency, up to `maxDepth` levels deep.
 *
 * Returns an empty object when no lockfile is found or the format is unsupported.
 */
export function buildTransitiveGraph(
  cwd: string,
  directDeps: string[],
  maxDepth = 4,
): TransitiveGraph {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'))
  } catch {
    return {}
  }

  // Only v2/v3 lockfiles have the `packages` field
  const packages = raw['packages'] as Record<string, { version?: string; dependencies?: Record<string, string> }> | undefined
  if (!packages) return {}

  // Build a flat adjacency map: package-name → { version, direct-child-names }
  type AdjEntry = { version: string; deps: string[] }
  const adj = new Map<string, AdjEntry>()

  for (const [key, info] of Object.entries(packages)) {
    if (key === '') continue // root entry

    // key is like "node_modules/foo" or "node_modules/@scope/bar"
    const name = key.replace(/^node_modules\//, '')
    adj.set(name, {
      version: info.version ?? 'unknown',
      deps: Object.keys(info.dependencies ?? {}),
    })
  }

  // Recursive builder (visited set prevents cycles)
  function buildNode(name: string, visited: ReadonlySet<string>, depth: number): DepNode {
    const info = adj.get(name)
    const version = info?.version ?? 'unknown'

    if (!info || depth >= maxDepth || visited.has(name)) {
      return { name, version, children: [] }
    }

    const next = new Set(visited)
    next.add(name)

    return {
      name,
      version,
      children: info.deps
        .filter((d) => d !== name)
        .map((d) => buildNode(d, next, depth + 1)),
    }
  }

  const graph: TransitiveGraph = {}
  for (const dep of directDeps) {
    if (!adj.has(dep)) continue
    graph[dep] = buildNode(dep, new Set(), 0)
  }
  return graph
}

// ─── Main analyze function ────────────────────────────────────────────────────

/**
 * Analyses all dependencies in a project and returns a full report.
 *
 * @example
 * ```ts
 * const report = await analyze({ cwd: process.cwd() })
 * await report.toHTML('./depsee-report.html')
 * ```
 */
export async function analyze(options: AnalyzeOptions = {}): Promise<AnalysisReport> {
  const {
    cwd = process.cwd(),
    includeDevDeps = true,
    audit = true,
    ignore = [],
    debug = false,
  } = options

  // 1. Read package.json
  const rawPkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  const pkg = PackageJsonSchema.parse(rawPkg)
  const projectName = pkg.name ?? 'unknown'

  // 2. Detect package manager
  const pm = detectPackageManager(cwd)

  // 3. Collect all dependencies to analyse
  const depsMap = new Map<string, { wanted: string; type: DepType }>()

  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (!ignore.includes(name)) {
      depsMap.set(name, { wanted: version, type: 'dependency' })
    }
  }

  if (includeDevDeps) {
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
      if (!ignore.includes(name)) {
        depsMap.set(name, { wanted: version, type: 'devDependency' })
      }
    }
  }

  const packageNames = Array.from(depsMap.keys())

  // 4. Fetch registry data + run audit in parallel
  const [registryData, auditResults] = await Promise.all([
    fetchPackagesBatch(packageNames),
    audit ? runAudit(cwd, pm, debug) : Promise.resolve(new Map()),
  ])

  if (debug) {
    console.log(`\n[depsee debug] auditResults: ${auditResults.size} vulnerable packages`)
    for (const [k, v] of auditResults) {
      console.log(`  → ${k}: ${v.map((x: { severity: string }) => x.severity).join(', ')}`)
    }
    console.log(`[depsee debug] registryData: ${registryData.size}/${packageNames.length} packages fetched`)
  }

  // 5. Build DepInfo for each package
  const packages: DepInfo[] = []

  for (const [name, { wanted, type }] of depsMap) {
    const data = registryData.get(name)
    if (!data) {
      if (debug) console.log(`[depsee debug] Skipping ${name} — no registry data`)
      continue
    }

    const installed       = parseVersion(wanted)
    const latest          = getLatestVersion(data)
    const installedAt     = getReleaseDate(data, installed) ?? new Date(0).toISOString()
    const latestAt        = getReleaseDate(data, latest)    ?? new Date().toISOString()
    const gapDays         = daysBetween(installedAt, latestAt)
    const missedVersions  = countMissedVersions(data, installed, latest)
    const publishFrequency = getPublishFrequency(data)
    const vulnerabilities = auditResults.get(name) ?? []

    const score  = computeScore({ installedAt, gapDays, missedVersions, publishFrequency, vulnerabilities })
    const status = deriveStatus(score, gapDays, publishFrequency, vulnerabilities)

    packages.push({
      name,
      type,
      wanted,
      installed,
      latest,
      installedAt,
      latestAt,
      gapDays,
      missedVersions,
      publishFrequency,
      score,
      status,
      vulnerabilities,
    })
  }

  // 5b. Add transitive vulnerable packages not already in direct deps
  const directNames = new Set(depsMap.keys())
  const transitiveNames = [...auditResults.keys()].filter((n) => !directNames.has(n))

  if (transitiveNames.length > 0) {
    const transitiveData = await fetchPackagesBatch(transitiveNames)

    for (const name of transitiveNames) {
      const vulnerabilities = auditResults.get(name) ?? []
      if (vulnerabilities.length === 0) continue

      const data = transitiveData.get(name)
      const installed       = data ? getLatestVersion(data) : 'unknown'
      const latest          = installed
      const installedAt     = data ? (getReleaseDate(data, installed) ?? new Date(0).toISOString()) : new Date(0).toISOString()
      const latestAt        = installedAt
      const gapDays         = 0
      const missedVersions  = 0
      const publishFrequency = data ? getPublishFrequency(data) : 0

      const score  = computeScore({ installedAt, gapDays, missedVersions, publishFrequency, vulnerabilities })
      const status = deriveStatus(score, gapDays, publishFrequency, vulnerabilities)

      packages.push({
        name,
        type: 'transitive',
        wanted: installed,
        installed,
        latest,
        installedAt,
        latestAt,
        gapDays,
        missedVersions,
        publishFrequency,
        score,
        status,
        vulnerabilities,
      })
    }
  }

  // Sort: worst score first
  packages.sort((a, b) => a.score - b.score)

  // 6. Build transitive graph from lockfile
  const directDepNames = [...depsMap.keys()]
  const transitiveGraph = buildTransitiveGraph(cwd, directDepNames)

  // 7. Compute summary
  const summary = {
    projectName,
    total:      packages.length,
    healthy:    packages.filter((p) => p.status === 'healthy').length,
    stale:      packages.filter((p) => p.status === 'stale').length,
    outdated:   packages.filter((p) => p.status === 'outdated').length,
    abandoned:  packages.filter((p) => p.status === 'abandoned').length,
    vulnerable: packages.filter((p) => p.vulnerabilities.length > 0).length,
    score:      computeGlobalScore(packages.map((p) => p.score)),
    packageManager: pm,
    generatedAt: new Date().toISOString(),
  }

  // 7. Return report object
  return {
    summary,
    packages,
    transitiveGraph,
    async toHTML(outputPath = 'depsee-report.html') {
      const html = renderHTML({ summary, packages, transitiveGraph })
      await writeFile(join(cwd, outputPath), html, 'utf8')
    },
    async toJSON(outputPath = 'depsee-report.json') {
      const json = JSON.stringify({ summary, packages, transitiveGraph }, null, 2)
      await writeFile(join(cwd, outputPath), json, 'utf8')
    },
  }
}
