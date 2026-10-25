import type { Listing, ListingsResponse } from './types'

export async function fetchListings(): Promise<ListingsResponse> {
  const response = await fetch('/api/listings', { headers: { accept: 'application/json' } })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`API ${response.status}: ${detail.slice(0, 200) || response.statusText}`)
  }
  return (await response.json()) as ListingsResponse
}

export function photoUrl(listing: Listing, index: number): string {
  return `/api/listings/${encodeURIComponent(listing.key)}/photos/${index}`
}

export function floorPlanUrl(listing: Listing, index: number): string {
  return `/api/listings/${encodeURIComponent(listing.key)}/floorplans/${index}`
}

export function archiveUrl(listing: Listing): string {
  return `/api/listings/${encodeURIComponent(listing.key)}/archive`
}
