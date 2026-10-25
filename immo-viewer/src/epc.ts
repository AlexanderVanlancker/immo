/** EPC label colours, green (A+) through red (G), following the Flemish scale. */
const EPC_COLORS: Record<string, string> = {
  'A+': '#0b7a43',
  A: '#1a9e4b',
  B: '#63b344',
  C: '#c2ac2b',
  D: '#e0912c',
  E: '#dd7030',
  F: '#cf4b41',
  G: '#a82f2f',
}

export function epcColor(label: string | null | undefined): string {
  if (!label) return '#8b93a1'
  return EPC_COLORS[label.toUpperCase()] ?? '#8b93a1'
}

export function hasEpc(label: string | null | undefined): label is string {
  return Boolean(label) && label !== 'null'
}
