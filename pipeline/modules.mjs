export const clangModules = [
  {
    id: 'clang-lex',
    name: 'Clang / Lex',
    paths: [
      /^clang\/(?:lib\/Lex\/|include\/clang\/Lex\/|test\/Lexer\/|test\/Preprocessor\/|unittests\/Lex\/)/,
    ],
    labels: ['clang:lex', 'clang:headers', 'clang:pch'],
  },
  {
    id: 'clang-sema',
    name: 'Clang / Sema',
    paths: [
      /^clang\/(?:lib\/Sema\/|include\/clang\/Sema\/|test\/Sema(?:\/|[A-Z])|unittests\/Sema\/)/,
    ],
    labels: ['clang:sema', 'clang: sema'],
  },
  {
    id: 'clang-ast',
    name: 'Clang / AST',
    paths: [/^clang\/(?:lib\/AST\/|include\/clang\/AST\/|test\/AST\/|unittests\/AST\/)/],
    labels: ['clang:ast', 'clang: ast'],
  },
  {
    id: 'clang-frontend',
    name: 'Clang / Frontend & Parse',
    paths: [
      /^clang\/(?:lib\/Parse\/|include\/clang\/Parse\/|lib\/Frontend\/|include\/clang\/Frontend\/|lib\/Basic\/|include\/clang\/Basic\/|test\/Parser\/|test\/Frontend\/)/,
    ],
    labels: ['clang:diagnostics', 'clang:modules'],
    fallbackLabels: ['clang:frontend'],
  },
  {
    id: 'clang-codegen',
    name: 'Clang / CodeGen & Driver',
    paths: [
      /^clang\/(?:lib\/CodeGen\/|include\/clang\/CodeGen\/|lib\/Driver\/|include\/clang\/Driver\/|test\/CodeGen(?:\/|[A-Z])|test\/Driver\/)/,
    ],
    labels: ['clang:codegen', 'clang:driver'],
  },
  {
    id: 'llvm-other',
    name: 'LLVM / Core & Other',
    paths: [
      /^(?:llvm|lld|mlir|lldb|libcxx|clang-tools-extra|compiler-rt|flang|bolt|libc|openmp)\//,
    ],
    labels: [
      'llvm',
      'llvm:ir',
      'llvm:transforms',
      'llvm:codegen',
      'lld',
      'mlir',
      'lldb',
      'libc++',
      'clang-tidy',
      'clangd',
      'clang-format',
      'flang',
      'compiler-rt',
    ],
  },
]

export function matchModuleEvidence({ paths = [], labels = [] }, modules = clangModules) {
  const uniquePaths = [...new Set(paths)].sort()
  const uniqueLabels = [...new Set(labels)].sort()
  const direct = modules
    .map((module) => {
      const matchedPaths = uniquePaths.filter((path) =>
        module.paths.some((pattern) => pattern.test(path)),
      )
      const matchedLabels = uniqueLabels.filter((label) =>
        module.labels.includes(label.trim().toLowerCase()),
      )
      return {
        moduleId: module.id,
        ...(matchedPaths.length ? { matchedPaths } : {}),
        ...(matchedLabels.length ? { matchedLabels } : {}),
      }
    })
    .filter((evidence) => evidence.matchedPaths || evidence.matchedLabels)
  if (direct.length > 0) return direct
  return modules
    .map((module) => {
      const matchedLabels = uniqueLabels.filter((label) =>
        (module.fallbackLabels ?? []).includes(label.trim().toLowerCase()),
      )
      return matchedLabels.length ? { moduleId: module.id, matchedLabels } : null
    })
    .filter(Boolean)
}

export function classifyModules(observation, modules) {
  return matchModuleEvidence(observation, modules).map((evidence) => evidence.moduleId)
}
