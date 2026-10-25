/**
 * Imports every ZIP in the inbox into the listings store, without starting the
 * server. The dev server does the same thing on scan; this is for a headless
 * import (or to see exactly what happened).
 *
 *   npm run unpack
 *   IMMOWEB_EXPORTS_DIR=~/Downloads npm run unpack
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { unpackPending } from '../server/unpack.ts'

const viewerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const inbox = process.env.IMMOWEB_EXPORTS_DIR ?? path.resolve(viewerRoot, '..', 'data', 'exports')
const store = process.env.IMMO_LISTINGS_DIR ?? path.resolve(viewerRoot, '..', 'data', 'listings')

console.log(`inbox: ${inbox}`)
console.log(`store: ${store}\n`)

const result = await unpackPending(inbox, store)

for (const entry of result.imported) {
  console.log(`  ${entry.action === 'replaced' ? 'updated' : 'imported'}  ${entry.folder}`)
}
for (const archive of result.skipped) {
  console.log(`  unchanged  ${archive}`)
}
for (const failure of result.errors) {
  console.error(`  FAILED     ${failure.archive}: ${failure.message}`)
}

console.log(
  `\n${result.imported.length} imported, ${result.skipped.length} unchanged, ${result.errors.length} failed`,
)
process.exitCode = result.errors.length > 0 ? 1 : 0
