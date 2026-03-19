// ─── Package managers ─────────────────────────────────────────────────────────

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

// ─── Dependency status ────────────────────────────────────────────────────────

/** Overall health status of a dependency. */
export type DepStatus = 'healthy' | 'stale' | 'outdated' | 'abandoned' | 'vulnerable'

/** Whether a dependency is a runtime, dev, or transitive dependency. */
export type DepType = 'dependency' | 'devDependency' | 'transitive'

// ─── Security ────────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'info'

export interface Vulnerability {
  /** CVE or GHSA identifier */
  id: string
  title: string
  severity: Severity
  /** Link to advisory */
  url: string
  fixAvailable: boolean
  fixedIn?: string
}

// ─── Dependency info ──────────────────────────────────────────────────────────

export interface DepInfo {
  name: string
  type: DepType
  /** Version range declared in package.json (e.g. "^18.2.0") */
  wanted: string
  /** Resolved installed version (e.g. "18.2.0") */
  installed: string
  /** Latest available version on the registry */
  latest: string
  /** ISO date of the installed version's release */
  installedAt: string
  /** ISO date of the latest version's release */
  latestAt: string
  /** Number of days between installedAt and latestAt */
  gapDays: number
  /** Number of versions published between installed and latest */
  missedVersions: number
  /** Average number of releases per year */
  publishFrequency: number
  /** Composite health score 0–100 */
  score: number
  status: DepStatus
  vulnerabilities: Vulnerability[]
}

// ─── Report summary ───────────────────────────────────────────────────────────

export interface ReportSummary {
  projectName: string
  total: number
  healthy: number
  stale: number
  outdated: number
  abandoned: number
  /** Number of packages with at least one vulnerability */
  vulnerable: number
  /** Global health score 0–100 (average of all package scores) */
  score: number
  packageManager: PackageManager
  generatedAt: string
}

// ─── Transitive dependency graph ──────────────────────────────────────────────

/**
 * A node in the transitive dependency tree.
 * Each direct dependency is a root node; its children are the packages it
 * pulls in, recursively up to a configurable depth.
 */
export interface DepNode {
  name: string
  version: string
  children: DepNode[]
}

/** Maps each direct dependency name to its resolved dependency subtree. */
export type TransitiveGraph = Record<string, DepNode>

// ─── Analysis report ──────────────────────────────────────────────────────────

export interface AnalysisReport {
  summary: ReportSummary
  packages: DepInfo[]
  /** Transitive dependency tree built from the lockfile. */
  transitiveGraph: TransitiveGraph
  /** Write an interactive HTML report to disk */
  toHTML(outputPath?: string): Promise<void>
  /** Write the raw data as JSON to disk */
  toJSON(outputPath?: string): Promise<void>
}

// ─── Analyze options ──────────────────────────────────────────────────────────

export interface AnalyzeOptions {
  /** Project root directory. Defaults to process.cwd(). */
  cwd?: string
  /** Include devDependencies. Defaults to true. */
  includeDevDeps?: boolean
  /** Run npm audit for security vulnerabilities. Defaults to true. */
  audit?: boolean
  /** Package names to ignore. */
  ignore?: string[]
  /** Print debug info to stdout. */
  debug?: boolean
}

// ─── CLI options ──────────────────────────────────────────────────────────────

export interface CliOptions {
  serve: boolean
  output: string
  format: 'html' | 'json'
  only?: 'deps' | 'devDeps'
  ci: boolean
  minScore: number
  ignore: string[]
  noAudit: boolean
  port: number
}
