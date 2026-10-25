import type { Listing } from './types'

export type TransactionFilter = 'all' | 'for-sale' | 'for-rent'

export interface FilterState {
  transaction: TransactionFilter
  /** Source sites, e.g. `Immoweb`, `Immoscoop`. Empty means "any". */
  sources: string[]
  /** Property types, e.g. `house`, `apartment`. Empty means "any". */
  types: string[]
  /** EPC labels, e.g. `A`, `B`. Empty means "any". */
  epc: string[]
  /** Postal codes. Empty means "any". */
  postalCodes: string[]
  /** Feature ids from FEATURE_FILTERS. All selected features must be present. */
  features: string[]
  priceMin: number | null
  priceMax: number | null
  perSqmMin: number | null
  perSqmMax: number | null
  livingMin: number | null
  livingMax: number | null
  plotMin: number | null
  bedroomsMin: number | null
  includeSold: boolean
  query: string
}

export const EPC_ORDER = ['A+', 'A', 'B', 'C', 'D', 'E', 'F', 'G'] as const

export interface FeatureFilter {
  id: string
  label: string
  test: (listing: Listing) => boolean
}

export const FEATURE_FILTERS: FeatureFilter[] = [
  { id: 'garden', label: 'Garden', test: (l) => l.features.garden === true || (l.area.garden ?? 0) > 0 },
  { id: 'terrace', label: 'Terrace', test: (l) => l.features.terrace === true || (l.area.terrace ?? 0) > 0 },
  {
    id: 'parking',
    label: 'Parking',
    test: (l) => (l.parking.indoor ?? 0) + (l.parking.outdoor ?? 0) + (l.parking.closedBox ?? 0) > 0,
  },
  { id: 'lift', label: 'Lift', test: (l) => l.features.lift === true },
  { id: 'pool', label: 'Pool', test: (l) => l.features.swimmingPool === true },
  { id: 'basement', label: 'Basement', test: (l) => l.features.basement === true },
  { id: 'airco', label: 'Air conditioning', test: (l) => l.features.airConditioning === true },
  { id: 'fireplace', label: 'Fireplace', test: (l) => l.features.fireplace === true },
  { id: 'solar', label: 'Solar panels', test: (l) => l.energy.photovoltaicPanels === true },
  {
    id: 'ready',
    label: 'Move-in ready',
    test: (l) => ['AS_NEW', 'NEW', 'EXCELLENT', 'GOOD'].includes(l.condition ?? ''),
  },
]

export function defaultFilters(): FilterState {
  return {
    transaction: 'all',
    sources: [],
    types: [],
    epc: [],
    postalCodes: [],
    features: [],
    priceMin: null,
    priceMax: null,
    perSqmMin: null,
    perSqmMax: null,
    livingMin: null,
    livingMax: null,
    plotMin: null,
    bedroomsMin: null,
    includeSold: true,
    query: '',
  }
}

const searchIndexCache = new WeakMap<Listing, string>()

function searchText(listing: Listing): string {
  const cached = searchIndexCache.get(listing)
  if (cached) return cached
  const parts = [
    listing.title,
    listing.address.label,
    listing.address.street,
    listing.address.city,
    listing.address.postalCode,
    listing.address.district,
    listing.propertyTypeLabel,
    listing.subtypeLabel,
    listing.agency.map((agency) => agency.name).join(' '),
    listing.description ?? '',
    listing.immowebId === null ? '' : String(listing.immowebId),
    listing.externalReference ?? '',
  ]
  const text = parts.filter(Boolean).join(' ').toLowerCase()
  searchIndexCache.set(listing, text)
  return text
}

export function applyFilters(listings: Listing[], filters: FilterState): Listing[] {
  const query = filters.query.trim().toLowerCase()
  const features = FEATURE_FILTERS.filter((feature) => filters.features.includes(feature.id))
  const types = new Set(filters.types)
  const epc = new Set(filters.epc)
  const postalCodes = new Set(filters.postalCodes)
  const sources = new Set(filters.sources)

  return listings.filter((listing) => {
    if (!filters.includeSold && listing.flags.isSoldOrRented) return false
    if (filters.transaction !== 'all' && listing.transaction.kind !== filters.transaction) return false
    if (sources.size > 0 && !sources.has(listing.source)) return false
    if (types.size > 0 && !(listing.propertyType && types.has(listing.propertyType))) return false
    if (epc.size > 0 && !(listing.energy.label && epc.has(listing.energy.label))) return false
    if (
      postalCodes.size > 0 &&
      !(listing.address.postalCode && postalCodes.has(listing.address.postalCode))
    ) {
      return false
    }
    if (filters.priceMin !== null && (listing.price.value ?? -Infinity) < filters.priceMin) return false
    if (filters.priceMax !== null && (listing.price.value ?? Infinity) > filters.priceMax) return false
    if (filters.perSqmMin !== null && (listing.price.perSqm ?? -Infinity) < filters.perSqmMin) return false
    if (filters.perSqmMax !== null && (listing.price.perSqm ?? Infinity) > filters.perSqmMax) return false
    if (filters.livingMin !== null && (listing.area.living ?? -Infinity) < filters.livingMin) return false
    if (filters.livingMax !== null && (listing.area.living ?? Infinity) > filters.livingMax) return false
    if (filters.plotMin !== null && (listing.area.plot ?? -Infinity) < filters.plotMin) return false
    if (filters.bedroomsMin !== null && (listing.area.bedrooms ?? -Infinity) < filters.bedroomsMin) return false
    for (const feature of features) {
      if (!feature.test(listing)) return false
    }
    if (query && !searchText(listing).includes(query)) return false
    return true
  })
}

export function activeFilterCount(filters: FilterState): number {
  const defaults = defaultFilters()
  let count = 0
  if (filters.transaction !== defaults.transaction) count++
  if (filters.sources.length) count++
  if (filters.types.length) count++
  if (filters.epc.length) count++
  if (filters.postalCodes.length) count++
  if (filters.features.length) count++
  for (const key of ['priceMin', 'priceMax', 'perSqmMin', 'perSqmMax', 'livingMin', 'livingMax', 'plotMin', 'bedroomsMin'] as const) {
    if (filters[key] !== null) count++
  }
  if (filters.includeSold !== defaults.includeSold) count++
  if (filters.query.trim() !== '') count++
  return count
}

export interface Facets {
  sources: { value: string; count: number }[]
  types: { value: string; label: string; count: number }[]
  epc: { value: string; count: number }[]
  postalCodes: { value: string; label: string; count: number }[]
  prices: { min: number; max: number }
  living: { min: number; max: number }
}

/**
 * Counts for the chips. The set of values comes from the whole catalogue so a
 * chip never disappears while you type, but each count is computed with every
 * *other* active filter applied (and its own selection lifted) — so a chip
 * showing "Immoscoop 0" is telling the truth when a search or a price range
 * already rules those listings out.
 */
export function computeFacets(listings: Listing[], filters: FilterState = defaultFilters()): Facets {
  const base = filters ?? defaultFilters()
  const pool = (patch: Partial<FilterState>) => applyFilters(listings, { ...base, ...patch })
  const sourcePool = pool({ sources: [] })
  const typePool = pool({ types: [] })
  const epcPool = pool({ epc: [] })
  const postalPool = pool({ postalCodes: [] })

  const sourceCounts = new Map<string, number>()
  const typeCounts = new Map<string, { label: string; count: number }>()
  const epcCounts = new Map<string, number>()
  const postalCounts = new Map<string, { label: string; count: number }>()

  const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)

  // Seed every value (and its label) from the full list, at 0.
  for (const listing of listings) {
    sourceCounts.set(listing.source, 0)
    if (listing.propertyType) {
      const existing = typeCounts.get(listing.propertyType)
      typeCounts.set(listing.propertyType, {
        label: listing.propertyTypeLabel ?? existing?.label ?? listing.propertyType,
        count: 0,
      })
    }
    if (listing.energy.label) epcCounts.set(listing.energy.label, 0)
    if (listing.address.postalCode) {
      const existing = postalCounts.get(listing.address.postalCode)
      postalCounts.set(listing.address.postalCode, {
        label: existing?.label ?? listing.address.city ?? listing.address.postalCode,
        count: 0,
      })
    }
  }

  // Then count over the facet pool.
  for (const listing of sourcePool) bump(sourceCounts, listing.source)
  for (const listing of typePool) {
    if (!listing.propertyType) continue
    const entry = typeCounts.get(listing.propertyType)
    if (entry) entry.count += 1
  }
  for (const listing of epcPool) {
    if (listing.energy.label) bump(epcCounts, listing.energy.label)
  }
  for (const listing of postalPool) {
    const code = listing.address.postalCode
    if (!code) continue
    const entry = postalCounts.get(code)
    if (entry) entry.count += 1
  }

  // Range hints stay global, so the min/max placeholders never jump around.
  let priceMin = Infinity
  let priceMax = -Infinity
  let livingMin = Infinity
  let livingMax = -Infinity
  for (const listing of listings) {
    if (listing.price.value !== null) {
      priceMin = Math.min(priceMin, listing.price.value)
      priceMax = Math.max(priceMax, listing.price.value)
    }
    if (listing.area.living !== null && listing.area.living > 0) {
      livingMin = Math.min(livingMin, listing.area.living)
      livingMax = Math.max(livingMax, listing.area.living)
    }
  }

  const epcRank = (value: string) => {
    const index = (EPC_ORDER as readonly string[]).indexOf(value)
    return index === -1 ? 99 : index
  }

  return {
    sources: [...sourceCounts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    types: [...typeCounts.entries()]
      .map(([value, info]) => ({ value, label: info.label, count: info.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    epc: [...epcCounts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => epcRank(a.value) - epcRank(b.value) || a.value.localeCompare(b.value)),
    postalCodes: [...postalCounts.entries()]
      .map(([value, info]) => ({ value, label: info.label, count: info.count }))
      .sort((a, b) => a.value.localeCompare(b.value)),
    prices: {
      min: Number.isFinite(priceMin) ? Math.floor(priceMin) : 0,
      max: Number.isFinite(priceMax) ? Math.ceil(priceMax) : 0,
    },
    living: {
      min: Number.isFinite(livingMin) ? Math.floor(livingMin) : 0,
      max: Number.isFinite(livingMax) ? Math.ceil(livingMax) : 0,
    },
  }
}

/**
 * Human-readable list of what is currently narrowing the results, used by the
 * empty state ("no match — these filters are on").
 */
export function describeFilters(filters: FilterState): string[] {
  const parts: string[] = []
  if (filters.query.trim()) parts.push(`Search “${filters.query.trim()}”`)
  if (filters.transaction !== 'all') {
    parts.push(filters.transaction === 'for-rent' ? 'For rent' : 'For sale')
  }
  if (filters.sources.length) parts.push(`Source: ${filters.sources.join(' / ')}`)
  if (filters.types.length) parts.push(`Type: ${filters.types.join(' / ')}`)
  if (filters.epc.length) parts.push(`EPC: ${filters.epc.join(' / ')}`)
  if (filters.postalCodes.length) parts.push(`Location: ${filters.postalCodes.join(' / ')}`)
  if (filters.features.length) {
    const labels = FEATURE_FILTERS.filter((feature) => filters.features.includes(feature.id)).map(
      (feature) => feature.label,
    )
    if (labels.length) parts.push(`Must have: ${labels.join(', ')}`)
  }
  const money = (value: number) => `€${Math.round(value).toLocaleString('en-US')}`
  if (filters.priceMin !== null) parts.push(`Price ≥ ${money(filters.priceMin)}`)
  if (filters.priceMax !== null) parts.push(`Price ≤ ${money(filters.priceMax)}`)
  if (filters.perSqmMin !== null) parts.push(`€/m² ≥ ${money(filters.perSqmMin)}`)
  if (filters.perSqmMax !== null) parts.push(`€/m² ≤ ${money(filters.perSqmMax)}`)
  if (filters.livingMin !== null) parts.push(`Living ≥ ${filters.livingMin} m²`)
  if (filters.livingMax !== null) parts.push(`Living ≤ ${filters.livingMax} m²`)
  if (filters.plotMin !== null) parts.push(`Plot ≥ ${filters.plotMin} m²`)
  if (filters.bedroomsMin !== null) parts.push(`${filters.bedroomsMin}+ bedrooms`)
  if (!filters.includeSold) parts.push('Sold / rented hidden')
  return parts
}

/** Filters live in the URL hash so a view can be bookmarked or shared. */
export function filtersToHash(filters: FilterState): string {
  const params = new URLSearchParams()
  const defaults = defaultFilters()
  if (filters.transaction !== defaults.transaction) params.set('tx', filters.transaction)
  if (filters.sources.length) params.set('src', filters.sources.join(','))
  if (filters.types.length) params.set('type', filters.types.join(','))
  if (filters.epc.length) params.set('epc', filters.epc.join(','))
  if (filters.postalCodes.length) params.set('pc', filters.postalCodes.join(','))
  if (filters.features.length) params.set('feat', filters.features.join(','))
  const numeric = ['priceMin', 'priceMax', 'perSqmMin', 'perSqmMax', 'livingMin', 'livingMax', 'plotMin', 'bedroomsMin'] as const
  for (const key of numeric) {
    const value = filters[key]
    if (value !== null) params.set(key, String(value))
  }
  if (filters.includeSold !== defaults.includeSold) params.set('sold', filters.includeSold ? '1' : '0')
  if (filters.query.trim()) params.set('q', filters.query.trim())
  return params.toString()
}

export function filtersFromHash(hash: string): FilterState {
  const filters = defaultFilters()
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const tx = params.get('tx')
  if (tx === 'for-sale' || tx === 'for-rent') filters.transaction = tx
  const list = (key: string) =>
    (params.get(key) ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  filters.types = list('type')
  filters.sources = list('src')
  filters.epc = list('epc')
  filters.postalCodes = list('pc')
  filters.features = list('feat')
  const numeric = (key: string) => {
    const raw = params.get(key)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  filters.priceMin = numeric('priceMin')
  filters.priceMax = numeric('priceMax')
  filters.perSqmMin = numeric('perSqmMin')
  filters.perSqmMax = numeric('perSqmMax')
  filters.livingMin = numeric('livingMin')
  filters.livingMax = numeric('livingMax')
  filters.plotMin = numeric('plotMin')
  filters.bedroomsMin = numeric('bedroomsMin')
  filters.includeSold = params.get('sold') !== '0'
  filters.query = params.get('q') ?? ''
  return filters
}
