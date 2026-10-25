import { clear, el } from './dom'
import { epcColor } from './epc'
import { activeFilterCount, defaultFilters, FEATURE_FILTERS, type Facets, type FilterState } from './filters'

export interface FiltersViewOptions {
  onChange: (patch: Partial<FilterState>) => void
  onReset: () => void
}

export interface FiltersView {
  update(facets: Facets, filters: FilterState): void
}

interface ChipSpec {
  value: string
  label: string
  count?: number
  epc?: boolean
}

/**
 * A group of toggle chips that is only rebuilt when its item list changes, so
 * clicks do not steal focus or reset the panel's scroll position.
 */
class ChipGroup {
  private signature = ''
  private buttons = new Map<string, HTMLButtonElement>()

  constructor(
    private readonly container: HTMLElement,
    private readonly onToggle: (value: string) => void,
  ) {}

  update(items: ChipSpec[], selected: string[]): void {
    const signature = items.map((item) => `${item.value}:${item.count ?? ''}`).join('|')
    if (signature !== this.signature) {
      this.signature = signature
      this.buttons.clear()
      clear(this.container)
      for (const item of items) {
        const button = el(
          'button',
          {
            class: item.epc ? 'chip epc-chip' : 'chip',
            attrs: { type: 'button', 'aria-pressed': 'false', 'data-value': item.value },
            on: { click: () => this.onToggle(item.value) },
          },
          [
            item.epc
              ? el('span', {
                  class: 'dot',
                  style: {
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: epcColor(item.value),
                  },
                })
              : null,
            item.label,
            item.count === undefined ? null : el('span', { class: 'count', text: String(item.count) }),
          ],
        )
        if (item.epc) button.style.setProperty('--epc-color', epcColor(item.value))
        this.buttons.set(item.value, button)
        this.container.append(button)
      }
    }

    const selectedSet = new Set(selected)
    for (const [value, button] of this.buttons) {
      const active = selectedSet.has(value)
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
  }
}

export function createFiltersView(root: HTMLElement, options: FiltersViewOptions): FiltersView {
  const toggleValue = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]

  const numberField = (
    placeholder: string,
    onChange: (value: number | null) => void,
  ): HTMLInputElement => {
    const input = el('input', {
      attrs: { type: 'number', inputmode: 'numeric', placeholder, min: 0, step: 1 },
    })
    input.addEventListener('input', () => {
      const raw = input.value.trim()
      if (raw === '') {
        onChange(null)
        return
      }
      const parsed = Number(raw)
      onChange(Number.isFinite(parsed) ? parsed : null)
    })
    return input
  }

  const group = (label: string): HTMLElement => {
    const wrapper = el('div', { class: 'filter-group' })
    wrapper.append(el('span', { class: 'filter-label', text: label }))
    root.append(wrapper)
    return wrapper
  }

  // Transaction
  const transactionGroup = group('Transaction')
  const transactionChips = el('div', { class: 'chips' })
  transactionGroup.append(transactionChips)
  const transactionGroupCtl = new ChipGroup(transactionChips, (value) => {
    options.onChange({ transaction: value as FilterState['transaction'] })
  })

  // Property type
  const typeChips = el('div', { class: 'chips' })
  group('Property type').append(typeChips)
  const typeGroup = new ChipGroup(typeChips, (value) => {
    options.onChange({ types: toggleValue(currentFilters.types, value) })
  })

  // Postal code / city
  const postalChips = el('div', { class: 'chips' })
  group('Location').append(postalChips)
  const postalGroup = new ChipGroup(postalChips, (value) => {
    options.onChange({ postalCodes: toggleValue(currentFilters.postalCodes, value) })
  })

  // EPC
  const epcChips = el('div', { class: 'chips' })
  group('EPC label').append(epcChips)
  const epcGroup = new ChipGroup(epcChips, (value) => {
    options.onChange({ epc: toggleValue(currentFilters.epc, value) })
  })

  // Price
  const priceRow = el('div', { class: 'range-row' })
  const priceMin = numberField('min €', (value) => options.onChange({ priceMin: value }))
  const priceMax = numberField('max €', (value) => options.onChange({ priceMax: value }))
  priceRow.append(priceMin, el('span', { class: 'sep', text: '–' }), priceMax)
  group('Price').append(priceRow)

  // €/m²
  const sqmRow = el('div', { class: 'range-row' })
  const sqmMin = numberField('min €/m²', (value) => options.onChange({ perSqmMin: value }))
  const sqmMax = numberField('max €/m²', (value) => options.onChange({ perSqmMax: value }))
  sqmRow.append(sqmMin, el('span', { class: 'sep', text: '–' }), sqmMax)
  group('Price per m²').append(sqmRow)

  // Living area
  const livingRow = el('div', { class: 'range-row' })
  const livingMin = numberField('min m²', (value) => options.onChange({ livingMin: value }))
  const livingMax = numberField('max m²', (value) => options.onChange({ livingMax: value }))
  livingRow.append(livingMin, el('span', { class: 'sep', text: '–' }), livingMax)
  group('Living area').append(livingRow)

  // Plot + bedrooms
  const smallRow = el('div', { class: 'range-row' })
  const plotMin = numberField('plot ≥ m²', (value) => options.onChange({ plotMin: value }))
  const bedroomsMin = numberField('bedrooms ≥', (value) => options.onChange({ bedroomsMin: value }))
  smallRow.append(plotMin, bedroomsMin)
  group('Plot & bedrooms').append(smallRow)

  // Features
  const featureChips = el('div', { class: 'chips' })
  group('Must have').append(featureChips)
  const featureGroup = new ChipGroup(featureChips, (value) => {
    options.onChange({ features: toggleValue(currentFilters.features, value) })
  })

  // Sold toggle
  const soldRow = group('Status')
  const soldInput = el('input', { attrs: { type: 'checkbox', checked: true } })
  soldInput.addEventListener('change', () => options.onChange({ includeSold: soldInput.checked }))
  soldRow.append(
    el('label', { class: 'toggle-row' }, [soldInput, 'Include sold / rented listings']),
  )

  let currentFilters: FilterState = defaultFilters()

  const syncNumber = (input: HTMLInputElement, value: number | null) => {
    if (document.activeElement === input) return
    input.value = value === null ? '' : String(value)
  }

  return {
    update(facets: Facets, filters: FilterState) {
      currentFilters = filters
      transactionGroupCtl.update(
        [
          { value: 'all', label: 'All' },
          { value: 'for-sale', label: 'For sale' },
          { value: 'for-rent', label: 'For rent' },
        ],
        [filters.transaction],
      )
      typeGroup.update(
        facets.types.map((item) => ({ value: item.value, label: item.label, count: item.count })),
        filters.types,
      )
      postalGroup.update(
        facets.postalCodes.map((item) => ({
          value: item.value,
          label: `${item.value} ${item.label}`.replace(/\s+/g, ' ').trim(),
          count: item.count,
        })),
        filters.postalCodes,
      )
      epcGroup.update(
        facets.epc.map((item) => ({ value: item.value, label: item.value, count: item.count, epc: true })),
        filters.epc,
      )
      featureGroup.update(
        FEATURE_FILTERS.map((feature) => ({ value: feature.id, label: feature.label })),
        filters.features,
      )

      syncNumber(priceMin, filters.priceMin)
      syncNumber(priceMax, filters.priceMax)
      syncNumber(sqmMin, filters.perSqmMin)
      syncNumber(sqmMax, filters.perSqmMax)
      syncNumber(livingMin, filters.livingMin)
      syncNumber(livingMax, filters.livingMax)
      syncNumber(plotMin, filters.plotMin)
      syncNumber(bedroomsMin, filters.bedroomsMin)

      if (document.activeElement !== soldInput) soldInput.checked = filters.includeSold

      const activeCount = activeFilterCount(filters)
      root.dataset.activeCount = String(activeCount)
    },
  }
}
