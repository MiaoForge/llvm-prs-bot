import { cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { loadEnv, type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))
const data = fileURLToPath(new URL('../data/', import.meta.url))

function snapshotAssets(): Plugin {
  return {
    name: 'snapshot-assets',
    configureServer(server) {
      // Run before Vite's SPA fallback, including for retired shard URLs.
      const base = server.config.base === './' ? '/' : server.config.base
      server.middlewares.use(`${base}data/`, async (req, res) => {
        const path = (req.url ?? '').split('?')[0].replace(/^\//, '')
        const valid = /^(summary\.json|snapshots\/[a-z0-9_-]+\/(items\/(pr|issue)-[0-9]+|modules\/[a-z0-9-]+\/(prs|issues)-index)\.json)$/
        try {
          if (!valid.test(path)) throw new Error('Unknown shard path')
          const { readFile } = await import('node:fs/promises')
          const content = await readFile(resolve(data, path))
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(content)
        } catch (error) {
          res.statusCode = error instanceof Error && 'code' in error && error.code !== 'ENOENT' ? 500 : 404
          res.end()
        }
      })
    },
    async writeBundle(options) {
      await cp(data, resolve(options.dir ?? resolve(root, 'dist'), 'data'), { recursive: true })
    },
  }
}

export default defineConfig(({ mode }) => ({
  root,
  base: loadEnv(mode, root).VITE_BASE_PATH || './',
  plugins: [react(), tailwind(), snapshotAssets()],
  build: { manifest: true },
  test: { environment: 'jsdom', restoreMocks: true },
}))
