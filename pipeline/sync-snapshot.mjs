import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildSnapshot } from './build-snapshot.mjs'
import {
  CompilerExplorerError,
  compilerExplorerShortId,
  createCompilerExplorerClient,
} from './compiler-explorer.mjs'
import { selectClangCompilers } from './compiler-selection.mjs'
import { createGitHubCollector, defaultGitHubOptions } from './github-collector.mjs'
import { issueSource, verifyIssue } from './issue-verification.mjs'
import { triagePr } from './pr-triage.mjs'
import { reverifyIssue } from './reverify-issue.mjs'
import { supportsCompileArgs } from './reproducer.mjs'

const defaultOutput = fileURLToPath(new URL('../data/', import.meta.url))
const stateVersion = 1
const defaultMaxReverify = 6

function fingerprint(issue, baseline, trunk) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        issue.upstreamUpdatedAt,
        issue.language,
        issue.kind,
        issue.repro,
        issue.expectations,
        issue.reportedCrashSignature,
        issue.declaredVersion,
        baseline?.id,
        baseline?.version,
        trunk?.id,
        trunk?.version,
      ]),
    )
    .digest('hex')
}

function isAutomatedDiagnostic(issue) {
  return issue.kind === 'diagnostic' && issueSource(issue) !== 'generated-by-fuzzer'
}

function canVerify(issue) {
  const { repro, expectations } = issue
  return Boolean(
    isAutomatedDiagnostic(issue) &&
      !issue.versionAmbiguous &&
      issue.language &&
      repro.sourceCode &&
      repro.expectedBehavior &&
      supportsCompileArgs(repro.compileArgs) &&
      expectations.reported.diagnosticIncludes &&
      Object.keys(expectations.expected).length > 0,
  )
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, '\n')
}

async function hydrateFromShortlink(issue, client) {
  const { repro } = issue
  if (!isAutomatedDiagnostic(issue)) return issue
  if (repro.sourceCode && repro.compileArgs != null) return issue
  const ids = new Set(
    (repro.reporterGodboltUrls ?? []).map(compilerExplorerShortId).filter(Boolean),
  )
  if (ids.size !== 1) return issue
  const [shortId] = ids
  const session = await client.fetchShortlink(shortId)
  if (!session) return issue
  // Treat the shortlink session as an atomic unit: refuse to mix conflicting
  // body and shortlink fields into an input the reporter never provided.
  if (issue.language && issue.language !== session.language) return issue
  if (
    repro.sourceCode &&
    normalizeLineEndings(repro.sourceCode) !== normalizeLineEndings(session.sourceCode)
  ) {
    return issue
  }
  if (
    repro.compileArgs != null &&
    JSON.stringify(repro.compileArgs) !== JSON.stringify(session.compileArgs)
  ) {
    return issue
  }
  return {
    ...issue,
    language: session.language,
    reportedCompilerId: session.compilerId,
    repro: {
      ...repro,
      sourceCode: repro.sourceCode || session.sourceCode,
      compileArgs: repro.compileArgs ?? session.compileArgs,
      sourceUrl: repro.sourceUrl ?? issue.url,
    },
  }
}

export async function prepareSnapshot({
  collector,
  client,
  repository,
  output = defaultOutput,
  previousState,
  now,
  snapshotId,
  maxReverify = defaultMaxReverify,
  baselineId,
  trunkId,
  cBaselineId,
  cTrunkId,
  dryRun = false,
}) {
  if (!Number.isSafeInteger(maxReverify) || maxReverify < 0) {
    throw new RangeError('MAX_REVERIFY_PER_RUN must be a non-negative safe integer')
  }
  const observations = await collector.collect(now)
  const cached =
    previousState?.version === stateVersion && previousState.repository === repository
      ? previousState.issues
      : {}
  const issues = { ...cached }
  const warnings = []
  const catalogs = new Map()
  async function catalog(language) {
    if (!catalogs.has(language)) {
      try {
        catalogs.set(language, await client.listCompilers(language))
      } catch (error) {
        if (!(error instanceof CompilerExplorerError)) throw error
        warnings.push(`Compiler Explorer catalog for ${language}: ${error.message}`)
        catalogs.set(language, null)
      }
    }
    return catalogs.get(language)
  }
  const cppCatalog = await catalog('c++')
  const { trunk } = selectClangCompilers(cppCatalog ?? [], { trunkId })
  const candidates = []
  for (const rawIssue of observations.issues) {
    let issue = rawIssue
    let shortlinkUnavailable = false
    try {
      issue = await hydrateFromShortlink(rawIssue, client)
    } catch (error) {
      if (!(error instanceof CompilerExplorerError)) throw error
      shortlinkUnavailable = true
      warnings.push(`Issue #${issue.id} shortlink: ${error.message}`)
    }
    const eligible = canVerify(issue)
    const available = eligible ? await catalog(issue.language) : []
    const resolved = selectClangCompilers(available ?? [], {
      language: issue.language,
      declaredVersion: issue.declaredVersion,
      reportedCompilerId: issue.reportedCompilerId,
      baselineId: issue.language === 'c' ? cBaselineId : baselineId,
      trunkId: issue.language === 'c' ? cTrunkId : trunkId,
    })
    const digest = fingerprint(issue, resolved.baseline, resolved.trunk)
    const previous = cached?.[issue.id]
    const fresh = previous?.digest === digest
    const baselineVersionKnown = Boolean(issue.declaredVersion || resolved.baseline)
    const next = { ...issue, baselineVersionKnown }
    if (fresh && previous.runs && eligible) {
      candidates.push({
        detail: verifyIssue({
          ...next,
          runs: previous.runs,
          lastVerifiedAt: previous.lastVerifiedAt,
        }),
        issue: next,
        eligible: false,
      })
      issues[issue.id] = previous
      continue
    }
    // Temporary service failures should preserve evidence for the next sync.
    issues[issue.id] =
      (available === null || shortlinkUnavailable) && previous
        ? previous
        : { digest, lastAttemptAt: previous?.lastAttemptAt ?? null }
    candidates.push({
      detail: verifyIssue(next),
      issue: next,
      eligible: eligible && Boolean(resolved.baseline && resolved.trunk),
      compilers: { baseline: resolved.baseline?.id, trunk: resolved.trunk?.id },
    })
  }
  const queue = candidates
    .filter((candidate) => candidate.eligible)
    .sort(
      (left, right) =>
        String(issues[left.issue.id].lastAttemptAt ?? '').localeCompare(
          String(issues[right.issue.id].lastAttemptAt ?? ''),
        ) || left.issue.id - right.issue.id,
    )
  let attempted = 0
  for (const candidate of dryRun ? [] : queue.slice(0, maxReverify)) {
    const { issue, compilers } = candidate
    const result = await reverifyIssue({ ...issue, compilers }, { client, verifiedAt: now })
    attempted++
    candidate.detail = result.detail
    for (const [side, failure] of Object.entries(result.failures)) {
      warnings.push(`Issue #${issue.id} ${side}: ${failure.message}`)
    }
    const state = issues[issue.id]
    state.lastAttemptAt = now
    const { runs, lastVerifiedAt } = result.detail
    if ([runs.baseline, runs.trunk].every((run) => run && run.outcome !== 'unknown')) {
      Object.assign(state, { runs, lastVerifiedAt })
    }
  }
  const trunkCompilerVersion = trunk?.version ?? null
  const input = {
    snapshotId,
    generatedAt: now,
    githubSyncedAt: now,
    trunkCompilerVersion,
    coverage: {
      mode: 'bounded-sample',
      note: 'Recently updated open PRs and issues sampled by GitHub label and collection limits. Counts cover only items classified into the tracked modules.',
    },
    prs: observations.prs
      .map((pr) => triagePr(pr, { now, reviewerHistory: observations.reviewerHistory }))
      .filter(Boolean),
    issues: candidates.map((candidate) => candidate.detail),
  }
  const state = {
    version: stateVersion,
    repository,
    githubSyncedAt: now,
    trunkCompilerVersion,
    issues,
  }
  if (!dryRun) buildSnapshot(input, output)
  return { input, state, attempted, queued: queue.length, warnings }
}

function readState(path) {
  if (!path) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function writeState(path, state) {
  const target = resolve(path)
  mkdirSync(dirname(target), { recursive: true })
  const temp = mkdtempSync(join(dirname(target), '.llvm-state-'))
  try {
    const file = join(temp, 'state.json')
    writeFileSync(file, JSON.stringify(state))
    renameSync(file, target)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function integer(name, fallback) {
  const value = process.env[name]
  if (!value) return fallback
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`Invalid ${name}`)
  return Number(value)
}

async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      state: { type: 'string' },
      'snapshot-id': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  const repository = process.env.UPSTREAM_GITHUB_REPOSITORY || defaultGitHubOptions.repository
  const maxReverify = integer('MAX_REVERIFY_PER_RUN', defaultMaxReverify)
  const maxIssues = integer('GITHUB_MAX_ISSUES', defaultGitHubOptions.maxIssues)
  const now = new Date().toISOString()
  const labels = (process.env.GITHUB_MODULE_LABELS || '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
  const snapshotId = values['snapshot-id'] ?? `live-${now.toLowerCase().replace(/[:.]/g, '')}`
  const collector = createGitHubCollector({
    repository,
    token: process.env.GITHUB_TOKEN,
    labels: labels.length ? labels : defaultGitHubOptions.labels,
    maxPages: integer('GITHUB_MAX_PAGES', defaultGitHubOptions.maxPages),
    maxPulls: integer('GITHUB_MAX_PRS', defaultGitHubOptions.maxPulls),
    maxIssues,
    maxHistory: integer('GITHUB_MAX_HISTORY', defaultGitHubOptions.maxHistory),
    timeoutMs: integer('GITHUB_TIMEOUT_MS', defaultGitHubOptions.timeoutMs),
    requestBudget: integer('GITHUB_REQUEST_BUDGET', defaultGitHubOptions.requestBudget),
  })
  const client = createCompilerExplorerClient({
    timeoutMs: integer('COMPILER_EXPLORER_TIMEOUT_MS', 15_000),
    requestBudget: integer('COMPILER_EXPLORER_REQUEST_BUDGET', 2 + maxIssues + 2 * maxReverify),
  })
  const { input, state, attempted, queued, warnings } = await prepareSnapshot({
    collector,
    client,
    repository,
    now,
    snapshotId,
    maxReverify,
    previousState: readState(values.state),
    output: values.output,
    dryRun: values['dry-run'],
    baselineId: process.env.CLANG_BASELINE_ID,
    trunkId: process.env.CLANG_TRUNK_ID || undefined,
    cBaselineId: process.env.CLANG_C_BASELINE_ID,
    cTrunkId: process.env.CLANG_C_TRUNK_ID,
  })
  if (values.state && !values['dry-run']) writeState(values.state, state)
  for (const warning of warnings) console.warn(warning)
  console.log(
    `${values['dry-run'] ? 'Dry run' : 'Published'} ${snapshotId}: ${input.prs.length} PRs, ${input.issues.length} issues, ${attempted}/${queued} scheduled rechecks.`,
  )
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
