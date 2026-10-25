/**
 * A tiny Connect middleware that serves the listing API for both `vite dev`
 * and `vite preview`. No framework, no external dependencies.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ListingStore, type AssetKind, type ManualLocation } from './store.ts'

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

    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

    // POST /api/listings/:key/location — pin a listing by hand on the map.
    if (
      req.method === 'POST' &&
      segments.length === 4 &&
      segments[1] === 'listings' &&
      segments[3] === 'location'
    ) {
      try {
        const key = segments[2] ?? ''
        const body = await readJsonBody(req)
        const parsed = parseLocation(body)
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error })
          return
        }
        const result = await store.locate(key, parsed.value)
        if (!result) {
          sendJson(res, 404, { error: 'Unknown listing' })
          return
        }
        console.log(
          `[immo-viewer] pinned ${result.listing.folder}/info.json at ${parsed.value.lat}, ${parsed.value.lon}`,
        )
        sendJson(res, 200, { listing: result.listing })
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[immo-viewer] locate failed:', error)
        sendJson(res, 500, { error: message })
        return
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' })
      return
    }

    try {
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
      // /api/listings/:key/files/:name  (info.json, summary.md, listing.json, …)
      if (segments.length === 5 && segments[1] === 'listings' && segments[3] === 'files') {
        const found = await store.document(segments[2] ?? '', segments[4] ?? '')
        if (!found) {
          sendJson(res, 404, { error: 'File not found' })
          return
        }
        res.writeHead(200, {
          'Content-Type': found.filename.endsWith('.json')
            ? 'application/json; charset=utf-8'
            : 'text/plain; charset=utf-8',
          'Content-Length': String(found.buffer.byteLength),
          'Content-Disposition': contentDisposition(found.filename),
          'Cache-Control': 'no-store',
        })
        res.end(req.method === 'HEAD' ? undefined : found.buffer)
        return
      }

      // /api/listings/:key/<photos|floorplans|documents>/:index
      if (segments.length >= 4 && segments[1] === 'listings') {
        const key = segments[2] ?? ''
        const action = segments[3] ?? ''

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

const MAX_BODY_BYTES = 16 * 1024

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('Request body too large')
    chunks.push(buffer)
  }
  if (total === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Request body is not valid JSON')
  }
}

function text(value: unknown, limit = 200): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, limit) : null
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function parseLocation(body: unknown): Parsed<ManualLocation> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Expected a JSON object' }
  }
  const raw = body as Record<string, unknown>
  const lat = typeof raw.lat === 'number' ? raw.lat : Number.NaN
  const lon = typeof raw.lon === 'number' ? raw.lon : Number.NaN
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { ok: false, error: 'lat must be a number between -90 and 90' }
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return { ok: false, error: 'lon must be a number between -180 and 180' }
  }
  return {
    ok: true,
    value: {
      lat: Number(lat.toFixed(7)),
      lon: Number(lon.toFixed(7)),
      label: text(raw.label, 300),
      street: text(raw.street),
      houseNumber: text(raw.houseNumber, 32),
      postalCode: text(raw.postalCode, 16),
      city: text(raw.city, 120),
    },
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
