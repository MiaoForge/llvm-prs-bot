const maxClientstateUrlLength = 4096

function inferLanguage(compileArgs: string[] | null, language?: 'c' | 'c++'): 'c' | 'c++' {
  if (language === 'c' || language === 'c++') return language
  if (!compileArgs) return 'c++'
  for (let i = 0; i < compileArgs.length; i++) {
    const arg = compileArgs[i]
    if (arg === '-x' && compileArgs[i + 1] === 'c') return 'c'
    if (arg === '-xc' || /^-std=(?:(?:c|gnu)\d|iso9899[:\d])/.test(arg)) return 'c'
  }
  return 'c++'
}

function formatCompilerOptions(compileArgs: string[] | null): string {
  if (!compileArgs || compileArgs.length === 0) return ''
  return compileArgs
    .map((arg) =>
      arg === '' || /[\s"'\\]/.test(arg) ? `"${arg.replace(/([\\"])/g, '\\$1')}"` : arg,
    )
    .join(' ')
}

function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function buildGodboltUrl({
  sourceCode,
  compileArgs,
  language,
}: {
  sourceCode: string
  compileArgs: string[] | null
  language?: 'c' | 'c++'
}): string | null {
  if (sourceCode.length === 0) return null
  const resolvedLanguage = inferLanguage(compileArgs, language)
  const compilerId = resolvedLanguage === 'c' ? 'cclang_trunk' : 'clang_trunk'
  const state = {
    sessions: [
      {
        id: 1,
        language: resolvedLanguage,
        source: sourceCode,
        compilers: [{ id: compilerId, options: formatCompilerOptions(compileArgs) }],
      },
    ],
  }
  const encoded = encodeURIComponent(encodeUtf8Base64(JSON.stringify(state)))
  const url = `https://godbolt.org/clientstate/${encoded}`
  return url.length <= maxClientstateUrlLength ? url : null
}
