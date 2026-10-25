/**
 * Turns the ZIPs the extension downloads into plain folders.
 *
 * The viewer no longer understands ZIP at all: `data/exports/` is an inbox and
 * `data/listings/` is the store, one directory per listing. Extraction is done
 * by the platform's own tool (macOS `ditto`, `bsdtar`, `unzip`), which is
 * battle-tested and handles the em dash in these folder names — macOS's
 * Info-ZIP build does not, which is why `ditto` is tried first there.
 *
 * Each imported folder records where it came from in `.source.json`, so an
 * already-imported archive is skipped until the ZIP changes again.
 */
import { execFile } from 'node:child_process'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface ImportedListing {
  archive: string
  folder: string
  action: 'imported' | 'replaced'
}

export interface UnpackError {
  archive: string
  message: string
}

export interface UnpackResult {
  imported: ImportedListing[]
  skipped: string[]
  errors: UnpackError[]
}

/** Recorded inside every imported folder. */
export interface SourceMarker {
  archive: string
  archiveMtimeMs: number
  importedAt: string
  extractor: string
}

const MARKER = '.source.json'
const STAGING_PREFIX = '.importing-'

interface Extractor {
  command: string
  args: (zipPath: string, destination: string) => string[]
}

const DITTO: Extractor = { command: 'ditto', args: (zip, dest) => ['-x', '-k', zip, dest] }
const BSDTAR: Extractor = { command: 'bsdtar', args: (zip, dest) => ['-xf', zip, '-C', dest] }
const UNZIP: Extractor = { command: 'unzip', args: (zip, dest) => ['-qq', '-o', zip, '-d', dest] }

/**
 * macOS ships Info-ZIP `unzip`, which cannot write these UTF-8 folder names;
 * its own `ditto` can. Elsewhere libarchive (`bsdtar`) is the safest first bet.
 */
const EXTRACTORS: Extractor[] =
  process.platform === 'darwin' ? [DITTO, BSDTAR, UNZIP] : [BSDTAR, UNZIP, DITTO]

async function extractZip(zipPath: string, destination: string): Promise<string> {
  const failures: string[] = []
  for (const extractor of EXTRACTORS) {
    try {
      await run(extractor.command, extractor.args(zipPath, destination), { maxBuffer: 4 * 1024 * 1024 })
      const entries = await readdir(destination)
      if (entries.length > 0) return extractor.command
      failures.push(`${extractor.command}: produced no files`)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        failures.push(`${extractor.command}: not installed`)
        continue
      }
      failures.push(`${extractor.command}: ${(error as Error).message.split('\n')[0]}`)
    }
    // A failed attempt can leave junk behind; start each try from clean.
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
  }
  throw new Error(`Could not extract the archive — ${failures.join('; ')}`)
}

/** Maps archive name → the folder it was imported into, via the markers. */
async function readMarkers(storeDir: string): Promise<Map<string, { folder: string; marker: SourceMarker }>> {
  const known = new Map<string, { folder: string; marker: SourceMarker }>()
  let entries: string[]
  try {
    entries = await readdir(storeDir)
  } catch {
    return known
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    try {
      const raw = await readFile(path.join(storeDir, entry, MARKER), 'utf8')
      const marker = JSON.parse(raw) as SourceMarker
      if (marker && typeof marker.archive === 'string') known.set(marker.archive, { folder: entry, marker })
    } catch {
      /* no marker: a hand-made folder, which is fine */
    }
  }
  return known
}

/** The listing folder inside the extraction staging dir. */
async function findExtractedRoot(stagingDir: string, archiveName: string): Promise<{ root: string; folder: string }> {
  const entries = await readdir(stagingDir, { withFileTypes: true })
  const directories = entries.filter((entry) => entry.isDirectory())

  for (const directory of directories) {
    try {
      await stat(path.join(stagingDir, directory.name, 'info.json'))
      return { root: path.join(stagingDir, directory.name), folder: directory.name }
    } catch {
      /* not a listing folder */
    }
  }

  // Files at the archive root (some tools drop the folder): the staging dir *is*
  // the listing, named after the archive.
  try {
    await stat(path.join(stagingDir, 'info.json'))
    return { root: stagingDir, folder: archiveName.replace(/\.zip$/i, '') }
  } catch {
    throw new Error('The archive has no info.json — was it created by Listing Zipper?')
  }
}

/**
 * Imports every archive in `inboxDir` that is missing from (or newer than) its
 * copy in `storeDir`. Archives are left where they are.
 */
export async function unpackPending(inboxDir: string, storeDir: string): Promise<UnpackResult> {
  const result: UnpackResult = { imported: [], skipped: [], errors: [] }
  await mkdir(storeDir, { recursive: true })

  let archives: string[]
  try {
    archives = (await readdir(inboxDir)).filter((file) => file.toLowerCase().endsWith('.zip')).sort()
  } catch {
    return result
  }
  if (archives.length === 0) return result

  const known = await readMarkers(storeDir)

  for (const [index, archive] of archives.entries()) {
    const zipPath = path.join(inboxDir, archive)
    let archiveMtimeMs: number
    try {
      archiveMtimeMs = (await stat(zipPath)).mtimeMs
    } catch (error) {
      result.errors.push({ archive, message: `Cannot read the archive: ${(error as Error).message}` })
      continue
    }

    const previous = known.get(archive)
    if (previous) {
      const folderExists = await stat(path.join(storeDir, previous.folder))
        .then(() => true)
        .catch(() => false)
      if (folderExists && previous.marker.archiveMtimeMs >= archiveMtimeMs) {
        result.skipped.push(archive)
        continue
      }
    }

    const staging = path.join(storeDir, `${STAGING_PREFIX}${process.pid}-${Date.now()}-${index}`)
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })

    try {
      const extractor = await extractZip(zipPath, staging)
      const { root, folder } = await findExtractedRoot(staging, archive)
      const target = path.join(storeDir, folder)

      const replaced = await stat(target).then(
        (info) => info.isDirectory(),
        () => false,
      )
      // Move the old copy aside first: if anything below fails, it comes back.
      const trash = replaced ? `${staging}-old` : null
      if (trash) await rename(target, trash)

      try {
        try {
          await rename(root, target)
        } catch (error) {
          // Renaming across devices fails (EXDEV); fall back to copying.
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
          await cp(root, target, { recursive: true })
        }
      } catch (error) {
        if (trash) await rename(trash, target)
        throw error
      }
      if (trash) await rm(trash, { recursive: true, force: true })

      const marker: SourceMarker = {
        archive,
        archiveMtimeMs,
        importedAt: new Date().toISOString(),
        extractor,
      }
      await writeFile(path.join(target, MARKER), JSON.stringify(marker, null, 2), 'utf8')

      result.imported.push({ archive, folder, action: replaced ? 'replaced' : 'imported' })
    } catch (error) {
      result.errors.push({ archive, message: (error as Error).message })
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  return result
}
