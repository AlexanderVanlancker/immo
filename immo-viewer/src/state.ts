import {
  applyFilters,
  defaultFilters,
  filtersFromHash,
  filtersToHash,
  type FilterState,
} from './filters'
import type { ImportReport, Listing, ScanError } from './types'

export type SortKey =
  | 'price-asc'
  | 'price-desc'
  | 'perSqm-asc'
  | 'perSqm-desc'
  | 'living-desc'
  | 'living-asc'
  | 'newest'
  | 'oldest'
  | 'address'

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'address', label: 'Address A–Z' },
  { value: 'price-asc', label: 'Price: low → high' },
  { value: 'price-desc', label: 'Price: high → low' },
  { value: 'perSqm-asc', label: '€/m²: low → high' },
  { value: 'perSqm-desc', label: '€/m²: high → low' },
  { value: 'living-desc', label: 'Living area: large → small' },
  { value: 'living-asc', label: 'Living area: small → large' },
  { value: 'newest', label: 'Newest listing first' },
  { value: 'oldest', label: 'Oldest listing first' },
]

export type View = 'map' | 'stats'

export type ChangeReason = 'data' | 'filters' | 'sort' | 'selection' | 'view' | 'status'

export interface AppState {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  /** Everything found on disk. */
  all: Listing[]
  /** `all` after filters and sorting. */
  filtered: Listing[]
  selectedKey: string | null
  sort: SortKey
  view: View
  filters: FilterState
  meta: {
    scannedAt: string
    sourceDir: string
    errors: ScanError[]
    imported?: ImportReport | null
  } | null
}

type Listener = (state: AppState, reason: ChangeReason) => void

function sortListings(listings: Listing[], sort: SortKey): Listing[] {
  const clone = [...listings]
  const num = (value: number | null) => (value === null ? Number.POSITIVE_INFINITY : value)
  const desc = (value: number | null) => (value === null ? Number.NEGATIVE_INFINITY : value)
  const time = (value: string | null) => {
    if (!value) return 0
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }

  switch (sort) {
    case 'price-asc':
      return clone.sort((a, b) => num(a.price.value) - num(b.price.value))
    case 'price-desc':
      return clone.sort((a, b) => desc(b.price.value) - desc(a.price.value))
    case 'perSqm-asc':
      return clone.sort((a, b) => num(a.price.perSqm) - num(b.price.perSqm))
    case 'perSqm-desc':
      return clone.sort((a, b) => desc(b.price.perSqm) - desc(a.price.perSqm))
    case 'living-desc':
      return clone.sort((a, b) => desc(b.area.living) - desc(a.area.living))
    case 'living-asc':
      return clone.sort((a, b) => num(a.area.living) - num(b.area.living))
    case 'newest':
      return clone.sort((a, b) => time(b.publishedAt ?? b.capturedAt) - time(a.publishedAt ?? a.capturedAt))
    case 'oldest':
      return clone.sort((a, b) => time(a.publishedAt ?? a.capturedAt) - time(b.publishedAt ?? b.capturedAt))
    case 'address':
    default:
      return clone.sort((a, b) => a.address.label.localeCompare(b.address.label, 'nl'))
  }
}

export class Store {
  private state: AppState
  private listeners = new Set<Listener>()

  constructor() {
    let filters = defaultFilters()
    try {
      filters = filtersFromHash(window.location.hash)
    } catch {
      filters = defaultFilters()
    }
    this.state = {
      status: 'loading',
      error: null,
      all: [],
      filtered: [],
      selectedKey: null,
      sort: 'address',
      view: 'map',
      filters,
      meta: null,
    }
  }

  /** Read-only view of the current state. */
  get snapshot(): AppState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setListings(
    listings: Listing[],
    meta: { scannedAt: string; sourceDir: string; errors: ScanError[]; imported?: ImportReport | null },
  ): void {
    this.state = {
      ...this.state,
      status: 'ready',
      error: null,
      all: listings,
      filtered: sortListings(applyFilters(listings, this.state.filters), this.state.sort),
      meta,
    }
    if (this.state.selectedKey && !this.state.all.some((l) => l.key === this.state.selectedKey)) {
      this.state = { ...this.state, selectedKey: null }
    }
    this.emit('data')
  }

  setError(message: string): void {
    this.state = { ...this.state, status: 'error', error: message }
    this.emit('status')
  }

  setLoading(): void {
    this.state = { ...this.state, status: 'loading', error: null }
    this.emit('status')
  }

  patchFilters(patch: Partial<FilterState>): void {
    const filters = { ...this.state.filters, ...patch }
    this.state = {
      ...this.state,
      filters,
      filtered: sortListings(applyFilters(this.state.all, filters), this.state.sort),
      selectedKey:
        this.state.selectedKey && applyFilters(this.state.all, filters).some((l) => l.key === this.state.selectedKey)
          ? this.state.selectedKey
          : null,
    }
    this.syncHash()
    this.emit('filters')
  }

  resetFilters(): void {
    this.patchFilters(defaultFilters())
  }

  setSort(sort: SortKey): void {
    this.state = {
      ...this.state,
      sort,
      filtered: sortListings(this.state.filtered, sort),
    }
    this.emit('sort')
  }

  setView(view: View): void {
    if (this.state.view === view) return
    this.state = { ...this.state, view }
    this.emit('view')
  }

  select(key: string | null, reason: ChangeReason = 'selection'): void {
    if (this.state.selectedKey === key) return
    this.state = { ...this.state, selectedKey: key }
    this.emit(reason)
  }

  /** Move the selection up/down the filtered list; used by the keyboard shortcuts. */
  stepSelection(offset: number): void {
    const { filtered, selectedKey } = this.state
    if (filtered.length === 0) return
    const current = selectedKey ? filtered.findIndex((listing) => listing.key === selectedKey) : -1
    const next = current === -1 ? (offset > 0 ? 0 : filtered.length - 1) : current + offset
    const clamped = Math.max(0, Math.min(filtered.length - 1, next))
    const target = filtered[clamped]
    if (target) this.select(target.key)
  }

  get selected(): Listing | null {
    if (!this.state.selectedKey) return null
    return this.state.all.find((listing) => listing.key === this.state.selectedKey) ?? null
  }

  private syncHash(): void {
    const hash = filtersToHash(this.state.filters)
    const url = `${window.location.pathname}${hash ? `#${hash}` : ''}`
    window.history.replaceState(null, '', url)
  }

  private emit(reason: ChangeReason): void {
    for (const listener of this.listeners) listener(this.state, reason)
  }
}
