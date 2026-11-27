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

export function classifyModules({ paths = [], labels = [] }, modules = clangModules) {
  const normalizedLabels = new Set(labels.map((label) => label.trim().toLowerCase()))
  return modules
    .filter(
      (module) =>
        module.paths.some((pattern) => paths.some((path) => pattern.test(path))) ||
        module.labels.some((label) => normalizedLabels.has(label)),
    )
    .map((module) => module.id)
}
