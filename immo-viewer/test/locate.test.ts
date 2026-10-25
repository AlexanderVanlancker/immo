/**
 * The viewer is read-only, except for one thing: pinning a listing by hand
 * rewrites the `info.json` inside its folder. These tests cover that write, and
 * the folder-based store that feeds it.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ListingStore, keyForFolder } from '../server/store.ts'

const FOLDER = 'Teststraat 1  2050 — Antwerpen'
const PHOTO = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb004300' + 'ff'.repeat(64) + 'ffd9',
  'hex',
)

const INFO = {
  source: 'Immoweb',
  url: 'https://www.immoweb.be/nl/classified/x/2050/1234567',
  id: 1234567,
  capturedAt: '2025-01-01T00:00:00.000Z',
  transaction: { kind: 'for-sale', typeLabel: 'For sale' },
  price: { value: 450000, display: '€ 450.000', currency: 'EUR' },
  property: { type: 'APARTMENT', typeLabel: 'Apartment', livingArea: 120, bedrooms: 3 },
  location: {
    street: 'Teststraat',
    number: '1',
    postalCode: '2050',
    locality: 'Antwerpen',
    latitude: null,
    longitude: null,
  },
  media: { pictureCount: 1 },
}

let root: string

async function makeListing(dir: string, name = FOLDER, info: Record<string, unknown> = INFO): Promise<string> {
  const folderPath = path.join(dir, name)
  await mkdir(path.join(folderPath, 'photos'), { recursive: true })
  await mkdir(path.join(folderPath, 'floorplans'), { recursive: true })
  await writeFile(path.join(folderPath, 'info.json'), JSON.stringify(info, null, 2))
  await writeFile(path.join(folderPath, 'summary.md'), '# Teststraat 1\n\nA test listing.')
  await writeFile(path.join(folderPath, 'photos', '01.jpg'), PHOTO)
  return folderPath
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'immo-store-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ListingStore on plain folders', () => {
  it('reads a listing folder without any archive involved', async () => {
    await makeListing(root)
    const store = new ListingStore(root) // no inbox → no unpacking
    const result = await store.scan()

    expect(result.errors).toEqual([])
    expect(result.listings).toHaveLength(1)
    const listing = result.listings[0]!
    expect(listing.folder).toBe(FOLDER)
    expect(listing.key).toBe(keyForFolder(FOLDER))
    expect(listing.title).toContain('Apartment')
    expect(listing.media.photos).toEqual([{ index: 0, name: '01.jpg', bytes: PHOTO.length }])
    expect(listing.address.lat).toBeNull()
  })

  it('serves media and text files straight off disk', async () => {
    await makeListing(root)
    const store = new ListingStore(root)
    const listing = (await store.scan()).listings[0]!

    const photo = await store.asset(listing.key, 'photo', 0)
    expect(photo?.contentType).toBe('image/jpeg')
    expect(photo?.buffer.equals(PHOTO)).toBe(true)
    expect(await store.asset(listing.key, 'photo', 5)).toBeNull()

    const info = await store.document(listing.key, 'info.json')
    expect(info?.filename).toBe('info.json')
    expect(JSON.parse(info!.buffer.toString('utf8')).price.value).toBe(450000)

    // Path traversal is not a thing here.
    expect(await store.document(listing.key, '../info.json')).toBeNull()
    expect(await store.document(listing.key, 'nope.json')).toBeNull()
  })

  it('ignores folders without info.json and keeps the rest', async () => {
    await makeListing(root)
    await mkdir(path.join(root, 'not-a-listing'))
    await writeFile(path.join(root, 'not-a-listing', 'notes.txt'), 'hello')
    await mkdir(path.join(root, '.importing-leftover'))

    const result = await new ListingStore(root).scan()
    expect(result.listings).toHaveLength(1)
    expect(result.errors).toEqual([])
  })

  it('re-reads a folder when its info.json changes', async () => {
    const folderPath = await makeListing(root)
    const store = new ListingStore(root)
    const first = (await store.scan()).listings[0]!
    expect(first.price.value).toBe(450000)

    await writeFile(
      path.join(folderPath, 'info.json'),
      JSON.stringify({ ...INFO, price: { ...INFO.price, value: 399000 } }, null, 2),
    )
    const second = (await store.scan()).listings[0]!
    expect(second.price.value).toBe(399000)
  })
})

describe('store.locate', () => {
  it('writes the hand-placed pin into the folder info.json and re-reads it', async () => {
    const folderPath = await makeListing(root)
    const store = new ListingStore(root)
    const listing = (await store.scan()).listings[0]!

    const result = await store.locate(listing.key, {
      lat: 51.2173,
      lon: 4.3714,
      label: 'Aalscholverlaan 78, 2050 Antwerpen',
      street: 'Aalscholverlaan',
      houseNumber: '78',
      postalCode: '2050',
      city: 'Antwerpen',
    })

    expect(result).not.toBeNull()
    // The API response carries the new coordinates immediately…
    expect(result?.listing.address.lat).toBeCloseTo(51.2173, 6)
    expect(result?.listing.address.lon).toBeCloseTo(4.3714, 6)
    expect(result?.listing.address.geoSource).toBe('manual')
    expect(result?.listing.address.manual?.label).toBe('Aalscholverlaan 78, 2050 Antwerpen')

    // …and so does the plain file on disk.
    const info = JSON.parse(await readFile(path.join(folderPath, 'info.json'), 'utf8'))
    expect(info.location.latitude).toBeCloseTo(51.2173, 6)
    expect(info.location.longitude).toBeCloseTo(4.3714, 6)
    expect(info.location.geoSource).toBe('manual')
    expect(info.location.exact).toBe(true)
    expect(info.location.manual.source).toBe('map-click')
    // Source data is not clobbered by the pin.
    expect(info.location.street).toBe('Teststraat')
    expect(info.price.value).toBe(450000)
    // The rest of the folder is untouched.
    expect((await readFile(path.join(folderPath, 'photos', '01.jpg'))).equals(PHOTO)).toBe(true)

    // No temp files are left behind.
    const leftovers = (await import('node:fs/promises')).readdir(folderPath)
    expect((await leftovers).filter((name) => name.startsWith('.info.json'))).toEqual([])

    // A fresh store (no cache) sees the pin too.
    const again = await new ListingStore(root).scan()
    expect(again.listings[0]?.address.lat).toBeCloseTo(51.2173, 6)
    expect(again.errors).toHaveLength(0)
  })

  it('moves an existing pin when it is placed again', async () => {
    await makeListing(root)
    const store = new ListingStore(root)
    const listing = (await store.scan()).listings[0]!

    await store.locate(listing.key, { lat: 51.2, lon: 4.4 })
    const moved = await store.locate(listing.key, { lat: 51.23, lon: 4.42 })

    expect(moved?.listing.address.lat).toBeCloseTo(51.23, 6)
    expect(moved?.listing.address.lon).toBeCloseTo(4.42, 6)
  })

  it('returns null for an unknown key', async () => {
    await makeListing(root)
    const store = new ListingStore(root)
    await store.scan()
    expect(await store.locate('does-not-exist', { lat: 1, lon: 2 })).toBeNull()
  })

  it('survives a broken info.json without breaking the folder', async () => {
    const folderPath = await makeListing(root)
    await writeFile(path.join(folderPath, 'info.json'), '{ not json')
    const store = new ListingStore(root)
    const result = await store.scan()

    expect(result.listings).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.folder).toBe(FOLDER)
    // The file is still there for the user to fix.
    expect((await stat(path.join(folderPath, 'info.json'))).size).toBeGreaterThan(0)
  })
})
