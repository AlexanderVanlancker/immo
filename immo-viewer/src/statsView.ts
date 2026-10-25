import { barChart, lineChart, scatterChart } from './charts'
import { clear, el } from './dom'
import { epcColor } from './epc'
import { euro, euroPerSqm, number, plural, squareMetres } from './format'
import { computeStats } from './stats'
import type { Listing } from './types'

export interface StatsViewOptions {
  onSelect: (key: string) => void
}

export interface StatsView {
  render(listings: Listing[], totalCount: number): void
}

export function createStatsView(container: HTMLElement, options: StatsViewOptions): StatsView {
  const panel = (
    title: string,
    subtitle: string,
    svg: string,
    wide = false,
  ): HTMLElement => {
    const wrapper = el('div', { class: wide ? 'panel wide' : 'panel' }, [
      el('h3', { text: title }),
      el('p', { class: 'panel-sub', text: subtitle }),
    ])
    const chartHost = el('div')
    chartHost.innerHTML = svg
    wrapper.append(chartHost)
    return wrapper
  }

  const kpi = (label: string, value: string, sub?: string): HTMLElement =>
    el('dl', { class: 'kpi' }, [
      el('dt', { text: label }),
      el('dd', {}, [value, sub ? el('span', { class: 'sub', text: sub }) : null]),
    ])

  return {
    render(listings, totalCount) {
      const computed = computeStats(listings)
      const scrollTop = container.scrollTop
      clear(container)

      container.append(
        el('div', { class: 'stats-head' }, [
          el('div', {}, [
            el('h2', { text: 'Market overview' }),
            el('p', {
              text:
                listings.length === totalCount
                  ? `${plural(listings.length, 'saved listing')}`
                  : `${listings.length} of ${plural(totalCount, 'saved listing')} (filters applied)`,
            }),
          ]),
        ]),
      )

      const saleCount = computed.saleCount
      const rentCount = computed.rentCount
      container.append(
        el('div', { class: 'kpis' }, [
          kpi(
            'Listings',
            number(computed.count),
            rentCount > 0 ? `${saleCount} for sale · ${rentCount} for rent` : `${saleCount} for sale`,
          ),
          kpi(
            'Median price',
            euro(computed.medianPrice),
            computed.priceRange
              ? `${euro(computed.priceRange.min)} – ${euro(computed.priceRange.max)}`
              : undefined,
          ),
          kpi(
            'Median €/m²',
            euroPerSqm(computed.medianPerSqm),
            computed.perSqmRange
              ? `${euro(computed.perSqmRange.min)} – ${euro(computed.perSqmRange.max)}`
              : undefined,
          ),
          kpi('Median living area', squareMetres(computed.medianLiving)),
          kpi(
            'On the map',
            `${number(computed.withCoordinates)} / ${number(computed.count)}`,
            computed.withCoordinates < computed.count ? 'Missing coordinates' : 'All geocoded',
          ),
        ]),
      )

      const grid = el('div', { class: 'chart-grid' })

      const trendNote = computed.trend
        ? `Trend line: roughly ${euro(Math.round(computed.trend.slope))} more per extra m² of living space.`
        : 'Add more sale listings to get a trend line.'
      grid.append(
        panel(
          'Price vs living area',
          `${plural(computed.scatter.length, 'sale listing')} with both a price and a living area. ${trendNote}`,
          scatterChart(
            computed.scatter.map((point) => ({
              x: point.living,
              y: point.price,
              label: point.label,
              key: point.key,
              title: `${point.label} — ${euro(point.price)} · ${squareMetres(point.living)}${
                point.perSqm ? ` · ${euroPerSqm(point.perSqm)}` : ''
              }`,
            })),
            {
              formatX: (value) => `${Math.round(value)}`,
              formatY: (value) => euro(value),
              xLabel: 'Living area (m²)',
              yLabel: 'Asking price',
              trend: computed.trend,
            },
          ),
          true,
        ),
      )

      grid.append(
        panel(
          'Median €/m² by EPC label',
          'What an energy label is worth per square metre.',
          barChart(
            computed.byEpc.map((bucket) => ({
              label: bucket.label,
              value: bucket.medianPerSqm,
              count: bucket.count,
              color: epcColor(bucket.label),
            })),
            { format: (value) => euro(value), label: 'Median price per square metre by EPC label' },
          ),
        ),
      )

      grid.append(
        panel(
          'Median €/m² by postal code',
          'Compare neighbourhoods at a glance.',
          barChart(
            computed.byPostalCode.map((bucket) => ({
              label: bucket.label,
              value: bucket.medianPerSqm,
              count: bucket.count,
            })),
            { format: (value) => euro(value), label: 'Median price per square metre by postal code' },
          ),
        ),
      )

      const evolutionNote =
        computed.timeline.length > 1
          ? `Median €/m² per month of publication, ${computed.timeline[0]?.label} → ${computed.timeline.at(-1)?.label}.`
          : 'Everything saved so far was published in the same month, so there is no curve yet — save more listings over time.'
      grid.append(
        panel(
          'Price per m² over time',
          evolutionNote,
          lineChart(
            computed.timeline.map((point) => ({
              label: point.label,
              value: point.medianPerSqm,
              count: point.count,
            })),
            { format: (value) => euro(value), label: 'Median price per square metre over time' },
          ),
          true,
        ),
      )

      grid.append(
        panel(
          'Median €/m² by bedrooms',
          'Does an extra bedroom pay off per m²?',
          barChart(
            computed.byBedrooms.map((bucket) => ({
              label: bucket.label,
              value: bucket.medianPerSqm,
              count: bucket.count,
            })),
            { format: (value) => euro(value), label: 'Median price per square metre by bedroom count' },
          ),
        ),
      )

      grid.append(
        panel(
          'Median price by property type',
          'Houses versus apartments in this selection.',
          barChart(
            computed.byType.map((bucket) => ({
              label: bucket.label,
              value: bucket.medianPrice,
              count: bucket.count,
            })),
            { format: (value) => euro(value), label: 'Median price by property type' },
          ),
        ),
      )

      container.append(grid)

      if (computed.notes.length > 0) {
        container.append(
          el(
            'div',
            { class: 'stats-notes' },
            computed.notes.map((note) => el('p', { class: 'notice', text: note })),
          ),
        )
      }

      for (const dot of container.querySelectorAll<SVGCircleElement>('.dot[data-key]')) {
        dot.addEventListener('click', () => {
          const key = dot.dataset.key
          if (key) options.onSelect(key)
        })
      }

      container.scrollTop = scrollTop
    },
  }
}
