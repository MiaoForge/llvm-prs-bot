export function issueSource({ labels = [], reporterIsBot }) {
  if (labels.some((label) => /^generated[- ]by[- ]fuzzer$/i.test(label.trim()))) {
    return 'generated-by-fuzzer'
  }
  return reporterIsBot === false ? 'human-reported' : 'unknown'
}

export function extractCrashSignature(diagnostics) {
  const lines = diagnostics.split(/\r?\n/).map((line) => line.trim())
  // Prefer a specific assertion or fatal diagnostic to a generic crash banner.
  return (
    lines.find((line) =>
      /\b(assertion\b.*\bfailed|assertion failure|LLVM ERROR:|fatal error: error in backend:)/i.test(
        line,
      ),
    ) ??
    lines.find(
      (line) =>
        /\b(segmentation fault|stack overflow|internal compiler error|SIG(?:ABRT|SEGV|ILL|BUS))\b/i.test(
          line,
        ) || /PLEASE submit a bug report|clang frontend command failed due to signal/i.test(line),
    ) ??
    null
  )
}

export function structuredEvidenceGaps(issue) {
  const { baseline, trunk } = issue.runs
  const gaps = [
    [issue.repro.sourceCode === null, 'source-code'],
    [issue.repro.compileArgs === null, 'compile-arguments'],
    [issue.repro.expectedBehavior === null, 'expected-behavior'],
    [baseline === null, 'baseline-run'],
    [baseline !== null && baseline.outcome !== 'reported-symptom', 'baseline-symptom'],
    [trunk === null, 'trunk-run'],
    [['unknown', 'different-behavior'].includes(trunk?.outcome), 'trunk-outcome'],
    [
      issue.source === 'generated-by-fuzzer' &&
        issue.kind === 'crash' &&
        issue.crashSignature === null,
      'crash-signature',
    ],
  ]
  return gaps.filter(([absent]) => absent).map(([, reason]) => reason)
}

function preview(run) {
  return run && { compilerVersion: run.compilerVersion, outcome: run.outcome }
}

export function verifyIssue(record) {
  const { id, title, url, moduleIds, originalReportAt, githubSyncedAt } = record
  const source = issueSource(record)
  const kind = record.kind ?? 'unknown'
  const repro = {
    sourceCode: record.repro?.sourceCode ?? null,
    compileArgs: record.repro?.compileArgs ?? null,
    expectedBehavior: record.repro?.expectedBehavior ?? null,
    sourceUrl: record.repro?.sourceUrl ?? null,
    ...(record.repro?.reporterGodboltUrls?.length
      ? { reporterGodboltUrls: record.repro.reporterGodboltUrls }
      : {}),
  }
  const baseline = record.runs?.baseline ?? null
  const trunk = record.runs?.trunk ?? null
  const reportedCrashSignature = kind === 'crash' ? (record.reportedCrashSignature ?? null) : null
  const crashSignature =
    kind === 'crash' && baseline?.outcome === 'reported-symptom'
      ? (extractCrashSignature(baseline.diagnostics) ?? reportedCrashSignature)
      : reportedCrashSignature
  const runs = { baseline, trunk }
  const fixAttribution = record.fixAttribution ?? { status: 'unknown' }
  const lastVerifiedAt = record.lastVerifiedAt ?? null
  const missingEvidence = structuredEvidenceGaps({ source, kind, repro, runs, crashSignature })
  if (baseline === null && record.baselineVersionKnown === false) {
    missingEvidence.push('baseline-version')
  }
  if (record.otherEvidenceMissing || (missingEvidence.length === 0 && lastVerifiedAt === null)) {
    missingEvidence.push('other')
  }
  const conclusion =
    missingEvidence.length > 0
      ? 'insufficient-evidence'
      : trunk.outcome === 'expected-behavior'
        ? 'close-candidate'
        : 'still-reproducible'
  return {
    id,
    title,
    url,
    moduleIds,
    ...(record.moduleEvidence?.length ? { moduleEvidence: record.moduleEvidence } : {}),
    originalReportAt,
    githubSyncedAt,
    source,
    kind,
    repro,
    runs,
    originalReportTracker: record.originalReportTracker ?? 'unknown',
    lastHumanCommentAt: record.lastHumanCommentAt ?? null,
    lastVerifiedAt,
    crashSignature,
    missingEvidence,
    conclusion,
    baseline: preview(baseline),
    trunk: preview(trunk),
    fixStatus: fixAttribution.status,
    fixAttribution,
  }
}

export function matchRun(run, { reported = {}, expected = {} } = {}) {
  // The exit status alone cannot identify a reported symptom.
  const signature = extractCrashSignature(run.diagnostics)
  const reportedMatches = reported.diagnosticIncludes
    ? run.diagnostics.includes(reported.diagnosticIncludes) &&
      (reported.exitCode === undefined || run.exitCode === reported.exitCode)
    : reported.crash === true && run.exitCode !== 0 && signature !== null
  const hasReportedCheck = Boolean(reported.diagnosticIncludes || reported.crash === true)
  const hasExpectedCheck =
    Number.isInteger(expected.exitCode) ||
    Boolean(expected.diagnosticIncludes) ||
    expected.noCrash === true
  const expectedMatches =
    hasExpectedCheck &&
    (expected.exitCode === undefined || run.exitCode === expected.exitCode) &&
    (!expected.diagnosticIncludes || run.diagnostics.includes(expected.diagnosticIncludes)) &&
    (!expected.diagnosticExcludes || !run.diagnostics.includes(expected.diagnosticExcludes)) &&
    (!expected.noCrash || [0, 1].includes(run.exitCode)) &&
    run.exitCode >= 0 &&
    run.exitCode < 128 &&
    signature === null
  if (reportedMatches && expectedMatches) return 'unknown'
  if (reportedMatches) return 'reported-symptom'
  if (expectedMatches) return 'expected-behavior'
  return hasReportedCheck && hasExpectedCheck ? 'different-behavior' : 'unknown'
}
