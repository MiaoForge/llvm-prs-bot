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
detail per snapshot and is listed once in each module it belongs to. Keep only
indexed details in the current snapshot's `items/` directory. Global
counts deduplicate each item kind by ID. A PR can enter multiple queues, so
the queue counts can add up to more than `prTotal`. Each issue has one
conclusion. `generatedByFuzzer` counts a source independently of conclusions.

## PR triage

- `headReview`, `headCi`, and `requiredChecks` carry the current `headSha`.
  Incomplete CI coverage can be recorded as `unknown`. A failing required
  check rules out a `passing` CI summary.
- `latestApproval` can point to an earlier revision. `commitsSinceApproval`
  is zero when the approval SHA is the head SHA and a positive integer when
  the SHAs differ and the distance is known. Use null when there is no approval
  or the distance is unknown, for example after a force-push.
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
  Incomplete comparisons list exactly the gaps indicated by their structured
  fields, with `other` available for additional reasons. Use `baseline-version`
  when a baseline version is unavailable and there is no baseline run. A
  conclusive fuzzer crash comparison requires its crash signature.
- `fixAttribution` records a separate judgment. A candidate or confirmed
  commit includes its full SHA, reasoning, and evidence URLs. A close
  candidate can have unknown attribution.

The mock snapshot includes overlapping PR queues, cross-module membership,
unknown and historical head evidence, matched and unmatched issue baselines,
and fuzzer issues with different conclusions. Mock URLs, identities, compiler
outputs, and commit SHAs are synthetic.
