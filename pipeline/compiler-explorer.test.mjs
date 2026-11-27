import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createCompilerExplorerClient, parseShortlinkSession } from './compiler-explorer.mjs'
import { reverifyIssue } from './reverify-issue.mjs'

const repro = {
  sourceCode: 'int x;',
  compileArgs: ['-std=c++17', '-DVALUE="two words"'],
  expectedBehavior: 'Accepts the source',
}
const compile = { ...repro, compilerId: 'old-clang' }
const catalog = [
  { id: 'old-clang', fullVersion: 'clang version 12.0.0 (old)' },
  { id: 'new-clang', fullVersion: 'clang version 22.0.0 (trunk)' },
]
const entry = {
  id: 10,
  title: 'Unexpected diagnostic',
  url: 'https://llvm.example.invalid/issues/10',
  moduleIds: ['clang-sema'],
  originalReportAt: '2020-02-03T00:00:00Z',
  githubSyncedAt: '2026-11-25T00:00:00Z',
  reporterIsBot: false,
  repro,
  compilers: { baseline: 'old-clang', trunk: 'new-clang' },
  expectations: {
    reported: { diagnosticIncludes: 'unexpected diagnostic' },
    expected: { exitCode: 0 },
  },
}
const verifiedAt = '2026-11-27T00:00:00Z'

const editor = {
  id: 1,
  language: 'c++',
  source: 'int x;\n',
  compilers: [{ id: 'clang_assertions_trunk', options: '-std=c++20 -DVALUE="two words"' }],
}

test('fetches normalized shortlinks with the shared transport and request budget', async () => {
  const paths = []
  const client = createCompilerExplorerClient({
    requestBudget: 2,
    async fetchImpl(url, request) {
      assert.equal(url.origin, 'https://godbolt.org')
      assert.equal(request.method, 'GET')
      assert.equal(request.headers.Accept, 'application/json')
      paths.push(url.pathname)
      return Response.json(
        url.pathname.startsWith('/api/compilers') ? catalog : { sessions: [editor] },
      )
    },
  })
  await assert.rejects(client.fetchShortlink('../compilers'), TypeError)
  assert.deepEqual(await client.fetchShortlink('abc_123'), {
    sourceCode: editor.source,
    compileArgs: ['-std=c++20', '-DVALUE=two words'],
    compilerId: 'clang_assertions_trunk',
    language: 'c++',
  })
  await client.listCompilers()
  await assert.rejects(client.compile(compile), { code: 'budget' })
  await assert.rejects(client.fetchShortlink('another'), { code: 'budget' })
  assert.deepEqual(paths, ['/api/shortlinkinfo/abc_123', '/api/compilers/c%2B%2B'])
})

test('parses single-file C with no options and ignores empty editors', () => {
  const cEditor = { ...editor, language: 'c', compilers: [{ id: 'cclang2210', options: '' }] }
  assert.deepEqual(parseShortlinkSession({ sessions: [{ source: '  ' }, cEditor], trees: [] }), {
    sourceCode: cEditor.source,
    compileArgs: [],
    compilerId: 'cclang2210',
    language: 'c',
  })
})

test('declines ambiguous or unsupported shortlink sessions', () => {
  for (const state of [
    { sessions: [editor, { ...editor, id: 2 }] },
    { sessions: [{ ...editor, language: 'rust' }] },
    { sessions: [editor], trees: [{}] },
    { sessions: [{ ...editor, compilers: [null, { id: 'g82', options: '' }] }] },
    { sessions: [{ ...editor, compilers: [{ id: 'clang_trunk', options: '"unterminated' }] }] },
    {
      sessions: [
        { ...editor, compilers: [{ id: 'clang_trunk', options: '', libs: [{ id: 'fmt' }] }] },
      ],
    },
  ]) {
    assert.equal(parseShortlinkSession(state), null)
  }
})

test('fetches observed compiler versions and sends lossless compile-only arguments', async () => {
  const requests = []
  const client = createCompilerExplorerClient({
    baseUrl: 'https://compiler.example.invalid/',
    requestBudget: 3,
    async fetchImpl(url, request) {
      requests.push({ url, request })
      if (request.method === 'GET') return Response.json(catalog)
      const baseline = url.pathname.includes('old-clang')
      return Response.json({
        code: baseline ? 1 : 0,
        stderr: baseline ? [{ text: ' error: unexpected diagnostic  ' }, { text: '    ^' }] : [],
        stdout: [],
      })
    },
  })
  const { detail, failures } = await reverifyIssue(
    {
      ...entry,
      godboltUrls: { baseline: 'https://godbolt.example.invalid/z/mock' },
    },
    { client, verifiedAt },
  )
  assert.deepEqual(failures, {})
  assert.equal(detail.conclusion, 'close-candidate')
  assert.equal(detail.lastVerifiedAt, verifiedAt)
  assert.equal(detail.githubSyncedAt, entry.githubSyncedAt)
  assert.equal(detail.runs.baseline.compilerVersion, catalog[0].fullVersion)
  assert.equal(detail.runs.trunk.compilerVersion, catalog[1].fullVersion)
  assert.equal(detail.runs.baseline.exitCode, 1)
  assert.equal(detail.runs.baseline.diagnostics, ' error: unexpected diagnostic  \n    ^')
  assert.equal(detail.runs.baseline.godboltUrl, 'https://godbolt.example.invalid/z/mock')
  assert.equal(detail.runs.trunk.godboltUrl, null)
  assert.deepEqual(
    requests.map(({ url }) => url.pathname),
    [
      '/api/compilers/c%2B%2B',
      '/api/compiler/old-clang/compile',
      '/api/compiler/new-clang/compile',
    ],
  )
  assert.equal(
    requests[0].url.searchParams.get('fields'),
    'id,name,fullVersion,version,semver,releaseTrack,compilerType',
  )
  assert.equal(requests[1].request.headers.Accept, 'application/json')
  const body = JSON.parse(requests[1].request.body)
  assert.equal(body.source, repro.sourceCode)
  assert.deepEqual(body.options.userArguments, repro.compileArgs)
  assert.equal(body.options.filters.execute, false)
  assert.equal(body.options.compilerOptions.executorRequest, false)
  assert.equal(body.allowStoreCodeDebug, false)
  await assert.rejects(client.compile(compile), { code: 'budget' })
  assert.equal(requests.length, 3)
})

test('keeps transport failures and exhausted budgets distinct from compiler outcomes', async () => {
  const client = createCompilerExplorerClient({
    requestBudget: 2,
    fetchImpl: async (_url, request) =>
      request.method === 'GET'
        ? Response.json(catalog)
        : new Response('unavailable', { status: 503 }),
  })
  const { detail, failures } = await reverifyIssue(entry, { client, verifiedAt })
  assert.equal(failures.baseline.code, 'http')
  assert.equal(failures.trunk.code, 'budget')
  assert.deepEqual(detail.missingEvidence, ['baseline-run', 'trunk-run'])
  assert.deepEqual(detail.runs, { baseline: null, trunk: null })
  assert.equal(detail.lastVerifiedAt, null)
})

test('bounds both the transport and JSON body with an abortable timeout', async () => {
  for (const delayBody of [false, true]) {
    let requestSignal
    const pending = new Promise(() => {})
    const client = createCompilerExplorerClient({
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => {
        requestSignal = signal
        return delayBody ? { ok: true, json: () => pending } : pending
      },
    })
    await assert.rejects(client.compile(compile), { code: 'timeout' })
    assert.equal(requestSignal.aborted, true)
    await assert.rejects(client.fetchShortlink('abc123'), { code: 'timeout' })
    assert.equal(requestSignal.aborted, true)
  }
})

test('treats a missing compiler version and a truncated diagnostic as insufficient', async () => {
  const client = createCompilerExplorerClient({
    fetchImpl: async (_url, request) =>
      request.method === 'GET'
        ? Response.json(catalog.slice(1))
        : Response.json({ code: 0, truncated: true, stderr: [], stdout: [] }),
  })
  const { detail, failures } = await reverifyIssue(entry, { client, verifiedAt })
  assert.equal(failures.baseline.code, 'compiler-unavailable')
  assert.equal(detail.runs.trunk.outcome, 'unknown')
  assert.equal(detail.conclusion, 'insufficient-evidence')
  assert.deepEqual(detail.missingEvidence, ['baseline-run', 'trunk-outcome', 'baseline-version'])
})

test('keeps an identified historical version when its compiler is unavailable', async () => {
  const client = createCompilerExplorerClient({
    fetchImpl: async (_url, request) =>
      request.method === 'GET'
        ? Response.json(catalog.slice(1))
        : Response.json({ code: 0, stderr: [], stdout: [] }),
  })
  const { detail, failures } = await reverifyIssue(
    { ...entry, baselineVersionKnown: true },
    { client, verifiedAt },
  )
  assert.equal(failures.baseline.code, 'compiler-unavailable')
  assert.equal(detail.baseline, null)
  assert.deepEqual(detail.missingEvidence, ['baseline-run'])
})

test('records an unidentified historical version separately from its missing run', async () => {
  const client = createCompilerExplorerClient({
    fetchImpl: async (_url, request) =>
      request.method === 'GET'
        ? Response.json(catalog)
        : Response.json({ code: 0, stderr: [], stdout: [] }),
  })
  const { detail, failures } = await reverifyIssue(
    {
      ...entry,
      baselineVersionKnown: false,
      compilers: { trunk: entry.compilers.trunk },
    },
    { client, verifiedAt },
  )
  assert.deepEqual(failures, {})
  assert.deepEqual(detail.missingEvidence, ['baseline-run', 'baseline-version'])
})

test('skips network requests when the repro is incomplete', async () => {
  const client = createCompilerExplorerClient({
    fetchImpl: () => assert.fail('unexpected request'),
  })
  const { detail, failures } = await reverifyIssue(
    { ...entry, repro: { ...repro, compileArgs: null } },
    { client, verifiedAt },
  )
  assert.deepEqual(failures, {})
  assert.deepEqual(detail.missingEvidence, ['compile-arguments', 'baseline-run', 'trunk-run'])
})
