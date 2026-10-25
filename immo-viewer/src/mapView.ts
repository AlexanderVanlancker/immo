import maplibregl, { type Map as MapLibreMap, type MapMouseEvent, type Marker } from 'maplibre-gl'
import { el } from './dom'
import { euroCompact } from './format'
import type { Listing } from './types'

/** Free, key-less vector basemap. */
const VECTOR_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

/** Raster fallback used when the vector style cannot be fetched (offline, blocked). */
const RASTER_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
}

export interface MapViewOptions {
  onSelect: (key: string) => void
  onHover: (key: string | null) => void
}

interface Pin {
  marker: Marker
  element: HTMLButtonElement
}

export interface PickedPoint {
  lon: number
  lat: number
}

export class MapView {
  private readonly map: MapLibreMap
  private readonly pins = new Map<string, Pin>()
  private signature = ''
  private styleSettled = false
  private fallbackTimer: ReturnType<typeof setTimeout> | undefined
  /** Set while the user is choosing a spot for a listing that has no pin. */
  private pickHandler: ((point: PickedPoint) => void) | null = null
  private draftMarker: Marker | null = null
  private draftElement: HTMLElement | null = null

  constructor(
    private readonly container: HTMLElement,
    private readonly options: MapViewOptions,
  ) {
    this.map = new maplibregl.Map({
      container,
      style: VECTOR_STYLE,
      center: [4.4, 50.72],
      zoom: 11,
      attributionControl: { compact: true },
      cooperativeGestures: false,
    })

    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-left')

    const settle = () => {
      this.styleSettled = true
      if (this.fallbackTimer) clearTimeout(this.fallbackTimer)
    }
    this.map.once('style.load', settle)
    this.map.on('error', (event) => {
      // Before the style has loaded, an error almost always means the basemap
      // request failed. Swap in raster tiles rather than showing a blank canvas.
      if (!this.styleSettled) {
        console.warn('[immo-viewer] basemap unavailable, falling back to OSM raster', event.error)
        settle()
        this.map.setStyle(RASTER_STYLE)
      }
    })
    this.fallbackTimer = setTimeout(() => {
      if (!this.styleSettled) {
        console.warn('[immo-viewer] basemap timed out, falling back to OSM raster')
        settle()
        this.map.setStyle(RASTER_STYLE)
      }
    }, 8000)
  }

  update(listings: Listing[], selectedKey: string | null): void {
    const visible = new Set<string>()

    for (const listing of listings) {
      const { lat, lon } = listing.address
      if (lat === null || lon === null) continue
      visible.add(listing.key)

      const existing = this.pins.get(listing.key)
      if (existing) {
        existing.marker.setLngLat([lon, lat])
        this.decorate(existing.element, listing)
        continue
      }

      const element = el(
        'button',
        {
          class: 'marker',
          attrs: {
            type: 'button',
            'aria-label': `${euroCompact(listing.price.value)} — ${listing.address.label}`,
          },
          on: {
            click: (event) => {
              event.stopPropagation()
              this.options.onSelect(listing.key)
            },
            mouseenter: () => this.options.onHover(listing.key),
            mouseleave: () => this.options.onHover(null),
          },
        },
        [el('span', { class: 'marker-pill', text: euroCompact(listing.price.value) })],
      )
      const marker = new maplibregl.Marker({ element, anchor: 'center' })
        .setLngLat([lon, lat])
        .addTo(this.map)
      this.pins.set(listing.key, { marker, element })
    }

    // Remove pins for listings that are filtered out.
    for (const [key, pin] of this.pins) {
      if (!visible.has(key)) {
        pin.marker.remove()
        this.pins.delete(key)
      }
    }

    const signature = listings
      .filter((listing) => listing.address.lat !== null)
      .map((listing) => listing.key)
      .sort()
      .join('|')

    if (signature !== this.signature) {
      this.signature = signature
      this.fitTo(listings)
    }

    this.setActive(selectedKey)
  }

  setActive(key: string | null): void {
    for (const [pinKey, pin] of this.pins) {
      pin.element.classList.toggle('is-active', pinKey === key)
    }
    if (key) {
      const pin = this.pins.get(key)
      if (pin) pin.element.classList.add('is-active')
    }
  }

  setHover(key: string | null): void {
    for (const [pinKey, pin] of this.pins) {
      pin.element.classList.toggle('is-hover', pinKey === key)
    }
  }

  flyTo(key: string): void {
    const pin = this.pins.get(key)
    if (!pin) return
    this.map.easeTo({ center: pin.marker.getLngLat(), zoom: Math.max(this.map.getZoom(), 14), duration: 500 })
  }

  resize(): void {
    this.map.resize()
  }

  get isPicking(): boolean {
    return this.pickHandler !== null
  }

  /** Crosshair mode: the next map click reports its coordinates. */
  beginPick(onPick: (point: PickedPoint) => void): void {
    this.endPick()
    this.pickHandler = onPick
    this.container.classList.add('is-picking')
    this.map.getCanvas().style.cursor = 'crosshair'
    this.map.on('click', this.handleMapClick)
  }

  endPick(): void {
    if (this.pickHandler) {
      this.pickHandler = null
      this.map.off('click', this.handleMapClick)
    }
    this.container.classList.remove('is-picking')
    this.map.getCanvas().style.cursor = ''
  }

  /** Shows the not-yet-saved pin. */
  showDraft(point: PickedPoint, label: string | null): void {
    if (!this.draftElement) {
      this.draftElement = el('div', { class: 'pin-draft' }, [
        el('div', { class: 'pin-draft-label' }),
        el('div', { class: 'pin-draft-dot' }),
      ])
      // Position before adding: Marker.addTo() reads the position right away.
      this.draftMarker = new maplibregl.Marker({
        element: this.draftElement,
        anchor: 'bottom',
      })
        .setLngLat([point.lon, point.lat])
        .addTo(this.map)
    }
    this.draftMarker?.setLngLat([point.lon, point.lat])
    const labelNode = this.draftElement.querySelector('.pin-draft-label')
    if (labelNode) labelNode.textContent = label ?? 'New pin'
  }

  clearDraft(): void {
    this.draftMarker?.remove()
    this.draftMarker = null
    this.draftElement = null
  }

  private readonly handleMapClick = (event: MapMouseEvent): void => {
    // Stay in pick mode: clicking again moves the draft pin so the spot can be
    // adjusted without pressing the button twice.
    const handler = this.pickHandler
    if (!handler) return
    handler({ lon: event.lngLat.lng, lat: event.lngLat.lat })
  }

  private decorate(element: HTMLButtonElement, listing: Listing): void {
    const pill = element.querySelector('.marker-pill')
    if (pill) pill.textContent = euroCompact(listing.price.value)
    element.setAttribute('aria-label', `${euroCompact(listing.price.value)} — ${listing.address.label}`)
    element.classList.toggle('is-rent', listing.transaction.kind === 'for-rent')
  }

  private fitTo(listings: Listing[]): void {
    const points = listings
      .filter((listing) => listing.address.lat !== null && listing.address.lon !== null)
      .map((listing) => [listing.address.lon as number, listing.address.lat as number] as [number, number])

    if (points.length === 0) return
    if (points.length === 1) {
      const [lon, lat] = points[0] as [number, number]
      this.map.easeTo({ center: [lon, lat], zoom: 14, duration: 600 })
      return
    }

    const bounds = points.reduce(
      (acc, point) => acc.extend(point),
      new maplibregl.LngLatBounds(points[0] as [number, number], points[0] as [number, number]),
    )
    this.map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 60, right: 60 }, maxZoom: 16, duration: 700 })
  }
}
