/**
 * A tiny Connect middleware that serves the listing API for both `vite dev`
 * and `vite preview`. No framework, no external dependencies.
 */
import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ListingStore, type AssetKind } from './store.ts'

type Next = (error?: unknown) => void

const ASSET_ROUTES: Record<string, AssetKind> = {
  photos: 'photo',
  floorplans: 'floorplan',
  documents: 'document',
}

export function createApiMiddleware(store: ListingStore) {
  return async function handleApi(req: IncomingMessage, res: ServerResponse, next: Next): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/')) {
      next()
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' })
      return
    }

    try {
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      // /api/listings
      if (segments.length === 2 && segments[1] === 'listings') {
        const result = await store.scan()
        sendJson(res, 200, result, 'no-store')
        return
      }
      // /api/health
      if (segments.length === 2 && segments[1] === 'health') {
        sendJson(res, 200, { ok: true, sourceDir: store.sourceDir }, 'no-store')
        return
      }
      // /api/listings/:key/<photos|floorplans|documents>/:index
      // /api/listings/:key/archive
      if (segments.length >= 4 && segments[1] === 'listings') {
        const key = segments[2] ?? ''
        const action = segments[3] ?? ''

        if (action === 'archive') {
          const found = store.zipPath(key)
          if (!found) {
            sendJson(res, 404, { error: 'Unknown listing' })
            return
          }
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': contentDisposition(found.filename),
            'Cache-Control': 'no-store',
          })
          if (req.method === 'HEAD') {
            res.end()
            return
          }
          createReadStream(found.path).pipe(res)
          return
        }

        const kind = ASSET_ROUTES[action]
        if (!kind) {
          sendJson(res, 404, { error: `Unknown resource ${action}` })
          return
        }
        const index = Number.parseInt(segments[4] ?? '', 10)
        if (!Number.isInteger(index) || index < 0) {
          sendJson(res, 400, { error: 'Bad asset index' })
          return
        }

        const asset = await store.asset(key, kind, index)
        if (!asset) {
          sendJson(res, 404, { error: 'Asset not found' })
          return
        }
        res.writeHead(200, {
          'Content-Type': asset.contentType,
          'Content-Length': String(asset.buffer.byteLength),
          // Key + archive mtime: safe to cache hard until the archive changes.
          'Cache-Control': 'public, max-age=31536000, immutable',
          ETag: `"${key}-${kind}-${index}-${asset.cacheTag}"`,
        })
        res.end(req.method === 'HEAD' ? undefined : asset.buffer)
        return
      }

      sendJson(res, 404, { error: 'Not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[immo-viewer] API error:', error)
      sendJson(res, 500, { error: message })
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, cacheControl = 'no-store'): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': cacheControl,
  })
  res.end(payload)
}

/** RFC 5987 content-disposition so the em dash and double space survive. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
