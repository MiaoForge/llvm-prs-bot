export const DEFAULT_BASELINE_MAJOR = '22'

function versionParts(entry) {
  return /^\d+(?:\.\d+){1,2}$/.test(entry.semver ?? '') ? entry.semver.split('.').map(Number) : []
}

export function selectClangCompilers(
  catalog,
  { declaredVersion, baselineId, trunkId = 'clang_trunk' } = {},
) {
  const available = catalog.filter((entry) => typeof entry.version === 'string' && entry.version)
  const trunk = available.find((entry) => entry.id === trunkId) ?? null
  if (!declaredVersion && baselineId) {
    return { baseline: available.find((entry) => entry.id === baselineId) ?? null, trunk }
  }
  const requested = (declaredVersion ?? DEFAULT_BASELINE_MAJOR).split('.').map(Number)
  const releases = available
    .filter(
      (entry) =>
        /^clang\d+$/.test(entry.id) &&
        entry.releaseTrack === 'stable' &&
        entry.compilerType === 'clang',
    )
    .map((entry) => ({ entry, parts: versionParts(entry) }))
    .filter(({ parts }) => requested.every((part, index) => parts[index] === part))
    .sort(
      (left, right) =>
        (right.parts[1] ?? 0) - (left.parts[1] ?? 0) ||
        (right.parts[2] ?? 0) - (left.parts[2] ?? 0),
    )
  return { baseline: releases[0]?.entry ?? null, trunk }
}
