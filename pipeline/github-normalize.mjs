import { matchModuleEvidence } from './modules.mjs'
import { extractReproducer } from './reproducer.mjs'

export function isBot(user) {
  return user?.type === 'Bot' || /\[bot\]$/i.test(user?.login ?? '')
}

function isHuman(user) {
  return Boolean(user && ['User', 'Mannequin'].includes(user.type) && !isBot(user))
}

export function labelNames(item) {
  return (item.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name))
}

const reviewStates = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
}

export function reviewEvent(review) {
  const reviewState = reviewStates[review.state]
  if (!reviewState || !review.submitted_at || !review.html_url || !review.user?.login) return null
  return {
    kind: 'review',
    at: review.submitted_at,
    actor: review.user.login,
    isBot: !isHuman(review.user),
    commitSha: review.commit_id ?? null,
    reviewState,
    description: {
      approved: 'Approved the revision.',
      'changes-requested': 'Requested changes.',
      commented: 'Reviewed the pull request.',
      dismissed: 'Review dismissed.',
    }[reviewState],
    url: review.html_url,
  }
}

export function latestApprovalSha(reviews) {
  const effective = new Map()
  const events = reviews
    .map(reviewEvent)
    .filter((event) => event && !event.isBot)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  for (const event of events) {
    if (event.reviewState === 'commented') continue
    const key = event.actor.toLowerCase()
    effective.delete(key)
    effective.set(key, event)
  }
  return (
    [...effective.values()].findLast((event) => event.reviewState === 'approved' && event.commitSha)
      ?.commitSha ?? null
  )
}

function asksForMerge(text) {
  const original = (text ?? '')
    .split('\n')
    .filter((line) => !line.startsWith('>'))
    .join(' ')
  return /\b(?:please merge|(?:could|can|would) (?:someone|you|a maintainer) (?:please )?merge|merge (?:it |this )?(?:for me|on my behalf)|need (?:someone|a maintainer) to merge)\b/i.test(
    original,
  )
}

export function normalizePull(pull, observations) {
  const {
    files,
    reviews,
    comments,
    commits,
    pushes,
    checks,
    requiredChecksComplete,
    distance,
    reviewsComplete,
    commentsComplete,
    commitsComplete,
    timelineComplete,
  } = observations
  const events = reviews.map(reviewEvent).filter(Boolean)
  // Git commit timestamps describe the commit, not when it reached this PR.
  // Use GitHub's head-ref-force-pushed event time when GitHub supplies one.
  for (const push of pushes) {
    if (!push.actor?.login || !push.created_at || !push.after_commit?.sha) continue
    events.push({
      at: push.created_at,
      kind: 'commit',
      isPush: true,
      actor: push.actor.login,
      isBot: !isHuman(push.actor),
      description: 'Updated the pull request head.',
      url: push.after_commit.html_url ?? pull.html_url,
      commitSha: push.after_commit.sha,
    })
  }
  for (const entry of commits) {
    const committer = entry.committer
    const at = entry.commit?.committer?.date
    if (
      !committer?.login ||
      !at ||
      !entry.html_url ||
      !entry.sha ||
      events.some((event) => event.kind === 'commit' && event.commitSha === entry.sha)
    )
      continue
    events.push({
      at,
      kind: 'commit',
      isPush: false,
      actor: committer.login,
      isBot: !isHuman(committer),
      description: 'Git commit metadata (committer timestamp).',
      url: entry.html_url,
      commitSha: entry.sha,
    })
  }
  for (const comment of comments) {
    if (!comment.created_at || !comment.html_url || !comment.user?.login) continue
    events.push({
      at: comment.created_at,
      kind: 'comment',
      actor: comment.user.login,
      isBot: !isHuman(comment.user),
      description: 'Commented on the pull request.',
      url: comment.html_url,
      commitSha: null,
      mergeHelpRequested: asksForMerge(comment.body),
    })
  }
  const requestedReviewers = [
    ...(pull.requested_reviewers ?? []).map((user) => ({
      login: user.login,
      kind: 'user',
      response:
        events
          .filter((event) => event.kind === 'review' && event.actor === user.login)
          .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
          .at(-1)?.reviewState ?? (reviewsComplete ? 'pending' : 'unknown'),
    })),
    ...(pull.requested_teams ?? []).map((team) => ({
      login: team.slug,
      kind: 'team',
      response: 'unknown',
    })),
  ].map((reviewer) =>
    reviewer.response === 'dismissed' ? { ...reviewer, response: 'pending' } : reviewer,
  )
  return {
    id: pull.number,
    title: pull.title,
    url: pull.html_url,
    author: pull.user.login,
    authorIsBot: isHuman(pull.user) ? false : isBot(pull.user) ? true : undefined,
    createdAt: pull.created_at,
    headSha: pull.head.sha,
    labels: labelNames(pull),
    paths: [
      ...new Set(files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean))),
    ],
    events,
    checks,
    requiredChecksComplete,
    reviewsComplete,
    commentsComplete,
    commitsComplete,
    timelineComplete,
    requestedReviewers,
    mergeability:
      pull.mergeable === true ? 'mergeable' : pull.mergeable === false ? 'conflicting' : 'unknown',
    commitsAheadBySha: distance ?? {},
  }
}

export function normalizeIssue(issue, comments, githubSyncedAt) {
  const labels = labelNames(issue)
  const migrated = labels.some((label) => label.toLowerCase() === 'bugzilla')
  const original =
    migrated &&
    /^(?:Originally reported (?:on|at)|Reported on|Opened on)\s*[:|]?\s*(\d{4}-\d{2}-\d{2})(?=\s|$)/im.exec(
      issue.body ?? '',
    )
  const originalDate = original && Date.parse(original[1])
  const extraction = extractReproducer(issue.body ?? '', issue.title)
  const paths =
    (issue.body ?? '').match(
      /\b(?:clang\/(?:lib|include\/clang|test|unittests)|llvm|lld|mlir|lldb|libcxx|clang-tools-extra|compiler-rt|flang|bolt|libc|openmp)\/[A-Za-z0-9_./-]+/g,
    ) ?? []
  // Recognize Clang/Lex issues from explicit lexer/preprocessor symbols, title tags,
  // or preprocessor/lexer terms when upstream issues carry the clang:frontend label.
  const lexHintText = `${issue.title ?? ''}\n${issue.body ?? ''}`
  const hasFrontendLabel = labels.some((label) => label.trim().toLowerCase() === 'clang:frontend')
  const explicitLexMatch =
    /(?:\[clang\]\[(?:Lex|Lexer|Preprocessor|PP)\]|\[(?:Lex|Lexer|Preprocessor|PP)\]|\b(?:Preprocessor::|Lexer::|TokenLexer|HeaderSearch|PPDirectives|PPMacroExpansion|DependencyDirectivesScanner|ModuleMap)\b)/i.test(
      lexHintText,
    )
  const frontendLexTopic =
    hasFrontendLabel &&
    /(?:\b(?:preprocessor|lexer|lexing|macro expansion|token pasting|line splicing|trigraph|digraph|raw string literal|string literal|character literal|__has_include|__has_embed|__VA_OPT__|__VA_ARGS__)\b|#(?:include|pragma|define|embed|ifdef|ifndef|elif|line)\b)/i.test(
      issue.title ?? '',
    )
  if (
    !paths.some((p) => p.startsWith('clang/lib/Lex/')) &&
    (explicitLexMatch || frontendLexTopic)
  ) {
    paths.push('clang/lib/Lex/')
  }
  const moduleEvidence = matchModuleEvidence({ labels, paths })
  const humanComment = comments
    .filter((comment) => isHuman(comment.user) && comment.created_at)
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))
    .at(-1)
  return {
    id: issue.number,
    title: issue.title,
    url: issue.html_url,
    labels,
    moduleIds: moduleEvidence.map((evidence) => evidence.moduleId),
    moduleEvidence,
    reporterIsBot: isHuman(issue.user) ? false : isBot(issue.user) ? true : undefined,
    originalReportAt: Number.isFinite(originalDate)
      ? new Date(originalDate).toISOString()
      : issue.created_at,
    originalReportTracker: migrated ? 'bugzilla' : 'github',
    lastHumanCommentAt: humanComment?.created_at ?? null,
    githubSyncedAt,
    upstreamUpdatedAt: issue.updated_at,
    ...extraction,
    repro: { ...extraction.repro, sourceUrl: extraction.repro.sourceCode ? issue.html_url : null },
  }
}

export function normalizeChecks(headSha, required, runs, statuses) {
  const observed = [
    ...runs
      .filter((run) => run.head_sha === headSha)
      .map((run) => ({
        name: run.name,
        app: run.app?.id,
        url: run.html_url,
        status:
          run.status !== 'completed'
            ? 'pending'
            : ['success', 'neutral', 'skipped'].includes(run.conclusion)
              ? 'passing'
              : run.conclusion
                ? 'failing'
                : 'unknown',
      })),
    ...statuses.map((status) => ({
      name: status.context,
      url: status.target_url,
      status:
        { success: 'passing', error: 'failing', failure: 'failing', pending: 'pending' }[
          status.state
        ] ?? 'unknown',
    })),
  ]
  return required.map(({ context, integration_id: app }) => {
    const matches = observed.filter(
      (check) => check.name === context && (!app || app === check.app),
    )
    const status =
      ['failing', 'unknown', 'pending'].find((value) =>
        matches.some((check) => check.status === value),
      ) ?? (matches.length ? 'passing' : 'unknown')
    return {
      name: context,
      status,
      commitSha: headSha,
      required: true,
      url:
        matches.find((check) => check.status === status && /^https:\/\//.test(check.url ?? ''))
          ?.url ?? null,
    }
  })
}
