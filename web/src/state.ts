import { useSearchParams } from 'react-router'
import type { IssueRow, PrRow, View } from './snapshot'

export const prQueues = {
  'approved-follow-up': 'Approved · Follow-up',
  'awaiting-rereview': 'Awaiting Re-review',
  'awaiting-first-review': 'Needs First Review',
  'long-inactive': 'Long Inactive',
} satisfies Record<PrRow['queues'][number], string>

export const issueQueues = {
  'close-candidate': 'Close Candidates',
  'still-reproducible': 'Still Reproducible',
  'insufficient-evidence': 'Insufficient Evidence',
} satisfies Record<IssueRow['conclusion'], string>

export const issueSources = {
  all: 'All Issues',
  'human-reported': 'Human-reported',
  'generated-by-fuzzer': 'generated-by-fuzzer',
} as const

export function parseItem(value: string | null) {
  const id = Number(value)
  return value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(id) ? id : null
}

export function useFilters() {
  const [params, setParams] = useSearchParams()

  function update(values: Record<string, string | number | null>, replace = false) {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === '' || value === 'all') next.delete(key)
      else next.set(key, String(value))
    }
    setParams(next, { replace })
  }

  return {
    params,
    update,
    reset: () => {
      const module = params.get('module')
      setParams(new URLSearchParams(module === null ? {} : { module }))
    },
  }
}

export function workbenchLink(
  view: View | 'overview',
  module?: string,
  values: Record<string, string> = {},
) {
  const params = new URLSearchParams(module ? { module, ...values } : values)
  return (view === 'overview' ? '/' : `/${view}`) + (params.size ? `?${params}` : '')
}

export function choice<T extends string>(
  value: string | null,
  options: Record<T, string>,
  fallback: NoInfer<T>,
) {
  return value !== null && Object.hasOwn(options, value) ? (value as T) : fallback
}

export function searchMatch(
  item: { id: number; title: string; author?: string },
  query: string | null,
) {
  const search = query?.trim().toLowerCase()
  if (!search) return true
  if (/^#?\d+$/.test(search)) return String(item.id) === search.replace(/^#/, '')
  return `${item.title} ${item.author ?? ''}`.toLowerCase().includes(search)
}

const date = (value: string | null) => (value === null ? -Infinity : Date.parse(value))

export const prSorts = {
  priority: 'Actionability',
  activity: 'Last Human Activity',
  oldest: 'Oldest Opened',
}
export const issueSorts = {
  verified: 'Last Verified',
  reported: 'Original Report Date',
  activity: 'Last Human Comment',
}

export function filterPrs(items: PrRow[], params: URLSearchParams, referenceTime: string) {
  const queue = params.get('queue')
  const ci = params.get('ci')
  const merge = params.get('merge')
  const days = Number(params.get('inactive'))
  const sort = choice(params.get('sort'), prSorts, 'priority')
  const threshold = date(referenceTime) - days * 86_400_000
  return items
    .filter(
      (item) =>
        (!queue || queue === 'all' || item.queues.some((value) => value === queue)) &&
        (!ci || ci === 'all' || item.headCi.status === ci) &&
        (!merge || merge === 'all' || item.mergeability === merge) &&
        (!days ||
          (item.lastHumanActivityAt !== null && date(item.lastHumanActivityAt) <= threshold)) &&
        searchMatch(item, params.get('q')),
    )
    .sort((a, b) => {
      if (sort === 'activity')
        return date(b.lastHumanActivityAt) - date(a.lastHumanActivityAt) || a.id - b.id
      if (sort === 'oldest') return date(a.createdAt) - date(b.createdAt) || a.id - b.id
      return b.priority - a.priority || a.id - b.id
    })
}

export function filterIssues(items: IssueRow[], params: URLSearchParams, referenceTime: string) {
  const sort = choice(params.get('sort'), issueSorts, 'verified')
  const age = params.get('age')
  const cutoff = (years: number) => {
    const value = new Date(referenceTime)
    return value.setUTCFullYear(value.getUTCFullYear() - years)
  }
  const five = cutoff(5)
  const ten = cutoff(10)
  return items
    .filter((item) => {
      for (const [key, value] of [
        ['queue', item.conclusion],
        ['source', item.source],
        ['fix', item.fixStatus],
      ] as const) {
        const filter = params.get(key)
        if (filter && filter !== 'all' && value !== filter) return false
      }
      const reported = date(item.originalReportAt)
      if (age === 'older' && reported > ten) return false
      if (age === 'middle' && (reported <= ten || reported > five)) return false
      if (age === 'recent' && reported <= five) return false
      return searchMatch(item, params.get('q'))
    })
    .sort((a, b) => {
      if (sort === 'reported')
        return date(a.originalReportAt) - date(b.originalReportAt) || a.id - b.id
      const key = sort === 'activity' ? 'lastHumanCommentAt' : 'lastVerifiedAt'
      return date(b[key]) - date(a[key]) || a.id - b.id
    })
}

export function nextItem(
  items: readonly { id: number }[],
  focused: number | null,
  direction: 1 | -1,
) {
  const position = items.findIndex((item) => item.id === focused)
  if (position < 0) return (direction === 1 ? items[0] : items.at(-1))?.id ?? null
  return items[Math.max(0, Math.min(items.length - 1, position + direction))].id
}
