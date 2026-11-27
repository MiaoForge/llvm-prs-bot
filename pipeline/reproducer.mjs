import { extractCrashSignature } from './issue-verification.mjs'

const languages = new Map([
  ['c', 'c'],
  ['c++', 'c++'],
  ['cpp', 'c++'],
  ['cxx', 'c++'],
  ['cc', 'c++'],
])
const fencePattern = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*)[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm

export function parseArgumentTokens(command) {
  const tokens = []
  let token = ''
  let quote = null
  let started = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (char === '\\' && quote !== "'") {
      if (++index === command.length) return null
      const escaped = command[index]
      if (escaped === '\n') continue
      if (quote === '"' && !/["\\$`]/.test(escaped)) token += '\\'
      token += escaped
    } else if (quote) {
      if (char === quote) quote = null
      else token += char
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token)
      token = ''
      started = false
      continue
    } else if (/[;&|<>()`$]/.test(char)) {
      return null
    } else {
      token += char
    }
    started = true
  }
  if (quote) return null
  if (started) tokens.push(token)
  return tokens
}

function invocation(line) {
  const command = line
    .trim()
    .replace(/^\$ +/, '')
    .replace(/^`([^`]+)`$/, '$1')
  const clang = /^clang(?:\+\+)?(?:-\d+)?(?:\s+|$)/.exec(command)
  const flags = /^(?:flags|compile (?:flags|arguments)):\s*/i.exec(command)
  if (!clang && !flags) return null
  const tokens = parseArgumentTokens(
    command.slice((clang ?? flags)[0].length).replace(/^`([^`]+)`$/, '$1'),
  )
  if (tokens === null) return null
  if (flags) return tokens.length && tokens[0].startsWith('-') ? tokens : null
  // Only a single local input can be replaced by Compiler Explorer's source pane.
  const inputs = tokens.filter((arg) => /^(?:\.\/)?[\w.-]+\.(?:c|cc|cpp|cxx|C)$/.test(arg))
  return inputs.length === 1 ? tokens.filter((arg) => arg !== inputs[0]) : null
}

export function supportsCompileArgs(args) {
  // The pilot rechecks single-file frontend behavior. Pass options as
  // argument tokens and restrict them to portable compilation settings.
  return (
    Array.isArray(args) &&
    args.every((arg) =>
      /^-(?:std=[\w+.-]+|O[0-3sgz]|g[0-3]?|W[\w=+-]+|[DU][A-Za-z_]\w*(?:=[^\r\n\0]*)?|fsyntax-only|ferror-limit=\d+|f(?:no-)?(?:exceptions|rtti)|pedantic(?:-errors)?|pipe|c|S|(?:m32|m64))$/.test(
        arg,
      ),
    )
  )
}

function declaredVersions(text) {
  const versions = [
    ...text.matchAll(/\bclang(?:\+\+)?(?:[ \t]+version)?[ \t-]+(\d{1,2}(?:\.\d+){0,2})\b/gi),
  ].map((match) => match[1])
  const table = /^\|?\s*Version\s*\|\s*(\d{1,2}(?:\.\d+){0,2})(?:\s*\||\s*$)/im.exec(text)
  if (table) versions.push(table[1])
  return [...new Set(versions)]
}

function expectedText(lines) {
  const label = /^(?:#{1,6}[ \t]*)?Expected(?:[ \t]+(?:behavior|output|result))?[ \t]*:[ \t]*(.*)$/i
  const index = lines.findIndex((line) => label.test(line))
  if (index === -1) return null
  const text = [label.exec(lines[index])[1].trim()].filter(Boolean)
  for (const line of lines.slice(index + 1)) {
    const trimmed = line.trim()
    if (
      /^(?:#|(?:Actual|Observed|Version|Flags|Command|Reproduction)(?: behavior| output| result)?\s*:)/i.test(
        trimmed,
      )
    )
      break
    if (trimmed) text.push(trimmed)
  }
  return text.length ? text.join('\n') : null
}

function expectedConditions(text, kind) {
  if (!text) return {}
  // Recognize complete statements. Matching only a prefix can discard a
  // diagnostic or warning that is part of the requested behavior.
  if (
    /^(?:should compile(?: successfully)?|compiles successfully|accepts? (?:the )?(?:code|program|input))\.?$/i.test(
      text,
    )
  ) {
    return { exitCode: 0 }
  }
  if (
    kind === 'crash' &&
    /^(?:no crash|(?:the compiler )?should not crash|safe termination)\.?$/i.test(text)
  ) {
    return { noCrash: true }
  }
  const diagnostic = /^\x60((?:fatal )?error: [^\x60\n]+)\x60$/i.exec(text)
  return diagnostic ? { diagnosticIncludes: diagnostic[1] } : {}
}

function reporterGodboltUrls(markdown) {
  const urls = new Set()
  for (const match of markdown.matchAll(/\bhttps:\/\/[^\s<>"'\x60\\\]]+/gi)) {
    let candidate = match[0].replace(/[.,;!?]+$/, '')
    // Remove Markdown's closing parenthesis while preserving balanced URL state.
    let extraClosers = candidate.split(')').length - candidate.split('(').length
    while (extraClosers > 0 && candidate.endsWith(')')) {
      candidate = candidate.slice(0, -1)
      extraClosers--
    }
    const url = URL.parse(candidate)
    if (
      url &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^(?:www\.)?(?:godbolt\.org|compiler-explorer\.com)$/.test(url.hostname)
    ) {
      urls.add(url.href)
    }
  }
  return [...urls]
}

export function extractReproducer(body = '', title = '') {
  const markdown = body.replaceAll('\r\n', '\n')
  const fences = [...markdown.matchAll(fencePattern)]
  const sources = fences.filter((fence) => languages.has(fence[2].toLowerCase()))
  const source = sources.length === 1 ? sources[0] : null
  const prose = markdown.replace(fencePattern, (block, _marker, info) =>
    languages.has(info.toLowerCase()) ? '\n' : block,
  )
  const lines = prose.split('\n')
  const invocations = lines.map(invocation).filter((args) => args !== null)
  const distinctArgs = new Map(invocations.map((args) => [JSON.stringify(args), args]))
  const compileArgs = distinctArgs.size === 1 ? distinctArgs.values().next().value : null
  const explicitExpected = expectedText(lines)
  const crashSignature = extractCrashSignature(title) ?? extractCrashSignature(prose)
  const kind =
    crashSignature ||
    /\b(?:crash(?:es|ed)?|assertion|stack overflow)\b/i.test(title) ||
    /\b(?:clang(?:\+\+)?|(?:the )?compiler) (?:crashes|crashed|segfaults|segfaulted)\b/i.test(prose)
      ? 'crash'
      : /(?:fatal )?error:\s*/i.test(prose) || /\bdiagnostic\b/i.test(title)
        ? 'diagnostic'
        : 'unknown'
  const diagnostic = /^(?!.*expected(?: behavior| output| result)?:).*?\berror:\s*(\S[^\n]*)/im
    .exec(prose)?.[1]
    ?.trim()
  const reported = crashSignature ?? (kind === 'diagnostic' ? diagnostic : null)
  const implicitNoCrash = kind === 'crash' && explicitExpected === null
  const expectedBehavior =
    explicitExpected ?? (implicitNoCrash ? 'The compiler should not crash.' : null)
  const expected = expectedConditions(expectedBehavior, kind)
  const versions = declaredVersions(prose)
  const links = reporterGodboltUrls(markdown)
  return {
    kind,
    language: source ? languages.get(source[2].toLowerCase()) : null,
    declaredVersion: versions.length === 1 ? versions[0] : null,
    versionAmbiguous: versions.length > 1,
    reportedCrashSignature: crashSignature,
    repro: {
      sourceCode: source?.[3]?.trim() ? source[3] : null,
      compileArgs,
      expectedBehavior,
      ...(links.length ? { reporterGodboltUrls: links } : {}),
    },
    expectations: {
      reported:
        kind === 'crash' && (implicitNoCrash || !reported)
          ? { crash: true }
          : reported
            ? { diagnosticIncludes: reported }
            : {},
      expected,
    },
  }
}
