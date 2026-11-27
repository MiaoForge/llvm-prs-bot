import { compilerExplorerClientstateUrl, CompilerExplorerError } from './compiler-explorer.mjs'
import { matchRun, verifyIssue } from './issue-verification.mjs'

export async function reverifyIssue(issue, { client, verifiedAt }) {
  const runs = { baseline: null, trunk: null }
  const failures = {}
  const { sourceCode, compileArgs, expectedBehavior } = issue.repro ?? {}
  if (sourceCode && Array.isArray(compileArgs) && expectedBehavior) {
    for (const side of ['baseline', 'trunk']) {
      const compilerId = issue.compilers?.[side]
      if (!compilerId) continue
      try {
        const language = issue.language ?? 'c++'
        const godboltUrl =
          issue.godboltUrls?.[side] ??
          compilerExplorerClientstateUrl({ compilerId, sourceCode, compileArgs, language })
        const { truncated, ...run } = await client.compile({
          compilerId,
          sourceCode,
          compileArgs,
          language,
          godboltUrl,
        })
        runs[side] = { ...run, outcome: truncated ? 'unknown' : matchRun(run, issue.expectations) }
      } catch (error) {
        if (!(error instanceof CompilerExplorerError)) throw error
        failures[side] = { code: error.code, message: error.message }
      }
    }
  }
  const baselineVersionKnown =
    issue.baselineVersionKnown ??
    Boolean(issue.compilers?.baseline && failures.baseline?.code !== 'compiler-unavailable')
  const detail = verifyIssue({
    ...issue,
    runs,
    baselineVersionKnown,
    lastVerifiedAt: runs.baseline || runs.trunk ? verifiedAt : null,
  })
  return { detail, failures }
}
