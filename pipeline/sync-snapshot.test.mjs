import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
  release('clang2210', '22.1.0'),
  release('clang2212', '22.1.2'),
  release('clang2220', '22.2.0', 'nightly'),
  release('clang2219assert', '22.1.9'),
  release('clang_trunk', '23.0.0git', 'nightly'),
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

function snapshotDirectory(context) {
  const temp = mkdtempSync(join(tmpdir(), 'llvm-sync-'))
  context.after(() => rmSync(temp, { recursive: true, force: true }))
  return join(temp, 'data')
}

function transports({ nextVersion = false, changed = false, unavailable = false } = {}) {
  const compilations = []
  const item = {
    state: 'open',
    title: 'unexpected diagnostic',
    html_url,
    user: actor,
    created_at: now,
    updated_at: now,
    labels: [{ name: 'clang:frontend' }],
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
          items: (url.searchParams.get('q').includes('is:issue') ? [2, 3] : [1]).map((number) => ({
            ...item,
            number,
          })),
        })
      if (path.endsWith('/pulls/1'))
        return response({ ...item, number: 1, head: { sha: head }, base: { ref: 'main' } })
      if (path.endsWith('/check-runs')) return response({ check_runs: [] })
      if (path.endsWith('/protection/required_status_checks'))
        return new Response(null, { status: 401 })
      if (/\/issues\/[23]$/.test(path)) {
        const number = Number(path.at(-1))
        const body = [
          number === 3 ? 'Clang 21.1.0' : 'Clang frontend',
          '```cpp',
          'int example;',
          '```',
          '`clang++ -std=c++20 example.cpp`',
          'error: unexpected diagnostic',
          'Expected behavior: should compile',
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
    async fetchImpl(url, request) {
      assert.equal(url.origin, 'https://ce.example.invalid')
      if (request.method === 'GET') {
        return unavailable ? new Response(null, { status: 503 }) : response(nextCatalog)
      }
      const id = url.pathname.split('/').at(-2)
      compilations.push(id)
      const trunk = id === 'clang_trunk'
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
