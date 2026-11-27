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
