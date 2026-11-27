import { useMemo } from 'react'
import highlighter from 'highlight.js/lib/core'
import cpp from 'highlight.js/lib/languages/cpp'

highlighter.registerLanguage('cpp', cpp)

export default function HighlightedSource({ source }: { source: string }) {
  // highlight.js escapes the original source before inserting token markup.
  const html = useMemo(() => highlighter.highlight(source, { language: 'cpp' }).value, [source])
  const lines = source.split('\n').length - Number(source.endsWith('\n'))
  return <div className="code-lines" tabIndex={0} aria-label="Reproducer source">
    <div className="line-numbers" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => <div key={index}>{index + 1}</div>)}
    </div>
    <pre><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
  </div>
}
