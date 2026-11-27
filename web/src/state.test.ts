import { describe, expect, it } from 'vitest'
import prIndex from '../../data/snapshots/mock-2026-11-27/modules/clang-sema/prs-index.json'
import issueIndex from '../../data/snapshots/mock-2026-11-27/modules/clang-sema/issues-index.json'
import summary from '../../data/summary.json'
import type { IssueRow, PrRow } from './snapshot'
import { filterIssues, filterPrs, nextItem, parseItem, workbenchLink } from './state'

const prs = prIndex.items as PrRow[]
const issues = issueIndex.items as IssueRow[]
const ids = (items: readonly { id: number }[]) => items.map(({ id }) => id)

describe('URL state and filtering', () => {
  it('encodes module, source, queue, sort, selection, and search in one link', () => {
    const link = workbenchLink('issues', 'clang-ast', {
      source: 'generated-by-fuzzer',
      queue: 'close-candidate',
      sort: 'verified',
      item: '204',
      q: '#204',
    })
    expect(link).toBe(
      '/issues?module=clang-ast&source=generated-by-fuzzer&queue=close-candidate&sort=verified&item=204&q=%23204',
    )
    expect(parseItem('204')).toBe(204)
    for (const invalid of [null, '0', '02', '1e2', '9007199254740992'])
      expect(parseItem(invalid)).toBeNull()
  })

  it('intersects overlapping PR queues with HEAD status and human inactivity', () => {
    const params = new URLSearchParams({
      queue: 'approved-follow-up',
      ci: 'passing',
      inactive: '90',
    })
    expect(ids(filterPrs(prs, params, summary.generatedAt))).toEqual([101])
    const ordered = filterPrs(prs, new URLSearchParams({ sort: 'activity' }), summary.generatedAt)
    const activity = ordered.map((pr) =>
      pr.lastHumanActivityAt ? Date.parse(pr.lastHumanActivityAt) : -Infinity,
    )
    expect(activity).toEqual([...activity].sort((a, b) => b - a))
    expect(ids(prs)).toEqual(prIndex.items.map((item) => item.id))
  })

  it('keeps source independent from outcome and filters attribution separately', () => {
    const params = new URLSearchParams({
      source: 'generated-by-fuzzer',
      queue: 'close-candidate',
      fix: 'candidate',
    })
    const filtered = filterIssues(issues, params, summary.generatedAt)
    expect(filtered).toHaveLength(1)
    expect(filtered[0]).toMatchObject({
      source: 'generated-by-fuzzer',
      conclusion: 'close-candidate',
      fixStatus: 'candidate',
    })
    const sorted = filterIssues(
      issues,
      new URLSearchParams({ sort: 'reported' }),
      summary.generatedAt,
    )
    expect(sorted.map((item) => item.originalReportAt)).toEqual(
      sorted.map((item) => item.originalReportAt).sort(),
    )
  })
})

describe('row navigation', () => {
  const items = [{ id: 9 }, { id: 3 }, { id: 8 }]
  it('uses filtered order and clamps at each end', () => {
    expect(nextItem(items, null, 1)).toBe(9)
    expect(nextItem(items, null, -1)).toBe(8)
    expect(nextItem(items, 9, -1)).toBe(9)
    expect(nextItem(items, 3, 1)).toBe(8)
    expect(nextItem(items, 8, 1)).toBe(8)
    expect(nextItem([], null, 1)).toBeNull()
  })
})
