/**
 * Hand-rolled SVG charts — no charting dependency, no canvas, and they scale
 * crisply because everything is drawn in a viewBox.
 */
import { escapeHtml } from './dom'

export interface BarDatum {
  label: string
  value: number | null
  count: number
  color?: string
}

export interface ScatterDatum {
  x: number
  y: number
  label: string
  key?: string
  title?: string
}

interface Axis {
  min: number
  max: number
  ticks: number[]
}

function niceAxis(min: number, max: number, tickCount = 4): Axis {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1
    min -= pad
    max += pad
  }
  const range = max - min
  const rough = range / tickCount
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude
  const axisMin = Math.floor(min / step) * step
  const axisMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let value = axisMin; value <= axisMax + step / 2; value += step) ticks.push(Number(value.toFixed(6)))
  return { min: axisMin, max: axisMax, ticks }
}

function wrapSvg(width: number, height: number, body: string, label: string): string {
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(label)}">${body}</svg>`
}

const PAD = { top: 16, right: 14, bottom: 40, left: 56 }

export function barChart(
  data: BarDatum[],
  options: { format: (value: number) => string; label: string; height?: number },
): string {
  const width = 640
  const height = options.height ?? 230
  const usable = data.filter((datum) => datum.value !== null) as (BarDatum & { value: number })[]
  if (usable.length === 0) return emptyChart(width, height, 'Not enough data yet')

  const axis = niceAxis(0, Math.max(...usable.map((datum) => datum.value)))
  const plotWidth = width - PAD.left - PAD.right
  const plotHeight = height - PAD.top - PAD.bottom
  const slot = plotWidth / usable.length
  const barWidth = Math.min(46, slot * 0.62)
  const rotate = usable.length > 7

  const y = (value: number) =>
    PAD.top + plotHeight - ((value - axis.min) / (axis.max - axis.min)) * plotHeight

  const grid = axis.ticks
    .map(
      (tick) =>
        `<line class="grid-line" x1="${PAD.left}" x2="${width - PAD.right}" y1="${y(tick)}" y2="${y(tick)}"/>` +
        `<text x="${PAD.left - 8}" y="${y(tick) + 3.5}" text-anchor="end">${escapeHtml(options.format(tick))}</text>`,
    )
    .join('')

  const bars = usable
    .map((datum, index) => {
      const centerX = PAD.left + slot * index + slot / 2
      const top = y(datum.value)
      const barHeight = Math.max(1, PAD.top + plotHeight - top)
      const fill = datum.color ? ` style="fill:${datum.color}"` : ''
      const labelY = rotate ? PAD.top + plotHeight + 14 : PAD.top + plotHeight + 16
      const label = `<text x="${centerX}" y="${labelY}" text-anchor="${rotate ? 'end' : 'middle'}"${
        rotate ? ` transform="rotate(-38 ${centerX} ${labelY})"` : ''
      }>${escapeHtml(datum.label)}</text>`
      return (
        `<g><title>${escapeHtml(`${datum.label}: ${options.format(datum.value)} (${datum.count})`)}</title>` +
        `<rect class="bar" x="${centerX - barWidth / 2}" y="${top}" width="${barWidth}" height="${barHeight}"${fill}/>` +
        `<text class="value-label" x="${centerX}" y="${top - 5}" text-anchor="middle">${escapeHtml(options.format(datum.value))}</text>` +
        `${label}</g>`
      )
    })
    .join('')

  const axisLine = `<line class="axis-line" x1="${PAD.left}" x2="${width - PAD.right}" y1="${PAD.top + plotHeight}" y2="${PAD.top + plotHeight}"/>`
  return wrapSvg(width, height, grid + axisLine + bars, options.label)
}

export function scatterChart(
  points: ScatterDatum[],
  options: {
    formatX: (value: number) => string
    formatY: (value: number) => string
    xLabel: string
    yLabel: string
    trend?: { slope: number; intercept: number } | null
    height?: number
  },
): string {
  const width = 760
  const height = options.height ?? 300
  if (points.length === 0) return emptyChart(width, height, 'No sale listings with both a price and a living area')

  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const axisX = niceAxis(Math.min(...xs) * 0.94, Math.max(...xs) * 1.06, 5)
  const axisY = niceAxis(Math.min(...ys) * 0.94, Math.max(...ys) * 1.06, 5)
  const plotWidth = width - PAD.left - PAD.right
  const plotHeight = height - PAD.top - PAD.bottom

  const px = (value: number) => PAD.left + ((value - axisX.min) / (axisX.max - axisX.min)) * plotWidth
  const py = (value: number) => PAD.top + plotHeight - ((value - axisY.min) / (axisY.max - axisY.min)) * plotHeight

  const grid =
    axisY.ticks
      .map(
        (tick) =>
          `<line class="grid-line" x1="${PAD.left}" x2="${width - PAD.right}" y1="${py(tick)}" y2="${py(tick)}"/>` +
          `<text x="${PAD.left - 8}" y="${py(tick) + 3.5}" text-anchor="end">${escapeHtml(options.formatY(tick))}</text>`,
      )
      .join('') +
    axisX.ticks
      .map(
        (tick) =>
          `<text x="${px(tick)}" y="${PAD.top + plotHeight + 16}" text-anchor="middle">${escapeHtml(options.formatX(tick))}</text>`,
      )
      .join('')

  const trend = options.trend
    ? (() => {
        const yAt = (x: number) => options.trend!.slope * x + options.trend!.intercept
        const x1 = axisX.min
        const x2 = axisX.max
        return `<line class="trend" x1="${px(x1)}" y1="${py(yAt(x1))}" x2="${px(x2)}" y2="${py(yAt(x2))}"/>`
      })()
    : ''

  const dots = points
    .map((point) => {
      const attributes = point.key ? ` data-key="${escapeHtml(point.key)}"` : ''
      const title = point.title ?? `${point.label}: ${options.formatY(point.y)} · ${options.formatX(point.x)}`
      return `<circle class="dot" cx="${px(point.x)}" cy="${py(point.y)}" r="5.5"${attributes}><title>${escapeHtml(title)}</title></circle>`
    })
    .join('')

  const axisLines =
    `<line class="axis-line" x1="${PAD.left}" x2="${width - PAD.right}" y1="${PAD.top + plotHeight}" y2="${PAD.top + plotHeight}"/>` +
    `<line class="axis-line" x1="${PAD.left}" x2="${PAD.left}" y1="${PAD.top}" y2="${PAD.top + plotHeight}"/>`

  const axisLabels =
    `<text x="${PAD.left + plotWidth / 2}" y="${height - 4}" text-anchor="middle">${escapeHtml(options.xLabel)}</text>` +
    `<text x="12" y="${PAD.top + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 12 ${PAD.top + plotHeight / 2})">${escapeHtml(options.yLabel)}</text>`

  return wrapSvg(width, height, grid + axisLines + trend + dots + axisLabels, `${options.yLabel} by ${options.xLabel}`)
}

export function lineChart(
  points: { label: string; value: number | null; count: number }[],
  options: { format: (value: number) => string; label: string; height?: number },
): string {
  const width = 760
  const height = options.height ?? 240
  const values = points.map((point) => point.value).filter((value): value is number => value !== null)
  if (values.length === 0) return emptyChart(width, height, 'No dated listings yet')

  const axis = niceAxis(Math.min(...values) * 0.96, Math.max(...values) * 1.04, 4)
  const plotWidth = width - PAD.left - PAD.right
  const plotHeight = height - PAD.top - PAD.bottom
  const stepX = points.length > 1 ? plotWidth / (points.length - 1) : 0

  const px = (index: number) => (points.length > 1 ? PAD.left + index * stepX : PAD.left + plotWidth / 2)
  const py = (value: number) => PAD.top + plotHeight - ((value - axis.min) / (axis.max - axis.min)) * plotHeight

  const grid = axis.ticks
    .map(
      (tick) =>
        `<line class="grid-line" x1="${PAD.left}" x2="${width - PAD.right}" y1="${py(tick)}" y2="${py(tick)}"/>` +
        `<text x="${PAD.left - 8}" y="${py(tick) + 3.5}" text-anchor="end">${escapeHtml(options.format(tick))}</text>`,
    )
    .join('')

  const segments: string[] = []
  let current: string[] = []
  points.forEach((point, index) => {
    if (point.value === null) {
      if (current.length > 1) segments.push(current.join(' '))
      current = []
      return
    }
    current.push(`${px(index)},${py(point.value)}`)
  })
  if (current.length > 1) segments.push(current.join(' '))

  const lines = segments
    .map((segment) => `<polyline class="line" points="${segment}"/>`)
    .join('')

  const dots = points
    .map((point, index) =>
      point.value === null
        ? ''
        : `<circle class="dot" cx="${px(index)}" cy="${py(point.value)}" r="4.5"><title>${escapeHtml(
            `${point.label}: ${options.format(point.value)} (${point.count})`,
          )}</title></circle>` +
          `<text class="value-label" x="${px(index)}" y="${py(point.value) - 10}" text-anchor="middle">${escapeHtml(
            options.format(point.value),
          )}</text>`,
    )
    .join('')

  const xLabels = points
    .map(
      (point, index) =>
        `<text x="${px(index)}" y="${PAD.top + plotHeight + 16}" text-anchor="middle">${escapeHtml(point.label)}</text>`,
    )
    .join('')

  const axisLine = `<line class="axis-line" x1="${PAD.left}" x2="${width - PAD.right}" y1="${PAD.top + plotHeight}" y2="${PAD.top + plotHeight}"/>`
  return wrapSvg(width, height, grid + axisLine + lines + dots + xLabels, options.label)
}

function emptyChart(width: number, height: number, message: string): string {
  return wrapSvg(
    width,
    height,
    `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" style="font-size:12.5px">${escapeHtml(message)}</text>`,
    message,
  )
}
