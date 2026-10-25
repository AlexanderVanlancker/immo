import { monthKey } from './format'
import type { Listing } from './types'

export interface Bucket {
  label: string
  count: number
  medianPrice: number | null
  medianPerSqm: number | null
}

export interface TimelinePoint {
  key: string
  label: string
  count: number
  medianPerSqm: number | null
  medianPrice: number | null
}

export interface ScatterPoint {
  key: string
  label: string
  living: number
  price: number
  perSqm: number | null
  epc: string | null
}

export interface Stats {
  count: number
  saleCount: number
  rentCount: number
  withCoordinates: number
  medianPrice: number | null
  medianPerSqm: number | null
  medianLiving: number | null
  priceRange: { min: number; max: number } | null
  perSqmRange: { min: number; max: number } | null
  byEpc: Bucket[]
  byPostalCode: Bucket[]
  byType: Bucket[]
  byBedrooms: Bucket[]
  timeline: TimelinePoint[]
  scatter: ScatterPoint[]
  /** Least-squares fit of price against living area, for the trend line. */
  trend: { slope: number; intercept: number } | null
  /** Why a chart may be thinner than the list. */
  notes: string[]
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? null
  const low = sorted[middle - 1]
  const high = sorted[middle]
  if (low === undefined || high === undefined) return null
  return (low + high) / 2
}

const priceOf = (listing: Listing) => listing.price.value
const perSqmOf = (listing: Listing) => listing.price.perSqm

function bucketBy(
  listings: Listing[],
  keyOf: (listing: Listing) => string | null,
  labelOf: (key: string, listing: Listing) => string,
  sort?: (a: Bucket, b: Bucket) => number,
): Bucket[] {
  const groups = new Map<string, Listing[]>()
  for (const listing of listings) {
    const key = keyOf(listing)
    if (!key) continue
    const group = groups.get(key)
    if (group) group.push(listing)
    else groups.set(key, [listing])
  }
  const buckets = [...groups.entries()].map(([key, group]) => ({
    label: labelOf(key, group[0] as Listing),
    count: group.length,
    medianPrice: median(group.map(priceOf).filter((value): value is number => value !== null)),
    medianPerSqm: median(group.map(perSqmOf).filter((value): value is number => value !== null)),
  }))
  return sort ? buckets.sort(sort) : buckets.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

export function computeStats(listings: Listing[]): Stats {
  const notes: string[] = []
  const prices = listings.map(priceOf).filter((value): value is number => value !== null)
  const perSqm = listings.map(perSqmOf).filter((value): value is number => value !== null)
  const living = listings
    .map((listing) => listing.area.living)
    .filter((value): value is number => value !== null && value > 0)

  const saleCount = listings.filter((listing) => listing.transaction.kind === 'for-sale').length
  const rentCount = listings.length - saleCount
  if (saleCount > 0 && rentCount > 0) {
    notes.push(
      'Sale prices and monthly rents are mixed in the overview figures — filter to one transaction type for a like-for-like comparison.',
    )
  }

  const scatter: ScatterPoint[] = []
  for (const listing of listings) {
    const area = listing.area.living
    const price = listing.price.value
    if (listing.transaction.kind !== 'for-sale') continue
    if (area === null || area <= 0 || price === null) continue
    scatter.push({
      key: listing.key,
      label: listing.address.label,
      living: area,
      price,
      perSqm: listing.price.perSqm,
      epc: listing.energy.label,
    })
  }
  if (scatter.length > 0 && scatter.length < listings.length) {
    notes.push('The price-vs-area chart only plots sale listings that have both a price and a living area.')
  }

  const timelineMap = new Map<string, Listing[]>()
  for (const listing of listings) {
    const key = monthKey(listing.publishedAt ?? listing.capturedAt)
    if (!key) continue
    const group = timelineMap.get(key)
    if (group) group.push(listing)
    else timelineMap.set(key, [listing])
  }
  const timeline: TimelinePoint[] = [...timelineMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, group]) => ({
      key,
      label: formatMonthKey(key),
      count: group.length,
      medianPerSqm: median(group.map(perSqmOf).filter((value): value is number => value !== null)),
      medianPrice: median(group.map(priceOf).filter((value): value is number => value !== null)),
    }))
  if (timeline.length < 2) {
    notes.push(
      'Price evolution needs listings spread over several months — every archive saved so far falls in the same month.',
    )
  }

  return {
    count: listings.length,
    saleCount,
    rentCount,
    withCoordinates: listings.filter((l) => l.address.lat !== null && l.address.lon !== null).length,
    medianPrice: median(prices),
    medianPerSqm: median(perSqm),
    medianLiving: median(living),
    priceRange:
      prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    perSqmRange:
      perSqm.length > 0 ? { min: Math.min(...perSqm), max: Math.max(...perSqm) } : null,
    byEpc: bucketBy(
      listings,
      (listing) => listing.energy.label,
      (key) => key,
      (a, b) => a.label.localeCompare(b.label),
    ),
    byPostalCode: bucketBy(
      listings,
      (listing) => listing.address.postalCode,
      (key, listing) => `${key} ${listing.address.city ?? ''}`.trim(),
      (a, b) => a.label.localeCompare(b.label),
    ),
    byType: bucketBy(
      listings,
      (listing) => listing.propertyType,
      (_key, listing) => listing.propertyTypeLabel ?? 'Unknown',
    ),
    byBedrooms: bucketBy(
      listings,
      (listing) => (listing.area.bedrooms === null ? null : String(listing.area.bedrooms)),
      (key) => `${key} bed`,
      (a, b) => Number.parseInt(a.label, 10) - Number.parseInt(b.label, 10),
    ),
    timeline,
    scatter,
    trend: linearRegression(scatter),
    notes,
  }
}

export function linearRegression(points: { living: number; price: number }[]): { slope: number; intercept: number } | null {
  if (points.length < 2) return null
  const n = points.length
  const sumX = points.reduce((total, point) => total + point.living, 0)
  const sumY = points.reduce((total, point) => total + point.price, 0)
  const meanX = sumX / n
  const meanY = sumY / n
  let numerator = 0
  let denominator = 0
  for (const point of points) {
    numerator += (point.living - meanX) * (point.price - meanY)
    denominator += (point.living - meanX) ** 2
  }
  if (denominator === 0) return null
  const slope = numerator / denominator
  return { slope, intercept: meanY - slope * meanX }
}

function formatMonthKey(key: string): string {
  const [year, monthPart] = key.split('-')
  const monthIndex = Number.parseInt(monthPart ?? '1', 10) - 1
  const date = new Date(Date.UTC(Number(year), monthIndex, 1))
  return date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}
