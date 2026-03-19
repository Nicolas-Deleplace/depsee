import type { DepInfo, ReportSummary } from './types.js'
import { getUpdateCommand, getRemoveCommand, getPackageManagerLabel } from './detector.js'

export interface RenderInput {
  summary: ReportSummary
  packages: DepInfo[]
  /** Enable interactive buttons (used in --serve mode). Defaults to false. */
  interactive?: boolean
  /** Port of the local server, needed for interactive fetch calls. */
  port?: number
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 75) return '#22c55e'  // green-500
  if (score >= 45) return '#f59e0b'  // amber-500
  return '#ef4444'                   // red-500
}

function scoreBg(score: number): string {
  if (score >= 75) return '#dcfce7'
  if (score >= 45) return '#fef3c7'
  return '#fee2e2'
}

function severityColor(severity: string): string {
  switch (severity) {
    case 'critical': return '#7f1d1d'
    case 'high':     return '#ef4444'
    case 'moderate': return '#f59e0b'
    case 'low':      return '#3b82f6'
    default:         return '#6b7280'
  }
}

function severityBg(severity: string): string {
  switch (severity) {
    case 'critical': return '#fecaca'
    case 'high':     return '#fee2e2'
    case 'moderate': return '#fef3c7'
    case 'low':      return '#dbeafe'
    default:         return '#f3f4f6'
  }
}

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    healthy:    'background:#dcfce7;color:#15803d',
    stale:      'background:#fef3c7;color:#92400e',
    outdated:   'background:#fee2e2;color:#b91c1c',
    abandoned:  'background:#f3f4f6;color:#374151',
    vulnerable: 'background:#fef3c7;color:#b45309',
  }
  const style = colors[status] ?? colors['abandoned']!
  return `<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;${style}">${status}</span>`
}

// ─── Timeline bar ─────────────────────────────────────────────────────────────

function timelineBar(pkg: DepInfo): string {
  const total = pkg.gapDays + 1
  const installedPct = Math.round((1 / total) * 100)
  const gapPct = 100 - installedPct
  const color = scoreColor(pkg.score)

  return `
    <div style="display:flex;align-items:center;gap:8px;width:100%">
      <div style="flex:1;height:8px;border-radius:4px;background:#f3f4f6;overflow:hidden;position:relative">
        <div style="position:absolute;left:0;top:0;height:100%;width:${100 - gapPct}%;background:${color};border-radius:4px"></div>
        <div style="position:absolute;right:0;top:0;height:100%;width:${Math.min(gapPct, 80)}%;background:#e5e7eb;border-radius:0 4px 4px 0;opacity:0.8"></div>
      </div>
      <span style="font-size:11px;color:#6b7280;white-space:nowrap">${pkg.gapDays}d behind</span>
    </div>`
}

// ─── Package row ──────────────────────────────────────────────────────────────

function packageRow(pkg: DepInfo, interactive: boolean, pm: import('./types.js').PackageManager = 'npm'): string {
  const vulnBadges = pkg.vulnerabilities.map((v) =>
    `<a href="${v.url}" target="_blank" style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:${severityBg(v.severity)};color:${severityColor(v.severity)};text-decoration:none">${v.severity.toUpperCase()}</a>`
  ).join(' ')

  // For transitive vulnerable packages: offer a "Fix resolution" button only
  // when a concrete fixed version is known (fixedIn is defined and non-empty).
  const fixVersion = pkg.vulnerabilities.find((v) => v.fixedIn)?.fixedIn
  const canFix = pkg.type === 'transitive' && fixVersion !== undefined
  const updateBtn = interactive && pkg.type !== 'transitive'
    ? `<button data-cmd="${getUpdateCommand(pm, pkg.name)}" onclick="runCmd(this.dataset.cmd, this)" style="font-size:11px;padding:4px 10px;border-radius:6px;background:#3b82f6;color:#fff;border:none;cursor:pointer;font-weight:600">Update</button>`
    : interactive && canFix
      ? `<button data-pkg="${pkg.name}" data-version="${fixVersion}" onclick="runResolution(this.dataset.pkg, this.dataset.version, this)" style="font-size:11px;padding:4px 10px;border-radius:6px;background:#7c3aed;color:#fff;border:none;cursor:pointer;font-weight:600">Fix resolution</button>`
      : ''
  const removeBtn = interactive && pkg.type !== 'transitive'
    ? `<button data-cmd="${getRemoveCommand(pm, pkg.name)}" onclick="runCmd(this.dataset.cmd, this)" style="font-size:11px;padding:4px 10px;border-radius:6px;background:#f3f4f6;color:#374151;border:1px solid #e5e7eb;cursor:pointer;font-weight:600">Remove</button>`
    : ''

  return `
  <tr class="pkg-row" data-status="${pkg.status}" data-type="${pkg.type}" data-score="${pkg.score}" data-vuln="${pkg.vulnerabilities.length > 0 ? '1' : '0'}"
    style="border-bottom:1px solid #f3f4f6;transition:background 0.15s">
    <td style="padding:12px 16px">
      <div style="font-weight:600;font-size:14px;color:#111827">${pkg.name}</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:2px">${pkg.type === 'devDependency' ? 'dev' : pkg.type === 'transitive' ? '⚠ transitive' : 'dep'}</div>
    </td>
    <td style="padding:12px 8px;font-family:monospace;font-size:13px;color:#374151">
      ${pkg.installed}
      ${pkg.installed !== pkg.latest ? `<span style="color:#9ca3af">→</span> <span style="color:#3b82f6">${pkg.latest}</span>` : ''}
    </td>
    <td style="padding:12px 8px;min-width:200px">${timelineBar(pkg)}</td>
    <td style="padding:12px 8px">${statusBadge(pkg.status)}</td>
    <td style="padding:12px 8px">${vulnBadges || '<span style="font-size:12px;color:#9ca3af">—</span>'}</td>
    <td style="padding:12px 8px;text-align:center">
      <span style="font-size:13px;font-weight:700;color:${scoreColor(pkg.score)}">${pkg.score}</span>
    </td>
    ${interactive ? `<td style="padding:12px 8px"><div style="display:flex;gap:6px">${updateBtn}${removeBtn}</div></td>` : ''}
  </tr>`
}

// ─── Chart.js data ────────────────────────────────────────────────────────────

function buildChartData(summary: ReportSummary): string {
  return JSON.stringify({
    donut: {
      labels: ['Healthy', 'Vulnerable', 'Stale', 'Outdated', 'Abandoned'],
      data: [summary.healthy, summary.vulnerable, summary.stale, summary.outdated, summary.abandoned],
      colors: ['#22c55e', '#f59e0b', '#fb923c', '#ef4444', '#9ca3af'],
    },
  })
}

// ─── Main renderer ────────────────────────────────────────────────────────────

export function renderHTML({ summary, packages, interactive = false, port = 4242 }: RenderInput): string {
  const rows = packages.map((p) => packageRow(p, interactive, summary.packageManager)).join('')
  const chartData = buildChartData(summary)
  const pmLabel = getPackageManagerLabel(summary.packageManager)
  const globalColor = scoreColor(summary.score)
  const globalBg = scoreBg(summary.score)
  const date = new Date(summary.generatedAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  })

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>depsee — ${summary.projectName}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f9fafb; margin:0; }
    .pkg-row:hover { background: #f9fafb; }
    table { border-collapse: collapse; width: 100%; }
    th { text-align:left; font-size:11px; font-weight:600; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; padding:8px 16px; border-bottom:1px solid #e5e7eb; background:#f9fafb; }
  </style>
</head>
<body>

<!-- Header -->
<div style="background:#fff;border-bottom:1px solid #e5e7eb;padding:20px 32px;display:flex;align-items:center;justify-content:space-between">
  <div style="display:flex;align-items:center;gap:16px">
    <div style="font-size:22px;font-weight:800;color:#111827;letter-spacing:-0.5px">depsee</div>
    <div style="width:1px;height:24px;background:#e5e7eb"></div>
    <div style="font-size:15px;font-weight:600;color:#374151">${summary.projectName}</div>
    <span data-pm="${summary.packageManager}" style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;background:#f3f4f6;color:#6b7280">${pmLabel}</span>
  </div>
  <div style="font-size:12px;color:#9ca3af">${date}</div>
</div>

<!-- Stats bar -->
<div style="background:#fff;border-bottom:1px solid #e5e7eb;padding:16px 32px;display:flex;gap:32px;align-items:center">
  <div style="display:flex;flex-direction:column;align-items:center">
    <div style="font-size:28px;font-weight:800;color:${globalColor}">${summary.score}</div>
    <div style="font-size:11px;color:#9ca3af;font-weight:500">GLOBAL SCORE</div>
  </div>
  <div style="width:1px;height:40px;background:#e5e7eb"></div>
  ${[
    ['TOTAL', summary.total, '#374151'],
    ['HEALTHY', summary.healthy, '#22c55e'],
    ['STALE', summary.stale, '#f59e0b'],
    ['OUTDATED', summary.outdated, '#ef4444'],
    ['ABANDONED', summary.abandoned, '#9ca3af'],
    ['VULNERABLE', summary.vulnerable, '#7c3aed'],
  ].map(([label, value, color]) => `
    <div style="display:flex;flex-direction:column;align-items:center">
      <div style="font-size:22px;font-weight:700;color:${color}">${value}</div>
      <div style="font-size:10px;color:#9ca3af;font-weight:600">${label}</div>
    </div>
  `).join('')}
</div>

<!-- Main content -->
<div style="max-width:1400px;margin:0 auto;padding:24px 32px">

  <!-- Charts row -->
  <div style="display:grid;grid-template-columns:1fr 2fr;gap:24px;margin-bottom:24px">

    <!-- Donut chart -->
    <div style="background:#fff;border-radius:12px;border:1px solid #e5e7eb;padding:24px;display:flex;flex-direction:column;align-items:center">
      <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:16px;align-self:flex-start">Status breakdown</div>
      <div style="width:200px;height:200px"><canvas id="donutChart"></canvas></div>
    </div>

    <!-- Score heatmap -->
    <div style="background:#fff;border-radius:12px;border:1px solid #e5e7eb;padding:24px">
      <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:16px">Health heatmap</div>
      <div id="heatmap" style="display:flex;flex-wrap:wrap;gap:6px">
        ${packages.map((p) => `
          <div title="${p.name} — ${p.score}/100" style="width:36px;height:36px;border-radius:6px;background:${scoreColor(p.score)};opacity:0.85;display:flex;align-items:center;justify-content:center;cursor:default">
            <span style="font-size:9px;font-weight:700;color:#fff">${p.score}</span>
          </div>`).join('')}
      </div>
    </div>
  </div>

  <!-- Filters -->
  <div style="background:#fff;border-radius:12px;border:1px solid #e5e7eb;padding:16px 24px;margin-bottom:16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap">
    <span style="font-size:12px;font-weight:600;color:#6b7280">FILTER</span>
    <div style="display:flex;gap:8px">
      ${['all', 'healthy', 'vulnerable', 'stale', 'outdated', 'abandoned'].map((s) =>
        `<button onclick="filterStatus('${s}')" id="btn-${s}" style="font-size:12px;padding:4px 12px;border-radius:6px;border:1px solid #e5e7eb;background:${s === 'all' ? '#111827' : '#fff'};color:${s === 'all' ? '#fff' : '#374151'};cursor:pointer;font-weight:500">${s}</button>`
      ).join('')}
    </div>
    <div style="width:1px;height:20px;background:#e5e7eb"></div>
    <label style="font-size:12px;color:#374151;display:flex;align-items:center;gap:6px;cursor:pointer">
      <input type="checkbox" id="filterVuln" onchange="filterVuln(this.checked)" style="cursor:pointer">
      Vulnerable only
    </label>
    <div style="width:1px;height:20px;background:#e5e7eb"></div>
    <label style="font-size:12px;color:#374151;display:flex;align-items:center;gap:6px;cursor:pointer">
      <input type="checkbox" id="filterDev" onchange="filterDev(this.checked)" style="cursor:pointer">
      devDependencies only
    </label>
    <div style="margin-left:auto">
      <input type="text" id="search" onkeyup="filterSearch(this.value)" placeholder="Search packages…"
        style="font-size:12px;padding:6px 12px;border-radius:6px;border:1px solid #e5e7eb;outline:none;width:200px">
    </div>
  </div>

  <!-- Table -->
  <div style="background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden">
    <table>
      <thead>
        <tr>
          <th>Package</th>
          <th>Version</th>
          <th>Timeline</th>
          <th>Status</th>
          <th>Security</th>
          <th style="text-align:center">Score</th>
          ${interactive ? '<th>Actions</th>' : ''}
        </tr>
      </thead>
      <tbody id="pkgTable">${rows}</tbody>
    </table>
    <div id="emptyState" style="display:none;padding:48px;text-align:center;color:#9ca3af;font-size:14px">
      No packages match the current filters.
    </div>
  </div>
</div>

<script>
const CHART_DATA = ${chartData}
let activeStatus = 'all'
let vulnOnly = false
let devOnly = false
let searchQuery = ''

// Init donut chart
new Chart(document.getElementById('donutChart'), {
  type: 'doughnut',
  data: {
    labels: CHART_DATA.donut.labels,
    datasets: [{ data: CHART_DATA.donut.data, backgroundColor: CHART_DATA.donut.colors, borderWidth: 2, borderColor: '#fff' }]
  },
  options: { plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 8 } } }, cutout: '65%' }
})

// Filter logic
function applyFilters() {
  const rows = document.querySelectorAll('.pkg-row')
  let visible = 0
  rows.forEach(row => {
    const status  = row.dataset.status
    const type    = row.dataset.type
    const vuln    = row.dataset.vuln === '1'
    const name    = row.querySelector('td div').textContent.toLowerCase()
    const show =
      (activeStatus === 'all' || status === activeStatus) &&
      (!vulnOnly || vuln) &&
      (!devOnly || type === 'devDependency') &&
      (!searchQuery || name.includes(searchQuery.toLowerCase()))
    row.style.display = show ? '' : 'none'
    if (show) visible++
  })
  document.getElementById('emptyState').style.display = visible === 0 ? 'block' : 'none'
}

function filterStatus(status) {
  activeStatus = status
  document.querySelectorAll('[id^="btn-"]').forEach(b => {
    b.style.background = b.id === 'btn-' + status ? '#111827' : '#fff'
    b.style.color = b.id === 'btn-' + status ? '#fff' : '#374151'
  })
  applyFilters()
}

function filterVuln(checked) { vulnOnly = checked; applyFilters() }
function filterDev(checked)  { devOnly = checked;  applyFilters() }
function filterSearch(q)     { searchQuery = q;    applyFilters() }

// ── Terminal overlay ──────────────────────────────────────────────────────────
function createTerminal() {
  const overlay = document.createElement('div')
  overlay.id = 'depsee-terminal'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)'

  overlay.innerHTML = \`
    <div style="width:640px;max-width:90vw;background:#0f172a;border-radius:14px;overflow:hidden;box-shadow:0 25px 60px rgba(0,0,0,0.5);font-family:monospace">
      <div style="padding:12px 16px;background:#1e293b;display:flex;align-items:center;gap:8px;position:relative">
        <button id="term-dot-close" title="Close / Cancel" style="width:12px;height:12px;border-radius:50%;background:#ef4444;border:none;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;font-size:9px;color:transparent;line-height:1" onmouseenter="this.style.color='#7f1d1d'" onmouseleave="this.style.color='transparent'">✕</button>
        <div style="width:12px;height:12px;border-radius:50%;background:#f59e0b"></div>
        <div style="width:12px;height:12px;border-radius:50%;background:#22c55e"></div>
        <span style="margin-left:8px;font-size:12px;color:#64748b">depsee — terminal</span>
        <span id="term-running-badge" style="margin-left:auto;font-size:10px;color:#60a5fa;font-family:sans-serif">● running</span>
      </div>
      <div id="term-body" style="padding:20px;min-height:180px;max-height:360px;overflow-y:auto;font-size:13px;line-height:1.6;color:#e2e8f0"></div>
      <div id="term-footer" style="padding:12px 16px;background:#1e293b;display:none;justify-content:flex-end">
        <button id="term-close" style="font-size:12px;padding:6px 16px;border-radius:6px;background:#3b82f6;color:#fff;border:none;cursor:pointer;font-weight:600">Close</button>
      </div>
    </div>\`

  document.body.appendChild(overlay)
  document.getElementById('term-close').onclick = () => overlay.remove()
  // Default red dot handler: just close (no process running yet).
  // initTermCmd overwrites this with an AbortController-aware handler.
  document.getElementById('term-dot-close').onclick = () => overlay.remove()
  return overlay
}

function termLog(overlay, text, color) {
  const body = document.getElementById('term-body')
  const line = document.createElement('div')
  line.style.color = color || '#e2e8f0'
  line.textContent = text
  body.appendChild(line)
  body.scrollTop = body.scrollHeight
}

function termDone(overlay, success) {
  // Remove the "● running" badge — process is over
  const badge = document.getElementById('term-running-badge')
  if (badge) badge.remove()
  // Show the Close button in the footer
  const footer = document.getElementById('term-footer')
  footer.style.display = 'flex'
  if (success) {
    termLog(overlay, '', '')
    termLog(overlay, '✓ Done! Reloading in 2s…', '#22c55e')
    setTimeout(() => { overlay.remove(); window.location.reload() }, 2000)
  }
}

${interactive ? `
// ── NDJSON stream reader ───────────────────────────────────────────────────────
// Reads a fetch Response whose body is newline-delimited JSON and calls
// onLine({ type, text, err, ok, field }) for each parsed object.
async function readNdjsonStream(response, onLine) {
  const reader = response.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try { onLine(JSON.parse(line)) } catch { /* ignore malformed line */ }
    }
  }
}

// ── Shared terminal setup ──────────────────────────────────────────────────────
function initTermCmd(cmd, btn) {
  btn.disabled = true
  btn.style.opacity = '0.6'
  btn.style.cursor = 'not-allowed'
  btn.innerHTML = '<span style="display:inline-block;animation:spin 0.8s linear infinite">⟳</span>'
  const overlay = createTerminal()
  termLog(overlay, '$ ' + cmd, '#94a3b8')
  termLog(overlay, '', '')
  // Spinner shown while waiting for the first line of output
  const spinnerLine = document.createElement('div')
  spinnerLine.style.color = '#60a5fa'
  spinnerLine.dataset.spinner = '1'
  spinnerLine.dataset.i = '0'
  spinnerLine.textContent = '⠋ Starting…'
  document.getElementById('term-body').appendChild(spinnerLine)
  const spinnerInterval = setInterval(() => {
    const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
    spinnerLine.dataset.i = String((parseInt(spinnerLine.dataset.i||'0') + 1) % frames.length)
    spinnerLine.textContent = frames[parseInt(spinnerLine.dataset.i)] + ' Starting…'
  }, 80)
  const clearSpinner = () => { clearInterval(spinnerInterval); spinnerLine.remove() }

  // AbortController lets the red dot instantly cut the fetch stream AND restore the button
  const controller = new AbortController()
  document.getElementById('term-dot-close').onclick = () => {
    const badge = document.getElementById('term-running-badge')
    if (badge) fetch('http://localhost:${port}/cancel', { method: 'POST' }).catch(() => {})
    controller.abort()   // immediately breaks readNdjsonStream
    overlay.remove()
  }
  return { overlay, clearSpinner, signal: controller.signal }
}

function restoreBtn(btn, originalText) {
  btn.disabled = false
  btn.style.opacity = '1'
  btn.style.cursor = 'pointer'
  btn.textContent = originalText
}

async function runCmd(cmd, btn) {
  const originalText = btn.textContent
  const { overlay, clearSpinner, signal } = initTermCmd(cmd, btn)
  let spinnerCleared = false

  try {
    const res = await fetch('http://localhost:${port}/run', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ cmd }),
      signal,
    })

    let ok = false
    await readNdjsonStream(res, (msg) => {
      if (!spinnerCleared) { clearSpinner(); spinnerCleared = true }
      if (msg.type === 'line') {
        termLog(overlay, msg.text, msg.err ? '#f87171' : '#94a3b8')
      } else if (msg.type === 'done') {
        ok = msg.ok
      }
    })

    if (!spinnerCleared) { clearSpinner(); spinnerCleared = true }
    if (ok) {
      termDone(overlay, true)
    } else {
      termLog(overlay, '', '')
      termLog(overlay, '✗ Command failed', '#ef4444')
      termDone(overlay, false)
      restoreBtn(btn, originalText)
    }
  } catch(e) {
    if (!spinnerCleared) { clearSpinner(); spinnerCleared = true }
    // AbortError = user clicked the red dot — overlay already gone, just restore btn
    if (e && e.name === 'AbortError') { restoreBtn(btn, originalText); return }
    if (document.getElementById('depsee-terminal')) {
      termLog(overlay, '✗ Could not reach depsee server. Is it still running?', '#ef4444')
      termDone(overlay, false)
    }
    restoreBtn(btn, originalText)
  }
}

async function runResolution(pkgName, version, btn) {
  const originalText = btn.textContent
  const pm = document.querySelector('[data-pm]')?.dataset.pm || 'npm'
  const fieldGuess = pm === 'yarn' ? 'resolutions' : 'overrides'
  const displayCmd = 'Adding ' + fieldGuess + '.' + pkgName + ' = "' + version + '" → reinstalling'
  const { overlay, clearSpinner, signal } = initTermCmd(displayCmd, btn)
  let spinnerCleared = false
  let resolvedField = fieldGuess

  try {
    const res = await fetch('http://localhost:${port}/add-resolution', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ packageName: pkgName, version, pm }),
      signal,
    })

    let ok = false
    await readNdjsonStream(res, (msg) => {
      if (!spinnerCleared) { clearSpinner(); spinnerCleared = true }
      if (msg.type === 'field') {
        resolvedField = msg.field
      } else if (msg.type === 'line') {
        termLog(overlay, msg.text, msg.err ? '#f87171' : '#94a3b8')
      } else if (msg.type === 'done') {
        ok = msg.ok
      }
    })

    if (!spinnerCleared) { clearSpinner(); spinnerCleared = true }
    if (ok) {
      termLog(overlay, '', '')
      termLog(overlay, '✓ ' + resolvedField + '.' + pkgName + ' = "' + version + '" added to package.json', '#22c55e')
      termDone(overlay, true)
    } else {
      termLog(overlay, '✗ Install failed', '#ef4444')
      termDone(overlay, false)
      restoreBtn(btn, originalText)
    }
  } catch(e) {
    if (!spinnerCleared) { clearSpinner(); spinnerCleared = true }
    if (e && e.name === 'AbortError') { restoreBtn(btn, originalText); return }
    if (document.getElementById('depsee-terminal')) {
      termLog(overlay, '✗ Could not reach depsee server', '#ef4444')
      termDone(overlay, false)
    }
    restoreBtn(btn, originalText)
  }
}` : ''}
</script>
<style>
@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
</style>
</body>
</html>`
}
