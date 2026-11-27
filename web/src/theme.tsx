import { useEffect, useState } from 'react'

const themes = ['graphite', 'dimmed', 'light'] as const
type Theme = typeof themes[number]

function storedTheme(): Theme {
  try {
    const saved = localStorage.getItem('llvm-triage-theme')
    return themes.find(theme => theme === saved) ?? 'graphite'
  } catch {
    return 'graphite'
  }
}

export function ThemePicker() {
  const [theme, setTheme] = useState(storedTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('llvm-triage-theme', theme)
    } catch {
      // The current palette still works if storage is unavailable.
    }
  }, [theme])

  return <div className="seg" role="group" aria-label="Color theme">
    {themes.map(option => (
      <button key={option} type="button" className="seg-btn capitalize" aria-pressed={theme === option}
        onClick={() => setTheme(option)}>
        {option}
      </button>
    ))}
  </div>
}
