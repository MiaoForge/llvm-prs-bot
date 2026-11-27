import { setTimeout as delay } from 'node:timers/promises'
import { parseArgumentTokens } from './reproducer.mjs'

const shortIdPattern = /^[A-Za-z0-9_-]+$/
const clangIdPattern = /^c?clang(?:\d+|_[a-z])[a-z0-9_]*$/
const clangReleaseIdPattern = /^c?clang\d+(?:assert)?$/
const defaultMaxClientstateUrlLength = 4096

function formatCompilerOptions(compileArgs) {
  return compileArgs
    .map((arg) =>
      arg === '' || /[\s"'\\]/.test(arg) ? `"${arg.replace(/([\\"])/g, '\\$1')}"` : arg,
    )
    .join(' ')
}

export function compilerExplorerClientstateUrl({
  compilerId,
  sourceCode,
  compileArgs = [],
  language = 'c++',
  baseUrl = 'https://godbolt.org/',
  maxUrlLength = defaultMaxClientstateUrlLength,
}) {
  if (
    typeof compilerId !== 'string' ||
    !/^[a-z0-9_+-][a-z0-9_.+-]*$/i.test(compilerId) ||
    typeof sourceCode !== 'string' ||
    sourceCode.length === 0 ||
    (language !== 'c' && language !== 'c++') ||
    !Array.isArray(compileArgs) ||
    compileArgs.some((arg) => typeof arg !== 'string')
  ) {
    return null
  }
  const state = {
    sessions: [
      {
        id: 1,
        language,
        source: sourceCode,
        compilers: [{ id: compilerId, options: formatCompilerOptions(compileArgs) }],
      },
    ],
  }
  const encoded = encodeURIComponent(Buffer.from(JSON.stringify(state), 'utf8').toString('base64'))
  const url = new URL(`clientstate/${encoded}`, baseUrl).href
  return url.length <= maxUrlLength ? url : null
}

export function compilerExplorerShortId(value) {
  if (typeof value !== 'string') return null
  const url = URL.parse(value)
  if (
    url?.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !/^(?:www\.)?(?:godbolt\.org|compiler-explorer\.com)$/.test(url.hostname)
  ) {
    return null
  }
  return /^\/z\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1] ?? null
}

export function parseShortlinkSession(state) {
  if (!Array.isArray(state?.sessions) || (state.trees != null && !isEmptyList(state.trees))) {
    return null
  }
  if (state.sessions.some((session) => typeof session?.source !== 'string')) return null
  const editors = state.sessions.filter(({ source }) => source.trim())
  if (editors.length !== 1) return null
  const { source, language, compilers } = editors[0]
  if ((language !== 'c' && language !== 'c++') || !Array.isArray(compilers)) return null

  const clang = compilers.filter(
    (compiler) => typeof compiler?.id === 'string' && clangIdPattern.test(compiler.id),
  )
  // Prefer a single historical compiler and keep its options paired with it.
  const releases = clang.filter(({ id }) => clangReleaseIdPattern.test(id))
  const choices = releases.length ? releases : clang
  if (choices.length !== 1) return null
  const [{ id: compilerId, options, libs, overrides }] = choices
  if (
    typeof options !== 'string' ||
    (libs != null && !isEmptyList(libs)) ||
    (overrides != null && !isEmptyList(overrides))
  ) {
    return null
  }
  const compileArgs = parseArgumentTokens(options)
  return compileArgs && { sourceCode: source, compileArgs, language, compilerId }
}

function isEmptyList(value) {
  return Array.isArray(value) && value.length === 0
}
export class CompilerExplorerError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.code = code
  }
}

function readOutput(lines) {
  if (!Array.isArray(lines) || lines.some((line) => typeof line?.text !== 'string')) {
    throw new CompilerExplorerError(
      'invalid-result',
      'Compiler Explorer response has invalid output lines',
    )
  }
  return lines.map(({ text }) => text).join('\n')
}

export function createCompilerExplorerClient({
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://godbolt.org/',
  timeoutMs = 15_000,
  requestBudget = 12,
} = {}) {
  if (!Number.isSafeInteger(requestBudget) || requestBudget < 0) {
    throw new RangeError('requestBudget must be a non-negative safe integer')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError('timeoutMs must be a positive timer interval')
  }

  const base = new URL(baseUrl)
  const catalogs = new Map()
  let remaining = requestBudget
  async function request(path, body) {
    if (remaining === 0) {
      throw new CompilerExplorerError('budget', 'Compiler Explorer request budget exhausted')
    }
    remaining--
    const controller = new AbortController()
    const timeout = delay(timeoutMs, undefined, { signal: controller.signal }).then(() => {
      const error = new CompilerExplorerError('timeout', 'Compiler Explorer request timed out')
      controller.abort(error)
      throw error
    })
    const response = async () => {
      const result = await fetchImpl(new URL(path, base), {
        method: body ? 'POST' : 'GET',
        headers: {
          Accept: 'application/json',
          ...(body && { 'Content-Type': 'application/json' }),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      })
      if (!result.ok) {
        throw new CompilerExplorerError('http', `Compiler Explorer returned HTTP ${result.status}`)
      }
      return result.json()
    }
    try {
      return await Promise.race([response(), timeout])
    } catch (error) {
      if (error instanceof CompilerExplorerError) throw error
      throw new CompilerExplorerError('transport', 'Compiler Explorer request failed', {
        cause: error,
      })
    } finally {
      controller.abort()
    }
  }

  function compilerCatalog(language) {
    if (!catalogs.has(language)) {
      const path = `api/compilers/${encodeURIComponent(language)}?fields=id,name,fullVersion,version,semver,releaseTrack,compilerType`
      catalogs.set(
        language,
        request(path)
          .then((compilers) => {
            if (
              !Array.isArray(compilers) ||
              compilers.some((entry) => typeof entry?.id !== 'string')
            ) {
              throw new CompilerExplorerError(
                'invalid-catalog',
                'Compiler Explorer response has no valid compiler catalog',
              )
            }
            return new Map(
              compilers.map((entry) => [
                entry.id,
                {
                  ...entry,
                  version: entry.fullVersion || entry.version,
                },
              ]),
            )
          })
          .catch((error) => {
            catalogs.delete(language)
            throw error
          }),
      )
    }
    return catalogs.get(language)
  }

  return {
    async listCompilers(language = 'c++') {
      return [...(await compilerCatalog(language)).values()].map((entry) => ({ ...entry }))
    },
    async fetchShortlink(shortId) {
      if (typeof shortId !== 'string' || !shortIdPattern.test(shortId)) {
        throw new TypeError('fetchShortlink requires a valid Compiler Explorer shortlink ID')
      }
      return parseShortlinkSession(await request(`api/shortlinkinfo/${shortId}`))
    },
    async compile({ compilerId, sourceCode, compileArgs, language = 'c++', godboltUrl = null }) {
      if (
        typeof compilerId !== 'string' ||
        !/^[a-z0-9_+-][a-z0-9_.+-]*$/i.test(compilerId) ||
        typeof sourceCode !== 'string' ||
        sourceCode.length === 0 ||
        !Array.isArray(compileArgs) ||
        compileArgs.some((arg) => typeof arg !== 'string')
      ) {
        throw new TypeError('Compile requires a compiler ID, source, and compiler argument tokens')
      }
      const catalog = await compilerCatalog(language)
      const compilerVersion = catalog.get(compilerId)?.version
      if (typeof compilerVersion !== 'string' || compilerVersion.length === 0) {
        throw new CompilerExplorerError(
          'compiler-unavailable',
          `Compiler version unavailable: ${compilerId}`,
        )
      }
      const response = await request(`api/compiler/${encodeURIComponent(compilerId)}/compile`, {
        source: sourceCode,
        lang: language,
        allowStoreCodeDebug: false,
        options: {
          userArguments: compileArgs,
          compilerOptions: { executorRequest: false, skipAsm: true },
          filters: { execute: false },
        },
      })
      if (
        response?.timedOut ||
        response?.networkError ||
        response?.didExecute ||
        !Number.isInteger(response?.code)
      ) {
        throw new CompilerExplorerError(
          'invalid-result',
          'Compiler Explorer returned no usable compile result',
        )
      }
      const diagnostics = [readOutput(response.stderr), readOutput(response.stdout)]
        .filter((stream) => stream !== '')
        .join('\n')
      return {
        compilerId,
        compilerVersion,
        exitCode: response.code,
        diagnostics,
        godboltUrl,
        truncated: response.truncated === true,
      }
    },
  }
}
