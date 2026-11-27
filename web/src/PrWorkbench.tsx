import { useQuery } from '@tanstack/react-query'
import { Copy, GitPullRequest } from 'lucide-react'
import { prIndexOptions, usePrDetail, type PrDetail, type Summary } from './snapshot'
import { filterPrs, parseItem, prQueues, prSorts, useFilters } from './state'
import { CopyButton, DetailClose, EmptyList, EvidenceLink, EvidenceLinks, humanize, day,
  LoadError, Loading, ModuleTags, SelectFilter, useRowNavigation, utc } from './ui'

export type WorkbenchProps = {
  summary: Summary
  moduleId: string
  reload: () => void
  busy: boolean
}

const ciChoices = { all: 'Any status', passing: 'Passing', failing: 'Failing', pending: 'Pending', unknown: 'Unknown' }
const mergeChoices = { all: 'Any status', mergeable: 'Mergeable', conflicting: 'Conflicting', unknown: 'Unknown' }
const inactiveChoices = { all: 'Any activity', 7: '≥ 7 days', 30: '≥ 30 days', 90: '≥ 90 days' }

export function PrWorkbench({ summary, moduleId, reload, busy }: WorkbenchProps) {
  const { params, update, reset } = useFilters()
  const index = useQuery(prIndexOptions(summary, moduleId))
  const rows = filterPrs(index.data?.items ?? [], params, summary.generatedAt)
  const selected = parseItem(params.get('item'))
  const select = (id: number | null, replace?: boolean) => update({ item: id }, replace)
  const navigation = useRowNavigation(rows, selected, select)
  const selectedRow = index.data?.items.find(item => item.id === selected)
  const setFilter = (key: string) => (value: string) => update({ [key]: value, item: null })

  return <>
    <div className="filter-bar">
      <div className="fpills">
        <SelectFilter label="Queue" options={{ all: 'All PRs', ...prQueues }} value={params.get('queue') ?? 'all'} change={setFilter('queue')} />
        <SelectFilter label="CI" options={ciChoices} value={params.get('ci') ?? 'all'} change={setFilter('ci')} />
        <SelectFilter label="Mergeability" options={mergeChoices} value={params.get('merge') ?? 'all'} change={setFilter('merge')} />
        <SelectFilter label="Human inactivity" options={inactiveChoices} value={params.get('inactive') ?? 'all'} change={setFilter('inactive')} />
        <SelectFilter label="Sort" options={prSorts} value={params.get('sort') ?? 'priority'} change={value => update({ sort: value })} />
      </div>
      {index.data && <span className="result-count">Showing {rows.length} of {index.data.items.length} PRs</span>}
    </div>
    {index.error && <LoadError error={index.error} reload={reload} busy={busy} retry={index.refetch} />}
    <div className={`split-pr ${selected !== null ? 'has-detail' : ''}`}>
      <div className="pane-list" aria-label="Pull requests" ref={navigation.list}>
        {index.isPending && <Loading>Loading pull requests…</Loading>}
        {index.data && rows.length === 0 && <EmptyList reset={reset} />}
        {rows.map(pr => <button key={pr.id} data-item={pr.id}
          aria-current={selected === pr.id ? 'true' : undefined} onClick={() => select(pr.id)}
          className={`row ${selected === pr.id ? 'selected' : ''}`}>
          <span className="row-top">
            <span className="row-title-wrap"><span className="row-id">#{pr.id}</span><span className="row-title">{pr.title}</span></span>
            <span className="meta-right">@{pr.author}</span>
          </span>
          <span className="verdict-row">{pr.reason}</span>
          <span className="row-foot"><span className="inline-facts">
            <ModuleTags summary={summary} ids={pr.moduleIds} />
            <span className={`fact-txt ${pr.headCi.status === 'passing' ? 'ok' : pr.headCi.status === 'failing' ? 'err' : ''}`}>CI {pr.headCi.status}</span>
            <span title={utc(pr.lastHumanActivityAt)}>Human activity {day(pr.lastHumanActivityAt)}</span>
          </span></span>
        </button>)}
      </div>
      <section className="inspector item-detail" aria-label="Pull request details" ref={navigation.detail}>
        {selected !== null && <div className="detail-close"><DetailClose close={navigation.close} /></div>}
        {selected !== null && index.isPending && <Loading>Loading pull requests…</Loading>}
        {selected === null && <div className="state-message"><GitPullRequest className="ic" /><p>Select a pull request to inspect its current HEAD and review history.</p></div>}
        {selected !== null && index.data && !selectedRow && <div className="state-message">
          <p>Pull request #{selected} is outside this module in the current snapshot.</p>
          <button className="btn" onClick={() => select(null)}>Clear selection</button>
        </div>}
        {selectedRow && <PrInspector key={selectedRow.id} summary={summary} id={selectedRow.id} reload={reload} busy={busy} />}
      </section>
    </div>
  </>
}

function PrInspector({ summary, id, reload, busy }: Omit<WorkbenchProps, 'moduleId'> & { id: number }) {
  const detail = usePrDetail(summary, id)
  if (detail.isPending) return <Loading>Loading pull request #{id}…</Loading>
  if (detail.error) return <LoadError error={detail.error} reload={reload} retry={detail.refetch} busy={busy} />
  return <PrEvidence pr={detail.data} />
}

function PrEvidence({ pr }: { pr: PrDetail }) {
  const { params, update } = useFilters()
  const humanOnly = params.get('bots') !== '1'
  const events = pr.timeline.filter(event => !humanOnly || !event.isBot)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const sha = (value: string) => <code title={value}>{value.slice(0, 12)}</code>
  const priorApproval = pr.latestApproval
    ? pr.commitsSinceApproval === null ? 'Commit distance unknown'
      : pr.commitsSinceApproval === 0 ? 'Approved at current HEAD'
      : `${pr.commitsSinceApproval} commit${pr.commitsSinceApproval === 1 ? '' : 's'} since approval`
    : 'No recorded approval'
  const facts = [
    ['Review at HEAD', humanize(pr.headReview.status), sha(pr.headReview.commitSha)],
    ['CI at HEAD', humanize(pr.headCi.status), sha(pr.headCi.commitSha)],
    ['Mergeability', humanize(pr.mergeability), null],
    ['Unresolved discussions', pr.unresolvedDiscussionCount ?? 'Unknown', null],
  ] as const

  return <>
    <header className="ins-head">
      <div className="ins-head-top"><span className="row-id">#{pr.id} · @{pr.author}</span><EvidenceLink url={pr.url} primary>Open GitHub</EvidenceLink></div>
      <h2 className="ins-title">{pr.title}</h2>
      <div className="inline-facts">
        {pr.queues.map(queue => <span key={queue} className={`badge ${queue === 'approved-follow-up' ? 'warn' : 'mut'}`}>{prQueues[queue]}</span>)}
      </div>
    </header>
    <section className="callout">
      <h3 className="callout-h">Why this PR is here</h3>
      <p className="callout-p">{pr.reason}</p>
      <EvidenceLinks urls={pr.reasonEvidenceUrls} />
    </section>
    <section>
      <h3 className="sec-h"><span>HEAD Health Matrix</span><span>{sha(pr.headSha)}</span></h3>
      <dl className="matrix-2">{facts.map(([label, value, context]) => <div className="m-cell" key={label}>
        <dt className="m-k">{label}</dt><dd className="m-v">{value}</dd><dd className="m-s">{context}</dd>
      </div>)}</dl>
      <div className="evidence-meta">
        <p><strong>Latest approval</strong> · {priorApproval}
          {pr.latestApproval && <> · {sha(pr.latestApproval.commitSha)} · {utc(pr.latestApproval.approvedAt)}</>}
        </p>
        {pr.mergeHelpRequested && <p>Merge help requested</p>}
        <EvidenceLinks urls={pr.unresolvedDiscussionUrls} />
        {pr.requiredChecks.length > 0 && <details>
          <summary>Required checks ({pr.requiredChecks.length})</summary>
          <ul>{pr.requiredChecks.map(check => <li key={`${check.name}-${check.url}`}>
            {check.url ? <EvidenceLink url={check.url}>{check.name}</EvidenceLink> : check.name}
            {' · '}{humanize(check.status)} · {sha(check.commitSha)}
          </li>)}</ul>
        </details>}
      </div>
    </section>
    <section>
      <div className="sec-h"><h3>Timeline</h3><label className="toggle-pill">
        <input type="checkbox" checked={humanOnly} onChange={event => update({ bots: event.target.checked ? null : '1' })} /> Human only
      </label></div>
      <p className="evidence-meta">Last human {utc(pr.lastHumanActivityAt)} · Last bot {utc(pr.lastBotActivityAt)}</p>
      {events.length === 0 ? <p className="muted">No matching timeline events.</p> : <ol className="timeline">
        {events.map((event, index) => <li key={`${event.at}-${event.url}-${index}`} className={`tl ${event.isBot ? 'bot' : 'inf'}`}>
          <time className="tl-t" dateTime={event.at}>{day(event.at)}</time>
          <div><EvidenceLink url={event.url}>@{event.actor}</EvidenceLink> · {event.description}
            {event.commitSha && <> · {sha(event.commitSha)}</>}
          </div>
        </li>)}
      </ol>}
    </section>
    <section>
      <h3 className="sec-h">Reviewers</h3>
      <div className="rev-card">
        <div className="rev-item"><h4>Requested on GitHub</h4>
          {pr.requestedReviewers.length ? <ul>{pr.requestedReviewers.map(reviewer => <li key={`${reviewer.kind}-${reviewer.login}`}>
            <code>@{reviewer.login}</code> · {humanize(reviewer.kind)} · {humanize(reviewer.response)}
          </li>)}</ul> : <p className="muted">No recorded requests.</p>}
        </div>
        <div className="rev-item">
          <div className="rev-top"><h4>Suggested</h4>
            {pr.suggestedReviewers.length > 0 && <CopyButton text={`cc ${pr.suggestedReviewers.map(reviewer => '@' + reviewer.login).join(' ')}`}><Copy className="ic ic-sm" /> Copy @cc</CopyButton>}
          </div>
          {pr.suggestedReviewers.length ? <ul>{pr.suggestedReviewers.map(reviewer => <li key={reviewer.login}>
            <code>@{reviewer.login}</code><p className="muted">{reviewer.reason}</p>
            <EvidenceLinks urls={reviewer.evidenceUrls} />
          </li>)}</ul> : <p className="muted">No suggestions.</p>}
        </div>
      </div>
    </section>
    <section>
      <h3 className="sec-h">Touched Paths</h3>
      {pr.touchedPaths.length ? <ul className="path-list">{pr.touchedPaths.map(path => <li className="path-row" key={path}>{path}</li>)}</ul>
        : <p className="muted">No paths recorded.</p>}
    </section>
  </>
}
