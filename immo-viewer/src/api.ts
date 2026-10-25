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

export interface LocationInput {
  lat: number
  lon: number
  label?: string | null
  street?: string | null
  houseNumber?: string | null
  postalCode?: string | null
  city?: string | null
}

/**
 * Writes hand-picked coordinates into the archive's info.json and returns the
 * listing as the server re-read it.
 */
export async function saveLocation(listing: Listing, input: LocationInput): Promise<Listing> {
  const response = await fetch(`/api/listings/${encodeURIComponent(listing.key)}/location`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Could not save the location (${response.status}): ${detail.slice(0, 200)}`)
  }
  const payload = (await response.json()) as { listing: Listing }
  return payload.listing
}

/** A text file out of the listing folder, e.g. `info.json`. */
export function documentUrl(listing: Listing, name: string): string {
  return `/api/listings/${encodeURIComponent(listing.key)}/files/${encodeURIComponent(name)}`
}
