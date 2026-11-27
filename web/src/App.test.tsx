import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HashRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import summary from '../../data/summary.json'
import prIndex from '../../data/snapshots/mock-2026-11-27/modules/clang-sema/prs-index.json'
import issueIndex from '../../data/snapshots/mock-2026-11-27/modules/clang-sema/issues-index.json'
import pr101 from '../../data/snapshots/mock-2026-11-27/items/pr-101.json'
import pr104 from '../../data/snapshots/mock-2026-11-27/items/pr-104.json'
import issue201 from '../../data/snapshots/mock-2026-11-27/items/issue-201.json'
import issue202 from '../../data/snapshots/mock-2026-11-27/items/issue-202.json'
import issue204 from '../../data/snapshots/mock-2026-11-27/items/issue-204.json'
import { App, makeQueryClient } from './App'

const client = makeQueryClient()

afterEach(() => {
  cleanup()
  client.clear()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'clipboard')
})

function open(hash: string) {
  window.history.replaceState(null, '', hash)
  return render(<HashRouter><App queryClient={client} /></HashRouter>)
}

function fixture(part: string) {
  const paths: Record<string, unknown> = {
    'summary.json': summary,
    'prs-index.json': prIndex,
    'issues-index.json': issueIndex,
    'pr-101.json': pr101,
    'pr-104.json': pr104,
    'issue-201.json': issue201,
    'issue-202.json': issue202,
    'issue-204.json': issue204,
  }
  return paths[part]
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
}

function mockFetch(override?: (path: string) => Promise<Response> | Response | undefined) {
  const fetcher = vi.fn(async (path: string) => {
    const special = override?.(path)
    if (special) return special
    const data = fixture(path.split('/').at(-1) ?? '')
    return data ? json(data) : new Response(null, { status: 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('static workbench', () => {
  it('restores a shared issue URL and writes source and sort changes back to the hash', async () => {
    mockFetch()
    open('#/issues?module=clang-sema&source=generated-by-fuzzer&queue=close-candidate&sort=reported&item=202')
    const detail = within(await screen.findByRole('region', { name: 'Issue details' }))
    expect(await detail.findByRole('heading', { name: issue202.title })).toBeTruthy()
    expect(detail.getByRole('heading', { name: 'Fuzzer Crash Signature' })).toBeTruthy()
    const filter = within(screen.getByRole('group', { name: 'Issue source' }))
    expect(filter.getByRole('button', { name: 'generated-by-fuzzer' }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByRole('combobox', { name: 'Sort' }) as HTMLSelectElement).value).toBe('reported')
    fireEvent.click(filter.getByRole('button', { name: 'Human-reported' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'activity' } })
    const params = new URLSearchParams(window.location.hash.split('?')[1])
    expect(Object.fromEntries(params)).toEqual({
      module: 'clang-sema', source: 'human-reported', queue: 'close-candidate', sort: 'activity',
    })
  })

  it('moves focus with j/k, opens with Enter, and ignores a late response for the previous selection', async () => {
    let finishOld!: (value: Response) => void
    const oldResponse = new Promise<Response>(resolve => { finishOld = resolve })
    const fetcher = mockFetch(path => path.endsWith('/pr-101.json') ? oldResponse : undefined)
    open('#/prs?module=clang-sema')
    const row = await screen.findByRole('button', { name: /#101/ })
    fireEvent.keyDown(window, { key: 'j' })
    expect(document.activeElement).toBe(row)
    // Enter activates the native row button. jsdom does not synthesize that click.
    fireEvent.click(row)
    await waitFor(() => expect(fetcher.mock.calls.some(([path]) => path.endsWith('/pr-101.json'))).toBe(true))
    fireEvent.keyDown(row, { key: 'j' })
    const detail = within(await screen.findByRole('region', { name: 'Pull request details' }))
    expect(await detail.findByRole('heading', { name: pr104.title })).toBeTruthy()
    await act(async () => { finishOld(json(pr101)); await oldResponse })
    expect(detail.queryByRole('heading', { name: pr101.title })).toBeNull()
    expect(new URLSearchParams(window.location.hash.split('?')[1]).get('item')).toBe('104')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(window.location.hash).toBe('#/prs?module=clang-sema')
  })

  it('recovers a retired shard by reloading the summary and keeping the URL state', async () => {
    const replacement = 'replacement-2026-11-27'
    let count = 0
    const fetcher = mockFetch(path => {
      if (path.endsWith('/summary.json') && ++count > 1) return json({
        ...summary, snapshotId: replacement, snapshotRoot: `snapshots/${replacement}/`,
      })
      if (path.includes(summary.snapshotRoot) && path.endsWith('/pr-101.json')) return new Response(null, { status: 404 })
      if (path.includes(replacement)) {
        if (path.endsWith('/prs-index.json')) return json({ ...prIndex, snapshotId: replacement })
        if (path.endsWith('/pr-101.json')) return json({ ...pr101, snapshotId: replacement })
      }
    })
    const hash = '#/prs?module=clang-sema&queue=approved-follow-up&ci=passing&item=101'
    open(hash)
    const detail = within(await screen.findByRole('region', { name: 'Pull request details' }))
    const button = await detail.findByRole('button', { name: 'Load latest snapshot' })
    expect(detail.getByRole('alert').textContent).toContain('unavailable in the current snapshot')
    fireEvent.click(button)
    expect(await detail.findByRole('heading', { name: pr101.title })).toBeTruthy()
    expect(detail.getByText(/2 commits since approval/)).toBeTruthy()
    expect(within(detail.getByText('Review at HEAD').parentElement!).getByText('Unknown')).toBeTruthy()
    expect(window.location.hash).toBe(hash)
    expect(fetcher.mock.calls.some(([url]) => url.endsWith(`snapshots/${replacement}/items/pr-101.json`))).toBe(true)
    expect(detail.queryByText(/@mock-ci/)).toBeNull()
    fireEvent.click(detail.getByRole('checkbox', { name: 'Human only' }))
    expect(detail.getByText('@mock-ci')).toBeTruthy()
  })

  it('shows diagnostics verbatim and copies the original reproducer and Markdown comment', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    mockFetch()
    open('#/issues?module=clang-sema&item=201')
    const detail = within(await screen.findByRole('region', { name: 'Issue details' }))
    expect(await detail.findByRole('heading', { name: issue201.title })).toBeTruthy()
    expect(detail.getByRole('heading', { name: 'Fix Attribution · Confirmed' })).toBeTruthy()
    expect(detail.getByRole('region', { name: 'Baseline diagnostics' }).querySelector('pre')?.textContent)
      .toBe(issue201.runs.baseline.diagnostics)
    await detail.findByLabelText('Reproducer source')
    fireEvent.click(detail.getByRole('button', { name: 'Copy source' }))
    fireEvent.click(detail.getByRole('button', { name: 'Copy Close Comment' }))
    await waitFor(() => expect(writeText.mock.calls).toHaveLength(2))
    expect(writeText.mock.calls[0][0]).toBe(issue201.repro.sourceCode)
    expect(writeText.mock.calls[1][0]).toBe([
      'I rechecked the reproducer from this issue with the following compilers:',
      '- Baseline: mock clang 6.0.0 (exit 1) reproduced the reported symptom. [Compiler Explorer](https://godbolt.example.invalid/z/201-baseline)',
      '- Trunk: mock clang trunk (rev 123abcd) (exit 0) met the expected behavior. [Compiler Explorer](https://godbolt.example.invalid/z/201-trunk)',
      '',
      'Expected behavior: The compiler accepts the program.',
      '',
      'Could a maintainer confirm whether this issue can be closed?',
    ].join('\n'))
    expect(detail.getAllByRole('status').map(status => status.textContent)).toEqual(['Copied', 'Copied'])
  })

  it('shows recorded evidence gaps without offering a close comment', async () => {
    mockFetch()
    open('#/issues?module=clang-sema&item=204')
    const detail = within(await screen.findByRole('region', { name: 'Issue details' }))
    expect(await detail.findByRole('heading', { name: 'Missing Evidence Checklist' })).toBeTruthy()
    expect(detail.getByRole('heading', { name: 'Fix Attribution · Unknown' })).toBeTruthy()
    expect(detail.queryByRole('button', { name: 'Copy Close Comment' })).toBeNull()
  })

  it('persists the selected theme across mounts', () => {
    mockFetch()
    localStorage.clear()
    const first = open('#/')
    fireEvent.click(screen.getByRole('button', { name: 'light' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    first.unmount()
    open('#/')
    expect(screen.getByRole('button', { name: 'light' }).getAttribute('aria-pressed')).toBe('true')
    localStorage.clear()
  })
})
