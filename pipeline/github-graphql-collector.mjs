import { setTimeout as delay } from 'node:timers/promises'
import { normalizeIssue, normalizePull, reviewEvent } from './github-normalize.mjs'

const PR_SEARCH_QUERY = `
query($query: String!, $first: Int!, $after: String) {
  search(query: $query, type: ISSUE, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        url
        state
        createdAt
        updatedAt
        mergeable
        headRefOid
        baseRefName
        author { __typename login }
        labels(first: 15) { nodes { name } }
        files(first: 40) {
          pageInfo { hasNextPage }
          nodes { path }
        }
        reviews(last: 15) {
          pageInfo { hasPreviousPage }
          nodes {
            state
            submittedAt
            url
            author { __typename login }
            commit { oid }
          }
        }
        reviewRequests(first: 15) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { slug }
            }
          }
        }
        comments(last: 15) {
          pageInfo { hasPreviousPage }
          nodes {
            createdAt
            url
            body
            author { __typename login }
          }
        }
        reviewThreads(first: 25) {
          nodes {
            isResolved
            comments(first: 1) { nodes { url } }
          }
        }
        timelineItems(last: 5, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
          nodes {
            ... on HeadRefForcePushedEvent {
              createdAt
              actor { __typename login }
              afterCommit { oid commitUrl }
            }
          }
        }
        commits(last: 1) {
          totalCount
          nodes {
            commit {
              oid
              commitUrl
              committedDate
              committer { user { __typename login } }
              statusCheckRollup {
                contexts(first: 20) {
                  pageInfo { hasNextPage }
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion detailsUrl }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`

const ISSUE_SEARCH_QUERY = `
query($query: String!, $first: Int!, $after: String) {
  search(query: $query, type: ISSUE, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number
        title
        body
        url
        state
        createdAt
        updatedAt
        author { __typename login }
        labels(first: 20) { nodes { name } }
        comments(last: 20) {
          pageInfo { hasPreviousPage }
          nodes {
            createdAt
            url
            author { __typename login }
          }
        }
      }
    }
  }
}
`

const MERGED_HISTORY_QUERY = `
query($query: String!, $first: Int!) {
  search(query: $query, type: ISSUE, first: $first) {
    nodes {
      ... on PullRequest {
        number
        url
        author { login }
        labels(first: 15) { nodes { name } }
        files(first: 40) { nodes { path } }
        reviews(last: 20) {
          nodes {
            state
            submittedAt
            url
            author { __typename login }
            commit { oid }
          }
        }
      }
    }
  }
}
`

export const defaultGraphQLOptions = {
  repository: 'llvm/llvm-project',
  pageSize: 20,
  maxPulls: 240,
  maxIssues: 200,
  maxHistory: 25,
  timeoutMs: 30_000,
  requestBudget: 60,
}

function toRestUser(actor) {
  if (!actor?.login) return null
  return {
    login: actor.login,
    type:
      actor.__typename === 'Bot' ? 'Bot' : actor.__typename === 'Mannequin' ? 'Mannequin' : 'User',
  }
}

function mapCheckStatus(context) {
  if (context.__typename === 'CheckRun') {
    const status = String(context.status ?? '').toLowerCase()
    const conclusion = String(context.conclusion ?? '').toLowerCase()
    const mapped =
      status !== 'completed'
        ? 'pending'
        : ['success', 'neutral', 'skipped'].includes(conclusion)
          ? 'passing'
          : conclusion
            ? 'failing'
            : 'unknown'
    return {
      name: context.name,
      status: mapped,
      url: /^https:\/\//.test(context.detailsUrl ?? '') ? context.detailsUrl : null,
    }
  }
  if (context.__typename === 'StatusContext') {
    const state = String(context.state ?? '').toLowerCase()
    const mapped =
      { success: 'passing', error: 'failing', failure: 'failing', pending: 'pending' }[state] ??
      'unknown'
    return {
      name: context.context,
      status: mapped,
      url: /^https:\/\//.test(context.targetUrl ?? '') ? context.targetUrl : null,
    }
  }
  return null
}

function convertGraphQLPull(node) {
  if (!node?.number || node.state !== 'OPEN' || !/^[0-9a-f]{40}$/.test(node.headRefOid ?? '')) {
    return null
  }
  const author = toRestUser(node.author)
  if (!author) return null
  const headCommit = node.commits?.nodes?.[0]?.commit
  const rollupContexts = headCommit?.statusCheckRollup?.contexts?.nodes ?? []
  const checks = rollupContexts
    .map(mapCheckStatus)
    .filter(Boolean)
    .map((check) => ({
      ...check,
      commitSha: node.headRefOid,
      required: true,
    }))
  const unresolvedThreads = (node.reviewThreads?.nodes ?? []).filter((thread) => !thread.isResolved)
  const requestedReviewers = []
  const requestedTeams = []
  for (const req of node.reviewRequests?.nodes ?? []) {
    const reviewer = req?.requestedReviewer
    if (reviewer?.__typename === 'User' && reviewer.login) {
      requestedReviewers.push({ login: reviewer.login })
    } else if (reviewer?.__typename === 'Team' && reviewer.slug) {
      requestedTeams.push({ slug: reviewer.slug })
    }
  }
  const restPull = {
    number: node.number,
    title: node.title,
    html_url: node.url,
    user: author,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    head: { sha: node.headRefOid },
    base: { ref: node.baseRefName },
    labels: (node.labels?.nodes ?? []).map((label) => ({ name: label.name })),
    requested_reviewers: requestedReviewers,
    requested_teams: requestedTeams,
    mergeable:
      node.mergeable === 'MERGEABLE' ? true : node.mergeable === 'CONFLICTING' ? false : null,
    commits: node.commits?.totalCount ?? 1,
    comments: node.comments?.nodes?.length ?? 0,
  }
  const reviews = (node.reviews?.nodes ?? []).map((review) => ({
    state: review.state,
    submitted_at: review.submittedAt,
    html_url: review.url,
    user: toRestUser(review.author),
    commit_id: review.commit?.oid ?? null,
  }))
  const comments = (node.comments?.nodes ?? []).map((comment) => ({
    created_at: comment.createdAt,
    html_url: comment.url,
    body: comment.body ?? '',
    user: toRestUser(comment.author),
  }))
  const commits = headCommit?.oid
    ? [
        {
          sha: headCommit.oid,
          html_url: headCommit.commitUrl,
          committer: toRestUser(headCommit.committer?.user),
          commit: { committer: { date: headCommit.committedDate } },
        },
      ]
    : []
  const files = (node.files?.nodes ?? []).map((file) => ({ filename: file.path }))
  const pushes = (node.timelineItems?.nodes ?? [])
    .filter((item) => item?.createdAt && item?.afterCommit?.oid)
    .map((item) => ({
      created_at: item.createdAt,
      actor: toRestUser(item.actor),
      after_commit: {
        sha: item.afterCommit.oid,
        html_url: item.afterCommit.commitUrl,
      },
    }))
  const normalized = normalizePull(restPull, {
    files,
    reviews,
    comments,
    commits,
    pushes,
    checks,
    requiredChecksComplete:
      checks.length > 0 && !headCommit?.statusCheckRollup?.contexts?.pageInfo?.hasNextPage,
    distance: {},
    reviewsComplete: !node.reviews?.pageInfo?.hasPreviousPage,
    commentsComplete: !node.comments?.pageInfo?.hasPreviousPage,
    commitsComplete: Boolean(headCommit?.oid),
    timelineComplete: true,
  })
  return {
    ...normalized,
    unresolvedDiscussionCount: unresolvedThreads.length,
    unresolvedDiscussionUrls: unresolvedThreads
      .map((thread) => thread.comments?.nodes?.[0]?.url)
      .filter((url) => typeof url === 'string' && /^https:\/\//.test(url)),
  }
}

function convertGraphQLIssue(node, githubSyncedAt) {
  if (!node?.number || node.state !== 'OPEN') return null
  const author = toRestUser(node.author)
  const restIssue = {
    number: node.number,
    title: node.title,
    body: node.body ?? '',
    html_url: node.url,
    user: author,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    labels: (node.labels?.nodes ?? []).map((label) => ({ name: label.name })),
  }
  const comments = (node.comments?.nodes ?? []).map((comment) => ({
    created_at: comment.createdAt,
    html_url: comment.url,
    user: toRestUser(comment.author),
  }))
  return normalizeIssue(restIssue, comments, githubSyncedAt)
}

export function createGitHubGraphQLCollector(options = {}) {
  const {
    repository,
    pageSize,
    maxPulls,
    maxIssues,
    maxHistory,
    timeoutMs,
    requestBudget,
    token,
    fetchImpl = globalThis.fetch,
    endpoint = 'https://api.github.com/graphql',
  } = { ...defaultGraphQLOptions, ...options }

  let remaining = requestBudget

  async function graphql(query, variables) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (remaining === 0) throw new Error('GitHub GraphQL request budget exhausted')
      remaining--
      const controller = new AbortController()
      const timeout = delay(timeoutMs, undefined, { signal: controller.signal }).then(() => {
        const error = new Error('GitHub GraphQL request timed out')
        controller.abort(error)
        throw error
      })
      async function post() {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ query, variables }),
          redirect: 'error',
          signal: controller.signal,
        })
        if (!response.ok) {
          const error = new Error(`GitHub GraphQL returned HTTP ${response.status}`)
          error.retryable = response.status >= 502 && response.status <= 504
          throw error
        }
        const payload = await response.json()
        if (payload.errors?.length && !payload.data) {
          throw new Error(`GitHub GraphQL error: ${payload.errors[0].message}`)
        }
        return payload.data
      }
      try {
        return await Promise.race([post(), timeout])
      } catch (error) {
        const transient =
          error?.retryable ||
          error instanceof SyntaxError ||
          error?.name === 'TypeError' ||
          /timed out/i.test(error?.message ?? '')
        if (attempt === 0 && transient && remaining > 0) {
          await delay(1000)
          continue
        }
        throw error
      } finally {
        controller.abort()
      }
    }
  }

  async function runSearch(queryDoc, searchQuery, limit) {
    const nodes = []
    let cursor = null
    while (nodes.length < limit && remaining > 0) {
      const first = Math.min(pageSize, limit - nodes.length)
      const data = await graphql(queryDoc, { query: searchQuery, first, after: cursor })
      const page = data?.search
      if (!page?.nodes?.length) break
      nodes.push(...page.nodes.filter(Boolean))
      if (!page.pageInfo?.hasNextPage || !page.pageInfo?.endCursor) break
      cursor = page.pageInfo.endCursor
    }
    return nodes
  }

  return {
    async collect(githubSyncedAt) {
      const staleCutoff = new Date(Date.parse(githubSyncedAt) - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10)
      // 1. Targeted Clang/Lex (both recent and >30d stale backlog) + Clang frontend,
      // then broad whole-repo coverage.
      const prQueries = [
        [
          `repo:${repository} is:pr is:open (Lex OR Lexer OR Preprocessor OR clang/lib/Lex) sort:updated-desc`,
          Math.min(60, maxPulls),
        ],
        [
          `repo:${repository} is:pr is:open (Lex OR Lexer OR Preprocessor OR clang/lib/Lex) updated:<=${staleCutoff} sort:updated-asc`,
          Math.min(60, maxPulls),
        ],
        [
          `repo:${repository} is:pr is:open label:"clang:frontend" sort:updated-desc`,
          Math.min(100, maxPulls),
        ],
        [`repo:${repository} is:pr is:open sort:updated-desc`, maxPulls],
      ]
      const issueQueries = [
        [
          `repo:${repository} is:issue is:open label:"clang:frontend" (lex OR lexer OR preprocessor OR macro OR pragma OR "#include") sort:updated-desc`,
          Math.min(60, maxIssues),
        ],
        [
          `repo:${repository} is:issue is:open label:"clang:frontend" (lex OR lexer OR preprocessor OR macro OR pragma OR "#include") updated:<=${staleCutoff} sort:updated-asc`,
          Math.min(60, maxIssues),
        ],
        [
          `repo:${repository} is:issue is:open label:"clang:frontend" sort:updated-desc`,
          Math.min(100, maxIssues),
        ],
        [`repo:${repository} is:issue is:open sort:updated-desc`, maxIssues],
      ]

      const pullMap = new Map()
      for (const [query, limit] of prQueries) {
        if (pullMap.size >= maxPulls || remaining <= 2) break
        for (const node of await runSearch(PR_SEARCH_QUERY, query, limit)) {
          if (pullMap.size >= maxPulls) break
          if (node?.number && !pullMap.has(node.number)) {
            const normalized = convertGraphQLPull(node)
            if (normalized) pullMap.set(node.number, normalized)
          }
        }
      }

      const issueMap = new Map()
      for (const [query, limit] of issueQueries) {
        if (issueMap.size >= maxIssues || remaining <= 1) break
        for (const node of await runSearch(ISSUE_SEARCH_QUERY, query, limit)) {
          if (issueMap.size >= maxIssues) break
          if (node?.number && !issueMap.has(node.number)) {
            const normalized = convertGraphQLIssue(node, githubSyncedAt)
            if (normalized?.moduleIds.length) issueMap.set(node.number, normalized)
          }
        }
      }

      const reviewerHistory = []
      if (maxHistory > 0 && remaining > 0) {
        const mergedData = await graphql(MERGED_HISTORY_QUERY, {
          query: `repo:${repository} is:pr is:merged sort:updated-desc`,
          first: Math.min(50, maxHistory),
        })
        for (const pull of mergedData?.search?.nodes ?? []) {
          const author = pull?.author?.login?.toLowerCase()
          if (!author) continue
          const paths = (pull.files?.nodes ?? []).map((f) => f.path).filter(Boolean)
          const labels = (pull.labels?.nodes ?? []).map((l) => l.name).filter(Boolean)
          for (const review of pull.reviews?.nodes ?? []) {
            const mapped = reviewEvent({
              state: review.state,
              submitted_at: review.submittedAt,
              html_url: review.url,
              user: toRestUser(review.author),
              commit_id: review.commit?.oid ?? null,
            })
            if (
              mapped &&
              !mapped.isBot &&
              mapped.reviewState !== 'dismissed' &&
              mapped.actor.toLowerCase() !== author
            ) {
              reviewerHistory.push({
                prId: pull.number,
                login: mapped.actor,
                author,
                isBot: false,
                paths,
                labels,
                url: mapped.url,
              })
            }
          }
        }
      }

      return {
        prs: [...pullMap.values()],
        issues: [...issueMap.values()],
        reviewerHistory,
      }
    },
  }
}
