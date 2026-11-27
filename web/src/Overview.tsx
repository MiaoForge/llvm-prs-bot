import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { Link } from 'react-router'
import { issueIndexOptions, prIndexOptions } from './snapshot'
import { filterIssues, filterPrs, issueQueues, prQueues, workbenchLink } from './state'
import { compactShas, LoadError, Loading } from './ui'
import type { WorkbenchProps } from './PrWorkbench'

export function Overview({ summary, moduleId, reload, busy }: WorkbenchProps) {
  const prs = useQuery(prIndexOptions(summary, moduleId))
  const issues = useQuery(issueIndexOptions(summary, moduleId))
  const kpis = summary.modules.find((module) => module.id === moduleId)?.counts ?? summary.kpis
  const { coverage } = summary
  const sampled = coverage?.mode === 'bounded-sample'
  const topPrs = filterPrs(prs.data?.items ?? [], new URLSearchParams(), summary.generatedAt).slice(
    0,
    3,
  )
  const topIssues = filterIssues(
    issues.data?.items ?? [],
    new URLSearchParams({ queue: 'close-candidate' }),
    summary.generatedAt,
  ).slice(0, 2)
  return (
    <div className="overview-scroll">
      <div className="ov-wrap">
        <section className="overview-header">
          <div className="inline-facts">
            <h2>LLVM Backlog Triage</h2>
            {coverage && (
              <span className={`badge ${sampled ? 'warn' : 'mut'}`} title={coverage.note}>
                {sampled ? 'Bounded sample' : 'Full coverage'}
              </span>
            )}
          </div>
          <p>
            {summary.kpis.prTotal} {sampled ? 'sampled PRs' : 'open PRs'} ·{' '}
            {summary.kpis.issueTotal} {sampled ? 'sampled issues' : 'issues'} across{' '}
            {summary.modules.length} modules
          </p>
        </section>
        <section>
          <h2 className="sec-h">PR Queues · {kpis.prTotal}</h2>
          <div className="kpi-4">
            {Object.entries(prQueues).map(([queue, label], index) => (
              <Kpi
                key={queue}
                label={label}
                count={kpis.prQueues[queue as keyof typeof prQueues]}
                total={kpis.prTotal}
                tone={index === 0 ? 'warn' : index === 1 ? 'inf' : 'mut'}
                href={workbenchLink('prs', moduleId, { queue })}
              />
            ))}
          </div>
        </section>
        <section>
          <h2 className="sec-h">Issue Verification · {kpis.issueTotal}</h2>
          <div className="kpi-4">
            {Object.entries(issueQueues).map(([queue, label], index) => (
              <Kpi
                key={queue}
                label={label}
                count={kpis.issueConclusions[queue as keyof typeof issueQueues]}
                total={kpis.issueTotal}
                tone={index === 0 ? 'warn' : index === 1 ? 'err' : 'mut'}
                href={workbenchLink('issues', moduleId, { queue })}
              />
            ))}
            <Kpi
              label="Fuzzer-Generated"
              count={kpis.generatedByFuzzer}
              total={kpis.issueTotal}
              tone="fuzz"
              href={workbenchLink('issues', moduleId, { source: 'generated-by-fuzzer' })}
            />
          </div>
        </section>
        <div className="ov-bottom-grid">
          <section className="min-w-0">
            <h2 className="sec-h">Module Matrix</h2>
            <div className="tbl-card">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">Module</th>
                    <th scope="col" className="num">
                      {sampled ? 'Sampled PRs' : 'Open PRs'}
                    </th>
                    <th scope="col" className="num">
                      {sampled ? 'Sampled Issues' : 'Issues'}
                    </th>
                    <th scope="col" className="num">
                      Close Candidates
                    </th>
                    <th scope="col" className="num">
                      Fuzzer
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {summary.modules.map((module) => (
                    <tr key={module.id}>
                      <th scope="row">
                        <Link className="link mono" to={workbenchLink('overview', module.id)}>
                          {module.name}
                        </Link>
                      </th>
                      <td className="num">
                        <Link to={workbenchLink('prs', module.id)}>{module.counts.prTotal}</Link>
                      </td>
                      <td className="num">
                        <Link to={workbenchLink('issues', module.id)}>
                          {module.counts.issueTotal}
                        </Link>
                      </td>
                      <td className="num">
                        <Link to={workbenchLink('issues', module.id, { queue: 'close-candidate' })}>
                          {module.counts.issueConclusions['close-candidate']}
                        </Link>
                      </td>
                      <td className="num">
                        <Link
                          to={workbenchLink('issues', module.id, { source: 'generated-by-fuzzer' })}
                        >
                          {module.counts.generatedByFuzzer}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="min-w-0">
            <h2 className="sec-h">Today’s Highest-Signal Items</h2>
            <div className="hl-list">
              {(prs.isPending || issues.isPending) && <Loading>Loading highlights…</Loading>}
              {prs.error && (
                <LoadError error={prs.error} reload={reload} retry={prs.refetch} busy={busy} />
              )}
              {issues.error && (
                <LoadError
                  error={issues.error}
                  reload={reload}
                  retry={issues.refetch}
                  busy={busy}
                />
              )}
              {topPrs.map((pr) => (
                <Highlight
                  key={`pr-${pr.id}`}
                  title={pr.title}
                  note={compactShas(pr.reason)}
                  id={pr.id}
                  href={workbenchLink('prs', moduleId, { item: String(pr.id) })}
                />
              ))}
              {topIssues.map((issue) => (
                <Highlight
                  key={`issue-${issue.id}`}
                  title={issue.title}
                  note="Close candidate · needs human confirmation"
                  id={issue.id}
                  href={workbenchLink('issues', moduleId, { item: String(issue.id) })}
                />
              ))}
              {prs.data && issues.data && topPrs.length + topIssues.length === 0 && (
                <p className="state-message">No highlights in this module.</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function Highlight({
  title,
  note,
  id,
  href,
}: {
  title: string
  note: string
  id: number
  href: string
}) {
  return (
    <Link className="hl-row" to={href}>
      <span className="hl-l">
        <span className="hl-title">
          <span className="row-id">#{id}</span> {title}
        </span>
        <span className="hl-sub">{note}</span>
      </span>
      <ArrowUpRight className="ic" aria-hidden="true" />
    </Link>
  )
}

function Kpi({
  label,
  count,
  total,
  href,
  tone,
}: {
  label: string
  count: number
  total: number
  href: string
  tone: string
}) {
  return (
    <Link className={`kpi ${tone === 'warn' ? 'hl' : ''}`} to={href}>
      <span className="kpi-top">
        {label}
        <span className={`sdot ${tone}`} />
      </span>
      <span className={`kpi-val ${tone}`}>{count}</span>
      <span className="bar-track" aria-hidden="true">
        <span
          className={`bar-fill ${tone}`}
          style={{ width: `${total ? (100 * count) / total : 0}%` }}
        />
      </span>
    </Link>
  )
}
