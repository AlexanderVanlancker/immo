/**
 * Importing the inbox: the ZIPs the extension downloads become plain folders.
 * Extraction is delegated to the platform tool (ditto/bsdtar/unzip), so these
 * tests exercise that hand-off on real fflate-written archives.
 */
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ListingStore } from '../server/store.ts'
import { unpackPending } from '../server/unpack.ts'

// fflate is what the extension writes archives with, so the fixtures behave
// exactly like the real inbox.
const require = createRequire(import.meta.url)
const fflate = require('../../immoweb-zipper/vendor/fflate.js') as {
  zip: (
    files: Record<string, [Uint8Array, { level: number }]>,
    options: { level: number },
    callback: (error: Error | null, data: Uint8Array) => void,
  ) => void
}

const FOLDER = 'Maria Claessensplein 5  2050 — Antwerpen'
const PHOTO = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb004300' + 'ff'.repeat(64) + 'ffd9',
  'hex',
)

function info(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'Immoweb',
    id: 20001234,
    capturedAt: '2025-01-01T00:00:00.000Z',
    transaction: { kind: 'for-sale', typeLabel: 'For sale' },
    price: { value: 475000, display: '€ 475.000', currency: 'EUR' },
    property: { type: 'HOUSE', typeLabel: 'House', livingArea: 130, bedrooms: 3 },
    location: { street: 'Maria Claessensplein', number: '5', postalCode: '2050', locality: 'Antwerpen' },
    ...overrides,
  }
}

async function writeArchive(
  inboxDir: string,
  archiveName: string,
  folder: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const encoder = new TextEncoder()
  const files: Record<string, [Uint8Array, { level: number }]> = {
    [`${folder}/info.json`]: [encoder.encode(JSON.stringify(payload, null, 2)), { level: 6 }],
    [`${folder}/summary.md`]: [encoder.encode('# A listing'), { level: 6 }],
    [`${folder}/photos/01.jpg`]: [new Uint8Array(PHOTO), { level: 0 }],
  }
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    fflate.zip(files, { level: 6 }, (error, data) => (error ? reject(error) : resolve(data)))
  })
  const zipPath = path.join(inboxDir, archiveName)
  await writeFile(zipPath, Buffer.from(bytes))
  return zipPath
}

let root: string
let inbox: string
let store: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'immo-unpack-'))
  inbox = path.join(root, 'exports')
  store = path.join(root, 'listings')
  await mkdir(inbox, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('unpackPending', () => {
  it('turns an archive into a folder and records where it came from', async () => {
    await writeArchive(inbox, `${FOLDER}.zip`, FOLDER, info())
    const result = await unpackPending(inbox, store)

    expect(result.errors).toEqual([])
    expect(result.imported).toEqual([{ archive: `${FOLDER}.zip`, folder: FOLDER, action: 'imported' }])

    const folderPath = path.join(store, FOLDER)
    expect((await readdir(folderPath)).sort()).toEqual(
      ['.source.json', 'info.json', 'photos', 'summary.md'].sort(),
    )
    // The em dash survived the extraction.
    expect((await readFile(path.join(folderPath, 'photos', '01.jpg'))).equals(PHOTO)).toBe(true)

    const marker = JSON.parse(await readFile(path.join(folderPath, '.source.json'), 'utf8'))
    expect(marker.archive).toBe(`${FOLDER}.zip`)
    expect(marker.extractor).toMatch(/ditto|bsdtar|unzip/)
    expect(marker.archiveMtimeMs).toBeGreaterThan(0)

    // No staging directories are left behind.
    const entries = await readdir(store)
    expect(entries.filter((entry) => entry.startsWith('.'))).toEqual([])
    // The archive itself stays in the inbox.
    expect((await stat(path.join(inbox, `${FOLDER}.zip`))).size).toBeGreaterThan(0)
  })

  it('skips an archive that was already imported', async () => {
    await writeArchive(inbox, `${FOLDER}.zip`, FOLDER, info())
    await unpackPending(inbox, store)
    const second = await unpackPending(inbox, store)

    expect(second.imported).toEqual([])
    expect(second.skipped).toEqual([`${FOLDER}.zip`])
    expect(second.errors).toEqual([])
  })

  it('re-imports when the archive is newer than the import', async () => {
    const zipPath = await writeArchive(inbox, `${FOLDER}.zip`, FOLDER, info())
    await unpackPending(inbox, store)

    // A re-saved archive with a different price, with a newer mtime.
    await rm(zipPath)
    await writeArchive(inbox, `${FOLDER}.zip`, FOLDER, info({ price: { value: 429000, display: '€ 429.000' } }))
    const future = new Date(Date.now() + 5000)
    await utimes(zipPath, future, future)

    const result = await unpackPending(inbox, store)
    expect(result.imported).toEqual([{ archive: `${FOLDER}.zip`, folder: FOLDER, action: 'replaced' }])

    const listing = (await new ListingStore(store).scan()).listings[0]!
    expect(listing.price.value).toBe(429000)
  })

  it('reports an archive that is not a listing instead of failing the import', async () => {
    const encoder = new TextEncoder()
    const files: Record<string, [Uint8Array, { level: number }]> = {
      'random/notes.txt': [encoder.encode('hello'), { level: 6 }],
    }
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      fflate.zip(files, { level: 6 }, (error, data) => (error ? reject(error) : resolve(data)))
    })
    await writeFile(path.join(inbox, 'random.zip'), Buffer.from(bytes))

    const result = await unpackPending(inbox, store)
    expect(result.imported).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toMatch(/no info\.json/i)
    // Nothing half-imported is left behind.
    expect((await readdir(store)).filter((entry) => entry.startsWith('.'))).toEqual([])
  })

  it('leaves hand-made folders alone', async () => {
    const handMade = path.join(store, 'By hand  2050 — Antwerpen')
    await mkdir(handMade, { recursive: true })
    await writeFile(path.join(handMade, 'info.json'), JSON.stringify(info()))

    await writeArchive(inbox, `${FOLDER}.zip`, FOLDER, info())
    const result = await unpackPending(inbox, store)

    expect(result.imported).toHaveLength(1)
    expect((await readdir(store)).sort()).toEqual(['By hand  2050 — Antwerpen', FOLDER].sort())
    // No marker was invented for the hand-made folder.
    expect(await readdir(handMade)).toEqual(['info.json'])
  })

  it('feeds the store end to end through the inbox', async () => {
    await writeArchive(inbox, `${FOLDER}.zip`, FOLDER, info())
    const listingStore = new ListingStore(store, inbox)
    const response = await listingStore.scan()

    expect(response.errors).toEqual([])
    expect(response.listings).toHaveLength(1)
    expect(response.imported?.imported).toHaveLength(1)

    const listing = response.listings[0]!
    const photo = await listingStore.asset(listing.key, 'photo', 0)
    expect(photo?.buffer.equals(PHOTO)).toBe(true)

    // A second scan does not re-import.
    const again = await listingStore.scan()
    expect(again.imported?.imported).toEqual([])
    expect(again.imported?.skipped).toEqual([`${FOLDER}.zip`])
  })
})
