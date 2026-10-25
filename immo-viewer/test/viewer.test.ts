import { describe, expect, it } from 'vitest'
import saleFixture from './fixtures/info-sale.json'
import rentFixture from './fixtures/info-rent.json'
import { normaliseListing } from '../server/normalise.ts'
import {
  applyFilters,
  computeFacets,
  defaultFilters,
  describeFilters,
  filtersFromHash,
  filtersToHash,
} from '../src/filters.ts'
import { computeStats, linearRegression, median } from '../src/stats.ts'
import type { Listing } from '../src/types.ts'

const photos = [
  { name: 'photos/01.jpg', bytes: 100 },
  { name: 'photos/02.jpg', bytes: 200 },
]

function sale(): Listing {
  return normaliseListing({
    key: 'sale-key',
    folder: 'Example Street 5  2000 — Antwerpen',
    info: saleFixture as Record<string, unknown>,
    photos,
    floorPlans: [{ name: 'floorplans/01.pdf', bytes: 10 }],
    documents: [],
  })
}

function rent(): Listing {
  return normaliseListing({
    key: 'rent-key',
    folder: 'Example 1  2050 — Antwerpen',
    info: rentFixture as Record<string, unknown>,
    photos: [],
    floorPlans: [],
    documents: [],
  })
}

describe('normaliseListing', () => {
  it('maps the sale fixture in full', () => {
    const listing = sale()
    expect(listing.transaction.kind).toBe('for-sale')
    expect(listing.price.value).toBe(475000)
    expect(listing.price.oldValue).toBe(495000)
    expect(listing.price.perSqm).toBe(3654)
    expect(listing.area.living).toBe(130)
    expect(listing.area.bedrooms).toBe(3)
    expect(listing.energy.label).toBe('A')
    expect(listing.address.label).toBe('Example Street 5, 2000 Antwerpen')
    expect(listing.address.lat).toBeCloseTo(51.2171577, 5)
    expect(listing.media.photos).toHaveLength(2)
    expect(listing.media.floorPlans).toHaveLength(1)
    expect(listing.agency[0]?.name).toBe('Example Agency')
    expect(listing.warnings).toEqual([])
  })

  it('drops non-boolean feature values instead of faking them', () => {
    const listing = sale()
    expect(listing.features.garden).toBe(true)
    expect(listing.features.swimmingPool).toBe(false)
    expect('somethingUnknown' in listing.features).toBe(false)
  })

  it('derives a €/m² figure when Immoweb did not publish one', () => {
    const listing = sale()
    const info = structuredClone(saleFixture) as Record<string, unknown>
    ;(info.price as Record<string, unknown>).computedPricePerSqm = null
    const recomputed = normaliseListing({
      key: 'k',
      folder: 'x',
      info,
      photos: [],
      floorPlans: [],
      documents: [],
    })
    expect(recomputed.price.perSqm).toBe(Math.round(475000 / 130))
    expect(listing.price.perSqm).toBe(3654)
  })

  it('handles a rental: monthly rent, charges and no price per m² confusion', () => {
    const listing = rent()
    expect(listing.transaction.kind).toBe('for-rent')
    expect(listing.price.value).toBe(1850)
    expect(listing.price.rent?.monthly).toBe(1850)
    expect(listing.price.rent?.excludingCharges).toBe(1730)
    expect(listing.price.rent?.monthlyCosts).toBe(120)
    expect(listing.price.perSqm).toBe(26)
  })

  it('warns when a listing cannot be placed on the map', () => {
    const listing = rent()
    expect(listing.address.lat).toBeNull()
    expect(listing.warnings.some((warning) => /coordinates/i.test(warning))).toBe(true)
  })

  it('falls back to a readable title and address when the data is sparse', () => {
    const listing = rent()
    expect(listing.address.label).toBe('2050 Antwerpen')
    expect(listing.title).toBe('Apartment')
  })

  it('survives a completely empty payload', () => {
    const listing = normaliseListing({
      key: 'empty',
      folder: 'empty',
      info: {},
      photos: [],
      floorPlans: [],
      documents: [],
    })
    expect(listing.price.value).toBeNull()
    expect(listing.transaction.kind).toBe('for-sale')
    expect(listing.address.label).toBe('Unknown address')
    expect(listing.warnings.length).toBeGreaterThan(0)
  })
})

describe('filters', () => {
  const listings = [sale(), rent()]

  it('filters by transaction type', () => {
    const filters = { ...defaultFilters(), transaction: 'for-rent' as const }
    expect(applyFilters(listings, filters).map((l) => l.key)).toEqual(['rent-key'])
  })

  it('filters by price ceiling and floor', () => {
    expect(applyFilters(listings, { ...defaultFilters(), priceMax: 2000 }).map((l) => l.key)).toEqual(['rent-key'])
    expect(applyFilters(listings, { ...defaultFilters(), priceMin: 400000 }).map((l) => l.key)).toEqual(['sale-key'])
  })

  it('requires every selected feature', () => {
    const garden = applyFilters(listings, { ...defaultFilters(), features: ['garden'] })
    expect(garden.map((l) => l.key)).toEqual(['sale-key'])
    const both = applyFilters(listings, { ...defaultFilters(), features: ['garden', 'pool'] })
    expect(both).toHaveLength(0)
  })

  it('searches addresses, postal codes and descriptions', () => {
    expect(applyFilters(listings, { ...defaultFilters(), query: 'example street' })).toHaveLength(1)
    expect(applyFilters(listings, { ...defaultFilters(), query: '2050' })).toHaveLength(1)
    expect(applyFilters(listings, { ...defaultFilters(), query: 'furnished' })).toHaveLength(1)
  })

  it('hides sold listings when asked to', () => {
    expect(applyFilters(listings, { ...defaultFilters(), includeSold: false }).map((l) => l.key)).toEqual(['sale-key'])
  })

  it('filters by source site and counts the facet', () => {
    const immoscoop = normaliseListing({
      key: 'scoop-key',
      folder: 'Aalscholverlaan 78 box 802  2050 — Antwerpen',
      info: { ...(rentFixture as Record<string, unknown>), source: 'Immoscoop' },
      photos: [],
      floorPlans: [],
      documents: [],
    })
    expect(immoscoop.source).toBe('Immoscoop')
    expect(sale().source).toBe('Immoweb')

    const mixed = [sale(), immoscoop]
    expect(applyFilters(mixed, { ...defaultFilters(), sources: ['Immoscoop'] }).map((l) => l.key)).toEqual([
      'scoop-key',
    ])
    expect(applyFilters(mixed, { ...defaultFilters(), sources: ['Immoweb'] }).map((l) => l.key)).toEqual([
      'sale-key',
    ])
    expect(applyFilters(mixed, { ...defaultFilters(), sources: [] })).toHaveLength(2)

    const facets = computeFacets(mixed)
    expect(facets.sources).toEqual([
      { value: 'Immoscoop', count: 1 },
      { value: 'Immoweb', count: 1 },
    ])
  })

  it('round-trips through the URL hash', () => {
    const filters = {
      ...defaultFilters(),
      transaction: 'for-sale' as const,
      sources: ['Immoweb', 'Immoscoop'],
      epc: ['A', 'B'],
      types: ['house'],
      priceMin: 100000,
      bedroomsMin: 2,
      features: ['garden'],
      query: 'antwerpen',
      includeSold: false,
    }
    const restored = filtersFromHash(`#${filtersToHash(filters)}`)
    expect(restored).toEqual(filters)
  })

  it('ignores junk in the hash', () => {
    const restored = filtersFromHash('#priceMin=abc&type=&epc=,,&q=')
    expect(restored.priceMin).toBeNull()
    expect(restored.types).toEqual([])
    expect(restored.epc).toEqual([])
    expect(restored.query).toBe('')
  })
})

describe('facets', () => {
  const mixed = () => {
    const scoop = normaliseListing({
      key: 'scoop-key',
      folder: 'Aalscholverlaan 78 box 802  2050 — Antwerpen',
      info: { ...(rentFixture as Record<string, unknown>), source: 'Immoscoop' },
      photos: [],
      floorPlans: [],
      documents: [],
    })
    return [sale(), scoop]
  }

  it('counts each group with the other filters applied', () => {
    const listings = mixed()
    const all = computeFacets(listings)
    expect(all.sources).toEqual([
      { value: 'Immoscoop', count: 1 },
      { value: 'Immoweb', count: 1 },
    ])

    // Selecting a source narrows the *other* groups, but not its own: the
    // Immoscoop rental is an apartment and carries no EPC label, so those chips
    // read 1 and 0 respectively instead of vanishing.
    const pairs = (rows: { value: string; count: number }[]) => rows.map((row) => [row.value, row.count])
    const scooped = computeFacets(listings, { ...defaultFilters(), sources: ['Immoscoop'] })
    expect(scooped.sources).toEqual([
      { value: 'Immoscoop', count: 1 },
      { value: 'Immoweb', count: 1 },
    ])
    expect(pairs(scooped.types)).toEqual([
      ['apartment', 1],
      ['house', 0],
    ])
    expect(pairs(scooped.epc)).toEqual([['A', 0]])

    // A search that only matches the Immoweb listing leaves Immoscoop at 0,
    // while the chip itself survives so the filter row does not jump.
    const searched = computeFacets(listings, { ...defaultFilters(), query: 'example street' })
    expect(searched.sources).toEqual([
      { value: 'Immoweb', count: 1 },
      { value: 'Immoscoop', count: 0 },
    ])
  })

  it('describes the active filters for the empty state', () => {
    expect(describeFilters(defaultFilters())).toEqual([])
    expect(
      describeFilters({
        ...defaultFilters(),
        sources: ['Immoscoop'],
        epc: ['A'],
        priceMax: 500000,
        query: 'antwerpen',
        includeSold: false,
      }),
    ).toEqual(['Search “antwerpen”', 'Source: Immoscoop', 'EPC: A', 'Price ≤ €500,000', 'Sold / rented hidden'])
  })
})

describe('stats', () => {
  it('computes a median for odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBeNull()
  })

  it('fits a line through two points', () => {
    const trend = linearRegression([
      { living: 100, price: 300000 },
      { living: 200, price: 500000 },
    ])
    expect(trend?.slope).toBeCloseTo(2000, 6)
    expect(trend?.intercept).toBeCloseTo(100000, 6)
  })

  it('returns no trend without variance in the x values', () => {
    expect(
      linearRegression([
        { living: 100, price: 300000 },
        { living: 100, price: 500000 },
      ]),
    ).toBeNull()
  })

  it('explains when there is no price history to plot', () => {
    const stats = computeStats([sale()])
    expect(stats.timeline).toHaveLength(1)
    expect(stats.notes.some((note) => /price evolution/i.test(note))).toBe(true)
  })

  it('aggregates the filtered listings', () => {
    const stats = computeStats([sale(), rent()])
    expect(stats.count).toBe(2)
    expect(stats.saleCount).toBe(1)
    expect(stats.rentCount).toBe(1)
    expect(stats.withCoordinates).toBe(1)
    expect(stats.byEpc.map((bucket) => bucket.label)).toEqual(['A'])
    expect(stats.byPostalCode).toHaveLength(2)
    // Only the sale listing is plotted: the rental has no area/price pair for it.
    expect(stats.scatter).toHaveLength(1)
    expect(stats.notes.some((note) => /sale prices and monthly rents/i.test(note))).toBe(true)
    // Two publication months: a timeline, and no "not enough history" note.
    expect(stats.timeline.map((point) => point.key)).toEqual(['2026-07', '2026-09'])
    expect(stats.notes.some((note) => /price evolution/i.test(note))).toBe(false)
  })
})
