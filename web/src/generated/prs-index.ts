// Generated from schemas/*.schema.json by npm run generate:types.

export interface PrIndex {
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
    [k: string]: unknown
  }[]
}
