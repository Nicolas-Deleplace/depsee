import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openSync } from 'node:fs'
import { analyze } from './analyzer.js'
import { startServer } from './server.js'
import { renderHTML } from './renderer.js'

// ─── Global safety net ────────────────────────────────────────────────────────
// Prevent any unexpected error or rejected promise from killing the server.
// In --serve mode this is critical: a single request error must never take
// down the whole process.
process.on('uncaughtException', (err) => {
  console.error('  depsee  uncaught exception (server kept alive):', err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('  depsee  unhandled rejection (server kept alive):', reason)
})

// ─── Parse CLI args ───────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    serve:      { type: 'boolean', default: false },
    output:     { type: 'string',  default: 'depsee-report.html' },
    format:     { type: 'string',  default: 'html' },
    only:       { type: 'string' },
    ci:         { type: 'boolean', default: false },
    'min-score':{ type: 'string',  default: '60' },
    ignore:     { type: 'string',  default: '' },
    'no-audit': { type: 'boolean', default: false },
    port:       { type: 'string',  default: '4242' },
    debug:      { type: 'boolean', default: false },
    help:       { type: 'boolean', default: false },
    version:    { type: 'boolean', default: false },
  },
  allowPositionals: true,
  strict: false,
})

// ─── Help / version ───────────────────────────────────────────────────────────

if (values.version) {
  console.log('depsee v0.1.0')
  process.exit(0)
}

if (values.help) {
  console.log(`
depsee — See your dependencies like never before.

Usage:
  npx depsee [options]

Options:
  --serve            Launch interactive UI on localhost (default port 4242)
  --output <path>    Output file path (default: depsee-report.html)
  --format <fmt>     Output format: html | json (default: html)
  --only <type>      Filter: deps | devDeps
  --ci               CI mode: exit 1 if global score < --min-score
  --min-score <n>    Minimum score threshold for CI mode (default: 60)
  --ignore <pkgs>    Comma-separated list of packages to ignore
  --no-audit         Skip security audit
  --port <n>         Port for --serve mode (default: 4242)
  --help             Show this help
  --version          Show version
`)
  process.exit(0)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const cwd      = process.cwd()
const port     = parseInt(String(values.port ?? '4242'), 10)
const minScore = parseInt(String(values['min-score'] ?? '60'), 10)
const ignore   = String(values.ignore ?? '').split(',').filter(Boolean)
const format   = String(values.format ?? 'html') as 'html' | 'json'
const output   = String(values.output ?? 'depsee-report.html')
const noAudit  = Boolean(values['no-audit'])
const debug    = Boolean(values.debug)
const only     = values.only as 'deps' | 'devDeps' | undefined

async function run(): Promise<void> {
  // ── --serve mode ────────────────────────────────────────────────────────────
  if (values.serve) {
    console.log(`\n  depsee  Analysing project…\n`)

    await startServer({
      port,
      cwd,
      reanalyze: () =>
        analyze({
          cwd,
          includeDevDeps: only !== 'deps',
          audit: !noAudit,
          ignore,
          debug,
        }),
    })

    const url = `http://localhost:${port}`
    console.log(`  ✓  depsee running at ${url}\n`)

    // Try to open the browser
    try {
      const { execSync } = await import('node:child_process')
      const openCmd =
        process.platform === 'darwin' ? `open ${url}` :
        process.platform === 'win32'  ? `start ${url}` :
        `xdg-open ${url}`
      execSync(openCmd, { stdio: 'ignore' })
    } catch { /* browser open is best-effort */ }

    // Keep the process alive
    await new Promise(() => {})
    return
  }

  // ── Report mode ─────────────────────────────────────────────────────────────
  // In JSON mode all progress/summary messages go to stderr so stdout stays
  // pure JSON — useful for piping and programmatic usage.
  const log = (msg: string) => process.stderr.write(msg)

  log('\n  depsee  Analysing project')
  const interval = setInterval(() => log('.'), 400)

  let report
  try {
    report = await analyze({
      cwd,
      includeDevDeps: only !== 'deps',
      audit: !noAudit,
      ignore,
      debug: Boolean(values.debug),
    })
  } finally {
    clearInterval(interval)
    log('\n\n')
  }

  const { summary } = report

  // Print summary to stderr
  log(`  Project     ${summary.projectName}\n`)
  log(`  Packages    ${summary.total}\n`)
  log(`  Score       ${summary.score}/100\n`)
  log(`  Vulnerable  ${summary.vulnerable}\n`)
  log(`  PM          ${summary.packageManager}\n`)
  log('\n')

  // Write output
  if (format === 'json') {
    // Emit pure JSON on stdout for easy piping / programmatic use
    process.stdout.write(JSON.stringify({ summary, packages: report.packages }, null, 2) + '\n')
  } else {
    await report.toHTML(output)
    log(`  ✓  Report saved to ${output}\n\n`)

    // Try to open the report in the browser
    try {
      const { execSync } = await import('node:child_process')
      const filePath = join(cwd, output)
      const openCmd =
        process.platform === 'darwin' ? `open "${filePath}"` :
        process.platform === 'win32'  ? `start "" "${filePath}"` :
        `xdg-open "${filePath}"`
      execSync(openCmd, { stdio: 'ignore' })
    } catch { /* best-effort */ }
  }

  // ── CI mode ─────────────────────────────────────────────────────────────────
  if (values.ci && summary.score < minScore) {
    process.stderr.write(`  ✗  Score ${summary.score} is below the minimum threshold of ${minScore}.\n\n`)
    process.exit(1)
  }
}

run().catch((err) => {
  console.error('\n  depsee error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
