/**
 * Reverse geocoding for hand-placed pins.
 *
 * Uses Nominatim (the OpenStreetMap geocoder) once, when you drop a pin, so the
 * archive records a readable address next to the coordinates. It is strictly
 * best-effort: if the request fails — offline, rate-limited, blocked — the pin
 * is still saved, just without a label.
 */
export interface GeocodeResult {
  label: string | null
  street: string | null
  houseNumber: string | null
  postalCode: string | null
  city: string | null
}

const EMPTY: GeocodeResult = {
  label: null,
  street: null,
  houseNumber: null,
  postalCode: null,
  city: null,
}

interface NominatimResponse {
  display_name?: string
  address?: Record<string, string>
}

const NOT_FOUND: GeocodeResult = EMPTY

/**
 * Nominatim's usage policy asks for at most one request per second. Pins are
 * placed by hand, so a simple throttle is enough.
 */
let lastRequest = 0

export async function reverseGeocode(lat: number, lon: number): Promise<GeocodeResult> {
  const wait = 1100 - (Date.now() - lastRequest)
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  lastRequest = Date.now()

  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('lat', lat.toFixed(7))
  url.searchParams.set('lon', lon.toFixed(7))
  url.searchParams.set('zoom', '18')
  url.searchParams.set('addressdetails', '1')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return NOT_FOUND
    const payload = (await response.json()) as NominatimResponse
    const address = payload.address ?? {}
    const street =
      address.road ?? address.pedestrian ?? address.footway ?? address.square ?? address.path ?? null
    const houseNumber = address.house_number ?? null
    const postalCode = address.postcode ?? null
    const city =
      address.city ?? address.town ?? address.village ?? address.municipality ?? address.hamlet ?? null

    const first = [street, houseNumber].filter(Boolean).join(' ')
    const second = [postalCode, city].filter(Boolean).join(' ')
    const compact = [first, second].filter(Boolean).join(', ')
    const fallback = payload.display_name
      ? payload.display_name.split(',').slice(0, 2).join(',').trim()
      : null

    return { label: compact || fallback, street, houseNumber, postalCode, city }
  } catch {
    return NOT_FOUND
  } finally {
    clearTimeout(timer)
  }
}
