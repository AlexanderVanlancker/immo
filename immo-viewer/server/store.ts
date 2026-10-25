/**
 * Scans a folder of Immoweb Zipper archives and keeps the parsed result in
 * memory. Archives are read in place — nothing is extracted to disk, so adding
 * a new ZIP only requires a page refresh.
 */
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Listing, ScanError, ListingsResponse } from '../src/types.ts'
import { normaliseListing, type MediaEntryInfo } from './normalise.ts'
import { ZipArchive, ZipReadError, type ZipEntry } from './zip.ts'

export type AssetKind = 'photo' | 'floorplan' | 'document'

export interface Asset {
  buffer: Buffer
  contentType: string
  filename: string
  cacheTag: string
}

interface CachedListing {
  signature: string
  archive: ZipArchive
  listing: Listing
  photos: ZipEntry[]
  floorPlans: ZipEntry[]
  documents: ZipEntry[]
}

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|avif|gif)$/i
const FLOORPLAN_EXTENSIONS = /\.(jpe?g|png|webp|pdf|svg)$/i
const DOCUMENT_EXTENSIONS = /\.(pdf|jpe?g|png|webp|docx?|txt|xml)$/i
const FOLDER = {
  photo: 'photos',
  floorplan: 'floorplans',
  document: 'documents',
} as const

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
}

export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

/** URL-safe, stable key derived from the archive name. */
export function keyForZip(zipFile: string): string {
  const base = zipFile.replace(/\.zip$/i, '')
  const slug = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return `${slug || 'listing'}-${shortHash(base)}`
}

function shortHash(input: string): string {
  // FNV-1a, 32-bit — enough to disambiguate two archives with the same street.
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6)
}

export class ListingStore {
  private cache = new Map<string, CachedListing>()
  private errors = new Map<string, ScanError>()
  private scannedAt = new Date(0).toISOString()

  constructor(readonly sourceDir: string) {}

  async scan(): Promise<ListingsResponse> {
    const listings: Listing[] = []
    const errors: ScanError[] = []
    const seen = new Set<string>()

    let files: string[]
    try {
      files = await readdir(this.sourceDir)
    } catch (error) {
      const message = `Cannot read ${this.sourceDir}: ${(error as Error).message}`
      return {
        scannedAt: new Date().toISOString(),
        sourceDir: this.sourceDir,
        listings: [],
        errors: [{ zipFile: '*', message }],
      }
    }

    const zips = files.filter((file) => file.toLowerCase().endsWith('.zip')).sort((a, b) =>
      a.localeCompare(b, 'en'),
    )

    for (const zipFile of zips) {
      const fullPath = path.join(this.sourceDir, zipFile)
      let signature: string
      try {
        const stats = await stat(fullPath)
        signature = `${stats.mtimeMs}:${stats.size}`
      } catch (error) {
        errors.push({ zipFile, message: `Cannot stat archive: ${(error as Error).message}` })
        continue
      }

      const cached = this.cache.get(zipFile)
      if (cached && cached.signature === signature) {
        listings.push(cached.listing)
        seen.add(zipFile)
        continue
      }

      if (cached && cached.signature !== signature) {
        await cached.archive.close().catch(() => {})
        this.cache.delete(zipFile)
      }

      try {
        const loaded = await loadArchive(fullPath, zipFile, signature)
        this.cache.set(zipFile, loaded)
        this.errors.delete(zipFile)
        listings.push(loaded.listing)
        seen.add(zipFile)
      } catch (error) {
        const message =
          error instanceof ZipReadError || error instanceof Error
            ? error.message
            : String(error)
        this.errors.set(zipFile, { zipFile, message })
      }
    }

    // Drop archives that vanished from the folder.
    for (const [zipFile, cached] of this.cache) {
      if (!seen.has(zipFile)) {
        await cached.archive.close().catch(() => {})
        this.cache.delete(zipFile)
      }
    }
    for (const zipFile of [...this.errors.keys()]) {
      if (!zips.includes(zipFile)) this.errors.delete(zipFile)
    }

    listings.sort((a, b) => a.title.localeCompare(b.title, 'en'))
    errors.push(...this.errors.values())

    this.scannedAt = new Date().toISOString()
    return { scannedAt: this.scannedAt, sourceDir: this.sourceDir, listings, errors }
  }

  has(key: string): boolean {
    return [...this.cache.values()].some((entry) => entry.listing.key === key)
  }

  async asset(key: string, kind: AssetKind, index: number): Promise<Asset | null> {
    const entry = this.findByKey(key)
    if (!entry) return null
    const list =
      kind === 'photo' ? entry.photos : kind === 'floorplan' ? entry.floorPlans : entry.documents
    const target = list[index]
    if (!target) return null
    const buffer = await entry.archive.read(target)
    return {
      buffer,
      contentType: contentTypeFor(target.name),
      filename: path.basename(target.name),
      cacheTag: entry.signature,
    }
  }

  zipPath(key: string): { path: string; filename: string } | null {
    const entry = this.findByKey(key)
    if (!entry) return null
    return {
      path: path.join(this.sourceDir, entry.listing.zipFile),
      filename: entry.listing.zipFile,
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.cache.values()].map((entry) => entry.archive.close().catch(() => {})))
    this.cache.clear()
  }

  private findByKey(key: string): CachedListing | null {
    for (const entry of this.cache.values()) {
      if (entry.listing.key === key) return entry
    }
    return null
  }
}

async function loadArchive(
  fullPath: string,
  zipFile: string,
  signature: string,
): Promise<CachedListing> {
  const archive = await ZipArchive.open(fullPath)
  try {
    const infoEntry = archive.find((name) => name === 'info.json' || name.endsWith('/info.json'))[0]
    if (!infoEntry) {
      throw new ZipReadError('Archive has no info.json — was it created by Immoweb Zipper?', fullPath)
    }
    const info = await archive.readJson<Record<string, unknown>>(infoEntry)

    const photos = archive.inFolder(FOLDER.photo, IMAGE_EXTENSIONS)
    const floorPlans = archive.inFolder(FOLDER.floorplan, FLOORPLAN_EXTENSIONS)
    const documents = archive.inFolder(FOLDER.document, DOCUMENT_EXTENSIONS)

    const toInfo = (entries: ZipEntry[]): MediaEntryInfo[] =>
      entries.map((item) => ({ name: item.name, bytes: item.size }))

    const listing = normaliseListing({
      key: keyForZip(zipFile),
      zipFile,
      info,
      photos: toInfo(photos),
      floorPlans: toInfo(floorPlans),
      documents: toInfo(documents),
    })

    return { signature, archive, listing, photos, floorPlans, documents }
  } catch (error) {
    await archive.close().catch(() => {})
    throw error
  }
}
