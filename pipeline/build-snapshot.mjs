import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { clangModules } from './modules.mjs'
import { checkDocument, countItems, indexRow, validateSnapshot } from './validate-snapshot.mjs'

function registerItems(items, kind, metadata) {
  const byId = new Map()
  for (const item of items) {
    const detail = checkDocument({ ...item, ...metadata }, kind, `${kind} ${item.id}`)
    const previous = byId.get(detail.id)
    if (previous && !isDeepStrictEqual(previous, detail)) {
      throw new Error(`Conflicting ${kind} details for ID ${detail.id}`)
    }
    byId.set(detail.id, detail)
  }
  return new Map([...byId].sort(([left], [right]) => left - right))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function installShards(staged, target, files) {
  try {
    renameSync(staged, target)
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
    // A retry may find the same shards already installed before summary replacement.
    const expectedEntries = readdirSync(staged, { recursive: true }).sort()
    const actualEntries = readdirSync(target, { recursive: true }).sort()
    const matches =
      isDeepStrictEqual(actualEntries, expectedEntries) &&
      files.every((path) => {
        const expected = JSON.parse(readFileSync(join(staged, path), 'utf8'))
        const actual = JSON.parse(readFileSync(join(target, path), 'utf8'))
        return isDeepStrictEqual(actual, expected)
      })
    if (!matches) {
      throw new Error(`Snapshot shards already exist with different contents: ${target}`, {
        cause: error,
      })
    }
  }
}

export function buildSnapshot(input, outputDirectory) {
  for (const field of ['prs', 'issues']) {
    if (!Object.hasOwn(input, field) || !Array.isArray(input[field])) {
      throw new TypeError(`Snapshot input requires an explicit ${field} array`)
    }
  }
  const {
    snapshotId,
    generatedAt,
    githubSyncedAt = null,
    trunkCompilerVersion = null,
    prs,
    issues,
    modules = clangModules,
  } = input
  const metadata = { schemaVersion: 1, snapshotId }
  const prItems = registerItems(prs, 'pr', metadata)
  const issueItems = registerItems(issues, 'issue', metadata)
  const moduleShards = modules.map(({ id, name }) => {
    const prRows = new Map([...prItems].filter(([, item]) => item.moduleIds.includes(id)))
    const issueRows = new Map([...issueItems].filter(([, item]) => item.moduleIds.includes(id)))
    return { id, name, counts: countItems(prRows, issueRows), prRows, issueRows }
  })
  const snapshotRoot = `snapshots/${snapshotId}/`
  const summary = checkDocument(
    {
      ...metadata,
      generatedAt,
      githubSyncedAt,
      trunkCompilerVersion,
      snapshotRoot,
      kpis: countItems(prItems, issueItems),
      modules: moduleShards.map(({ id, name, counts }) => ({ id, name, counts })),
    },
    'summary',
    'summary.json',
  )
  const moduleIds = new Set(summary.modules.map((module) => module.id))
  for (const item of [...prItems.values(), ...issueItems.values()]) {
    if (item.moduleIds.some((id) => !moduleIds.has(id))) {
      throw new Error(`Item ${item.id} belongs to an unconfigured module`)
    }
  }

  const directory = resolve(outputDirectory)
  mkdirSync(directory, { recursive: true })
  const stage = mkdtempSync(join(dirname(directory), '.llvm-triage-'))
  try {
    const stagedRoot = join(stage, snapshotRoot)
    mkdirSync(join(stagedRoot, 'items'), { recursive: true })
    mkdirSync(join(stagedRoot, 'modules'))
    const shardPaths = []
    function writeShard(path, value) {
      writeJson(join(stagedRoot, path), value)
      shardPaths.push(path)
    }
    for (const [kind, items] of [
      ['pr', prItems],
      ['issue', issueItems],
    ]) {
      for (const [id, detail] of items) {
        writeShard(`items/${kind}-${id}.json`, detail)
      }
    }
    for (const { id, prRows, issueRows } of moduleShards) {
      const path = `modules/${id}`
      mkdirSync(join(stagedRoot, path), { recursive: true })
      for (const [kind, index, rows] of [
        ['pr', 'prs-index', prRows],
        ['issue', 'issues-index', issueRows],
      ]) {
        writeShard(`${path}/${index}.json`, {
          ...metadata,
          moduleId: id,
          items: [...rows.values()].map((row) => indexRow(kind, row)),
        })
      }
    }
    writeJson(join(stage, 'summary.json'), summary)
    validateSnapshot(stage)
    const finalRoot = join(directory, snapshotRoot)
    mkdirSync(dirname(finalRoot), { recursive: true })
    // Readers can continue to resolve previous roots until the new pointer is installed.
    installShards(stagedRoot, finalRoot, shardPaths)
    renameSync(join(stage, 'summary.json'), join(directory, 'summary.json'))
    return summary
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 4) {
      throw new Error('Usage: node build-snapshot.mjs <normalized-input.json> <data-directory>')
    }
    const [, , input, output] = process.argv
    const summary = buildSnapshot(JSON.parse(readFileSync(input, 'utf8')), output)
    console.log(`Published validated snapshot ${summary.snapshotId} to ${resolve(output)}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
