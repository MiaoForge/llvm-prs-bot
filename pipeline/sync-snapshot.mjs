import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildSnapshot } from './build-snapshot.mjs'
import { CompilerExplorerError, createCompilerExplorerClient } from './compiler-explorer.mjs'
import { selectClangCompilers } from './compiler-selection.mjs'
import { createGitHubCollector, defaultGitHubOptions } from './github-collector.mjs'
import { verifyIssue } from './issue-verification.mjs'
import { triagePr } from './pr-triage.mjs'
import { reverifyIssue } from './reverify-issue.mjs'
import { supportsCompileArgs } from './reproducer.mjs'

const defaultOutput = fileURLToPath(new URL('../data/', import.meta.url))
const stateVersion = 1

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

function canVerify(issue) {
  const { repro, expectations } = issue
  return Boolean(
    !issue.versionAmbiguous &&
      issue.language &&
      repro.sourceCode &&
      repro.expectedBehavior &&
      supportsCompileArgs(repro.compileArgs) &&
      expectations.reported.diagnosticIncludes &&
      Object.keys(expectations.expected).length > 0,
  )
}

export async function prepareSnapshot({
  collector,
  client,
  repository,
  output = defaultOutput,
  previousState,
  now,
  snapshotId,
  maxReverify = 4,
  baselineId,
  trunkId,
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
  const issues = {}
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
  for (const issue of observations.issues) {
    const eligible = canVerify(issue)
    const available = eligible ? await catalog(issue.language) : []
    const resolved = selectClangCompilers(available ?? [], {
      declaredVersion: issue.declaredVersion,
      baselineId,
      trunkId,
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
    // A catalog outage should not evict evidence that can be reused when it returns.
    issues[issue.id] =
      available === null && previous
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
  const maxReverify = integer('MAX_REVERIFY_PER_RUN', 4)
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
    maxIssues: integer('GITHUB_MAX_ISSUES', defaultGitHubOptions.maxIssues),
    maxHistory: integer('GITHUB_MAX_HISTORY', defaultGitHubOptions.maxHistory),
    timeoutMs: integer('GITHUB_TIMEOUT_MS', defaultGitHubOptions.timeoutMs),
    requestBudget: integer('GITHUB_REQUEST_BUDGET', defaultGitHubOptions.requestBudget),
  })
  const client = createCompilerExplorerClient({
    timeoutMs: integer('COMPILER_EXPLORER_TIMEOUT_MS', 15_000),
    requestBudget: integer('COMPILER_EXPLORER_REQUEST_BUDGET', 2 + 2 * maxReverify),
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
