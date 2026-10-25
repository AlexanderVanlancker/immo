/**
 * Minimal, dependency-free ZIP reader.
 *
 * Immoweb Zipper archives are written by fflate: a single flat directory
 * listing, `deflateRaw` compression, UTF-8 names, no encryption, no zip64 for
 * listings of a realistic size. That is all this reader needs to support, but
 * it does read through the central directory rather than guessing, so archives
 * produced by other tools (Info-ZIP, macOS Archive Utility, 7-Zip) work too.
 */
import { open, type FileHandle } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_SIZE = 22
/** The EOCD comment field is 16-bit, so the record starts within the last 64 KiB + 22 bytes. */
const EOCD_SEARCH_LIMIT = 0xffff + EOCD_MIN_SIZE

export interface ZipEntry {
  /** Full path inside the archive, e.g. `Maria Claessensplein 5  2050 — Antwerpen/photos/01.jpg`. */
  name: string
  /** 0 = stored, 8 = deflate. Anything else is rejected when reading. */
  method: number
  compressedSize: number
  size: number
  /** CRC-32 of the uncompressed bytes, as recorded in the central directory. */
  crc32: number
  offset: number
}

export class ZipReadError extends Error {
  constructor(
    message: string,
    readonly zipPath: string,
  ) {
    super(message)
    this.name = 'ZipReadError'
  }
}

export class ZipArchive {
  /** Entries keyed by their in-archive name, in central-directory order. */
  readonly entries = new Map<string, ZipEntry>()

  private constructor(
    readonly path: string,
    private readonly handle: FileHandle,
    private readonly fileSize: number,
  ) {}

  static async open(path: string): Promise<ZipArchive> {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      const archive = new ZipArchive(path, handle, size)
      await archive.readCentralDirectory()
      return archive
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  async close(): Promise<void> {
    await this.handle.close()
  }

  get names(): string[] {
    return [...this.entries.keys()]
  }

  /** Entries whose name matches a predicate, sorted case-insensitively for stable output. */
  find(predicate: (name: string) => boolean): ZipEntry[] {
    return [...this.entries.values()]
      .filter((entry) => predicate(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
  }

  /**
   * Files inside a named folder at any depth, e.g. `…/photos/01.jpg`.
   * The listing folder name is address-dependent, so we match on the last two
   * path segments rather than on a known prefix.
   */
  inFolder(folder: string, pattern: RegExp): ZipEntry[] {
    return this.find((name) => {
      const segments = name.split('/')
      if (segments.length < 2) return false
      const parent = segments[segments.length - 2]
      const file = segments[segments.length - 1] ?? ''
      return parent === folder && file.length > 0 && pattern.test(file)
    })
  }

  async read(entry: ZipEntry | string): Promise<Buffer> {
    const target = typeof entry === 'string' ? this.entries.get(entry) : entry
    if (!target) {
      throw new ZipReadError(`No entry ${JSON.stringify(entry)} in archive`, this.path)
    }
    if (target.size === 0) return Buffer.alloc(0)

    const header = Buffer.alloc(30)
    await this.readAt(header, target.offset, 30)
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new ZipReadError(`Bad local header for ${target.name}`, this.path)
    }
    const dataOffset = target.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    const raw = await this.readAt(Buffer.alloc(target.compressedSize), dataOffset, target.compressedSize)

    if (target.method === 0) return raw
    if (target.method === 8) {
      try {
        return inflateRawSync(raw)
      } catch (error) {
        throw new ZipReadError(
          `Inflate failed for ${target.name}: ${(error as Error).message}`,
          this.path,
        )
      }
    }
    throw new ZipReadError(`Unsupported compression method ${target.method} for ${target.name}`, this.path)
  }

  async readText(entry: ZipEntry | string): Promise<string> {
    const name = typeof entry === 'string' ? entry : entry.name
    const entryObj = this.entries.get(name)
    const buf = await this.read(entry ?? name)
    // Strip a UTF-8 BOM if present; Immoweb's JSON never has one but other tools add it.
    return entryObj && buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
      ? buf.subarray(3).toString('utf8')
      : buf.toString('utf8')
  }

  async readJson<T = unknown>(entry: ZipEntry | string): Promise<T> {
    return JSON.parse(await this.readText(entry)) as T
  }

  private async readAt(buffer: Buffer, position: number, length: number): Promise<Buffer> {
    let read = 0
    while (read < length) {
      const { bytesRead } = await this.handle.read(buffer, read, length - read, position + read)
      if (bytesRead <= 0) {
        throw new ZipReadError(`Unexpected end of archive at byte ${position + read}`, this.path)
      }
      read += bytesRead
    }
    return buffer
  }

  private async readCentralDirectory(): Promise<void> {
    if (this.fileSize < EOCD_MIN_SIZE) {
      throw new ZipReadError('File is too small to be a ZIP archive', this.path)
    }

    const tailLength = Math.min(this.fileSize, EOCD_SEARCH_LIMIT)
    const tail = await this.readAt(Buffer.alloc(tailLength), this.fileSize - tailLength, tailLength)

    let eocd = -1
    for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i
        break
      }
    }
    if (eocd < 0) {
      throw new ZipReadError('No end-of-central-directory record found (not a ZIP file?)', this.path)
    }

    let count = tail.readUInt16LE(eocd + 10)
    let size = tail.readUInt32LE(eocd + 12)
    let offset = tail.readUInt32LE(eocd + 16)

    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      // ZIP64: locate the zip64 EOCD locator that precedes the classic EOCD.
      const locatorOffset = eocd - 20
      if (locatorOffset < 0 || tail.readUInt32LE(locatorOffset) !== 0x07064b50) {
        throw new ZipReadError('Archive claims ZIP64 but has no ZIP64 locator', this.path)
      }
      const zip64Offset = Number(tail.readBigUInt64LE(locatorOffset + 8))
      const record = Buffer.alloc(56)
      await this.readAt(record, zip64Offset, 56)
      if (record.readUInt32LE(0) !== 0x06064b50) {
        throw new ZipReadError('Corrupt ZIP64 end-of-central-directory record', this.path)
      }
      count = Number(record.readBigUInt64LE(32))
      size = Number(record.readBigUInt64LE(40))
      offset = Number(record.readBigUInt64LE(48))
    }

    // `offset` is relative to the start of the file for single-disk archives.
    const base = this.fileSize - tailLength
    let directory: Buffer
    let directoryStart = 0
    if (offset >= base) {
      directoryStart = offset - base
      directory = tail.subarray(directoryStart, directoryStart + size)
    } else {
      directory = await this.readAt(Buffer.alloc(size), offset, size)
    }

    let cursor = 0
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > directory.length) break
      if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        throw new ZipReadError(`Corrupt central directory at entry ${i}`, this.path)
      }
      const flags = directory.readUInt16LE(cursor + 8)
      const method = directory.readUInt16LE(cursor + 10)
      const crc32 = directory.readUInt32LE(cursor + 16)
      let compressedSize = directory.readUInt32LE(cursor + 20)
      let uncompressedSize = directory.readUInt32LE(cursor + 24)
      const nameLength = directory.readUInt16LE(cursor + 28)
      const extraLength = directory.readUInt16LE(cursor + 30)
      const commentLength = directory.readUInt16LE(cursor + 32)
      let localOffset = directory.readUInt32LE(cursor + 42)

      const nameBytes = directory.subarray(cursor + 46, cursor + 46 + nameLength)
      // Bit 11 = name (and comment) are UTF-8. Immoweb Zipper always sets it.
      const name = flags & 0x800 ? nameBytes.toString('utf8') : decodeLegacyName(nameBytes)

      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        const extra = directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength)
        const resolved = readZip64Extra(extra)
        compressedSize = resolved.compressedSize ?? compressedSize
        uncompressedSize = resolved.uncompressedSize ?? uncompressedSize
        localOffset = resolved.localOffset ?? localOffset
      }

      if (!name.endsWith('/')) {
        this.entries.set(name, {
          name,
          method,
          compressedSize,
          size: uncompressedSize,
          crc32,
          offset: localOffset,
        })
      }
      cursor += 46 + nameLength + extraLength + commentLength
    }

    if (this.entries.size === 0 && count > 0) {
      throw new ZipReadError('Central directory produced no readable entries', this.path)
    }
  }
}

function decodeLegacyName(bytes: Buffer): string {
  const utf8 = bytes.toString('utf8')
  // A lossless round-trip means it really was UTF-8; otherwise assume cp437/latin1.
  return Buffer.from(utf8, 'utf8').equals(bytes) ? utf8 : bytes.toString('latin1')
}

/** Reads the parts of a ZIP64 extended-information extra field that we care about. */
function readZip64Extra(extra: Buffer): {
  compressedSize?: number
  uncompressedSize?: number
  localOffset?: number
} {
  let cursor = 0
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor)
    const length = extra.readUInt16LE(cursor + 2)
    if (id === 0x0001) {
      let field = cursor + 4
      const end = field + length
      const out: { compressedSize?: number; uncompressedSize?: number; localOffset?: number } = {}
      // Order is fixed by the spec: uncompressed, compressed, offset, disk.
      if (field + 8 <= end) {
        out.uncompressedSize = Number(extra.readBigUInt64LE(field))
        field += 8
      }
      if (field + 8 <= end) {
        out.compressedSize = Number(extra.readBigUInt64LE(field))
        field += 8
      }
      if (field + 8 <= end) {
        out.localOffset = Number(extra.readBigUInt64LE(field))
      }
      return out
    }
    cursor += 4 + length
  }
  return {}
}
