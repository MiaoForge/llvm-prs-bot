export const clangModules = [
  {
    id: 'clang-sema',
    name: 'Clang / Sema',
    paths: [/^clang\/(?:lib\/Sema\/|include\/clang\/Sema\/|test\/Sema(?:\/|[A-Z]))/],
    labels: ['clang:sema', 'clang: sema'],
  },
  {
    id: 'clang-ast',
    name: 'Clang / AST',
    paths: [/^clang\/(?:lib\/AST\/|include\/clang\/AST\/|test\/AST\/)/],
    labels: ['clang:ast', 'clang: ast'],
  },
]

export function matchModuleEvidence({ paths = [], labels = [] }, modules = clangModules) {
  const uniquePaths = [...new Set(paths)].sort()
  const uniqueLabels = [...new Set(labels)].sort()
  return modules
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
}

export function classifyModules(observation, modules) {
  return matchModuleEvidence(observation, modules).map((evidence) => evidence.moduleId)
}
