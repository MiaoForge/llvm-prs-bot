# LLVM Backlog Triage Web

Use Node.js 20.19+, 22.12+, or a newer supported LTS release. From the
repository root, install dependencies and start the workbench.

```sh
npm ci --prefix web
npm --prefix web run dev
```

Run the type check, tests, and production build.

```sh
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
npm --prefix web run preview
```

Publish `web/dist/` as the GitHub Pages artifact. The default relative base
works at the root and under a repository path. Set `VITE_BASE_PATH` to an
explicit path such as `/llvm-prs-bot/` for the build and its matching preview.

Development reads the repository's `data/` directory directly. The production
build copies it into `web/dist/data/`. Regenerate the committed frontend types
with `npm --prefix web run generate:types` after a change to the snapshot schemas.
