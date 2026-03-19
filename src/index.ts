/**
 * depsee
 *
 * See your dependencies like never before.
 * Interactive dependency dashboard with health scores, dataviz, and security audit.
 *
 * @module depsee
 */

// Public API
export { analyze }     from './analyzer.js'
export { startServer } from './server.js'
export { renderHTML }  from './renderer.js'

// Utilities
export { detectPackageManager, getUpdateCommand, getRemoveCommand } from './detector.js'
export { computeScore, computeGlobalScore, deriveStatus }           from './scorer.js'
export { runAudit, getHighestSeverity }                              from './auditor.js'
export { fetchPackageData, fetchPackagesBatch }                      from './registry.js'

// Types
export type {
  AnalysisReport,
  AnalyzeOptions,
  CliOptions,
  DepInfo,
  DepStatus,
  DepType,
  PackageManager,
  ReportSummary,
  Severity,
  Vulnerability,
} from './types.js'
