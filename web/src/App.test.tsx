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
const dialogPrototype = HTMLDialogElement.prototype
let restoreShowModal = false

afterEach(() => {
  cleanup()
  client.clear()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'clipboard')
  if (restoreShowModal) {
    Reflect.deleteProperty(dialogPrototype, 'showModal')
    restoreShowModal = false
  }
})

function open(hash: string) {
  window.history.replaceState(null, '', hash)
  return render(
    <HashRouter>
      <App queryClient={client} />
    </HashRouter>,
  )
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

async function openSearch() {
  // jsdom does not implement the native dialog opening method.
  if (!dialogPrototype.showModal) {
    Object.defineProperty(dialogPrototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true
      },
    })
    restoreShowModal = true
  }
  const trigger = screen.getByRole<HTMLButtonElement>('button', { name: /Search backlog/ })
  await waitFor(() => expect(trigger.disabled).toBe(false))
  fireEvent.click(trigger)
  return within(screen.getByRole('dialog', { name: 'Search backlog' }))
}

describe('static workbench', () => {
  it('restores a shared issue URL and writes source and sort changes back to the hash', async () => {
    mockFetch()
    open(
      '#/issues?module=clang-sema&source=generated-by-fuzzer&queue=close-candidate&sort=reported&item=202',
    )
    const detail = within(await screen.findByRole('region', { name: 'Issue details' }))
    expect(await detail.findByRole('heading', { name: issue202.title })).toBeTruthy()
    expect(detail.getByRole('heading', { name: 'Fuzzer Crash Signature' })).toBeTruthy()
    const filter = within(screen.getByRole('group', { name: 'Issue source' }))
    expect(
      filter.getByRole('button', { name: 'generated-by-fuzzer' }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect((screen.getByRole('combobox', { name: 'Sort' }) as HTMLSelectElement).value).toBe(
      'reported',
    )
    fireEvent.click(filter.getByRole('button', { name: 'Human-reported' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), {
      target: { value: 'activity' },
    })
    const params = new URLSearchParams(window.location.hash.split('?')[1])
    expect(Object.fromEntries(params)).toEqual({
      module: 'clang-sema',
      source: 'human-reported',
      queue: 'close-candidate',
      sort: 'activity',
    })
  })

  it('moves focus with j/k, opens with Enter, and ignores a late response for the previous selection', async () => {
    let finishOld!: (value: Response) => void
    const oldResponse = new Promise<Response>((resolve) => {
      finishOld = resolve
    })
    const fetcher = mockFetch((path) => (path.endsWith('/pr-101.json') ? oldResponse : undefined))
    open('#/prs?module=clang-sema')
    const row = await screen.findByRole('button', { name: /#101/ })
    fireEvent.keyDown(window, { key: 'j' })
    expect(document.activeElement).toBe(row)
    // Enter activates the native row button. jsdom does not synthesize that click.
    fireEvent.click(row)
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([path]) => path.endsWith('/pr-101.json'))).toBe(true),
    )
    fireEvent.keyDown(row, { key: 'j' })
    const detail = within(await screen.findByRole('region', { name: 'Pull request details' }))
    expect(await detail.findByRole('heading', { name: pr104.title })).toBeTruthy()
    await act(async () => {
      finishOld(json(pr101))
      await oldResponse
    })
    expect(detail.queryByRole('heading', { name: pr101.title })).toBeNull()
    expect(new URLSearchParams(window.location.hash.split('?')[1]).get('item')).toBe('104')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(window.location.hash).toBe('#/prs?module=clang-sema')
  })

  it('recovers a retired shard and explains when the selected PR changes queues', async () => {
    const replacement = 'replacement-2026-11-27'
    const moved = { ...pr101, snapshotId: replacement, queues: ['long-inactive'] }
    let count = 0
    const fetcher = mockFetch((path) => {
      if (path.endsWith('/summary.json') && ++count > 1)
        return json({
          ...summary,
          snapshotId: replacement,
          snapshotRoot: `snapshots/${replacement}/`,
        })
      if (path.includes(summary.snapshotRoot) && path.endsWith('/pr-101.json'))
        return new Response(null, { status: 404 })
      if (path.includes(replacement)) {
        if (path.endsWith('/prs-index.json'))
          return json({
            ...prIndex,
            snapshotId: replacement,
            items: prIndex.items.map((pr) =>
              pr.id === moved.id ? { ...pr, queues: moved.queues } : pr,
            ),
          })
        if (path.endsWith('/pr-101.json')) return json(moved)
      }
    })
    const hash = '#/prs?module=clang-sema&queue=approved-follow-up&ci=passing&item=101&sort=oldest'
    open(hash)
    const detail = within(await screen.findByRole('region', { name: 'Pull request details' }))
    const button = await detail.findByRole('button', { name: 'Load latest snapshot' })
    expect(detail.getByRole('alert').textContent).toContain('unavailable in the current snapshot')
    fireEvent.click(button)
    expect(await detail.findByRole('heading', { name: pr101.title })).toBeTruthy()
    expect(detail.getByText(/2 commits since approval/)).toBeTruthy()
    const reviewFact = detail.getByText('Review at HEAD').parentElement
    if (reviewFact === null) throw new Error('Missing review fact container')
    expect(within(reviewFact).getByText('Unknown')).toBeTruthy()
    expect(window.location.hash).toBe(hash)
    expect(detail.getByText(/does not match the current filters/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /#101/ })).toBeNull()
    fireEvent.click(detail.getByRole('button', { name: 'Clear filters' }))
    expect(window.location.hash).toBe('#/prs?module=clang-sema&item=101&sort=oldest')
    expect(detail.queryByRole('button', { name: 'Clear filters' })).toBeNull()
    expect(screen.getByRole('button', { name: /#101/ }).getAttribute('aria-current')).toBe('true')
    expect(
      fetcher.mock.calls.some(([url]) =>
        url.endsWith(`snapshots/${replacement}/items/pr-101.json`),
      ),
    ).toBe(true)
    expect(detail.queryByText(/@mock-ci/)).toBeNull()
    fireEvent.click(detail.getByRole('checkbox', { name: 'Human only' }))
    expect(detail.getByText('@mock-ci')).toBeTruthy()
  })

  it('distinguishes an issue excluded by filters from an issue outside the module', async () => {
    mockFetch()
    const result = open('#/issues?module=clang-sema&source=human-reported&item=202')
    const detail = within(await screen.findByRole('region', { name: 'Issue details' }))
    expect(await detail.findByRole('heading', { name: issue202.title })).toBeTruthy()
    expect(detail.getByText(/does not match the current filters/)).toBeTruthy()
    fireEvent.click(detail.getByRole('button', { name: 'Clear filters' }))
    expect(window.location.hash).toBe('#/issues?module=clang-sema&item=202')

    result.unmount()
    open('#/issues?module=clang-sema&item=999')
    expect(await screen.findByText(/Issue #999 is outside this module/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  })

  it('recovers a missing search index alongside a cached one without clearing the search term', async () => {
    const replacement = 'replacement-2026-11-27'
    let count = 0
    const fetcher = mockFetch((path) => {
      if (path.endsWith('/summary.json') && ++count > 1)
        return json({
          ...summary,
          snapshotId: replacement,
          snapshotRoot: `snapshots/${replacement}/`,
        })
      if (path.endsWith('/issues-index.json')) {
        return path.includes(replacement)
          ? json({ ...issueIndex, snapshotId: replacement })
          : new Response(null, { status: 404 })
      }
      if (path.includes(replacement) && path.endsWith('/prs-index.json')) {
        return json({ ...prIndex, snapshotId: replacement })
      }
    })
    open('#/prs?module=clang-sema')
    await screen.findByRole('button', { name: /#101/ })
    const dialog = await openSearch()
    const input = dialog.getByRole<HTMLInputElement>('textbox', { name: 'Search query' })
    fireEvent.change(input, { target: { value: 'Sema' } })
    const reload = await dialog.findByRole('button', { name: 'Load latest snapshot' })
    expect(dialog.getByRole('button', { name: /PR #101/ })).toBeTruthy()
    expect(dialog.queryByRole('button', { name: /Issue #202/ })).toBeNull()
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/prs-index.json'))).toHaveLength(1)
    fireEvent.click(reload)
    expect(await dialog.findByRole('button', { name: /Issue #202/ })).toBeTruthy()
    expect(input.value).toBe('Sema')
    expect(dialog.queryByRole('alert')).toBeNull()
    expect(window.location.hash).toBe('#/prs?module=clang-sema')
  })

  it('opens a search result without filtering the workbench or restricting keyboard navigation', async () => {
    mockFetch()
    open('#/prs?module=clang-sema&queue=approved-follow-up')
    const dialog = await openSearch()
    fireEvent.change(dialog.getByRole('textbox', { name: 'Search query' }), {
      target: { value: '#101' },
    })
    fireEvent.click(await dialog.findByRole('button', { name: /PR #101/ }))
    expect(window.location.hash).toBe('#/prs?module=clang-sema&item=101')
    expect(screen.queryByRole('dialog')).toBeNull()

    const detail = within(screen.getByRole('region', { name: 'Pull request details' }))
    expect(await detail.findByRole('heading', { name: pr101.title })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'j' })
    expect(await detail.findByRole('heading', { name: pr104.title })).toBeTruthy()
    fireEvent.click(detail.getByRole('button', { name: 'Close details' }))
    expect(window.location.hash).toBe('#/prs?module=clang-sema')
    fireEvent.keyDown(window, { key: 'k' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /#101/ }))
  })

  it('shows one recovery action for an unavailable issue index', async () => {
    mockFetch((path) =>
      path.endsWith('/issues-index.json') ? new Response(null, { status: 404 }) : undefined,
    )
    open('#/issues?module=clang-sema&item=202')
    expect(await screen.findByRole('button', { name: 'Load latest snapshot' })).toBeTruthy()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').closest('.pane-list')).toBeNull()
  })

  it('labels a human-reported crash and only quotes empty or whitespace-containing compiler arguments', async () => {
    mockFetch((path) => {
      if (path.endsWith('/issues-index.json'))
        return json({
          ...issueIndex,
          items: issueIndex.items.map((issue) =>
            issue.id === issue202.id ? { ...issue, source: 'human-reported' } : issue,
          ),
        })
      if (path.endsWith('/issue-202.json'))
        return json({
          ...issue202,
          source: 'human-reported',
          repro: {
            ...issue202.repro,
            compileArgs: ['-std=c++17', '-Ipath with spaces', '', '-DNAME=value'],
          },
        })
    })
    open('#/issues?module=clang-sema&item=202')
    const detail = within(await screen.findByRole('region', { name: 'Issue details' }))
    expect(await detail.findByRole('heading', { name: 'Crash Signature' })).toBeTruthy()
    expect(detail.queryByRole('heading', { name: 'Fuzzer Crash Signature' })).toBeNull()
    expect(detail.getByText('-std=c++17', { selector: 'code' })).toBeTruthy()
    expect(detail.getByText('"-Ipath with spaces"', { selector: 'code' })).toBeTruthy()
    expect(detail.getByText('""', { selector: 'code' })).toBeTruthy()
  })

  it('shows diagnostics verbatim and copies the original reproducer and Markdown comment', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    mockFetch()
    open('#/issues?module=clang-sema&item=201')
    const detail = within(await screen.findByRole('region', { name: 'Issue details' }))
    expect(await detail.findByRole('heading', { name: issue201.title })).toBeTruthy()
    expect(detail.getByRole('heading', { name: 'Fix Attribution · Confirmed' })).toBeTruthy()
    expect(
      detail.getByRole('region', { name: 'Baseline diagnostics' }).querySelector('pre')
        ?.textContent,
    ).toBe(issue201.runs.baseline.diagnostics)
    await detail.findByLabelText('Reproducer source')
    fireEvent.click(detail.getByRole('button', { name: 'Copy source' }))
    fireEvent.click(detail.getByRole('button', { name: 'Copy Close Comment' }))
    await waitFor(() => expect(writeText.mock.calls).toHaveLength(2))
    expect(writeText.mock.calls[0][0]).toBe(issue201.repro.sourceCode)
    expect(writeText.mock.calls[1][0]).toBe(
      [
        'I rechecked the reproducer from this issue with the following compilers:',
        '- Baseline: mock clang 22.1.0 (exit 1) reproduced the reported symptom. [Compiler Explorer](https://godbolt.example.invalid/z/201-baseline)',
        '- Trunk: mock clang trunk (rev 123abcd) (exit 0) met the expected behavior. [Compiler Explorer](https://godbolt.example.invalid/z/201-trunk)',
        '',
        'Expected behavior: The compiler accepts the program.',
        '',
        'Could a maintainer confirm whether this issue can be closed?',
      ].join('\n'),
    )
    expect(detail.getAllByRole('status').map((status) => status.textContent)).toEqual([
      'Copied',
      'Copied',
    ])
  })

  it('shows recorded evidence gaps without offering a close comment', async () => {
    mockFetch()
    open('#/issues?module=clang-sema&item=204')
    const detail = within(await screen.findByRole('region', { name: 'Issue details' }))
    expect(await detail.findByRole('heading', { name: 'Missing Evidence Checklist' })).toBeTruthy()
    expect(detail.getByRole('heading', { name: 'Fix Attribution · Unknown' })).toBeTruthy()
    expect(detail.queryByRole('button', { name: 'Copy Close Comment' })).toBeNull()
  })

  it('labels bounded coverage and presents overview counts as sampled', async () => {
    const note = 'Includes a bounded sample of open PRs and issues in the configured modules.'
    mockFetch((path) =>
      path.endsWith('/summary.json')
        ? json({ ...summary, coverage: { mode: 'bounded-sample', note } })
        : undefined,
    )

    open('#/')
    expect(await screen.findByText('Bounded sample')).toBeTruthy()
    expect(screen.getByText(note)).toBeTruthy()
    expect(
      screen.getByText(
        `${summary.kpis.prTotal} sampled PRs and ${summary.kpis.issueTotal} sampled issues in this snapshot`,
      ),
    ).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: /PR Actionable Queues · \d+ Sampled PRs/ }),
    ).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: /Issue Verification · \d+ Sampled Issues/ }),
    ).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Sampled PRs' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Sampled Issues' })).toBeTruthy()
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
