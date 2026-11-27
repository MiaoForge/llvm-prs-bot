export const DEFAULT_BASELINE_MAJOR = '22'

function versionParts(entry) {
  return /^\d+(?:\.\d+){1,2}$/.test(entry.semver ?? '') ? entry.semver.split('.').map(Number) : []
}

export function selectClangCompilers(
  catalog,
  { language = 'c++', declaredVersion, reportedCompilerId, baselineId, trunkId } = {},
) {
  const nativeRelease = language === 'c' ? /^cclang\d+$/ : /^clang\d+$/
  const linkedRelease = language === 'c' ? /^cclang\d+(?:assert)?$/ : /^clang\d+(?:assert)?$/
  const nativeTrunk = language === 'c' ? 'cclang_trunk' : 'clang_trunk'
  const available = catalog.filter((entry) => typeof entry.version === 'string' && entry.version)
  const trunk = available.find((entry) => entry.id === (trunkId || nativeTrunk)) ?? null
  if (!declaredVersion) {
    const reported = available.find(
      (entry) =>
        entry.id === reportedCompilerId &&
        linkedRelease.test(entry.id) &&
        entry.releaseTrack === 'stable' &&
        entry.compilerType === 'clang',
    )
    if (reported) return { baseline: reported, trunk }
  }
  if (!declaredVersion && baselineId) {
    return { baseline: available.find((entry) => entry.id === baselineId) ?? null, trunk }
  }
  const requested = (declaredVersion ?? DEFAULT_BASELINE_MAJOR).split('.').map(Number)
  const releases = available
    .filter(
      (entry) =>
        nativeRelease.test(entry.id) &&
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
