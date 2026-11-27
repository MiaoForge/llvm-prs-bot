# Triage pipeline

## Sync from LLVM GitHub

Use Node.js 24. Live synchronization defaults to `llvm/llvm-project` and
the `clang:frontend`, `clang:sema` and `clang:ast` labels. Label matches are
combined across searches. The broad `clang:frontend` label discovers candidates.
Module membership requires a matching path or a specific module label. Each
run refreshes a bounded, recently updated window of open PRs and issues and
samples recently merged PRs for reviewer evidence. The summary declares this
coverage as `bounded-sample`.

```sh
npm ci --prefix pipeline
npm --prefix pipeline run sync
node pipeline/sync-snapshot.mjs --output /path/to/data --state /path/to/triage-state.json
node pipeline/sync-snapshot.mjs --dry-run
```

The default output is `data/`. Dry runs query upstream and the compiler
catalog but skip compilation and leave both the snapshot and state untouched.
Keep the optional state file outside the published data directory. It stores
the last synchronization time and cached comparisons, including evidence for
issues outside the current window.
The next run reuses comparisons with unchanged issue inputs and compiler
versions. If either changes, it queues a recheck and shows insufficient
evidence until a fresh comparison is available. Least recently attempted
issues are tried first. Without a state file, no past results are assumed
and the same per-run budget applies.

| Environment variable | Default |
| --- | --- |
| `UPSTREAM_GITHUB_REPOSITORY` | `llvm/llvm-project` |
| `GITHUB_MODULE_LABELS` | `clang:frontend,clang:sema,clang:ast` |
| `GITHUB_TOKEN` | Optional token with read access |
| `GITHUB_MAX_PAGES` / `GITHUB_MAX_PRS` / `GITHUB_MAX_ISSUES` / `GITHUB_MAX_HISTORY` | 3 / 25 / 30 / 6 |
| `GITHUB_REQUEST_BUDGET` / `GITHUB_TIMEOUT_MS` | 400 / 15,000 |
| `MAX_REVERIFY_PER_RUN` | 6 issue comparisons |
| `COMPILER_EXPLORER_REQUEST_BUDGET` / `COMPILER_EXPLORER_TIMEOUT_MS` | Two catalog requests plus two requests per allowed issue / 15,000 |
| `CLANG_BASELINE_ID` / `CLANG_TRUNK_ID` | Latest stable Clang 22 for C++ / `clang_trunk` |
| `CLANG_C_BASELINE_ID` / `CLANG_C_TRUNK_ID` | Latest stable Clang 22 for C / `cclang_trunk` |

An explicitly reported Clang version takes precedence over the default.
Major-only declarations can match the latest stable release of that major.
A specific release requires a matching catalog entry. The sample data uses
synthetic Clang 22.1.0 observations.

GitHub requests are serial. Collection stops between records when the
remaining request budget cannot cover a complete record at the page limit.

The collector preserves the GitHub creation timestamp for migrated Bugzilla
issues unless the report supplies an explicit original date. A pull request
whose head or update timestamp changes during collection is left for the next
run. Unavailable protection metadata leaves CI coverage unknown. The
reproducer extractor accepts an unambiguous C or C++ Markdown source block,
one single-file compile invocation or a flags line, and explicitly stated
behavior. Other inputs remain visible with evidence gaps. Only supported
portable compile options are submitted to Compiler Explorer.

Compound expectations that cannot be fully checked remain evidence gaps.
The rules consume normalized records. The collector marks upstream coverage
before applying them. Rules operate on passed-in observations and timestamps
and can be tested without network access.

## PR observations

`triagePr(record, options)` returns a PR detail before snapshot metadata is
added. It returns null for records outside the tracked modules. The default
modules cover Clang Sema and AST by checked paths or normalized labels.

Provide the item ID, title, URL, author, creation time and current SHA. The
optional `paths`, `labels`, `events`, `checks` and `requestedReviewers` fields
default to empty arrays. Include reviewer and check coverage explicitly with
`reviewsComplete` and `requiredChecksComplete`. For each check, provide its SHA,
status and whether it is required. A complete empty required-check set indicates
that there are no required checks.

Events carry the V1 timeline fields plus `reviewState` for reviews and
`mergeHelpRequested` for a comment confirmed to ask for merge assistance. A
dismissal invalidates the last decisive review for that reviewer. Provide the
reviewer's identity as the actor in that normalized review event. When
available, `commitsAheadBySha` supplies proven positive ancestry distances
relative to the current HEAD.

Pass a fixed `now` for inactivity calculations. The threshold defaults to
180 days. Set `authorIsBot: false` when a human opened the PR. Creation then
counts as human activity when the timeline has no human events. Inactivity
requires complete review, comment, commit and timeline pagination. Mark
commit events with `isPush: true` only for observed pushes. Git commit
metadata can identify the current SHA, but its timestamp is not evidence of
PR activity.
`reviewerHistory` contains prior reviews with `prId`, `login`,
`isBot`, the historical PR `author`, `paths`, optional `labels`, and the review
`url`. A historical PR author's own replies are excluded. Suggestions favor
exact touched paths over module-only matches and count each historical PR once
per reviewer.

## Issue verification

`verifyIssue(record)` builds an issue detail from report metadata, extracted
reproduction input, and optional compiler observations. Supply `moduleIds`,
`originalReportAt` and `githubSyncedAt` with the item identity. The
`generated by fuzzer` label (space or hyphen form) determines fuzzer provenance.
An observed human reporter can be marked with `reporterIsBot: false`.

Reproduction input contains source, compiler argument tokens and the expected
behavior. A run's outcome compares the observed behavior to the report.
A nonzero exit code alone cannot identify the reported symptom. The
verification timestamp applies to the recorded observations. A separately
supplied `fixAttribution` can carry evidence about a fix commit.

`reverifyIssue(record, { client, verifiedAt })` obtains observations via the
injected client, accepts `compilers: { baseline, trunk }` as Compiler Explorer
IDs and returns `{ detail, failures }`. Supply `expectations.reported` with a
case-sensitive `diagnosticIncludes` marker and optional `exitCode`. Supply
`expectations.expected` with an exit code or a diagnostic marker and,
optionally, a `diagnosticExcludes` marker. An ambiguous or truncated result
remains unknown. Existing links can be supplied through `godboltUrls`.
A known historical version (`baselineVersionKnown: true`) remains known if a
compile attempt fails. An explicitly supplied `reportedCrashSignature` is
retained for crash reports of any source.

`createCompilerExplorerClient` bounds requests with a per-client budget
(12 by default, including compiler discovery) and a per-request timeout
(15 seconds by default). Use a new client per batch. Recorded versions come
from the Compiler Explorer catalog fetched for that batch. The client compiles
single-file inputs with execution disabled and does not create public links.
Tests inject `fetchImpl` for all HTTP calls. See the
[Compiler Explorer API](https://github.com/compiler-explorer/compiler-explorer/blob/main/docs/API.md).

## Build a snapshot

Use Node.js 24. From the repository root:

```sh
npm ci --prefix pipeline
npm --prefix pipeline run build:snapshot -- /path/to/normalized.json /path/to/data
npm --prefix pipeline run validate -- /path/to/data
```

The input JSON object contains `snapshotId`, `generatedAt`, and the
`prs` and `issues` detail arrays produced by the rules. Both arrays are required
and may be explicitly empty. The input can also supply
`githubSyncedAt`, `trunkCompilerVersion`, and `modules` (ID and name pairs).
Omitted module definitions use Clang Sema and AST. The builder deduplicates
identical items of the same kind and ID and rejects conflicting duplicates.

The builder stages and validates the complete output before installing the
shards. It replaces `summary.json` last, keeps older snapshot directories
and allows a retry with identical shards for the same snapshot ID. Use a new
ID when shard contents change.
