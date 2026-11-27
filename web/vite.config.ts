import { cp, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { loadEnv, type Connect, type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))
const data = fileURLToPath(new URL('../data/', import.meta.url))
const shardPath = /^(summary\.json|snapshots\/[a-z0-9_-]+\/(items\/(pr|issue)-[0-9]+|modules\/[a-z0-9-]+\/(prs|issues)-index)\.json)$/

function serveSnapshots(middlewares: Connect.Server, base: string, directory: string) {
  const prefix = base === './' ? '/' : base
  // Handle retired shard URLs before the SPA fallback can return index.html.
  middlewares.use(prefix + 'data/', async (req, res) => {
    const path = (req.url ?? '').split('?')[0].replace(/^\//, '')
    if (!shardPath.test(path)) {
      res.statusCode = 404
      res.end()
      return
    }
    try {
      const content = await readFile(resolve(directory, path))
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(content)
    } catch (error) {
      res.statusCode = error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 404 : 500
      res.end()
    }
  })
}

function snapshotAssets(): Plugin {
  return {
    name: 'snapshot-assets',
    configureServer(server) {
      serveSnapshots(server.middlewares, server.config.base, data)
    },
    configurePreviewServer(server) {
      serveSnapshots(server.middlewares, server.config.base, resolve(root, server.config.build.outDir, 'data'))
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
