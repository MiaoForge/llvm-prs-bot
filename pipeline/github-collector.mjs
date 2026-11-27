import { setTimeout as delay } from 'node:timers/promises'
import {
  labelNames,
  latestApprovalSha,
  normalizeChecks,
  normalizeIssue,
  normalizePull,
  reviewEvent,
} from './github-normalize.mjs'

export class GitHubHttpError extends Error {
  constructor(status, path) {
    super(`GitHub returned HTTP ${status} for ${path}`)
    this.status = status
  }
}

const perPage = 30
export const defaultGitHubOptions = {
  repository: 'llvm/llvm-project',
  labels: ['clang:frontend', 'clang:sema', 'clang:ast'],
  maxPages: 3,
  maxPulls: 12,
  maxIssues: 24,
  maxHistory: 6,
  timeoutMs: 15_000,
  requestBudget: 400,
}

function nextPage(response) {
  return (response.headers.get('link') ?? '').split(',').some((link) => /;\s*rel="next"/.test(link))
}

export function createGitHubCollector(options = {}) {
  const {
    repository,
    labels,
    maxPages,
    maxPulls,
    maxIssues,
    maxHistory,
    timeoutMs,
    requestBudget,
    fetchImpl = globalThis.fetch,
    token,
    baseUrl = 'https://api.github.com/',
  } = { ...defaultGitHubOptions, ...options }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new TypeError('GitHub repository must be owner/name')
  if (
    !Array.isArray(labels) ||
    !labels.every((label) => typeof label === 'string' && /^[\w: .+-]+$/.test(label))
  ) {
    throw new TypeError('GitHub labels must be literal label names')
  }
  for (const [name, value] of Object.entries({
    maxPages,
    maxPulls,
    maxIssues,
    maxHistory,
    timeoutMs,
    requestBudget,
  })) {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (['maxPages', 'timeoutMs'].includes(name) && value === 0)
    ) {
      throw new RangeError(`Invalid GitHub option ${name}`)
    }
  }
  if (timeoutMs > 2_147_483_647) throw new RangeError('GitHub timeout exceeds timer range')
  const root = `repos/${repository}`
  let remaining = requestBudget

  async function request(path, params = {}) {
    if (remaining === 0) throw new Error('GitHub request budget exhausted')
    remaining--
    const url = new URL(path, baseUrl)
    url.search = new URLSearchParams(params)
    const controller = new AbortController()
    const timeout = delay(timeoutMs, undefined, { signal: controller.signal }).then(() => {
      const error = new Error(`GitHub request timed out for ${path}`)
      controller.abort(error)
      throw error
    })
    async function get() {
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) throw new GitHubHttpError(response.status, path)
      return { data: await response.json(), more: nextPage(response) }
    }
    try {
      return await Promise.race([get(), timeout])
    } finally {
      controller.abort()
    }
  }

  async function optional(operation, unavailable = [404]) {
    try {
      return await operation()
    } catch (error) {
      if (!(error instanceof GitHubHttpError) || !unavailable.includes(error.status)) throw error
      return null
    }
  }

  async function pages(path, params = {}, select = (data) => data, limit = Infinity) {
    const items = []
    for (let page = 1; page <= maxPages && items.length < limit; page++) {
      const { data, more } = await request(path, { ...params, page, per_page: perPage })
      const values = select(data)
      if (!Array.isArray(values)) throw new Error(`Invalid paginated GitHub response for ${path}`)
      items.push(...values)
      if (!more) return { items: items.slice(0, limit), complete: items.length <= limit }
    }
    return { items: items.slice(0, limit), complete: false }
  }

  async function search(query, limit) {
    if (limit === 0) return []
    const found = new Map()
    for (const label of labels.length ? labels : [null]) {
      const q = `repo:${repository} ${query}${label ? ` label:"${label}"` : ''}`
      const { items } = await pages(
        'search/issues',
        { q, sort: 'updated', order: 'desc' },
        (data) => {
          if (data.incomplete_results) throw new Error('GitHub search returned incomplete results')
          return data.items
        },
        limit,
      )
      for (const item of items) found.set(item.number, item)
    }
    return [...found.values()]
      .sort(
        (left, right) =>
          Date.parse(right.updated_at) - Date.parse(left.updated_at) || right.number - left.number,
      )
      .slice(0, limit)
  }

  const protections = new Map()
  function protection(branch) {
    if (!protections.has(branch)) protections.set(branch, loadProtection(branch))
    return protections.get(branch)
  }

  async function loadProtection(branch) {
    const encoded = encodeURIComponent(branch)
    const rules = await optional(() => pages(`${root}/rules/branches/${encoded}`), [403, 404])
    const legacy = await optional(
      () => request(`${root}/branches/${encoded}/protection/required_status_checks`),
      [403, 404],
    )
    const required = (rules?.items ?? []).flatMap((rule) =>
      rule.type === 'required_status_checks' ? rule.parameters.required_status_checks : [],
    )
    if (legacy) {
      const checks = legacy.data.checks ?? []
      required.push(
        ...checks.map(({ context, app_id }) => ({
          context,
          integration_id: app_id > 0 ? app_id : undefined,
        })),
      )
      required.push(
        ...(legacy.data.contexts ?? [])
          .filter((context) => !checks.some((check) => check.context === context))
          .map((context) => ({ context })),
      )
    }
    return {
      checks: [
        ...new Map(
          required.map((check) => [`${check.context}/${check.integration_id ?? ''}`, check]),
        ).values(),
      ],
      // The legacy protection endpoint normally needs administrative read access.
      // A hidden policy is not evidence that every required check passed.
      complete: Boolean(rules?.complete && legacy),
    }
  }

  async function collectPull(number) {
    const path = `${root}/pulls/${number}`
    const { data: pull } = await request(path)
    if (pull.state !== 'open') return null
    if (!/^[0-9a-f]{40}$/.test(pull.head.sha)) throw new Error(`Invalid head SHA for PR ${number}`)
    const sha = pull.head.sha
    const files = await pages(`${path}/files`)
    const commits = await pages(`${path}/commits`)
    const reviews = await pages(`${path}/reviews`)
    const comments = await pages(`${root}/issues/${number}/comments`)
    const timeline = await optional(() => pages(`${root}/issues/${number}/timeline`))
    const pushes = (timeline?.items ?? []).filter(
      (event) => event.event === 'head_ref_force_pushed',
    )
    const policy = await protection(pull.base.ref)
    const runs = await optional(
      () =>
        pages(`${root}/commits/${sha}/check-runs`, { filter: 'latest' }, (data) => data.check_runs),
      [403, 404, 422],
    )
    const status = await optional(() => pages(`${root}/commits/${sha}/statuses`), [403, 404, 422])
    const latestStatuses = new Map()
    for (const observation of status?.items ?? []) {
      if (!latestStatuses.has(observation.context))
        latestStatuses.set(observation.context, observation)
    }
    const checks = normalizeChecks(sha, policy.checks, runs?.items ?? [], [
      ...latestStatuses.values(),
    ])
    const approval = latestApprovalSha(reviews.items)
    const distance = {}
    if (approval && approval !== sha && /^[0-9a-f]{40}$/.test(approval)) {
      const ancestry = await optional(
        () =>
          request(`${root}/compare/${approval}...${sha}`, {
            per_page: 1,
            page: 1,
          }),
        [404, 409, 422],
      )
      if (
        ancestry?.data.status === 'ahead' &&
        Number.isSafeInteger(ancestry.data.ahead_by) &&
        ancestry.data.ahead_by > 0
      ) {
        distance[approval] = ancestry.data.ahead_by
      }
    }
    // Discard a raced observation instead of mixing evidence from two PR heads.
    const { data: current } = await request(path)
    if (
      current.state !== 'open' ||
      current.head.sha !== sha ||
      current.updated_at !== pull.updated_at
    )
      return null
    return normalizePull(pull, {
      files: files.items,
      commits: commits.items,
      reviews: reviews.items,
      comments: comments.items,
      pushes,
      checks,
      requiredChecksComplete: Boolean(policy.complete && runs?.complete && status?.complete),
      distance,
      reviewsComplete: reviews.complete,
    })
  }

  return {
    async collect(githubSyncedAt) {
      const pulls = await search('is:pr is:open', maxPulls)
      const issues = await search('is:issue is:open', maxIssues)
      const merged = await search('is:pr is:merged', maxHistory)
      const prs = []
      for (const pull of pulls) {
        const observation = await collectPull(pull.number)
        if (observation) prs.push(observation)
      }
      const reviewerHistory = []
      for (const pull of merged) {
        const path = `${root}/pulls/${pull.number}`
        const files = await pages(`${path}/files`)
        const reviews = await pages(`${path}/reviews`)
        const paths = files.items.map((file) => file.filename)
        for (const review of reviews.items.map(reviewEvent).filter(Boolean)) {
          if (!review.isBot && review.reviewState !== 'dismissed')
            reviewerHistory.push({
              prId: pull.number,
              login: review.actor,
              isBot: false,
              paths,
              labels: labelNames(pull),
              url: review.url,
            })
        }
      }
      const reports = []
      for (const match of issues) {
        const path = `${root}/issues/${match.number}`
        const { data: issue } = await request(path)
        if (issue.state !== 'open' || issue.pull_request) continue
        const comments = await pages(`${path}/comments`)
        const report = normalizeIssue(
          issue,
          comments.complete ? comments.items : [],
          githubSyncedAt,
        )
        if (report.moduleIds.length) reports.push(report)
      }
      return { prs, issues: reports, reviewerHistory }
    },
  }
}
