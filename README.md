# LLVM PR and issue triage

A static workbench for reviewing LLVM GitHub pull requests and compiler issue
verification evidence. The initial module is Clang / Sema.

- `schemas/` defines the versioned JSON contracts shared by producers and the UI.
- `pipeline/` owns collection, triage, verification, and snapshot validation.
  Keep classification rules independent of GitHub, Compiler Explorer, and file
  I/O so they can be tested with deterministic inputs.
- `data/` contains the static entry point `summary.json` and versioned shards
  under `snapshots/<snapshotId>/`. Consumers pin reads to the selected snapshot.
- `web/` owns the read-only static workbench.

Use one independently reviewable change per commit. Write an imperative title
in the form `[component] Concise summary` and explain why the change is needed
and how it was tested in the commit body.

## Format and lint

From the repository root, install the pinned Biome tool with `npm ci`.

```sh
npm run format        # Apply the formatter
npm run format:check  # Check formatting without writing files
npm run lint          # Check static rules and treat warnings as failures
```

These commands check JavaScript, TypeScript, CSS, and JSON source in
`pipeline/` and `web/`, plus the hand-written JSON schemas in `schemas/`.
They skip dependencies, lockfiles, the web build,
and schema-generated TypeScript. CI runs both checks on pushes and pull
requests.

## Validate the mock snapshot

From the repository root, with Node.js 24 and npm installed:

```sh
npm ci --prefix pipeline
npm --prefix pipeline run validate
npm --prefix pipeline test
```

Pass a different data directory to `node pipeline/validate-snapshot.mjs`
to validate another snapshot. The [V1 contract guide](schemas/README.md)
describes the shard layout and evidence semantics.

## Pipeline and deployment

The [pipeline guide](pipeline/README.md) shows how to derive triage results
from normalized observations and publish a validated static snapshot.

CI runs on pushes and pull requests. It validates the committed snapshot,
runs pipeline and web tests, typechecks the web app, and checks a project-site
build with the repository as its URL base path.

Enable **GitHub Actions** as the Pages source in the repository settings to
deploy. Run the Pages workflow manually from the default branch and provide the
`snapshot_id` from `data/summary.json`. It validates that ID and the complete
snapshot both before and after the Pages build. The current checked-in
snapshot is a demo. A future production workflow can build `data/` from
collected upstream inputs before these checks.
