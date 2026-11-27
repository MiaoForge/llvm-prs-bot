import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { compile } from 'json-schema-to-typescript'

const root = new URL('../../schemas/', import.meta.url)
const output = new URL('../src/generated/', import.meta.url)
const contracts = {
  summary: 'Summary',
  'prs-index': 'PrIndex',
  'issues-index': 'IssueIndex',
  pr: 'PrDetail',
  issue: 'IssueDetail',
}
const readSchema = async (name) =>
  JSON.parse(await readFile(new URL(`${name}.schema.json`, root), 'utf8'))
const common = await readSchema('common')

function inlineShared(value) {
  if (Array.isArray(value)) return value.map(inlineShared)
  if (value === null || typeof value !== 'object') return value
  const { $ref, ...siblings } = value
  if ($ref) {
    const key = $ref.replace(/^common\.schema\.json#\/\$defs\//, '')
    if (!Object.hasOwn(common.$defs, key)) throw new Error(`Unresolved reference: ${$ref}`)
    return inlineShared({
      ...common.$defs[key],
      ...siblings,
      ...(siblings.unevaluatedProperties === false && { additionalProperties: false }),
    })
  }
  return Object.fromEntries(
    Object.entries(siblings).map(([key, child]) => [key, inlineShared(child)]),
  )
}

await mkdir(output, { recursive: true })
for (const [file, type] of Object.entries(contracts)) {
  const schema = inlineShared(await readSchema(file))
  // Detail contracts add evidence to their shared list fields using allOf.
  if (schema.allOf) {
    const [list] = schema.allOf
    schema.properties = { ...list.properties, ...schema.properties }
    schema.required = [...new Set([...list.required, ...schema.required])]
    schema.additionalProperties = false
    delete schema.allOf
  }
  const types = await compile({ ...schema, title: type }, type, {
    bannerComment: '// Generated from schemas/*.schema.json by npm run generate:types.',
    ignoreMinAndMaxItems: true,
    style: { semi: false, singleQuote: true },
  })
  await writeFile(new URL(`${file}.ts`, output), types)
}
