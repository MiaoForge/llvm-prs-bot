// Generated from schemas/*.schema.json by npm run generate:types.

export interface PrDetail {
  id: number
  title: string
  url: string
  /**
   * @minItems 1
   */
  moduleIds: string[]
  author: string
  createdAt: string
  lastHumanActivityAt: string | null
  lastBotActivityAt: string | null
  queues: ('approved-follow-up' | 'awaiting-rereview' | 'awaiting-first-review' | 'long-inactive')[]
  priority: number
  reason: string
  headSha: string
  headReview: {
    status: 'approved' | 'changes-requested' | 'review-required' | 'unknown'
    commitSha: string
  }
  headCi: {
    status: 'passing' | 'failing' | 'pending' | 'unknown'
    commitSha: string
  }
  latestApproval: {
    commitSha: string
    approvedAt: string
  } | null
  /**
   * Zero when the latest approval SHA matches headSha. A known distance from a different SHA is a positive integer. Null means no approval or an unknown distance, such as after a force-push.
   */
  commitsSinceApproval: number | null
  mergeability: 'mergeable' | 'conflicting' | 'unknown'
  unresolvedDiscussionCount: number | null
  mergeHelpRequested: boolean
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
  reasonEvidenceUrls: string[]
  requestedReviewers: {
    login: string
    kind: 'user' | 'team'
    response: 'pending' | 'commented' | 'approved' | 'changes-requested' | 'unknown'
  }[]
  suggestedReviewers: {
    login: string
    reason: string
    /**
     * @minItems 1
     */
    evidenceUrls: string[]
  }[]
  timeline: {
    at: string
    kind: 'commit' | 'review' | 'review-request' | 'comment' | 'check' | 'label' | 'other'
    actor: string
    isBot: boolean
    description: string
    url: string
    commitSha: string | null
  }[]
  touchedPaths: string[]
  requiredChecks: {
    name: string
    status: 'passing' | 'failing' | 'pending' | 'unknown'
    commitSha: string
    url: string | null
  }[]
  unresolvedDiscussionUrls: string[]
}
