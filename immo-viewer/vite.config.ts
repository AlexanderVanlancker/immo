import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { createApiMiddleware } from './server/api.ts'
import { ListingStore } from './server/store.ts'

const viewerRoot = path.dirname(fileURLToPath(import.meta.url))

/**
 * Two folders:
 *   inbox  — the ZIPs the extension downloads (`data/exports/`)
 *   store  — one unpacked directory per listing (`data/listings/`)
 *
 * Override with `IMMOWEB_EXPORTS_DIR` / `IMMO_LISTINGS_DIR`.
 */
function resolveDir(env: string | undefined, ...fallbacks: string[]): string {
  if (env) return env
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate
  }
  return fallbacks[0] as string
}

function resolveInboxDir(): string {
  return resolveDir(
    process.env.IMMOWEB_EXPORTS_DIR,
    path.resolve(viewerRoot, '..', 'data', 'exports'),
    path.resolve(viewerRoot, 'data', 'exports'),
  )
}

function resolveStoreDir(): string {
  return resolveDir(
    process.env.IMMO_LISTINGS_DIR,
    path.resolve(viewerRoot, '..', 'data', 'listings'),
    path.resolve(viewerRoot, 'data', 'listings'),
  )
}

/** Serves /api/* from the unpacked listings, in dev and in preview alike. */
function immowebDataPlugin(): Plugin {
  let store: ListingStore | null = null
  const getStore = () => {
    if (!store) {
      const storeDir = resolveStoreDir()
      const inboxDir = resolveInboxDir()
      console.log(`[immo-viewer] listings: ${storeDir}`)
      console.log(`[immo-viewer] inbox:    ${inboxDir}`)
      store = new ListingStore(storeDir, inboxDir)
      // Import the inbox in the background so the first request is not blocked
      // by a 45 MB unpack. Never from a test run: tests must not write data.
      if (!process.env.VITEST) void store.scan().catch(() => {})
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
