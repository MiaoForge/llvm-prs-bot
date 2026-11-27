import { setTimeout as delay } from 'node:timers/promises'

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
      const path = `api/compilers/${encodeURIComponent(language)}?fields=id,fullVersion,version`
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
            return new Map(compilers.map((entry) => [entry.id, entry.fullVersion || entry.version]))
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
      const compilerVersion = catalog.get(compilerId)
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
