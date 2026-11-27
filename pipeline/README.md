# Triage pipeline

The pipeline consumes normalized records. Producers retain responsibility for
fetching upstream data and marking coverage. Rules operate on passed-in
observations and timestamps and can be tested without network access.

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
180 days. `reviewerHistory` contains prior reviews with `prId`, `login`,
`isBot`, `paths`, optional `labels`, and the review `url`. Suggestions favor
exact touched paths over module-only matches and count each historical PR once
per reviewer.
