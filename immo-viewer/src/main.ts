import 'maplibre-gl/dist/maplibre-gl.css'
import './styles.css'

import { fetchListings } from './api'
import { DetailView } from './detailView'
import { debounce } from './dom'
import { activeFilterCount, computeFacets, type Facets } from './filters'
import { createFiltersView } from './filtersView'
import { createListView } from './listView'
import { MapView } from './mapView'
import { SORT_OPTIONS, Store, type SortKey } from './state'
import { createStatsView } from './statsView'
import type { AppState, ChangeReason } from './state'

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
})

const filtersView = createFiltersView(filtersRoot, {
  onChange: (patch) => store.patchFilters(patch),
  onReset: () => store.resetFilters(),
})

const statsView = createStatsView(statsRoot, {
  onSelect: (key) => selectListing(key),
})

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
    text.textContent = `${count} ${count === 1 ? 'listing' : 'listings'} · saved ${scanned}${
      errors > 0 ? ` · ${errors} archive${errors === 1 ? '' : 's'} skipped` : ''
    }`
    if (errors > 0) {
      statusNode.title = state.meta.errors.map((error) => `${error.zipFile}: ${error.message}`).join('\n')
    }
  }
  statusNode.append(text)

  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.textContent = 'Refresh'
  refresh.addEventListener('click', () => void load(true))
  statusNode.append(refresh)
}

function ensureFacets(state: AppState): void {
  const signature = state.all.map((listing) => listing.key).join('|')
  if (signature === facetSignature) return
  facetSignature = signature
  facets = computeFacets(state.all)
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
    listView.render(state.filtered, state.selectedKey, state.all.length)
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
