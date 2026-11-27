import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { isMissingSnapshotFile, type PrDetail, type Summary } from './snapshot'
import { nextItem } from './state'

export function humanize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll('-', ' ')
}

export function utc(value: string | null) {
  return value ? `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Unknown'
}

export function day(value: string | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : 'Unknown'
}

export function compactCompilerVersion(version: string | null) {
  const firstLine = version?.trim().split(/\r?\n/, 1)[0].trim()
  if (!firstLine) return 'Unknown'

  const clang = firstLine.match(/\bclang version\s+(\d[\w.+-]*)/i)?.[1]
  if (clang) {
    const revision = firstLine.match(/\s([0-9a-f]{7,40})(?=\s*(?:\)|$))/i)?.[1]
    return revision ? `clang ${clang} · ${revision.slice(0, 12)}` : `clang ${clang}`
  }

  return firstLine.length > 36 ? `${firstLine.slice(0, 35).trimEnd()}…` : firstLine
}

export function ModuleEvidence({
  evidence,
  modules,
}: {
  evidence: PrDetail['moduleEvidence']
  modules: Summary['modules']
}) {
  if (!evidence?.length) return null
  return (
    <section aria-label="Module Evidence">
      <h3 className="sec-h">Module Evidence</h3>
      <dl className="grid gap-3 text-xs">
        {evidence.map(({ moduleId, matchedPaths, matchedLabels }) => (
          <div key={moduleId}>
            <dt className="font-semibold">
              {modules.find(({ id }) => id === moduleId)?.name ?? moduleId}
            </dt>
            {matchedPaths?.length ? (
              <dd className="mt-1">
                Matched paths
                <ul className="list-disc pl-5">
                  {matchedPaths.map((path) => (
                    <li key={path}>
                      <code className="break-all">{path}</code>
                    </li>
                  ))}
                </ul>
              </dd>
            ) : null}
            {matchedLabels?.length ? (
              <dd className="mt-1">
                Matched labels
                <ul className="inline-facts mt-1">
                  {matchedLabels.map((label) => (
                    <li key={label}>
                      <span className="mod-tag">{label}</span>
                    </li>
                  ))}
                </ul>
              </dd>
            ) : null}
          </div>
        ))}
      </dl>
    </section>
  )
}

export function EvidenceLink({
  url,
  children,
  primary = false,
}: {
  url: string
  children: ReactNode
  primary?: boolean
}) {
  return (
    <a
      className={primary ? 'btn primary' : 'link inline-flex items-center gap-1'}
      href={url}
      target="_blank"
      rel="noreferrer"
    >
      {children}
      <ExternalLink className="ic ic-sm" aria-hidden="true" />
    </a>
  )
}

export function EvidenceLinks({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null
  return (
    <ul className="evidence-links">
      {urls.map((url, i) => (
        <li key={url}>
          <EvidenceLink url={url}>
            {urls.length === 1 ? 'Evidence' : `Evidence ${i + 1}`}
          </EvidenceLink>
        </li>
      ))}
    </ul>
  )
}

export function CopyButton({ text, children }: { text: string; children: ReactNode }) {
  const [status, setStatus] = useState('')
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        className="btn"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setStatus('Copied')
          } catch {
            setStatus('Clipboard unavailable')
          }
        }}
      >
        {children}
      </button>
      <span role="status" className="muted text-xs">
        {status}
      </span>
    </span>
  )
}

export function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="state-message" role="status">
      <p>{children}</p>
      <div className="skeleton" aria-hidden="true" />
      <div className="skeleton short" aria-hidden="true" />
    </div>
  )
}

export function FilteredSelection({ clearFilters }: { clearFilters: () => void }) {
  return (
    <div className="callout warn">
      <p role="status">This item is still in this module but does not match the current filters.</p>
      <div>
        <button type="button" className="btn" onClick={clearFilters}>
          Clear filters
        </button>
      </div>
    </div>
  )
}

export function LoadError({
  error,
  reload,
  retry,
  busy = false,
}: {
  error: Error
  reload?: () => void
  retry?: () => void
  busy?: boolean
}) {
  const expired = isMissingSnapshotFile(error) && reload
  return (
    <div className="state-message" role="alert">
      <p>
        {expired
          ? 'This file is unavailable in the current snapshot. Load the latest snapshot to continue.'
          : error.message}
      </p>
      {expired ? (
        <button type="button" className="btn" disabled={busy} onClick={reload}>
          Load latest snapshot
        </button>
      ) : (
        retry && (
          <button type="button" className="btn" disabled={busy} onClick={retry}>
            Try again
          </button>
        )
      )}
    </div>
  )
}

export function SelectFilter({
  label,
  value,
  options,
  change,
}: {
  label: string
  value: string
  options: Record<string, string>
  change: (value: string) => void
}) {
  return (
    <label className="fpill">
      {label}
      <select
        aria-label={label}
        value={Object.hasOwn(options, value) ? value : Object.keys(options)[0]}
        onChange={(event) => change(event.target.value)}
      >
        {Object.entries(options)
          .sort(([a], [b]) => Number(b === 'all') - Number(a === 'all'))
          .map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
      </select>
    </label>
  )
}

export function ModuleTags({ summary, ids }: { summary: Summary; ids: string[] }) {
  return (
    <>
      {ids.map((id) => (
        <span key={id} className="mod-tag">
          {summary.modules.find((module) => module.id === id)?.name ?? id}
        </span>
      ))}
    </>
  )
}

export function useRowNavigation(
  items: readonly { id: number }[],
  selected: number | null,
  select: (id: number | null, replace?: boolean) => void,
) {
  const list = useRef<HTMLElement>(null)
  const detail = useRef<HTMLElement>(null)
  const returnFocus = useRef<number | null>(null)

  const close = useCallback(() => {
    returnFocus.current = selected
    select(null)
  }, [selected, select])

  useLayoutEffect(() => {
    if (selected === null && returnFocus.current !== null) {
      list.current?.querySelector<HTMLElement>(`[data-item="${returnFocus.current}"]`)?.focus()
      returnFocus.current = null
    }
    if (selected !== null && detail.current) {
      detail.current.scrollTop = 0
      if (window.matchMedia?.('(max-width: 1139px)').matches) {
        detail.current
          .querySelector<HTMLButtonElement>('button[aria-label="Close details"]')
          ?.focus()
      }
    }
  }, [selected])

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = event.target instanceof Element ? event.target : null
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        target?.closest('input, select, textarea, [contenteditable], dialog[open]')
      )
        return

      if (event.key === 'Escape' && selected !== null) {
        event.preventDefault()
        close()
      }
      if (event.key !== 'j' && event.key !== 'k') return
      if (selected !== null && window.matchMedia?.('(max-width: 1139px)').matches) return
      const focused = list.current?.contains(document.activeElement)
        ? document.activeElement?.closest<HTMLElement>('[data-item]')?.dataset.item
        : undefined
      const id = nextItem(items, focused ? Number(focused) : selected, event.key === 'j' ? 1 : -1)
      if (id === null) return
      event.preventDefault()
      list.current?.querySelector<HTMLElement>(`[data-item="${id}"]`)?.focus()
      if (selected !== null && selected !== id) select(id, true)
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [items, selected, select, close])

  return { list, detail, close }
}

export function DetailClose({ close }: { close: () => void }) {
  return (
    <button type="button" className="btn" aria-label="Close details" onClick={close}>
      <X className="ic" />
    </button>
  )
}

export function EmptyList({ reset }: { reset: () => void }) {
  return (
    <div className="state-message">
      <p>No items match these filters.</p>
      <button type="button" className="btn" onClick={reset}>
        Reset filters
      </button>
    </div>
  )
}
