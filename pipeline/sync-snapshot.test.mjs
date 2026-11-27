import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCompilerExplorerClient } from './compiler-explorer.mjs'
import { selectClangCompilers } from './compiler-selection.mjs'
import { createGitHubCollector } from './github-collector.mjs'
import { prepareSnapshot } from './sync-snapshot.mjs'
import { validateSnapshot } from './validate-snapshot.mjs'

const repository = 'llvm/project'
const head = 'a'.repeat(40)
const actor = { login: 'author', type: 'User' }
const now = '2026-11-27T03:00:00.000Z'
const html_url = 'https://github.example.invalid/llvm/project'
const crashLink = 'https://compiler-explorer.com/z/crashFixture'
const crashSource = 'int x;\n'
const crashDiagnostic = "clang: fixture.cpp: Assertion 'fixture' failed."
const response = (data) => Response.json(data)
const release = (id, semver, releaseTrack = 'stable') => ({
  id,
  semver,
  releaseTrack,
  compilerType: 'clang',
  version: `clang version ${semver}`,
})
const catalog = [
  release('clang2110', '21.1.0'),
  release('clang120assert', '12.0.0 (assertions)'),
  release('clang2210', '22.1.0'),
  release('clang2212', '22.1.2'),
  release('clang2220', '22.2.0', 'nightly'),
  release('clang2219assert', '22.1.9'),
  release('clang_trunk', '23.0.0git', 'nightly'),
]
const cCatalog = [
  release('cclang2110', '21.1.0'),
  release('cclang2210', '22.1.0'),
  release('cclang2212', '22.1.2'),
  release('cclang_trunk', '23.0.0git', 'nightly'),
]

test('selects the newest stable Clang 22 and matches declared versions exactly', () => {
  const select = (declaredVersion, baselineId) =>
    selectClangCompilers(catalog, { declaredVersion, baselineId }).baseline?.id
  assert.equal(select(), 'clang2212')
  assert.equal(select('22.1'), 'clang2212')
  assert.equal(select('22.1.0'), 'clang2210')
  assert.equal(select('21', 'clang2210'), 'clang2110')
  assert.equal(select('19', 'clang2210'), undefined)
  assert.equal(select(undefined, 'clang2210'), 'clang2210')
})

test('resolves release, declared version and overrides in each language catalog', () => {
  for (const [language, entries, prefix] of [
    ['c', cCatalog, 'cclang'],
    ['c++', catalog, 'clang'],
  ]) {
    const pick = (options) => selectClangCompilers(entries, { language, ...options })
    assert.equal(pick().baseline.id, `${prefix}2212`)
    assert.equal(pick().trunk.id, `${prefix}_trunk`)
    assert.equal(
      pick({ declaredVersion: '21.1.0', baselineId: `${prefix}2210` }).baseline.id,
      `${prefix}2110`,
    )
    const overridden = pick({ baselineId: `${prefix}2210`, trunkId: `${prefix}2110` })
    assert.equal(overridden.baseline.id, `${prefix}2210`)
    assert.equal(overridden.trunk.id, `${prefix}2110`)
  }
})

function snapshotDirectory(context) {
  const temp = mkdtempSync(join(tmpdir(), 'llvm-sync-'))
  context.after(() => rmSync(temp, { recursive: true, force: true }))
  return join(temp, 'data')
}

function transports({
  nextVersion = false,
  changed = false,
  unavailable = false,
  issueNumbers = [2, 3],
  cIssue = false,
  coarseOnlyPr = false,
  expectedWarning = false,
  crash,
  shortlinkDiag,
  requestBudget,
} = {}) {
  const compilations = []
  const item = {
    state: 'open',
    title: 'unexpected diagnostic',
    html_url,
    user: actor,
    created_at: now,
    updated_at: now,
    labels: [{ name: 'clang:frontend' }, { name: 'clang:sema' }],
  }
  const collector = createGitHubCollector({
    repository,
    labels: ['clang:frontend'],
    baseUrl: 'https://github.example.invalid/',
    maxHistory: 0,
    async fetchImpl(url) {
      assert.equal(url.origin, 'https://github.example.invalid')
      const path = url.pathname
      if (path === '/search/issues')
        return response({
          items: (url.searchParams.get('q').includes('is:issue') ? issueNumbers : [1]).map(
            (number) => ({
              ...item,
              number,
            }),
          ),
        })
      if (path.endsWith('/pulls/1'))
        return response({
          ...item,
          number: 1,
          head: { sha: head },
          base: { ref: 'main' },
          labels: coarseOnlyPr ? ['clang:frontend'] : item.labels,
        })
      if (path.endsWith('/pulls/1/files') && coarseOnlyPr) {
        return response([{ filename: 'clang/lib/Frontend/CompilerInstance.cpp' }])
      }
      if (path.endsWith('/check-runs')) return response({ check_runs: [] })
      if (path.endsWith('/protection/required_status_checks'))
        return new Response(null, { status: 401 })
      if (/\/issues\/[23]$/.test(path)) {
        const number = Number(path.at(-1))
        if (crash) {
          return response({
            ...item,
            number,
            title: 'Clang Assertion failure while compiling',
            body: crashLink,
            labels: [...item.labels, { name: 'generated-by-fuzzer' }],
          })
        }
        if (shortlinkDiag) {
          const lines = [
            shortlinkDiag.inlineSource ? `\`\`\`cpp\n${shortlinkDiag.inlineSource}\n\`\`\`` : '',
            'error: unexpected diagnostic',
            `Compiler Explorer: ${crashLink}`,
            'Expected behavior: should compile',
          ].filter(Boolean)
          return response({
            ...item,
            number,
            body: lines.join('\n'),
          })
        }
        const body = [
          number === 3 ? 'Clang 21.1.0' : 'Clang frontend',
          cIssue && number === 2 ? '```c' : '```cpp',
          'int example;',
          '```',
          cIssue && number === 2
            ? '`clang -std=c17 example.c`'
            : '`clang++ -std=c++20 example.cpp`',
          'error: unexpected diagnostic',
          'Compiler Explorer: https://godbolt.org/z/example',
          expectedWarning
            ? 'Expected behavior: should compile with a warning about unused variables'
            : 'Expected behavior: should compile',
        ].join('\n')
        return response({
          ...item,
          number,
          body,
          updated_at: number === 2 && changed ? '2026-11-28T03:00:00.000Z' : now,
        })
      }
      return response([])
    },
  })
  const nextCatalog = nextVersion
    ? [...catalog.slice(0, -1), release('clang_trunk', '24.0.0git', 'nightly')]
    : catalog
  const client = createCompilerExplorerClient({
    baseUrl: 'https://ce.example.invalid/',
    requestBudget,
    async fetchImpl(url, request) {
      assert.equal(url.origin, 'https://ce.example.invalid')
      if (url.pathname === '/api/shortlinkinfo/crashFixture') {
        assert.equal(request.method, 'GET')
        const cfg = shortlinkDiag ?? crash ?? {}
        const editor = {
          language: 'c++',
          source: cfg.sessionSource ?? crashSource,
          compilers: [
            { id: 'clang_trunk', options: '-std=c++20' },
            ...(cfg.release ? [{ id: 'clang2110', options: '-std=c++17' }] : []),
          ],
        }
        return response({ sessions: cfg.multiple ? [editor, editor] : [editor] })
      }
      if (request.method === 'GET') {
        const entries = url.pathname.endsWith('/c') ? cCatalog : nextCatalog
        return unavailable ? new Response(null, { status: 503 }) : response(entries)
      }
      const id = url.pathname.split('/').at(-2)
      compilations.push(id)
      const trunk = id.endsWith('_trunk')
      if (crash) {
        const body = JSON.parse(request.body)
        assert.equal(body.source, crashSource)
        assert.deepEqual(body.options.userArguments, [
          crash.release ? '-ferror-limit=0' : '-std=c++20',
        ])
        const crashed = !trunk || crash.trunkCrash
        return response({
          code: crashed ? 134 : 1,
          stdout: [],
          stderr: [{ text: crashed ? crashDiagnostic : 'fixture.cpp: error: invalid input' }],
        })
      }
      return response({
        code: trunk ? 0 : 1,
        stdout: [],
        stderr: trunk ? [] : [{ text: 'example.cpp:1:1: error: unexpected diagnostic' }],
      })
    },
  })
  return { collector, client, compilations }
}

async function sync(output, day, config = {}, previousState, dryRun = false) {
  const { collector, client, compilations } = transports(config)
  const result = await prepareSnapshot({
    output,
    collector,
    client,
    repository,
    previousState,
    maxReverify: 1,
    snapshotId: `fixture-day-${day}`,
    now: `2026-11-${day}T03:00:00.000Z`,
    dryRun,
  })
  return { ...result, compilations }
}

test('runs the complete pipeline offline and budgets and persists comparisons across syncs', async (context) => {
  const output = snapshotDirectory(context)
  const initial = await sync(output, 27)
  assert.equal(initial.attempted, 1)
  assert.equal(initial.queued, 2)
  assert.deepEqual(initial.compilations, ['clang2212', 'clang_trunk'])
  assert.deepEqual(
    initial.input.issues.map((issue) => issue.conclusion),
    ['insufficient-evidence', 'close-candidate'],
  )
  assert.equal(initial.input.prs[0].headCi.status, 'unknown')
  const issue = initial.input.issues.find((entry) => entry.id === 2)
  assert.deepEqual(issue.moduleEvidence, [
    { moduleId: 'clang-sema', matchedLabels: ['clang:sema'] },
  ])
  assert.deepEqual(issue.repro.reporterGodboltUrls, ['https://godbolt.org/z/example'])
  assert.ok(issue.runs.trunk.godboltUrl?.startsWith('https://godbolt.org/clientstate/'))
  assert.notEqual(issue.runs.trunk.godboltUrl, issue.repro.reporterGodboltUrls[0])
  assert.equal(
    validateSnapshot(output, { expectedSnapshotId: initial.input.snapshotId }).issueTotal,
    2,
  )

  const following = await sync(output, 28, {}, initial.state)
  assert.deepEqual(following.compilations, ['clang2110', 'clang_trunk'])
  assert.ok(following.input.issues.every((issue) => issue.conclusion === 'close-candidate'))
  assert.equal(following.state.issues[2].lastVerifiedAt, now)

  const changed = await sync(output, 29, { changed: true }, following.state)
  assert.deepEqual(changed.compilations, ['clang2212', 'clang_trunk'])
  assert.equal(changed.state.issues[3].lastVerifiedAt, following.state.issues[3].lastVerifiedAt)

  const bumped = await sync(output, 30, { changed: true, nextVersion: true }, changed.state)
  assert.equal(bumped.queued, 2)
  assert.deepEqual(bumped.compilations, ['clang2110', 'clang_trunk'])
  assert.equal(
    bumped.input.issues.find((issue) => issue.id === 2)?.conclusion,
    'insufficient-evidence',
  )
  assert.equal(bumped.state.trunkCompilerVersion, 'clang version 24.0.0git')
})

test('dry run performs discovery without compiling or writing a snapshot', async (context) => {
  const output = snapshotDirectory(context)
  const result = await sync(output, 27, {}, undefined, true)
  assert.equal(result.queued, 2)
  assert.equal(result.attempted, 0)
  assert.deepEqual(result.compilations, [])
  assert.equal(existsSync(output), false)
})

test('preserves cached evidence through a compiler catalog outage', async (context) => {
  const output = snapshotDirectory(context)
  const initial = await sync(output, 27)
  const outage = await sync(output, 28, { unavailable: true }, initial.state)
  assert.deepEqual(outage.state.issues[2], initial.state.issues[2])
  assert.equal(outage.input.trunkCompilerVersion, null)
  assert.equal(outage.attempted, 0)
  assert.ok(outage.warnings.some((warning) => warning.includes('HTTP 503')))
  assert.ok(outage.input.issues.every((issue) => issue.conclusion === 'insufficient-evidence'))
  const recovered = await sync(output, 29, {}, outage.state)
  assert.equal(recovered.state.issues[2].lastVerifiedAt, now)
  assert.deepEqual(recovered.compilations, ['clang2110', 'clang_trunk'])
})

test('retains off-window evidence for reuse and reports bounded coverage in the summary', async (context) => {
  const output = snapshotDirectory(context)
  const initial = await sync(output, 27)
  const narrowed = await sync(output, 28, { issueNumbers: [3] }, initial.state)
  assert.deepEqual(narrowed.state.issues[2], initial.state.issues[2])
  assert.deepEqual(
    narrowed.input.issues.map((issue) => issue.id),
    [3],
  )
  const returned = await sync(output, 29, {}, narrowed.state)
  assert.deepEqual(returned.compilations, [])
  const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'))
  assert.equal(summary.coverage.mode, 'bounded-sample')
  assert.match(summary.coverage.note, /sampled/)
  assert.equal(returned.input.issues.find((issue) => issue.id === 2)?.lastVerifiedAt, now)
})

test('uses the C catalog and excludes unsupported expectations and broad-only PRs', async (context) => {
  const output = snapshotDirectory(context)
  const valid = await sync(output, 27, { cIssue: true, coarseOnlyPr: true })
  assert.deepEqual(valid.compilations, ['cclang2212', 'cclang_trunk'])
  assert.equal(valid.input.issues.find((issue) => issue.id === 2)?.conclusion, 'close-candidate')
  assert.equal(
    JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8')).modules.find(
      (entry) => entry.id === 'clang-sema',
    ).counts.prTotal,
    0,
  )
  const warning = await sync(output, 28, { cIssue: true, expectedWarning: true }, valid.state)
  assert.deepEqual(warning.compilations, [])
  assert.equal(
    warning.input.issues.find((issue) => issue.id === 2)?.conclusion,
    'insufficient-evidence',
  )
})

test('hydrates diagnostic shortlinks and skips automated compilation for crash or fuzzer issues', async (context) => {
  const output = snapshotDirectory(context)
  const diag = await sync(output, 27, {
    shortlinkDiag: { release: true, sessionSource: 'int from_shortlink;\n' },
    issueNumbers: [2],
    requestBudget: 5,
  })
  assert.deepEqual(diag.warnings, [])
  assert.deepEqual(diag.compilations, ['clang2110', 'clang_trunk'])
  assert.equal(diag.input.issues[0].conclusion, 'close-candidate')
  assert.equal(diag.input.issues[0].repro.sourceCode, 'int from_shortlink;\n')
  assert.deepEqual(diag.input.issues[0].repro.compileArgs, ['-std=c++17'])
  assert.deepEqual(diag.input.issues[0].repro.reporterGodboltUrls, [crashLink])

  const fuzzerCrash = await sync(output, 28, {
    crash: { release: true },
    issueNumbers: [2],
    requestBudget: 5,
  })
  assert.deepEqual(fuzzerCrash.compilations, [])
  assert.equal(fuzzerCrash.attempted, 0)
  assert.equal(fuzzerCrash.input.issues[0].conclusion, 'insufficient-evidence')
  assert.equal(fuzzerCrash.input.issues[0].source, 'generated-by-fuzzer')
  assert.deepEqual(fuzzerCrash.input.issues[0].repro.reporterGodboltUrls, [crashLink])
})

test('refuses to mix conflicting inline source with shortlink compiler arguments', async (context) => {
  const output = snapshotDirectory(context)
  for (const [day, inlineSource, sessionSource] of [
    [27, 'int from_body;', 'int from_shortlink;'],
    [28, 'static_assert(__LINE__ == 1);', '\nstatic_assert(__LINE__ == 1);\n'],
  ]) {
    const conflict = await sync(output, day, {
      shortlinkDiag: { inlineSource, sessionSource },
      issueNumbers: [2],
      requestBudget: 5,
    })
    assert.deepEqual(conflict.compilations, [])
    assert.equal(conflict.attempted, 0)
    const [issue] = conflict.input.issues
    assert.equal(issue.conclusion, 'insufficient-evidence')
    assert.equal(issue.repro.sourceCode, `${inlineSource}\n`)
    assert.equal(issue.repro.compileArgs, null)
    assert.deepEqual(issue.repro.reporterGodboltUrls, [crashLink])
  }
})

test('retains shortlink provenance when the budget is exhausted or the session is unsupported', async (context) => {
  const output = snapshotDirectory(context)
  for (const config of [
    { shortlinkDiag: {}, requestBudget: 1 },
    { shortlinkDiag: { multiple: true } },
  ]) {
    const result = await sync(output, 27, { ...config, issueNumbers: [2] })
    const [issue] = result.input.issues
    assert.equal(issue.conclusion, 'insufficient-evidence')
    assert.equal(issue.repro.sourceCode, null)
    assert.deepEqual(issue.repro.reporterGodboltUrls, [crashLink])
    assert.deepEqual(result.compilations, [])
    if (config.requestBudget) assert.match(result.warnings[0], /shortlink: .*budget exhausted/)
  }
})
