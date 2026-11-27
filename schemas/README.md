# V1 static snapshot contract

The six JSON Schema documents use Draft 2020-12. The five document schemas
reference `common.schema.json` for shared fields and enumerations. Schema IDs
identify the documents within the validator and resolve locally.

```text
data/
  summary.json
  snapshots/<snapshotId>/
    modules/<moduleId>/prs-index.json
    modules/<moduleId>/issues-index.json
    items/pr-<id>.json
    items/issue-<id>.json
```

Read `summary.json` first, then resolve the remaining paths under its
`snapshotRoot`, relative to `summary.json`. Pin an index and all of its
details to that root. If a shard becomes unavailable, reload the entry point
before selecting a new snapshot. `schemaVersion` is the contract version
and `snapshotId` identifies the published dataset. `generatedAt` is the
publication time recorded by the producer. `githubSyncedAt` records the
latest snapshot-level sync, and `trunkCompilerVersion` identifies the
current verification target. Individual issues retain their own run versions.

Each index contains the fields needed for the list, filters, and sorting.
Details repeat those fields exactly and add evidence. A numbered entry has one
detail per snapshot and is listed once in each module it belongs to. Global
counts deduplicate each item kind by ID. A PR can enter multiple queues, so
the queue counts can add up to more than `prTotal`. Each issue has one
conclusion. `generatedByFuzzer` counts a source independently of conclusions.

## PR triage

- `headReview`, `headCi`, and `requiredChecks` carry the current `headSha`.
  An unavailable observation has status `unknown`. `latestApproval` can
  point to an earlier revision, with `commitsSinceApproval` set to null
  when the distance is unavailable. Do not promote a historical approval
  to the current head.
- Human and bot activity timestamps are independently nullable. Use the
  human timestamp for inactivity and sorting. Timeline records carry
  `isBot`, an evidence URL, and a commit SHA when the event has one.
- `requestedReviewers` records GitHub requests. Each `suggestedReviewers`
  entry carries a reason and at least one evidence URL. `priority` sorts in
  descending order. Queue explanations may link to their evidence through
  `reasonEvidenceUrls`.

## Issue verification

- `source` captures provenance, including `generated-by-fuzzer`, and
  `kind` classifies the reported symptom. `originalReportAt` can predate
  GitHub when the report was imported. The GitHub sync and most recent
  verification have separate timestamps. A null `lastVerifiedAt` indicates
  no recorded verification time.
- The repro holds source code, argument tokens in original order, and
  expected behavior. Null denotes missing information. An empty argument
  array denotes a known invocation with no explicit arguments. Each non-null
  run records the actual compiler ID and version, integer exit code, raw
  diagnostics, symptom comparison outcome, and a Godbolt URL when available.
- A close candidate reproduced the reported symptom on the baseline and
  met the expected behavior on trunk. A still-reproducible issue showed the
  reported symptom on both runs. A passing trunk run with an unverified baseline
  remains insufficient evidence. Exit status alone cannot identify a symptom.
  Incomplete comparisons list missing evidence. A conclusive fuzzer crash
  comparison requires its crash signature.
- `fixAttribution` records a separate judgment. A candidate or confirmed
  commit includes its full SHA, reasoning, and evidence URLs. A close
  candidate can have unknown attribution.

The mock snapshot includes overlapping PR queues, cross-module membership,
unknown and historical head evidence, matched and unmatched issue baselines,
and fuzzer issues with different conclusions. Mock URLs, identities, compiler
outputs, and commit SHAs are synthetic.
