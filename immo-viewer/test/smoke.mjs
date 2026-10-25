/**
 * End-to-end smoke test against a running dev/preview server.
 *
 * Expectations are derived from /api/listings, so the test keeps working as
 * archives accumulate — it checks relationships, not magic numbers.
 *
 *   npm run dev            # in one terminal
 *   npm run smoke          # in another
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:5173/'
const problems = []
const checks = []

function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) problems.push(`${name} ${detail}`)
}

const payload = await (await fetch(new URL('/api/listings', BASE))).json()
const listings = payload.listings ?? []
const total = listings.length
const withCoords = listings.filter((l) => l.address.lat !== null && l.address.lon !== null).length
const epcA = listings.filter((l) => l.energy.label === 'A').length
const salesWithArea = listings.filter(
  (l) => l.transaction.kind === 'for-sale' && l.price.value !== null && l.area.living !== null,
).length
const sources = [...new Set(listings.map((l) => l.source))]
const cheap = listings.filter((l) => (l.price.value ?? Infinity) <= 480000).length
const postal2050 = listings.filter((l) => l.address.postalCode === '2050').length
// A street name that only one listing has — used to prove facet counts react.
const uniqueStreet = listings.find(
  (l) => l.address.street && listings.filter((o) => o.address.street === l.address.street).length === 1,
)?.address.street
const uniqueStreetSource = listings.find((l) => l.address.street === uniqueStreet)?.source

if (total === 0) {
  console.error(`No listings in ${new URL('/api/listings', BASE)} — drop a ZIP into data/exports/ first.`)
  process.exit(1)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const consoleErrors = []
const pageErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => pageErrors.push(String(error)))

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.card', { timeout: 15000 })

  const cardCount = await page.locator('.card').count()
  check(`${total} listing cards`, cardCount === total, `got ${cardCount}`)

  const markerCount = await page.locator('.marker').count()
  check(`${withCoords} map markers (only listings with coordinates)`, markerCount === withCoords, `got ${markerCount}`)

  const resultCount = (await page.locator('#result-count').innerText()).trim()
  check('result count label', resultCount === `${total} of ${total} listings`, `got "${resultCount}"`)

  const firstName = await page.locator('.card .card-address').first().innerText()
  const firstPrice = await page.locator('.card .card-price').first().innerText()
  check('card shows address + price', Boolean(firstName) && firstPrice.includes('€'), `${firstName} / ${firstPrice}`)

  const sourcePills = await page.locator('.card .pill.source').count()
  check('every card names its source', sourcePills === total, `${sourcePills} of ${total}`)

  const noPin = await page.locator('.card .pill.warn', { hasText: 'No map pin' }).count()
  check('listings without coordinates are flagged', noPin === total - withCoords, `${noPin} flagged`)

  // --- detail panel ---
  await page.locator('.card').first().click()
  await page.waitForSelector('#detail:not([hidden])', { timeout: 5000 })
  const gallerySrc = await page.locator('#detail .gallery img').getAttribute('src')
  check(
    'detail gallery loads a photo from the archive',
    /\/api\/listings\/.+\/photos\/0$/.test(gallerySrc ?? ''),
    gallerySrc ?? 'none',
  )

  const photoOk = await page.evaluate(async (src) => {
    const response = await fetch(src)
    return response.ok && (response.headers.get('content-type') ?? '').startsWith('image/')
  }, gallerySrc)
  check('photo endpoint returns an image', photoOk)

  const counterBefore = await page.locator('#detail .gallery-counter').innerText()
  await page.locator('#detail .gallery-nav.next').click()
  const counterAfter = await page.locator('#detail .gallery-counter').innerText()
  check('gallery next advances', counterBefore !== counterAfter, `${counterBefore} -> ${counterAfter}`)

  const factCount = await page.locator('#detail .fact').count()
  check('detail shows property facts', factCount >= 8, `${factCount} facts`)

  const detailText = await page.locator('#detail').innerText()
  check('detail names the source site', sources.some((source) => detailText.includes(source)), sources.join(', '))

  const detailSections = await page.locator('#detail .detail-section').count()
  check('detail has several sections', detailSections >= 5, `${detailSections} sections`)

  // --- filters ---
  await page.keyboard.press('Escape')
  const hiddenAfterEscape = await page.locator('#detail').getAttribute('hidden')
  check('Escape closes the detail panel', hiddenAfterEscape !== null)

  await page.locator('.chip[data-value="A"]').click()
  await page.waitForTimeout(150)
  const epcFiltered = await page.locator('.card').count()
  check(`EPC filter keeps the ${epcA} A-label listings`, epcFiltered === epcA, `got ${epcFiltered}`)
  const badgeText = await page.locator('#filter-badge').innerText()
  check('filter badge counts the active filter', badgeText === '1', `got ${badgeText}`)
  const markersAfterFilter = await page
    .locator('.marker')
    .count()
  check('map markers follow the filter', markersAfterFilter <= epcA, `got ${markersAfterFilter}`)

  await page.locator('#clear-filters').click()
  await page.waitForTimeout(150)
  check('clear restores every listing', (await page.locator('.card').count()) === total)

  // --- source filter (only rendered when both sites are present) ---
  const sourceChips = await page.locator('.filter-group', { hasText: 'Source' }).locator('.chip').count()
  if (sources.length > 1) {
    check('source chips appear once two sites are saved', sourceChips === sources.length, `${sourceChips} chips`)
    const target = sources.find((source) => source !== sources[0]) ?? sources[0]
    const expected = listings.filter((l) => l.source === target).length
    await page.locator(`.filter-group:has-text("Source") .chip[data-value="${target}"]`).click()
    await page.waitForTimeout(200)
    const sourceFiltered = await page.locator('.card').count()
    check(`source filter keeps the ${target} listings`, sourceFiltered === expected, `got ${sourceFiltered}, want ${expected}`)
    await page.locator('#clear-filters').click()
    await page.waitForTimeout(200)
  } else {
    check('source chips stay hidden with a single site', sourceChips === 0, `${sourceChips} chips`)
  }

  // --- search ---
  // Street names, postal codes and description text are all indexed.
  await page.locator('#search').fill(uniqueStreet)
  await page.waitForTimeout(300)
  const streetHits = await page.locator('.card').count()
  check(`search by street name ("${uniqueStreet}") finds 1`, streetHits === 1, `got ${streetHits}`)

  if (sources.length > 1) {
    const other = sources.find((source) => source !== uniqueStreetSource)
    const otherChip = page.locator(`.filter-group:has-text("Source") .chip[data-value="${other}"]`)
    const otherCount = (await otherChip.locator('.count').innerText()).trim()
    check(`facet count is honest while searching (${other} shows 0)`, otherCount === '0', `got "${otherCount}"`)
    check('a zero-count chip is not clickable', await otherChip.isDisabled())
  }

  // --- empty state explains itself ---
  await page.locator('#search').fill('zzzznomatch')
  await page.waitForTimeout(300)
  const emptyText = (await page.locator('.empty-state').innerText()).replace(/\s+/g, ' ')
  check('empty state names the active filter', /Currently narrowing the list/.test(emptyText) && /zzzznomatch/.test(emptyText), emptyText.slice(0, 120))
  await page.locator('.empty-state button', { hasText: 'Clear all filters' }).click()
  await page.waitForTimeout(300)
  check('“Clear all filters” restores every listing', (await page.locator('.card').count()) === total)

  await page.locator('#search').fill('2050')
  await page.waitForTimeout(250)
  const postalHits = await page.locator('.card').count()
  check(`search by postal code finds all ${postal2050}`, postalHits === postal2050, `got ${postalHits}`)

  await page.locator('#search').fill('')
  await page.waitForTimeout(250)

  // --- numeric filter ---
  await page.locator('input[placeholder="max €"]').fill('480000')
  await page.waitForTimeout(200)
  const cheapCount = await page.locator('.card').count()
  check(`max price filter keeps ${cheap}`, cheapCount === cheap, `got ${cheapCount}`)
  await page.locator('input[placeholder="max €"]').fill('')
  await page.waitForTimeout(200)

  // --- stats view ---
  await page.locator('.tab[data-view="stats"]').click()
  await page.waitForSelector('#stats:not([hidden])', { timeout: 5000 })
  const kpis = await page.locator('#stats .kpi').count()
  check('stats shows 5 KPIs', kpis === 5, `got ${kpis}`)
  const charts = await page.locator('#stats svg.chart').count()
  check('stats renders 6 charts', charts === 6, `got ${charts}`)
  const scatterDots = await page.locator('#stats .dot[data-key]').count()
  check(`scatter plots every sale with a living area (${salesWithArea})`, scatterDots === salesWithArea, `got ${scatterDots}`)
  const notes = await page.locator('#stats .notice').allInnerTexts()
  check('stats explain the missing point', notes.some((note) => /price-vs-area|living area/i.test(note)), notes.join(' / '))
  const medianSqm = await page.locator('#stats .kpi').nth(2).innerText()
  check('median €/m² is populated', /\d/.test(medianSqm), medianSqm.replace(/\n/g, ' | '))

  // clicking a scatter dot opens that listing
  await page.locator('#stats .dot[data-key]').first().click()
  await page.waitForSelector('#detail:not([hidden])', { timeout: 5000 })
  check('scatter dot opens the listing detail', (await page.locator('#detail .gallery img').count()) > 0)

  await page.locator('.tab[data-view="map"]').click()
  await page.waitForTimeout(400)
  check('map view comes back', (await page.locator('#stats').getAttribute('hidden')) !== null)

  const mapCanvas = await page.locator('#map canvas.maplibregl-canvas').count()
  check('MapLibre canvas is mounted', mapCanvas === 1, `got ${mapCanvas}`)

  // The basemap needs the network; only a failure of the app itself is a problem.
  const appErrors = [
    ...pageErrors,
    ...consoleErrors.filter(
      (text) => !/tiles\.openfreemap|tile\.openstreetmap|Failed to load resource|WebGL|font/i.test(text),
    ),
  ]
  check('no JavaScript errors', appErrors.length === 0, appErrors.slice(0, 5).join(' | '))

  // --- layout sanity (fresh load: nothing is selected, so the map is auto-fitted) ---
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.marker', { timeout: 15000 })
  await page.waitForTimeout(1200)
  const layout = await page.evaluate(() => {
    const map = document.querySelector('#map').getBoundingClientRect()
    const sidebar = document.querySelector('#sidebar').getBoundingClientRect()
    return {
      mapWidth: Math.round(map.width),
      mapHeight: Math.round(map.height),
      sidebarWidth: Math.round(sidebar.width),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
  check('map fills the stage', layout.mapHeight > 600 && layout.mapWidth > 600, JSON.stringify(layout))
  check('no horizontal overflow', layout.overflow <= 0, `overflow ${layout.overflow}px`)

  const pinsInView = await page.evaluate(() => {
    const map = document.querySelector('#map').getBoundingClientRect()
    return [...document.querySelectorAll('.maplibregl-marker')].filter((marker) => {
      const box = marker.getBoundingClientRect()
      return (
        box.left >= map.left - 20 &&
        box.right <= map.right + 20 &&
        box.top >= map.top - 20 &&
        box.bottom <= map.bottom + 20
      )
    }).length
  })
  check(`all pins sit inside the map after auto-fit (${withCoords})`, pinsInView === withCoords, `${pinsInView} in view`)

  await page.screenshot({ path: '/tmp/immo-map.png', fullPage: false })
} catch (error) {
  problems.push(`threw: ${error.message}`)
  checks.push({ name: 'smoke run completed', ok: false, detail: error.message })
} finally {
  await browser.close().catch(() => {})
}

for (const entry of checks) {
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`)
}
console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`)
if (problems.length) {
  console.log('\nProblems:')
  for (const problem of problems) console.log(' -', problem)
  process.exit(1)
}
