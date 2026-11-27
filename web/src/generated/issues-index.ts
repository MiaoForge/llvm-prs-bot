// Generated from schemas/*.schema.json by npm run generate:types.

export interface IssueIndex {
  schemaVersion: 1
  snapshotId: string
  moduleId: string
  items: {
    id: number
    title: string
    url: string
    /**
     * @minItems 1
     */
    moduleIds: string[]
    source: 'human-reported' | 'generated-by-fuzzer' | 'unknown'
    kind: 'diagnostic' | 'crash' | 'other' | 'unknown'
    originalReportAt: string
    originalReportTracker: 'github' | 'bugzilla' | 'unknown'
    lastHumanCommentAt: string | null
    githubSyncedAt: string
    lastVerifiedAt: string | null
    conclusion: 'close-candidate' | 'still-reproducible' | 'insufficient-evidence'
    fixStatus: 'unknown' | 'candidate' | 'confirmed'
    baseline: {
      compilerVersion: string
      outcome: 'reported-symptom' | 'expected-behavior' | 'different-behavior' | 'unknown'
    } | null
    trunk: {
      compilerVersion: string
      outcome: 'reported-symptom' | 'expected-behavior' | 'different-behavior' | 'unknown'
    } | null
    [k: string]: unknown
  }[]
}
