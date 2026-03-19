import { z } from 'zod'

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const VersionTimeSchema = z.record(z.string(), z.string())

const DistTagsSchema = z.object({
  latest: z.string(),
}).passthrough()

const NpmPackageSchema = z.object({
  name: z.string(),
  'dist-tags': DistTagsSchema,
  time: VersionTimeSchema,
  versions: z.record(z.string(), z.unknown()),
})

export type NpmPackageData = z.infer<typeof NpmPackageSchema>

// ─── Registry client ──────────────────────────────────────────────────────────

const REGISTRY_URL = 'https://registry.npmjs.org'

/** Fetches and validates package metadata from the npm registry. */
export async function fetchPackageData(name: string): Promise<NpmPackageData> {
  const url = `${REGISTRY_URL}/${encodeURIComponent(name)}`

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  })

  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for package "${name}"`)
  }

  const raw = await res.json()
  return NpmPackageSchema.parse(raw)
}

/**
 * Fetches multiple packages in parallel with a concurrency limit.
 * Returns a map of name → data (failed packages are silently skipped).
 */
export async function fetchPackagesBatch(
  names: string[],
  concurrency = 8,
): Promise<Map<string, NpmPackageData>> {
  const results = new Map<string, NpmPackageData>()
  const queue = [...names]

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const name = queue.shift()
      if (!name) break
      try {
        const data = await fetchPackageData(name)
        results.set(name, data)
      } catch {
        // Skip packages that fail to fetch (scoped, private, etc.)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}

// ─── Data extractors ──────────────────────────────────────────────────────────

/**
 * Returns the release date (ISO string) of a specific version,
 * or undefined if not found in the time map.
 */
export function getReleaseDate(data: NpmPackageData, version: string): string | undefined {
  // Strip leading range chars like ^, ~, >=, etc.
  const clean = version.replace(/^[\^~>=<]+/, '').split('-')[0]
  return data.time[clean ?? version] ?? data.time[version]
}

/**
 * Returns the latest published version tag.
 */
export function getLatestVersion(data: NpmPackageData): string {
  return data['dist-tags'].latest
}

/**
 * Counts how many published versions exist between two version strings.
 * Compares by position in the `time` map (chronological order).
 */
export function countMissedVersions(
  data: NpmPackageData,
  installedVersion: string,
  latestVersion: string,
): number {
  const allVersions = Object.keys(data.time).filter(
    (v) => v !== 'created' && v !== 'modified',
  )

  const installedIdx = allVersions.indexOf(installedVersion)
  const latestIdx    = allVersions.indexOf(latestVersion)

  if (installedIdx === -1 || latestIdx === -1) return 0
  return Math.max(0, latestIdx - installedIdx)
}

/**
 * Estimates publish frequency as average releases per year.
 */
export function getPublishFrequency(data: NpmPackageData): number {
  const times = Object.entries(data.time)
    .filter(([k]) => k !== 'created' && k !== 'modified')
    .map(([, v]) => new Date(v).getTime())
    .sort((a, b) => a - b)

  if (times.length < 2) return 0

  const first = times[0]
  const last  = times[times.length - 1]
  if (first === undefined || last === undefined) return 0

  const years = (last - first) / (1000 * 60 * 60 * 24 * 365)
  if (years < 0.1) return times.length // very new package

  return Math.round((times.length / years) * 10) / 10
}
