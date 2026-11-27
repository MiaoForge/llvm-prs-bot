import { useMemo } from 'react'
import highlighter from 'highlight.js/lib/core'
import cpp from 'highlight.js/lib/languages/cpp'

highlighter.registerLanguage('cpp', cpp)

export default function HighlightedSource({ source }: { source: string }) {
  // highlight.js escapes the original source before inserting token markup.
  const html = useMemo(() => highlighter.highlight(source, { language: 'cpp' }).value, [source])
  const lines = source.split('\n').length - Number(source.endsWith('\n'))
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the source.
    <section className="code-lines" tabIndex={0} aria-label="Reproducer source">
      <div className="line-numbers" aria-hidden="true">
        {Array.from({ length: lines }, (_, index) => index + 1).map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
      <pre>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: The fixed C++ highlighter escapes source text before emitting token spans. */}
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </section>
  )
}
