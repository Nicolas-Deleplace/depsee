import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderHTML } from './renderer.js'
import type { AnalysisReport } from './types.js'

// ─── Active process registry ──────────────────────────────────────────────────
// At most one command runs at a time; stored here so /cancel can kill it.
let activeProc: ChildProcess | null = null

// ─── Streaming process runner ─────────────────────────────────────────────────
// Writes NDJSON to `res` as the process runs, then resolves with exit status.
// Each line: { type: 'line', text: string, err?: boolean }
// Final line: { type: 'done', ok: boolean, cancelled?: boolean }

function streamSpawn(
  bin: string,
  args: string[],
  cwd: string,
  res: ServerResponse,
): Promise<boolean> {
  return new Promise((resolve) => {
    const write = (obj: object) => {
      if (!res.destroyed && !res.writableEnded) {
        try { res.write(JSON.stringify(obj) + '\n') } catch { /* socket closed */ }
      }
    }

    // detached: true creates a new process group so we can kill the whole tree
    const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    activeProc = proc

    const onData = (isErr: boolean) => (chunk: Buffer) => {
      chunk.toString().split('\n').forEach((line) => {
        if (line.trim()) write({ type: 'line', text: line, err: isErr })
      })
    }

    proc.stdout.on('data', onData(false))
    proc.stderr.on('data', onData(true))

    proc.on('close', (code, signal) => {
      activeProc = null
      const cancelled = signal === 'SIGTERM' || signal === 'SIGKILL'
      const ok = code === 0 && !cancelled
      write({ type: 'done', ok, cancelled })
      resolve(ok)
    })

    proc.on('error', (err) => {
      activeProc = null
      write({ type: 'line', text: String(err), err: true })
      write({ type: 'done', ok: false })
      resolve(false)
    })
  })
}

// ─── Request helpers ──────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function safeSend(res: ServerResponse, status: number, body: string, contentType = 'text/plain'): void {
  // Guard against writing to a closed/destroyed socket (e.g. browser reloaded mid-request)
  if (res.destroyed || res.writableEnded) return
  try {
    res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
    res.end(body)
  } catch {
    // Socket may have closed between the guard check and the write — silently ignore
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

export interface ServeOptions {
  port?: number
  cwd?: string
  /** Called when a fresh analysis is needed (e.g. after a package update). */
  reanalyze: () => Promise<AnalysisReport>
}

/**
 * Starts a local HTTP server that serves the interactive depsee UI.
 *
 * Routes:
 * - GET  /          → serve interactive HTML report
 * - POST /run       → execute a package manager command (update/remove)
 * - GET  /refresh   → re-run analysis and return updated HTML fragment
 */
export function startServer(options: ServeOptions): Promise<void> {
  const { port = 4242, cwd = process.cwd(), reanalyze } = options

  return new Promise((resolve, reject) => {
    let currentReport: AnalysisReport | null = null

    const server = createServer(async (req, res) => {
      const url = req.url ?? '/'
      const method = req.method ?? 'GET'

      // Silence socket errors that fire when the browser closes the connection
      // mid-request (reload, navigation). Without this listener Node.js would
      // throw an uncaught 'error' EventEmitter exception and crash the process.
      res.on('error', () => {})
      req.on('error', () => {})

      // ── GET / ──────────────────────────────────────────────────────────────
      if (method === 'GET' && url === '/') {
        try {
          // Serve the cached report immediately so the browser gets a response
          // right away, then kick off a fresh analysis in the background.
          if (currentReport) {
            const cached = renderHTML({
              summary: currentReport.summary,
              packages: currentReport.packages,
              transitiveGraph: currentReport.transitiveGraph,
              interactive: true,
              port,
            })
            safeSend(res, 200, cached, 'text/html; charset=utf-8')
            // Re-analyze in the background — update cache for next reload
            reanalyze().then((r) => { currentReport = r }).catch(() => {})
            return
          }

          // First load: no cache yet, must wait for analysis
          currentReport = await reanalyze()
          const html = renderHTML({
            summary: currentReport.summary,
            packages: currentReport.packages,
            transitiveGraph: currentReport.transitiveGraph,
            interactive: true,
            port,
          })
          safeSend(res, 200, html, 'text/html; charset=utf-8')
        } catch (err) {
          safeSend(res, 500, `Analysis failed: ${String(err)}`)
        }
        return
      }

      // ── POST /run ──────────────────────────────────────────────────────────
      if (method === 'POST' && url === '/run') {
        try {
          const body = await readBody(req)
          const { cmd } = JSON.parse(body) as { cmd: string }

          // Safety: only allow install/remove/add commands
          const allowed = /^(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall)\s+/
          if (!allowed.test(cmd)) {
            safeSend(res, 400, JSON.stringify({ ok: false, error: 'Command not allowed' }), 'application/json')
            return
          }

          console.log(`\n  depsee  Running: ${cmd}`)
          const [bin, ...args] = cmd.split(' ') as [string, ...string[]]

          // Stream NDJSON to client in real time
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'Transfer-Encoding': 'chunked' })
          const ok = await streamSpawn(bin, args, cwd, res)
          if (!res.writableEnded) res.end()

          console.log(ok ? `  ✓  Command succeeded\n` : `  ✗  Command failed\n`)
        } catch (err) {
          safeSend(res, 500, JSON.stringify({ type: 'done', ok: false, error: String(err) }), 'application/x-ndjson')
        }
        return
      }

      // ── POST /add-resolution ───────────────────────────────────────────────
      if (method === 'POST' && url === '/add-resolution') {
        try {
          const body = await readBody(req)
          const { packageName, version, pm } = JSON.parse(body) as {
            packageName: string
            version: string
            pm: string
          }

          const pkgPath = join(cwd, 'package.json')
          const raw = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>

          // yarn → resolutions, npm/pnpm/bun → overrides
          const field = pm === 'yarn' ? 'resolutions' : 'overrides'
          const existing = (raw[field] ?? {}) as Record<string, string>
          existing[packageName] = version
          raw[field] = existing

          writeFileSync(pkgPath, JSON.stringify(raw, null, 2) + '\n', 'utf8')

          console.log(`\n  depsee  Added ${field}.${packageName} = "${version}" to package.json`)

          // Stream install output in real time
          const installCmd = pm === 'yarn' ? 'yarn install' : pm === 'pnpm' ? 'pnpm install' : 'npm install --legacy-peer-deps'
          const [bin, ...args] = installCmd.split(' ') as [string, ...string[]]
          console.log(`  depsee  Running: ${installCmd}`)

          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'Transfer-Encoding': 'chunked' })

          const ndjsonWrite = (obj: object) => {
            if (!res.destroyed && !res.writableEnded)
              try { res.write(JSON.stringify(obj) + '\n') } catch { /* closed */ }
          }

          // These lines clear the client spinner right away before the install starts
          ndjsonWrite({ type: 'field', field })
          ndjsonWrite({ type: 'line', text: `✎ package.json → ${field}.${packageName} = "${version}"` })
          ndjsonWrite({ type: 'line', text: `$ ${installCmd}` })

          const ok = await streamSpawn(bin, args, cwd, res)
          if (!res.writableEnded) res.end()

          console.log(ok ? `  ✓  Resolution applied\n` : `  ✗  Install failed after resolution\n`)
        } catch (err) {
          safeSend(res, 500, JSON.stringify({ type: 'done', ok: false, error: String(err) }), 'application/x-ndjson')
        }
        return
      }

      // ── POST /cancel ───────────────────────────────────────────────────────
      if (method === 'POST' && url === '/cancel') {
        if (activeProc && activeProc.pid !== undefined) {
          try {
            // Kill the entire process group (negative PID) to catch all children
            process.kill(-activeProc.pid, 'SIGTERM')
          } catch {
            // Process may already be gone — fall back to direct kill
            try { activeProc.kill('SIGTERM') } catch { /* already dead */ }
          }
          activeProc = null
          console.log('  depsee  Process group cancelled by user\n')
        }
        safeSend(res, 200, JSON.stringify({ ok: true }), 'application/json')
        return
      }

      // ── GET /refresh ───────────────────────────────────────────────────────
      if (method === 'GET' && url === '/refresh') {
        try {
          currentReport = await reanalyze()
          const html = renderHTML({
            summary: currentReport.summary,
            packages: currentReport.packages,
            transitiveGraph: currentReport.transitiveGraph,
            interactive: true,
          })
          safeSend(res, 200, html, 'text/html; charset=utf-8')
        } catch (err) {
          safeSend(res, 500, `Refresh failed: ${String(err)}`)
        }
        return
      }

      safeSend(res, 404, 'Not found')
    })

    // Disable Nagle's algorithm on every new connection so streaming responses
    // (chunked NDJSON) are flushed to the client immediately without waiting
    // for the TCP buffer to fill up.
    server.on('connection', (socket) => { socket.setNoDelay(true) })

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Try --port <number>.`))
      } else {
        reject(err)
      }
    })

    server.listen(port, '127.0.0.1', () => {
      resolve()
    })
  })
}
