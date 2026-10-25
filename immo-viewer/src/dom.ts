type Props = {
  class?: string
  text?: string
  html?: string
  attrs?: Record<string, string | number | boolean | null | undefined>
  style?: Partial<CSSStyleDeclaration>
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>
}

type Child = Node | string | null | undefined | false

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (props.class) node.className = props.class
  if (props.text !== undefined) node.textContent = props.text
  if (props.html !== undefined) node.innerHTML = props.html
  if (props.attrs) {
    for (const [name, value] of Object.entries(props.attrs)) {
      if (value === null || value === undefined || value === false) continue
      node.setAttribute(name, value === true ? '' : String(value))
    }
  }
  if (props.style) {
    for (const [property, value] of Object.entries(props.style)) {
      if (value === undefined || value === null) continue
      // CSS custom properties need setProperty; Object.assign silently drops them.
      if (property.startsWith('--')) node.style.setProperty(property, String(value))
      else (node.style as unknown as Record<string, string>)[property] = String(value)
    }
  }
  if (props.on) {
    for (const [event, handler] of Object.entries(props.on)) {
      if (handler) node.addEventListener(event, handler as EventListener)
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function svgIcon(pathData: string, size = 16): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', pathData)
  svg.append(path)
  return svg
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined
  return ((...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }) as T
}
