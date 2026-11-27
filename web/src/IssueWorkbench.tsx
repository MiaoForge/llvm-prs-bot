import { lazy, Suspense } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Copy, FlaskConical, Zap } from 'lucide-react'
import { issueIndexOptions, useIssueDetail, type IssueDetail, type IssueRow } from './snapshot'
import { filterIssues, issueQueues, issueSorts, issueSources, parseItem, useFilters } from './state'
import { CopyButton, DetailClose, EmptyList, EvidenceLink, EvidenceLinks, day, humanize,
  LoadError, Loading, ModuleTags, SelectFilter, useRowNavigation, utc } from './ui'
import type { WorkbenchProps } from './PrWorkbench'

const HighlightedSource = lazy(() => import('./HighlightedSource'))
const ageChoices = { all: 'Any age', older: 'Over 10 years', middle: '5–10 years', recent: 'Under 5 years' }
const fixChoices = { all: 'Any status', confirmed: 'Confirmed', candidate: 'Candidate', unknown: 'Unknown' }

const verdicts = {
  'close-candidate': { title: 'Close candidate', tone: 'warn', explanation: 'The baseline reproduced the reported symptom and trunk met the expected behavior. Review the evidence before closing.' },
  'still-reproducible': { title: 'Still reproducible', tone: 'err', explanation: 'Both compiler runs reproduced the reported symptom.' },
  'insufficient-evidence': { title: 'Insufficient evidence', tone: 'mut', explanation: 'The recorded runs do not establish a conclusive baseline-to-trunk comparison.' },
} satisfies Record<IssueRow['conclusion'], { title: string; tone: string; explanation: string }>

type Outcome = NonNullable<IssueRow['baseline']>['outcome']
const outcomes = {
  'reported-symptom': { label: 'Reported symptom', tone: 'err' },
  'expected-behavior': { label: 'Expected behavior', tone: 'ok' },
  'different-behavior': { label: 'Different behavior', tone: 'warn' },
  unknown: { label: 'Unknown', tone: 'mut' },
} satisfies Record<Outcome, { label: string; tone: string }>

const gaps = {
  'source-code': 'Reproducer source code is unavailable.',
  'compile-arguments': 'Compiler arguments are unavailable.',
  'expected-behavior': 'Expected behavior is undocumented.',
  'baseline-version': 'The historical compiler version is unknown.',
  'baseline-run': 'A baseline run is unavailable.',
  'baseline-symptom': 'The baseline did not confirm the reported symptom.',
  'trunk-run': 'A trunk run is unavailable.',
  'trunk-outcome': 'The trunk outcome does not establish a conclusive comparison.',
  'crash-signature': 'The crash signature is unavailable.',
  other: 'The snapshot records another evidence gap.',
} satisfies Record<IssueDetail['missingEvidence'][number], string>

export function IssueWorkbench({ summary, moduleId, reload, busy }: WorkbenchProps) {
  const { params, update, reset } = useFilters()
  const index = useQuery(issueIndexOptions(summary, moduleId))
  const rows = filterIssues(index.data?.items ?? [], params, summary.generatedAt)
  const selected = parseItem(params.get('item'))
  const select = (id: number | null, replace?: boolean) => update({ item: id }, replace)
  const navigation = useRowNavigation(rows, selected, select)
  const selectedRow = index.data?.items.find(item => item.id === selected)
  const setFilter = (key: string) => (value: string) => update({ [key]: value, item: null })

  return <>
    <div className="filter-bar issues-filter">
      <div className="fpills">
        <div className="seg" role="group" aria-label="Issue source">
          {Object.entries(issueSources).map(([source, label]) => <button key={source}
            className={`seg-btn ${source === 'generated-by-fuzzer' ? 'fuzz' : ''}`}
            aria-pressed={(params.get('source') ?? 'all') === source}
            onClick={() => setFilter('source')(source)}>{label}</button>)}
        </div>
        <SelectFilter label="Queue" options={{ all: 'Any outcome', ...issueQueues }} value={params.get('queue') ?? 'all'} change={setFilter('queue')} />
        <SelectFilter label="Report age" options={ageChoices} value={params.get('age') ?? 'all'} change={setFilter('age')} />
        <SelectFilter label="Fix" options={fixChoices} value={params.get('fix') ?? 'all'} change={setFilter('fix')} />
        <SelectFilter label="Sort" options={issueSorts} value={params.get('sort') ?? 'verified'} change={value => update({ sort: value })} />
      </div>
      {index.data && <span className="result-count">Showing {rows.length} of {index.data.items.length} issues</span>}
    </div>
    {index.error && <LoadError error={index.error} reload={reload} busy={busy} retry={index.refetch} />}
    <div className={`split-issue ${selected !== null ? 'has-detail' : ''}`}>
      <div className="pane-list" aria-label="Issues" ref={navigation.list}>
        {index.isPending && <Loading>Loading issues…</Loading>}
        {index.error && <LoadError error={index.error} reload={reload} retry={index.refetch} busy={busy} />}
        {index.data && rows.length === 0 && <EmptyList reset={reset} />}
        {rows.map(issue => <button key={issue.id} data-item={issue.id}
          aria-current={selected === issue.id ? 'true' : undefined} onClick={() => select(issue.id)}
          className={`row ${selected === issue.id ? 'selected' : ''}`}>
          <span className="row-title-wrap"><span className="row-id">#{issue.id}</span><span className="row-title">{issue.title}</span></span>
          <span className="inline-facts"><IssueBadges issue={issue} /><ModuleTags summary={summary} ids={issue.moduleIds} /></span>
          <span className="inline-facts comparison-row">
            <span>Baseline <OutcomeText outcome={issue.baseline?.outcome} /></span>
            <ArrowRight className="ic ic-sm" aria-hidden="true" />
            <span>Trunk <OutcomeText outcome={issue.trunk?.outcome} /></span>
          </span>
          <span className="row-foot issue-row-foot">
            <span>Reported {day(issue.originalReportAt)} · {tracker(issue.originalReportTracker)}</span>
            <span title={utc(issue.lastVerifiedAt)}>Verified {issue.lastVerifiedAt ? day(issue.lastVerifiedAt) : '—'}</span>
          </span>
        </button>)}
      </div>
      <section className="issue-detail item-detail" aria-label="Issue details" ref={navigation.detail}>
        {selected !== null && <div className="detail-close"><DetailClose close={navigation.close} /></div>}
        {selected !== null && index.isPending && <Loading>Loading issues…</Loading>}
        {selected === null && <div className="state-message"><FlaskConical className="ic" /><p>Select an issue to compare its baseline and trunk runs.</p></div>}
        {selected !== null && index.data && !selectedRow && <div className="state-message">
          <p>Issue #{selected} is outside this module in the current snapshot.</p>
          <button className="btn" onClick={() => select(null)}>Clear selection</button>
        </div>}
        {selectedRow && <IssueInspector key={selectedRow.id} summary={summary} id={selectedRow.id} reload={reload} busy={busy} />}
      </section>
    </div>
  </>
}

function tracker(value: IssueRow['originalReportTracker']) {
  if (value === 'github') return 'GitHub'
  return value === 'bugzilla' ? 'Bugzilla' : 'Unknown tracker'
}

function IssueBadges({ issue }: { issue: IssueRow }) {
  const verdict = verdicts[issue.conclusion]
  return <><span className={`badge ${verdict.tone}`}>{verdict.title}</span>
    {issue.source === 'generated-by-fuzzer' && <span className="badge fuzz">generated-by-fuzzer</span>}</>
}

function OutcomeText({ outcome }: { outcome: Outcome | undefined }) {
  const display = outcome ? outcomes[outcome] : { label: 'Unavailable', tone: 'mut' }
  return <span className={`fact-txt ${display.tone}`}>{display.label}</span>
}

function IssueInspector({ summary, id, reload, busy }: Omit<WorkbenchProps, 'moduleId'> & { id: number }) {
  const detail = useIssueDetail(summary, id)
  if (detail.isPending) return <Loading>Loading issue #{id}…</Loading>
  if (detail.error) return <LoadError error={detail.error} reload={reload} retry={detail.refetch} busy={busy} />
  return <IssueEvidence issue={detail.data} />
}

export function closeComment(issue: IssueDetail) {
  const { baseline, trunk } = issue.runs
  if (issue.conclusion !== 'close-candidate' || !baseline || !trunk) return null
  const parts = [
    'I rechecked the reproducer from this issue with the following compilers:',
    `- Baseline: ${baseline.compilerVersion} (exit ${baseline.exitCode}) reproduced the reported symptom.${baseline.godboltUrl ? ` [Compiler Explorer](${baseline.godboltUrl})` : ''}`,
    `- Trunk: ${trunk.compilerVersion} (exit ${trunk.exitCode}) met the expected behavior.${trunk.godboltUrl ? ` [Compiler Explorer](${trunk.godboltUrl})` : ''}`,
  ]
  if (issue.repro.expectedBehavior !== null) parts.push('', 'Expected behavior: ' + issue.repro.expectedBehavior)
  parts.push('', 'Could a maintainer confirm whether this issue can be closed?')
  return parts.join('\n')
}

function IssueEvidence({ issue }: { issue: IssueDetail }) {
  const verdict = verdicts[issue.conclusion]
  const { baseline, trunk } = issue.runs
  const { sourceCode, compileArgs, expectedBehavior, sourceUrl } = issue.repro
  const comment = closeComment(issue)
  const godbolt = trunk?.godboltUrl ?? baseline?.godboltUrl
  return <>
    <header className="ins-head">
      <div className="ins-head-top">
        <div className="inline-facts"><span className="row-id">#{issue.id}</span><IssueBadges issue={issue} /></div>
        <div className="inline-facts">
          <EvidenceLink url={issue.url}>Open GitHub</EvidenceLink>
          {comment !== null && <CopyButton text={comment}><Copy className="ic ic-sm" />Copy Close Comment</CopyButton>}
          {godbolt && <EvidenceLink url={godbolt} primary>Open in Godbolt</EvidenceLink>}
        </div>
      </div>
      <h2 className="ins-title">{issue.title}</h2>
      <div className="inline-facts evidence-meta">
        <span>GitHub synced <time dateTime={issue.githubSyncedAt}>{utc(issue.githubSyncedAt)}</time></span>
        <span>Last verified {issue.lastVerifiedAt
          ? <time dateTime={issue.lastVerifiedAt}>{utc(issue.lastVerifiedAt)}</time> : 'Unknown'}</span>
      </div>
    </header>
    {issue.crashSignature && <section className={`callout ${verdict.tone}`}>
      <h3 className="callout-h"><span className="inline-flex items-center gap-2"><Zap className="ic" />Fuzzer Crash Signature</span></h3>
      <pre className="diag crash-signature">{issue.crashSignature}</pre>
    </section>}
    <div className="matrix-2 issue-verdict-grid">
      <section className={`callout ${verdict.tone}`}>
        <h3 className="callout-h">Verification Result</h3><p className="callout-p">{verdict.explanation}</p>
      </section>
      <section className="callout mut">
        <h3 className="callout-h">Fix Attribution · {humanize(issue.fixAttribution.status)}</h3>
        {issue.fixAttribution.status === 'unknown' ? <p className="callout-p">No fix commit has been identified.</p>
          : <><p className="callout-p">{issue.fixAttribution.reason}</p>
            <code className="break-all text-xs">{issue.fixAttribution.commitSha}</code>
            <EvidenceLinks urls={issue.fixAttribution.evidenceUrls} /></>}
      </section>
    </div>
    {issue.missingEvidence.length > 0 && <section className="callout mut">
      <h3 className="callout-h">Missing Evidence Checklist</h3>
      <ul className="list-disc pl-5">{issue.missingEvidence.map(gap => <li key={gap}>{gaps[gap]}</li>)}</ul>
    </section>}
    <section className="code-box">
      <div className="code-bar">
        <h3>Extracted Reproducer</h3>
        <div className="inline-facts">
          {sourceUrl && <EvidenceLink url={sourceUrl}>Source report</EvidenceLink>}
          {sourceCode !== null && <CopyButton text={sourceCode}>Copy source</CopyButton>}
        </div>
      </div>
      <div className="compile-args">
        <strong>Compiler arguments</strong>
        {compileArgs === null ? 'Unknown' : compileArgs.length ? (
          <ul className="inline-facts">{compileArgs.map((arg, index) => <li key={index}><code>{JSON.stringify(arg)}</code></li>)}</ul>
        ) : 'None'}
      </div>
      {sourceCode === null ? <p className="state-message">No source code is available.</p> : (
        <Suspense fallback={<pre className="diag">{sourceCode}</pre>}>
          <HighlightedSource source={sourceCode} />
        </Suspense>
      )}
    </section>
    <div className="diff-grid">
      <Diagnostic title="Baseline" run={baseline} />
      <Diagnostic title="Trunk" run={trunk} />
    </div>
    <section className="m-cell">
      <h3 className="m-k">Expected Behavior</h3><p className="expected-behavior">{expectedBehavior ?? 'Unknown'}</p>
    </section>
  </>
}

function Diagnostic({ title, run }: { title: string; run: IssueDetail['runs']['trunk'] }) {
  return <section className="code-box" aria-label={`${title} diagnostics`}>
    <div className="code-bar">
      <h3>{title}{run && <> · <code title={run.compilerId}>{run.compilerVersion}</code></>}</h3>
      {run && <span className={`badge ${outcomes[run.outcome].tone}`}>exit {run.exitCode}</span>}
    </div>
    {run ? <>
      <div className="run-meta"><OutcomeText outcome={run.outcome} />
        {run.godboltUrl && <EvidenceLink url={run.godboltUrl}>Godbolt</EvidenceLink>}
      </div>
      {run.diagnostics !== '' ? <pre className="diag" tabIndex={0}>{run.diagnostics}</pre>
        : <p className="state-message">No diagnostic output.</p>}
    </> : <p className="state-message">No compiler run recorded.</p>}
  </section>
}
