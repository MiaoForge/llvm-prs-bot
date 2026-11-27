import { queryOptions, useQuery } from '@tanstack/react-query'
import type { Summary } from './generated/summary'
import type { PrIndex } from './generated/prs-index'
import type { IssueIndex } from './generated/issues-index'
import type { PrDetail } from './generated/pr'
import type { IssueDetail } from './generated/issue'

export type { Summary, PrDetail, IssueDetail }
export type PrRow = PrIndex['items'][number]
export type IssueRow = IssueIndex['items'][number]
export type Counts = Summary['kpis']
export type View = 'prs' | 'issues'

export class SnapshotError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export function isMissingSnapshotFile(error: unknown) {
  return error instanceof SnapshotError && error.status === 404
}

async function getJson(path: string, signal: AbortSignal, cache?: RequestCache) {
  const response = await fetch(path, { signal, cache })
  if (!response.ok)
    throw new SnapshotError(`Snapshot request failed (HTTP ${response.status}).`, response.status)
  return response.json()
}

const dataRoot = `${import.meta.env.BASE_URL}data/`

export const summaryOptions = queryOptions({
  queryKey: ['summary'],
  queryFn: async ({ signal }): Promise<Summary> => {
    const summary = await getJson(`${dataRoot}summary.json`, signal, 'no-store')
    if (summary?.schemaVersion !== 1)
      throw new SnapshotError('This snapshot uses an unsupported schema version.')
    if (
      !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(summary.snapshotId) ||
      summary.snapshotRoot !== `snapshots/${summary.snapshotId}/`
    ) {
      throw new SnapshotError('The snapshot root does not match its ID.')
    }
    return summary
  },
  staleTime: Infinity,
})

function shardOptions<T extends { schemaVersion: number; snapshotId: string }>(
  summary: Summary,
  path: string,
  matches: (shard: T) => boolean,
) {
  return queryOptions({
    queryKey: ['shard', summary.snapshotId, summary.snapshotRoot, path],
    queryFn: async ({ signal }): Promise<T> => {
      const shard: T = await getJson(dataRoot + summary.snapshotRoot + path, signal)
      if (
        shard?.schemaVersion !== 1 ||
        shard.snapshotId !== summary.snapshotId ||
        !matches(shard)
      ) {
        throw new SnapshotError('This data file does not match the active snapshot or item.')
      }
      return shard
    },
    staleTime: Infinity,
  })
}

export function prIndexOptions(summary: Summary, moduleId: string) {
  return shardOptions<PrIndex>(
    summary,
    `modules/${moduleId}/prs-index.json`,
    (shard) => shard.moduleId === moduleId,
  )
}

export function issueIndexOptions(summary: Summary, moduleId: string) {
  return shardOptions<IssueIndex>(
    summary,
    `modules/${moduleId}/issues-index.json`,
    (shard) => shard.moduleId === moduleId,
  )
}

export function usePrDetail(summary: Summary, id: number) {
  return useQuery(
    shardOptions<PrDetail>(summary, `items/pr-${id}.json`, (shard) => shard.id === id),
  )
}

export function useIssueDetail(summary: Summary, id: number) {
  return useQuery(
    shardOptions<IssueDetail>(summary, `items/issue-${id}.json`, (shard) => shard.id === id),
  )
}
