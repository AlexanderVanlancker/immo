const euroFormatter = new Intl.NumberFormat('nl-BE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
})

const numberFormatter = new Intl.NumberFormat('nl-BE', { maximumFractionDigits: 0 })
const decimalFormatter = new Intl.NumberFormat('nl-BE', { maximumFractionDigits: 1 })

export function euro(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return euroFormatter.format(value)
}

/** Compact price for map pins: €475 000 → €475k. */
export function euroCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000) return `€${decimalFormatter.format(value / 1_000_000)}M`
  if (value >= 10_000) return `€${numberFormatter.format(Math.round(value / 1000))}k`
  return `€${numberFormatter.format(value)}`
}

export function euroPerSqm(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${euroFormatter.format(value)}/m²`
}

export function number(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return numberFormatter.format(value)
}

export function decimal(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return decimalFormatter.format(value)
}

export function squareMetres(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return '—'
  return `${numberFormatter.format(value)} m²`
}

export function date(value: string | null | undefined): string {
  const parsed = parseDate(value)
  if (!parsed) return '—'
  return parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function month(value: string | null | undefined): string {
  const parsed = parseDate(value)
  if (!parsed) return '—'
  return parsed.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
}

export function monthKey(value: string | null | undefined): string | null {
  const parsed = parseDate(value)
  if (!parsed) return null
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`
}

export function relativeDays(value: string | null | undefined): string {
  const parsed = parseDate(value)
  if (!parsed) return '—'
  const days = Math.round((Date.now() - parsed.getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.round(days / 30)
  if (months < 18) return `${months} month${months === 1 ? '' : 's'} ago`
  return `${Math.round(days / 365)} years ago`
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${numberFormatter.format(count)} ${count === 1 ? singular : pluralForm}`
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Media query helper so the UI can collapse on small screens. */
export function prefersNarrow(): boolean {
  return window.matchMedia('(max-width: 900px)').matches
}
