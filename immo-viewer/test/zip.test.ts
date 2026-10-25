import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ZipArchive, ZipReadError } from '../server/zip.ts'
import { keyForZip } from '../server/store.ts'

/** Builds a small archive in the same shape fflate writes: central directory + deflate. */
function buildZip(entries: { name: string; data: Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const method = entry.store ? 0 : 8
    const payload = entry.store ? entry.data : deflateRawSync(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(entry.data), 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc32(entry.data), 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + payload.length
  }

  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, directory, eocd])
}

let crcTable: Uint32Array | null = null
function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let value = i
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      crcTable[i] = value >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const FOLDER = 'Gentplaats 12  2000 — Antwerpen'

describe('ZipArchive', () => {
  let dir: string
  let archivePath: string
  let storedPath: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'immo-zip-'))
    archivePath = path.join(dir, 'listing.zip')
    storedPath = path.join(dir, 'stored.zip')

    await writeFile(
      archivePath,
      buildZip([
        { name: `${FOLDER}/info.json`, data: Buffer.from('{"id": 1, "city": "Antwerpen"}', 'utf8') },
        { name: `${FOLDER}/photos/01.jpg`, data: Buffer.alloc(900, 7) },
        { name: `${FOLDER}/photos/02.jpg`, data: Buffer.alloc(1200, 9) },
        { name: `${FOLDER}/floorplans/01.pdf`, data: Buffer.from('%PDF-1.4 fake', 'utf8') },
        { name: `${FOLDER}/README.txt`, data: Buffer.from('hello', 'utf8') },
      ]),
    )
    await writeFile(
      storedPath,
      buildZip([{ name: 'photos/01.jpg', data: Buffer.from('stored-bytes'), store: true }]),
    )
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads the central directory including UTF-8 names', async () => {
    const archive = await ZipArchive.open(archivePath)
    expect(archive.names).toHaveLength(5)
    expect(archive.names.some((name) => name.includes('—'))).toBe(true)
    await archive.close()
  })

  it('reads deflated text and JSON', async () => {
    const archive = await ZipArchive.open(archivePath)
    const info = await archive.readJson<{ id: number; city: string }>(`${FOLDER}/info.json`)
    expect(info).toEqual({ id: 1, city: 'Antwerpen' })
    await archive.close()
  })

  it('finds media in a nested folder and sorts it naturally', async () => {
    const archive = await ZipArchive.open(archivePath)
    const photos = archive.inFolder('photos', /\.(jpe?g|png)$/i)
    expect(photos.map((entry) => entry.name.split('/').pop())).toEqual(['01.jpg', '02.jpg'])
    expect(photos[0]?.size).toBe(900)
    const plans = archive.inFolder('floorplans', /\.pdf$/i)
    expect(plans).toHaveLength(1)
    // The address folder itself must not be mistaken for a media folder.
    expect(archive.inFolder('Antwerpen', /.*/)).toHaveLength(0)
    await archive.close()
  })

  it('reads stored (uncompressed) entries', async () => {
    const archive = await ZipArchive.open(storedPath)
    expect((await archive.read('photos/01.jpg')).toString('utf8')).toBe('stored-bytes')
    await archive.close()
  })

  it('throws a typed error for a missing entry', async () => {
    const archive = await ZipArchive.open(archivePath)
    await expect(archive.read('nope.jpg')).rejects.toBeInstanceOf(ZipReadError)
    await archive.close()
  })

  it('rejects files that are not archives', async () => {
    const notZip = path.join(dir, 'junk.zip')
    await writeFile(notZip, Buffer.from('this is definitely not a zip file'))
    await expect(ZipArchive.open(notZip)).rejects.toBeInstanceOf(ZipReadError)
  })
})

describe('keyForZip', () => {
  it('produces a URL-safe key from the address', () => {
    const key = keyForZip('Maria Claessensplein 5  2050 — Antwerpen.zip')
    expect(key).toMatch(/^[a-z0-9-]+$/)
    expect(key).not.toContain('--')
    expect(key.startsWith('maria-claessensplein-5-2050-antwerpen-')).toBe(true)
  })

  it('keeps two archives at the same address apart', () => {
    const first = keyForZip('Gentplaats 12  2000 — Antwerpen.zip')
    const second = keyForZip('Gentplaats 12  2000 — Antwerpen (1).zip')
    expect(first).not.toBe(second)
  })

  it('is stable across calls', () => {
    expect(keyForZip('Kerkstraat 1.zip')).toBe(keyForZip('Kerkstraat 1.zip'))
  })

  it('never returns an empty key', () => {
    expect(keyForZip('.zip')).toMatch(/^listing-/)
  })
})
