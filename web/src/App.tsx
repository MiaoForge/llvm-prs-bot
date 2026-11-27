import { useEffect, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Eye,
  GitPullRequest,
  LayoutGrid,
  RefreshCw,
  Search,
  X,
  Zap,
  CircleHelp,
  type LucideIcon,
} from 'lucide-react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import {
  isMissingSnapshotFile,
  issueIndexOptions,
  prIndexOptions,
  summaryOptions,
  type Counts,
  type Summary,
} from './snapshot'
import { issueQueues, prQueues, searchMatch, useFilters, workbenchLink } from './state'
import { LoadError, Loading, utc } from './ui'
import { PrWorkbench } from './PrWorkbench'
import { IssueWorkbench } from './IssueWorkbench'
import { Overview } from './Overview'
import { ThemePicker } from './theme'

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) => count < 1 && !isMissingSnapshotFile(error),
      },
    },
  })
}

const client = makeQueryClient()

export function App({ queryClient = client }: { queryClient?: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Workbench queryClient={queryClient} />
    </QueryClientProvider>
  )
}

function Workbench({ queryClient }: { queryClient: QueryClient }) {
  const location = useLocation()
  const { params } = useFilters()
  const requestedModule = params.get('module')
  const summaryQuery = useQuery(summaryOptions)
  const summary = summaryQuery.data
  const module =
    summary?.modules.find((entry) => entry.id === requestedModule) ??
    summary?.modules.find((entry) => entry.id === 'clang-sema') ??
    summary?.modules[0]
  const view =
    location.pathname === '/prs' ? 'prs' : location.pathname === '/issues' ? 'issues' : 'overview'
  const queue = params.get('queue')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchTrigger = useRef<HTMLButtonElement>(null)
  const prLabel =
    queue && Object.hasOwn(prQueues, queue) ? prQueues[queue as keyof typeof prQueues] : 'PR Triage'
  const issueLabel =
    queue && Object.hasOwn(issueQueues, queue)
      ? issueQueues[queue as keyof typeof issueQueues]
      : 'Issue Verification'
  const title = view === 'prs' ? prLabel : view === 'issues' ? issueLabel : 'Backlog Overview'

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return
      const command = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'
      const typing =
        event.target instanceof Element &&
        event.target.closest('input, textarea, select, [contenteditable], dialog[open]')
      if (!command && (typing || event.metaKey || event.ctrlKey || event.key !== '/')) return
      if (!module) return
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [module])

  async function reload() {
    const previousId = summary?.snapshotId
    const next = await summaryQuery.refetch()
    if (!next.isError && next.data?.snapshotId === previousId) {
      await queryClient.refetchQueries({
        type: 'active',
        predicate: (query) => query.queryKey[0] === 'shard' && query.state.status === 'error',
      })
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Workbench sidebar">
        <div className="sb-top">
          <Link className="brand" to={workbenchLink('overview', module?.id)}>
            <span className="brand-l">
              <span className="logo" aria-hidden="true">
                LL
              </span>
              <span className="brand-name">LLVM Triage</span>
            </span>
            <span className="pilot-pill">Pilot</span>
          </Link>
          <button
            type="button"
            className="search-trigger"
            onClick={() => setSearchOpen(true)}
            ref={searchTrigger}
            disabled={!module}
          >
            <span className="search-trigger-l">
              <Search className="ic ic-sm" />
              Search backlog…
            </span>
            <kbd className="kbd">/</kbd>
          </button>
          <nav className="sidebar-nav" aria-label="Backlog queues">
            <NavItem
              label="Overview"
              icon={LayoutGrid}
              href={workbenchLink('overview', module?.id)}
              active={view === 'overview'}
            />
            <div className="sb-group">
              <div className="sb-label">PR Queues</div>
              {Object.entries(prQueues).map(([key, label], index) => (
                <NavItem
                  key={key}
                  label={label}
                  icon={prIcons[index]}
                  count={module?.counts.prQueues[key as keyof Counts['prQueues']]}
                  tone={index === 0 ? 'warn' : undefined}
                  href={workbenchLink('prs', module?.id, { queue: key })}
                  active={view === 'prs' && queue === key}
                />
              ))}
            </div>
            <div className="sb-group">
              <div className="sb-label">Issue Verification</div>
              {Object.entries(issueQueues).map(([key, label], index) => (
                <NavItem
                  key={key}
                  label={label}
                  icon={issueIcons[index]}
                  tone={index === 0 ? 'warn' : index === 1 ? 'err' : undefined}
                  count={module?.counts.issueConclusions[key as keyof Counts['issueConclusions']]}
                  href={workbenchLink('issues', module?.id, { queue: key })}
                  active={view === 'issues' && queue === key && !params.get('source')}
                />
              ))}
              <NavItem
                label="Fuzzer-Generated"
                icon={Zap}
                tone="fuzz"
                count={module?.counts.generatedByFuzzer}
                href={workbenchLink('issues', module?.id, { source: 'generated-by-fuzzer' })}
                active={view === 'issues' && params.get('source') === 'generated-by-fuzzer'}
              />
            </div>
            {summary && (
              <div className="sb-group module-nav">
                <div className="sb-label">Modules</div>
                {summary.modules.map((entry) => {
                  const next = new URLSearchParams(params)
                  next.set('module', entry.id)
                  next.delete('item')
                  return (
                    <Link
                      key={entry.id}
                      className={`sb-item module-link ${entry === module ? 'active' : ''}`}
                      to={`${location.pathname}?${next}`}
                      aria-current={entry === module ? 'true' : undefined}
                    >
                      <span className="mono">{entry.name}</span>
                      {entry === module ? (
                        <span className="pilot-pill">Active</span>
                      ) : (
                        <span className="cnt">
                          {entry.counts.prTotal + entry.counts.issueTotal}
                        </span>
                      )}
                    </Link>
                  )
                })}
              </div>
            )}
          </nav>
        </div>
        {summary && (
          <footer className="sb-footer">
            <div className="sb-foot-row">
              <span>
                <span className="live-dot" />
                GitHub Sync
              </span>
            </div>
            <time dateTime={summary.githubSyncedAt ?? undefined}>
              {utc(summary.githubSyncedAt)}
            </time>
            <div className="sb-foot-row mt-2">
              <span>Clang Trunk</span>
            </div>
            <code>{summary.trunkCompilerVersion ?? 'Unknown'}</code>
          </footer>
        )}
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="crumb">
            {module && (
              <>
                <span className="mono">{module.name}</span>
                <span className="crumb-sep" aria-hidden="true">
                  /
                </span>
              </>
            )}
            <h1>{title}</h1>
          </div>
          <div className="topbar-actions">
            {view !== 'overview' && (
              <span className="keyboard-help">
                Navigate <kbd className="kbd">j</kbd> <kbd className="kbd">k</kbd>
              </span>
            )}
            <ThemePicker />
          </div>
        </header>
        {summaryQuery.isPending && <Loading>Loading snapshot…</Loading>}
        {summaryQuery.error && (
          <LoadError error={summaryQuery.error} retry={reload} busy={summaryQuery.isFetching} />
        )}
        {summary && !module && <div className="state-message">This snapshot has no modules.</div>}
        {requestedModule && module && module.id !== requestedModule && (
          <p className="state-message" role="status">
            The requested module is unavailable in this snapshot. Showing {module.name}.
          </p>
        )}
        {summary && module && (
          <Routes>
            <Route
              path="/"
              element={
                <Overview
                  summary={summary}
                  moduleId={module.id}
                  reload={reload}
                  busy={summaryQuery.isFetching}
                />
              }
            />
            <Route
              path="/prs"
              element={
                <PrWorkbench
                  key={module.id}
                  summary={summary}
                  moduleId={module.id}
                  reload={reload}
                  busy={summaryQuery.isFetching}
                />
              }
            />
            <Route
              path="/issues"
              element={
                <IssueWorkbench
                  key={module.id}
                  summary={summary}
                  moduleId={module.id}
                  reload={reload}
                  busy={summaryQuery.isFetching}
                />
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
      {summary && module && searchOpen && (
        <SearchDialog
          summary={summary}
          moduleId={module.id}
          reload={reload}
          busy={summaryQuery.isFetching}
          summaryError={summaryQuery.error}
          close={() => {
            setSearchOpen(false)
            searchTrigger.current?.focus()
          }}
        />
      )}
    </div>
  )
}

const prIcons = [GitPullRequest, RefreshCw, Eye, Clock3]
const issueIcons = [CheckCircle2, AlertCircle, CircleHelp]

function NavItem({
  label,
  icon: Icon,
  href,
  count,
  tone = '',
  active,
}: {
  label: string
  icon: LucideIcon
  href: string
  count?: number
  tone?: string
  active: boolean
}) {
  return (
    <Link
      to={href}
      aria-current={active ? 'page' : undefined}
      className={`sb-item ${active ? 'active' : ''}`}
    >
      <span className="sb-item-l">
        <Icon className={`ic ${tone}`} aria-hidden="true" />
        {label}
      </span>
      {count !== undefined && <span className={`cnt ${tone}`}>{count}</span>}
    </Link>
  )
}

function SearchDialog({
  summary,
  moduleId,
  close,
  reload,
  busy,
  summaryError,
}: {
  summary: Summary
  moduleId: string
  close: () => void
  reload: () => void
  busy: boolean
  summaryError: Error | null
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const prs = useQuery(prIndexOptions(summary, moduleId))
  const issues = useQuery(issueIndexOptions(summary, moduleId))
  const missingFile = [prs.error, issues.error].find(isMissingSnapshotFile)
  const searchError = missingFile ?? prs.error ?? issues.error
  const loading = prs.isPending || issues.isPending
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const matches = query.trim()
    ? [
        ...(prs.data?.items ?? [])
          .filter((item) => searchMatch(item, query))
          .map((item) => ({ ...item, view: 'prs' as const })),
        ...(issues.data?.items ?? [])
          .filter((item) => searchMatch(item, query))
          .map((item) => ({ ...item, view: 'issues' as const })),
      ].slice(0, 12)
    : []
  const open = (item: (typeof matches)[number]) => {
    navigate(workbenchLink(item.view, moduleId, { item: String(item.id) }))
    close()
  }
  return (
    <dialog
      className="search-dialog"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      aria-label="Search backlog"
    >
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (matches[0]) open(matches[0])
        }}
      >
        <Search className="ic" />
        <input
          autoFocus
          placeholder="Search by number, title, or PR author"
          aria-label="Search query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="btn" type="button" aria-label="Close search" onClick={close}>
          <X className="ic" />
        </button>
      </form>
      {loading && <p className="state-message">Loading the module index…</p>}
      {summaryError ? (
        <LoadError error={summaryError} retry={reload} busy={busy} />
      ) : (
        searchError && (
          <LoadError
            error={searchError}
            reload={reload}
            busy={busy}
            retry={() => {
              if (prs.isError) void prs.refetch()
              if (issues.isError) void issues.refetch()
            }}
          />
        )
      )}
      {query.trim() && matches.length === 0 && !loading && !searchError && (
        <p className="state-message">No matching items in this module.</p>
      )}
      <ul>
        {matches.map((item) => (
          <li key={`${item.view}-${item.id}`}>
            <button type="button" className="sb-item" onClick={() => open(item)}>
              <span className="row-id">
                {item.view === 'prs' ? 'PR' : 'Issue'} #{item.id}
              </span>
              {item.title}
            </button>
          </li>
        ))}
      </ul>
    </dialog>
  )
}
