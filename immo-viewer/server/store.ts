/**
 * Reads the unpacked listings from disk and keeps the parsed result in memory.
 *
 * Each listing is a plain folder: `info.json` plus `photos/`, `floorplans/` and
 * `documents/`. The inbox of ZIPs is only touched by `unpack.ts` — nothing here
 * knows what a ZIP is.
 */
import { readdir, readFile, rename, stat, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Listing, ScanError, ListingsResponse } from '../src/types.ts'
import { normaliseListing, type MediaEntryInfo } from './normalise.ts'
import { unpackPending, type UnpackResult } from './unpack.ts'

export type AssetKind = 'photo' | 'floorplan' | 'document'

/** What the map picker sends when you pin a listing by hand. */
export interface ManualLocation {
  lat: number
  lon: number
  /** Short human label for the spot, usually reverse-geocoded from OSM. */
  label?: string | null
  street?: string | null
  houseNumber?: string | null
  postalCode?: string | null
  city?: string | null
}

export interface Asset {
  buffer: Buffer
  contentType: string
  filename: string
  cacheTag: string
}

interface CachedListing {
  signature: string
  listing: Listing
  photos: MediaEntryInfo[]
  floorPlans: MediaEntryInfo[]
  documents: MediaEntryInfo[]
}

export interface ScanOptions {
  /** Skip the inbox import (used by tests that build folders by hand). */
  importFromInbox?: boolean
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

/** URL-safe, stable key derived from the folder name. */
export function keyForFolder(folder: string): string {
  const slug = folder
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return `${slug || 'listing'}-${shortHash(folder)}`
}

function shortHash(input: string): string {
  // FNV-1a, 32-bit — enough to disambiguate two folders with the same street.
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
  private lastImport: UnpackResult | null = null
  /** Concurrent scans share one pass (and one inbox import). */
  private scanning: Promise<ListingsResponse> | null = null

  constructor(
    readonly sourceDir: string,
    readonly inboxDir: string | null = null,
  ) {}

  /** Imports new archives from the inbox, then re-reads the store folders. */
  async scan(options: ScanOptions = {}): Promise<ListingsResponse> {
    if (!this.scanning) {
      this.scanning = this.doScan(options).finally(() => {
        this.scanning = null
      })
    }
    return this.scanning
  }

  private async doScan(options: ScanOptions): Promise<ListingsResponse> {
    const errors: ScanError[] = []

    if (this.inboxDir && options.importFromInbox !== false) {
      try {
        this.lastImport = await unpackPending(this.inboxDir, this.sourceDir)
        for (const failure of this.lastImport.errors) {
          errors.push({ folder: failure.archive, message: failure.message })
        }
      } catch (error) {
        errors.push({
          folder: this.inboxDir,
          message: `Could not import archives: ${(error as Error).message}`,
        })
      }
    }

    const listings: Listing[] = []
    const seen = new Set<string>()

    let folders: string[]
    try {
      folders = (await readdir(this.sourceDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, 'en'))
    } catch (error) {
      return {
        scannedAt: new Date().toISOString(),
        sourceDir: this.sourceDir,
        listings: [],
        errors: [
          ...errors,
          { folder: '*', message: `Cannot read ${this.sourceDir}: ${(error as Error).message}` },
        ],
        imported: this.lastImport,
      }
    }

    for (const folder of folders) {
      const fullPath = path.join(this.sourceDir, folder)
      let signature: string
      try {
        const stats = await stat(path.join(fullPath, 'info.json'))
        signature = `${stats.mtimeMs}:${stats.size}`
      } catch {
        // No info.json: not a listing folder (or an empty one). Stay quiet.
        continue
      }

      const cached = this.cache.get(folder)
      if (cached && cached.signature === signature) {
        listings.push(cached.listing)
        seen.add(folder)
        continue
      }

      try {
        const loaded = await loadListing(fullPath, folder, signature)
        this.cache.set(folder, loaded)
        this.errors.delete(folder)
        listings.push(loaded.listing)
        seen.add(folder)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.errors.set(folder, { folder, message })
      }
    }

    for (const folder of [...this.cache.keys()]) {
      if (!seen.has(folder)) this.cache.delete(folder)
    }
    for (const folder of [...this.errors.keys()]) {
      if (!folders.includes(folder)) this.errors.delete(folder)
    }

    listings.sort((a, b) => a.title.localeCompare(b.title, 'en'))
    errors.push(...this.errors.values())

    this.scannedAt = new Date().toISOString()
    return {
      scannedAt: this.scannedAt,
      sourceDir: this.sourceDir,
      listings,
      errors,
      imported: this.lastImport,
    }
  }

  has(key: string): boolean {
    return this.findByKey(key) !== null
  }

  async asset(key: string, kind: AssetKind, index: number): Promise<Asset | null> {
    const entry = this.findByKey(key)
    if (!entry) return null
    const list =
      kind === 'photo' ? entry.photos : kind === 'floorplan' ? entry.floorPlans : entry.documents
    const target = list[index]
    if (!target) return null
    const fullPath = path.join(this.sourceDir, entry.listing.folder, FOLDER[kind], target.name)
    try {
      const buffer = await readFile(fullPath)
      return {
        buffer,
        contentType: contentTypeFor(target.name),
        filename: path.basename(target.name),
        cacheTag: entry.signature,
      }
    } catch {
      return null
    }
  }

  /** Serves a text file out of a listing folder (`info.json`, `summary.md`, …). */
  async document(key: string, name: string): Promise<{ buffer: Buffer; filename: string } | null> {
    const entry = this.findByKey(key)
    if (!entry) return null
    if (!/^[a-z0-9._-]+$/i.test(name)) return null
    try {
      const buffer = await readFile(path.join(this.sourceDir, entry.listing.folder, name))
      return { buffer, filename: name }
    } catch {
      return null
    }
  }

  folderPath(key: string): { path: string; folder: string } | null {
    const entry = this.findByKey(key)
    if (!entry) return null
    return {
      path: path.join(this.sourceDir, entry.listing.folder),
      folder: entry.listing.folder,
    }
  }

  /**
   * Writes hand-picked coordinates into the folder's `info.json` and returns the
   * re-read listing. The folder stays the single source of truth: no sidecar, no
   * database.
   */
  async locate(key: string, input: ManualLocation): Promise<{ listing: Listing } | null> {
    const cached = this.findByKey(key)
    if (!cached) return null

    const folder = cached.listing.folder
    const infoPath = path.join(this.sourceDir, folder, 'info.json')
    const info = JSON.parse(await readFile(infoPath, 'utf8')) as Record<string, unknown>
    const location = asRecord(info.location)
    location.latitude = input.lat
    location.longitude = input.lon
    location.exact = true
    location.geoSource = 'manual'
    location.manual = {
      lat: input.lat,
      lon: input.lon,
      label: input.label ?? null,
      street: input.street ?? null,
      houseNumber: input.houseNumber ?? null,
      postalCode: input.postalCode ?? null,
      city: input.city ?? null,
      pinnedAt: new Date().toISOString(),
      source: 'map-click',
    }
    info.location = location

    // Write beside the file and rename over it, so a crash can never leave a
    // half-written info.json behind.
    const tempPath = path.join(this.sourceDir, folder, `.info.json.${process.pid}.${Date.now()}`)
    await writeFile(tempPath, `${JSON.stringify(info, null, 2)}\n`, 'utf8')
    try {
      await rename(tempPath, infoPath)
    } catch (error) {
      await rm(tempPath, { force: true })
      throw error
    }

    this.cache.delete(folder)
    const stats = await stat(infoPath)
    const reloaded = await loadListing(
      path.join(this.sourceDir, folder),
      folder,
      `${stats.mtimeMs}:${stats.size}`,
    )
    this.cache.set(folder, reloaded)
    return { listing: reloaded.listing }
  }

  private findByKey(key: string): CachedListing | null {
    for (const entry of this.cache.values()) {
      if (entry.listing.key === key) return entry
    }
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Files of a listing subfolder, as relative names plus sizes. */
async function listMedia(folderPath: string, pattern: RegExp): Promise<MediaEntryInfo[]> {
  let entries: string[]
  try {
    entries = await readdir(folderPath)
  } catch {
    return []
  }
  const files: MediaEntryInfo[] = []
  for (const name of entries.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    if (name.startsWith('.') || !pattern.test(name)) continue
    const stats = await stat(path.join(folderPath, name)).catch(() => null)
    if (!stats || !stats.isFile()) continue
    files.push({ name, bytes: stats.size })
  }
  return files
}

async function loadListing(folderPath: string, folder: string, signature: string): Promise<CachedListing> {
  const info = JSON.parse(await readFile(path.join(folderPath, 'info.json'), 'utf8')) as Record<
    string,
    unknown
  >

  const photos = await listMedia(path.join(folderPath, FOLDER.photo), IMAGE_EXTENSIONS)
  const floorPlans = await listMedia(path.join(folderPath, FOLDER.floorplan), FLOORPLAN_EXTENSIONS)
  const documents = await listMedia(path.join(folderPath, FOLDER.document), DOCUMENT_EXTENSIONS)

  const listing = normaliseListing({
    key: keyForFolder(folder),
    folder,
    info,
    photos,
    floorPlans,
    documents,
  })

  return { signature, listing, photos, floorPlans, documents }
}
