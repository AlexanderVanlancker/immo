import 'maplibre-gl/dist/maplibre-gl.css'
import './styles.css'

import { fetchListings, saveLocation } from './api'
import { DetailView } from './detailView'
import { debounce } from './dom'
import { activeFilterCount, computeFacets, describeFilters, filtersToHash, type Facets } from './filters'
import { createFiltersView } from './filtersView'
import { createListView } from './listView'
import { reverseGeocode, type GeocodeResult } from './geocode'
import { MapView } from './mapView'
import { SORT_OPTIONS, Store, type SortKey } from './state'
import { createStatsView } from './statsView'
import type { AppState, ChangeReason } from './state'
import type { Listing } from './types'

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing element #${id}`)
  return node as T
}

const searchInput = $<HTMLInputElement>('search')
const sortSelect = $<HTMLSelectElement>('sort')
const statusNode = $('status')
const filtersRoot = $('filters')
const filtersToggle = $('filters-toggle')
const filterBadge = $('filter-badge')
const clearButton = $<HTMLButtonElement>('clear-filters')
const resultsRoot = $('results')
const resultCount = $('result-count')
const statsRoot = $('stats')
const detailRoot = $('detail')
const pickerNode = $('picker')
const pickerTitle = $('picker-title')
const pickerHint = $('picker-hint')
const pickerSave = $<HTMLButtonElement>('picker-save')
const pickerCancel = $<HTMLButtonElement>('picker-cancel')
const toastNode = $('toast')
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab')]

const store = new Store()

let facets: Facets = { sources: [], types: [], epc: [], postalCodes: [], prices: { min: 0, max: 0 }, living: { min: 0, max: 0 } }
let facetSignature = ''
let lastFetch = 0

const listView = createListView(resultsRoot, {
  onSelect: (key) => selectListing(key),
  onHover: (key) => {
    mapView.setHover(key)
    listView.setHover(key)
  },
})

const mapView = new MapView($('map'), {
  onSelect: (key) => selectListing(key),
  onHover: (key) => {
    mapView.setHover(key)
    listView.setHover(key)
  },
})

const detailView = new DetailView(detailRoot, {
  onClose: () => store.select(null),
  onLocate: (listing) => startLocating(listing),
})

const filtersView = createFiltersView(filtersRoot, {
  onChange: (patch) => store.patchFilters(patch),
  onReset: () => store.resetFilters(),
})

const statsView = createStatsView(statsRoot, {
  onSelect: (key) => selectListing(key),
})

/* ------------------------------------------------------------------ *
 * Placing a listing on the map (writes info.json inside the archive)
 * ------------------------------------------------------------------ */

interface PendingPin {
  listing: Listing
  lat: number
  lon: number
  geocode: GeocodeResult | null
}

let pendingPin: PendingPin | null = null
/** The listing being located, so cancelling can reopen its panel. */
let pickListing: Listing | null = null
let toastTimer: number | undefined

function showToast(message: string, isError = false): void {
  toastNode.textContent = message
  toastNode.classList.toggle('is-error', isError)
  toastNode.hidden = false
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastNode.hidden = true
  }, isError ? 8000 : 4000)
}

function startLocating(listing: Listing): void {
  pickListing = listing
  store.setView('map')
  // Get the detail panel out of the way: it covers a third of the map, and every
  // click there is a click that cannot place the pin.
  store.select(null)
  pendingPin = null
  mapView.clearDraft()
  mapView.beginPick((point) => {
    void handlePick(listing, point.lat, point.lon)
  })
  pickerNode.hidden = false
  pickerSave.hidden = true
  pickerSave.disabled = true
  pickerTitle.textContent = `Where is ${listing.address.label}?`
  pickerHint.textContent = 'Click on the map to drop a pin · Esc to cancel'
}

async function handlePick(listing: Listing, lat: number, lon: number): Promise<void> {
  pendingPin = { listing, lat, lon, geocode: null }
  mapView.showDraft({ lat, lon }, 'New pin')
  pickerHint.textContent = 'Looking up the address…'
  pickerSave.hidden = true

  const geocode = await reverseGeocode(lat, lon)
  // Cancelled, or another spot picked, while the lookup was in flight.
  if (!pendingPin || pendingPin.lat !== lat || pendingPin.lon !== lon) return
  pendingPin.geocode = geocode

  const label = geocode.label ?? `${lat.toFixed(5)}, ${lon.toFixed(5)}`
  mapView.showDraft({ lat, lon }, label)
  pickerHint.textContent = geocode.label
    ? 'Save this location, or click elsewhere to adjust.'
    : 'No address found for this spot — the coordinates are still saved.'
  pickerSave.hidden = false
  pickerSave.disabled = false
}

async function savePendingPin(): Promise<void> {
  const pending = pendingPin
  if (!pending) return
  pickerSave.disabled = true
  pickerHint.textContent = 'Writing the coordinates into info.json…'
  try {
    await saveLocation(pending.listing, {
      lat: pending.lat,
      lon: pending.lon,
      label: pending.geocode?.label ?? null,
      street: pending.geocode?.street ?? null,
      houseNumber: pending.geocode?.houseNumber ?? null,
      postalCode: pending.geocode?.postalCode ?? null,
      city: pending.geocode?.city ?? null,
    })
    const key = pending.listing.key
    const folder = pending.listing.folder
    pendingPin = null
    pickListing = null
    mapView.clearDraft()
    mapView.endPick()
    pickerNode.hidden = true
    await load(false)
    store.select(key)
    mapView.flyTo(key)
    showToast(`Location saved in ${folder}/info.json`)
  } catch (error) {
    pickerSave.disabled = false
    pickerHint.textContent = 'Could not save — check the terminal and try again.'
    showToast((error as Error).message, true)
  }
}

function cancelLocating(): void {
  const restore = pickListing
  pickListing = null
  pendingPin = null
  mapView.endPick()
  mapView.clearDraft()
  pickerNode.hidden = true
  pickerSave.hidden = true
  if (restore) store.select(restore.key)
}

pickerSave.addEventListener('click', () => void savePendingPin())
pickerCancel.addEventListener('click', () => cancelLocating())

function selectListing(key: string): void {
  store.select(key)
  listView.scrollTo(key)
  mapView.flyTo(key)
}

for (const option of SORT_OPTIONS) {
  sortSelect.append(new Option(option.label, option.value))
}
sortSelect.value = 'address'
sortSelect.addEventListener('change', () => {
  store.setSort(sortSelect.value as SortKey)
})

searchInput.addEventListener('input', debounce(() => store.patchFilters({ query: searchInput.value }), 120))

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const view = tab.dataset.view
    if (view === 'map' || view === 'stats') store.setView(view)
  })
})

filtersToggle.addEventListener('click', () => {
  const collapsed = filtersToggle.getAttribute('aria-expanded') === 'true'
  filtersToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
  filtersRoot.hidden = collapsed
})

clearButton.addEventListener('click', () => {
  searchInput.value = ''
  store.resetFilters()
})

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement

  if (event.key === '/' && !typing) {
    event.preventDefault()
    searchInput.focus()
    searchInput.select()
    return
  }
  if (event.key === 'Escape') {
    if (typing) {
      searchInput.blur()
      return
    }
    if (!pickerNode.hidden) {
      cancelLocating()
      return
    }
    if (detailView.isOpen) {
      detailView.close()
      return
    }
    if (searchInput.value) {
      searchInput.value = ''
      store.patchFilters({ query: '' })
    }
    return
  }
  if (typing) return

  if (detailView.isOpen) {
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      detailView.nextPhoto()
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      detailView.prevPhoto()
    }
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'j') {
    event.preventDefault()
    store.stepSelection(1)
  } else if (event.key === 'ArrowUp' || event.key === 'k') {
    event.preventDefault()
    store.stepSelection(-1)
  }
})

window.addEventListener('resize', debounce(() => mapView.resize(), 120))

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastFetch > 30_000) {
    void load(false)
  }
})

function setStatus(state: AppState): void {
  statusNode.replaceChildren()
  statusNode.classList.toggle('is-error', state.status === 'error')

  const dot = document.createElement('span')
  dot.className = 'dot'
  statusNode.append(dot)

  const text = document.createElement('span')
  if (state.status === 'loading') {
    text.textContent = 'Loading listings…'
  } else if (state.status === 'error') {
    text.textContent = state.error ?? 'Could not load listings'
  } else if (state.meta) {
    const count = state.all.length
    const errors = state.meta.errors.length
    const scanned = new Date(state.meta.scannedAt).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    })
    const imported = state.meta.imported?.imported.length ?? 0
    text.textContent = `${count} ${count === 1 ? 'listing' : 'listings'} · saved ${scanned}${
      imported > 0 ? ` · imported ${imported} archive${imported === 1 ? '' : 's'}` : ''
    }${errors > 0 ? ` · ${errors} folder${errors === 1 ? '' : 's'} skipped` : ''}`
    if (errors > 0) {
      statusNode.title = state.meta.errors.map((error) => `${error.folder}: ${error.message}`).join('\n')
    }
  }
  statusNode.append(text)

  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.textContent = 'Refresh'
  refresh.addEventListener('click', () => void load(true))
  statusNode.append(refresh)
}

/** Chip counts depend on the active filters, so the cache key includes them. */
function ensureFacets(state: AppState): void {
  const signature = `${state.all.map((listing) => listing.key).join('|')}#${filtersToHash(state.filters)}`
  if (signature === facetSignature) return
  facetSignature = signature
  facets = computeFacets(state.all, state.filters)
}

function render(state: AppState, reason: ChangeReason): void {
  ensureFacets(state)

  if (reason === 'data' || reason === 'filters' || reason === 'sort' || reason === 'status') {
    filtersView.update(facets, state.filters)
    const active = activeFilterCount(state.filters)
    filterBadge.hidden = active === 0
    filterBadge.textContent = String(active)
    clearButton.hidden = active === 0
    resultCount.textContent =
      state.all.length === 0
        ? 'No listings'
        : `${state.filtered.length} of ${state.all.length} listing${state.all.length === 1 ? '' : 's'}`
    if (searchInput.value !== state.filters.query && document.activeElement !== searchInput) {
      searchInput.value = state.filters.query
    }
    listView.render(state.filtered, state.selectedKey, state.all.length, {
      activeFilters: describeFilters(state.filters),
      onClearFilters: () => store.resetFilters(),
    })
    mapView.update(state.filtered, state.selectedKey)
    if (state.view === 'stats') statsView.render(state.filtered, state.all.length)
  }

  if (reason === 'selection' || reason === 'data' || reason === 'filters') {
    listView.setSelected(state.selectedKey)
    mapView.setActive(state.selectedKey)
    detailView.render(store.selected)
    if (reason === 'selection' && state.selectedKey) mapView.flyTo(state.selectedKey)
  }

  if (reason === 'view' || reason === 'data' || reason === 'filters') {
    const showStats = state.view === 'stats'
    statsRoot.hidden = !showStats
    for (const tab of tabs) {
      const active = tab.dataset.view === state.view
      tab.classList.toggle('is-active', active)
      tab.setAttribute('aria-selected', active ? 'true' : 'false')
    }
    if (showStats) statsView.render(state.filtered, state.all.length)
    else mapView.resize()
  }

  if (reason === 'data' || reason === 'status') setStatus(state)

  if (reason === 'data' && state.error) {
    // Surface archive-level problems without blocking the page.
    console.warn('[immo-viewer]', state.error)
  }
}

store.subscribe((state, reason) => render(state, reason))

async function load(showSpinner: boolean): Promise<void> {
  if (showSpinner) store.setLoading()
  try {
    const response = await fetchListings()
    lastFetch = Date.now()
    store.setListings(response.listings, {
      scannedAt: response.scannedAt,
      sourceDir: response.sourceDir,
      errors: response.errors,
      imported: response.imported,
    })
    if (response.errors.length > 0) {
      console.warn('[immo-viewer] archives skipped:', response.errors)
    }
  } catch (error) {
    store.setError((error as Error).message)
  }
}

void load(true)

// Expose the store for quick debugging in the console.
Object.defineProperty(window, 'immoViewer', { value: { store, listingCount: () => store.snapshot.all.length } })
