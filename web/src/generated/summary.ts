// Generated from schemas/*.schema.json by npm run generate:types.

export interface Summary {
  schemaVersion: 1
  snapshotId: string
  generatedAt: string
  githubSyncedAt: string | null
  trunkCompilerVersion: string | null
  snapshotRoot: string
  kpis: {
    prTotal: number
    issueTotal: number
    prQueues: {
      'approved-follow-up': number
      'awaiting-rereview': number
      'awaiting-first-review': number
      'long-inactive': number
    }
    issueConclusions: {
      'close-candidate': number
      'still-reproducible': number
      'insufficient-evidence': number
    }
    generatedByFuzzer: number
  }
  modules: {
    id: string
    name: string
    counts: {
      prTotal: number
      issueTotal: number
      prQueues: {
        'approved-follow-up': number
        'awaiting-rereview': number
        'awaiting-first-review': number
        'long-inactive': number
      }
      issueConclusions: {
        'close-candidate': number
        'still-reproducible': number
        'insufficient-evidence': number
      }
      generatedByFuzzer: number
    }
  }[]
}
