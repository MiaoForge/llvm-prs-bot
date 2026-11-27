// Generated from schemas/*.schema.json by npm run generate:types.

export interface IssueDetail {
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
  schemaVersion: 1
  snapshotId: string
  /**
   * @minItems 1
   */
  moduleEvidence?: {
    moduleId: string
    /**
     * @minItems 1
     */
    matchedPaths?: string[]
    /**
     * @minItems 1
     */
    matchedLabels?: string[]
  }[]
  repro: {
    sourceCode: string | null
    compileArgs: string[] | null
    expectedBehavior: string | null
    reporterGodboltUrls?: string[]
    sourceUrl: string | null
  }
  runs: {
    baseline: {
      compilerId: string
      compilerVersion: string
      exitCode: number
      diagnostics: string
      outcome: 'reported-symptom' | 'expected-behavior' | 'different-behavior' | 'unknown'
      godboltUrl: string | null
    } | null
    trunk: {
      compilerId: string
      compilerVersion: string
      exitCode: number
      diagnostics: string
      outcome: 'reported-symptom' | 'expected-behavior' | 'different-behavior' | 'unknown'
      godboltUrl: string | null
    } | null
  }
  fixAttribution:
    | {
        status: 'unknown'
      }
    | {
        status: 'candidate' | 'confirmed'
        commitSha: string
        reason: string
        /**
         * @minItems 1
         */
        evidenceUrls: string[]
      }
  crashSignature: string | null
  missingEvidence: (
    | 'source-code'
    | 'compile-arguments'
    | 'expected-behavior'
    | 'baseline-version'
    | 'baseline-run'
    | 'baseline-symptom'
    | 'trunk-run'
    | 'trunk-outcome'
    | 'crash-signature'
    | 'other'
  )[]
}
