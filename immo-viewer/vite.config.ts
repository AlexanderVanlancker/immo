import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { createApiMiddleware } from './server/api.ts'
import { ListingStore } from './server/store.ts'

const viewerRoot = path.dirname(fileURLToPath(import.meta.url))

/**
 * Where the Immoweb Zipper archives live. Override with
 * `IMMOWEB_EXPORTS_DIR=/path/to/zips npm run dev`.
 */
function resolveSourceDir(): string {
  const candidates = [
    process.env.IMMOWEB_EXPORTS_DIR,
    path.resolve(viewerRoot, '..', 'data', 'exports'),
    path.resolve(viewerRoot, 'data', 'exports'),
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[1] ?? path.resolve(viewerRoot, 'data', 'exports')
}

/** Serves /api/* from the ZIP archives, in dev and in preview alike. */
function immowebDataPlugin(): Plugin {
  let store: ListingStore | null = null
  const getStore = () => {
    if (!store) {
      const sourceDir = resolveSourceDir()
      console.log(`[immo-viewer] reading listings from ${sourceDir}`)
      store = new ListingStore(sourceDir)
    }
    return store
  }

  return {
    name: 'immo-viewer-data',
    configureServer(server) {
      server.middlewares.use(createApiMiddleware(getStore()))
    },
    configurePreviewServer(server) {
      server.middlewares.use(createApiMiddleware(getStore()))
    },
    closeBundle() {
      void store?.close()
      store = null
    },
  }
}

export default defineConfig({
  plugins: [immowebDataPlugin()],
  server: {
    port: 5173,
    strictPort: false,
    open: false,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
