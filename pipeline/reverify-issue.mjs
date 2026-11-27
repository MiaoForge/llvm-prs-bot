import { CompilerExplorerError } from "./compiler-explorer.mjs";
import { matchRun, verifyIssue } from "./issue-verification.mjs";

export async function reverifyIssue(issue, { client, verifiedAt }) {
  const runs = { baseline: null, trunk: null };
  const failures = {};
  const { sourceCode, compileArgs, expectedBehavior } = issue.repro ?? {};
  if (sourceCode && Array.isArray(compileArgs) && expectedBehavior) {
    for (const side of ["baseline", "trunk"]) {
      const compilerId = issue.compilers?.[side];
      if (!compilerId) continue;
      try {
        const { truncated, ...run } = await client.compile({
          compilerId, sourceCode, compileArgs, language: issue.language,
          godboltUrl: issue.godboltUrls?.[side] ?? null,
        });
        runs[side] = { ...run, outcome: truncated ? "unknown" : matchRun(run, issue.expectations) };
      } catch (error) {
        if (!(error instanceof CompilerExplorerError)) throw error;
        failures[side] = { code: error.code, message: error.message };
      }
    }
  }
  const baselineVersionKnown = failures.baseline?.code === "compiler-unavailable"
    ? false : issue.baselineVersionKnown ?? (issue.compilers?.baseline ? undefined : false);
  const detail = verifyIssue({ ...issue, runs, baselineVersionKnown,
    lastVerifiedAt: runs.baseline || runs.trunk ? verifiedAt : null });
  return { detail, failures };
}
