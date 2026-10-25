import { archiveUrl, floorPlanUrl, photoUrl } from './api'
import { clear, el, svgIcon } from './dom'
import { epcColor } from './epc'
import { date, euro, euroPerSqm, number, plural, relativeDays, squareMetres } from './format'
import type { Listing } from './types'

export interface DetailViewOptions {
  onClose: () => void
  onLocate?: (listing: Listing) => void
}

const FEATURE_LABELS: Record<string, string> = {
  lift: 'Lift',
  garden: 'Garden',
  terrace: 'Terrace',
  swimmingPool: 'Swimming pool',
  airConditioning: 'Air conditioning',
  basement: 'Basement',
  dressingRoom: 'Dressing room',
  livingRoom: 'Living room',
  laundryRoom: 'Laundry room',
  fireplace: 'Fireplace',
  disabledAccess: 'Disabled access',
  caretaker: 'Caretaker',
  sauna: 'Sauna',
  jacuzzi: 'Jacuzzi',
  hammam: 'Hammam',
  alarm: 'Alarm',
  visiophone: 'Video phone',
  doorPhone: 'Door phone',
  internet: 'Internet',
  cableTv: 'Cable TV',
  armoredDoor: 'Armoured door',
  homeOffice: 'Home office',
}

const CLOSE_ICON = 'M6 6l12 12M18 6L6 18'
const PREV_ICON = 'M15 5l-7 7 7 7'
const NEXT_ICON = 'M9 5l7 7-7 7'
const EXTERNAL_ICON = 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'
const DOWNLOAD_ICON = 'M12 3v12M7 11l5 5 5-5M5 20h14'

export class DetailView {
  private listing: Listing | null = null
  private photoIndex = 0
  private mainImage: HTMLImageElement | null = null
  private counter: HTMLElement | null = null
  private thumbs: HTMLElement | null = null

  constructor(
    private readonly root: HTMLElement,
    private readonly options: DetailViewOptions,
  ) {}

  get isOpen(): boolean {
    return !this.root.hidden
  }

  get current(): Listing | null {
    return this.listing
  }

  close(): void {
    this.root.hidden = true
    this.root.replaceChildren()
    this.listing = null
    this.mainImage = null
    this.counter = null
    this.thumbs = null
    this.options.onClose()
  }

  render(listing: Listing | null): void {
    if (!listing) {
      this.root.hidden = true
      this.root.replaceChildren()
      this.listing = null
      return
    }
    const sameListing = this.listing?.key === listing.key
    this.listing = listing
    if (!sameListing) this.photoIndex = 0

    this.root.hidden = false
    clear(this.root)
    this.mainImage = null
    this.counter = null
    this.thumbs = null

    const scroll = el('div', { class: 'detail-scroll' })

    scroll.append(this.buildHead(listing))
    scroll.append(this.buildGallery(listing))
    if (listing.media.photos.length > 1) scroll.append(this.buildThumbs(listing))
    scroll.append(this.buildPrice(listing))
    scroll.append(this.buildFacts(listing))
    scroll.append(this.buildEnergy(listing))
    const features = this.buildFeatures(listing)
    if (features) scroll.append(features)
    const description = this.buildDescription(listing)
    if (description) scroll.append(description)
    scroll.append(this.buildLocation(listing))
    const agency = this.buildAgency(listing)
    if (agency) scroll.append(agency)
    scroll.append(this.buildActions(listing))
    if (listing.warnings.length > 0) {
      scroll.append(
        el('div', { class: 'detail-section' }, [
          el('h3', { class: 'section-title', text: 'Notes' }),
          ...listing.warnings.map((warning) => el('p', { class: 'notice', text: warning })),
        ]),
      )
    }

    this.root.append(scroll)
    this.syncPhoto()
  }

  nextPhoto(): void {
    if (!this.listing) return
    const count = this.listing.media.photos.length
    if (count === 0) return
    this.photoIndex = (this.photoIndex + 1) % count
    this.syncPhoto()
  }

  prevPhoto(): void {
    if (!this.listing) return
    const count = this.listing.media.photos.length
    if (count === 0) return
    this.photoIndex = (this.photoIndex - 1 + count) % count
    this.syncPhoto()
  }

  private buildHead(listing: Listing): HTMLElement {
    const close = el(
      'button',
      {
        class: 'icon-button',
        attrs: { type: 'button', 'aria-label': 'Close details' },
        on: { click: () => this.close() },
      },
      [svgIcon(CLOSE_ICON)],
    )
    return el('header', { class: 'detail-head' }, [
      el('div', {}, [
        el('h2', { text: listing.title }),
        el('p', { class: 'detail-address', text: listing.address.label }),
      ]),
      close,
    ])
  }

  private buildGallery(listing: Listing): HTMLElement {
    const gallery = el('div', { class: 'gallery' })
    if (listing.media.photos.length === 0) {
      gallery.append(el('div', { class: 'gallery-empty', text: 'No photos in this archive' }))
      return gallery
    }

    this.mainImage = el('img', {
      attrs: {
        src: photoUrl(listing, 0),
        alt: `Photo of ${listing.address.label}`,
        decoding: 'async',
      },
    })
    this.counter = el('span', {
      class: 'gallery-counter',
      text: `1 / ${listing.media.photos.length}`,
    })

    const prev = el(
      'button',
      {
        class: 'gallery-nav prev',
        attrs: { type: 'button', 'aria-label': 'Previous photo' },
        on: { click: () => this.prevPhoto() },
      },
      [svgIcon(PREV_ICON, 18)],
    )
    const next = el(
      'button',
      {
        class: 'gallery-nav next',
        attrs: { type: 'button', 'aria-label': 'Next photo' },
        on: { click: () => this.nextPhoto() },
      },
      [svgIcon(NEXT_ICON, 18)],
    )

    gallery.append(this.mainImage, this.counter)
    if (listing.media.photos.length > 1) gallery.append(prev, next)
    return gallery
  }

  private buildThumbs(listing: Listing): HTMLElement {
    this.thumbs = el('div', { class: 'thumbs' })
    listing.media.photos.forEach((photo, index) => {
      const button = el(
        'button',
        {
          attrs: { type: 'button', 'aria-label': `Photo ${index + 1}` },
          on: {
            click: () => {
              this.photoIndex = index
              this.syncPhoto()
            },
          },
        },
        [
          el('img', {
            attrs: {
              src: photoUrl(listing, photo.index),
              alt: '',
              loading: 'lazy',
              decoding: 'async',
            },
          }),
        ],
      )
      if (index === 0) button.classList.add('is-active')
      this.thumbs?.append(button)
    })
    return this.thumbs
  }

  private buildPrice(listing: Listing): HTMLElement {
    const badges: (HTMLElement | null)[] = [
      listing.energy.label
        ? el('span', {
            class: 'pill epc',
            text: `EPC ${listing.energy.label}`,
            style: { '--epc-color': epcColor(listing.energy.label) } as Partial<CSSStyleDeclaration>,
          })
        : null,
      listing.propertyTypeLabel ? el('span', { class: 'pill', text: listing.propertyTypeLabel }) : null,
      listing.conditionLabel ? el('span', { class: 'pill', text: listing.conditionLabel }) : null,
      listing.transaction.subtypeLabel
        ? el('span', { class: 'pill', text: listing.transaction.subtypeLabel })
        : null,
      listing.flags.isSoldOrRented ? el('span', { class: 'pill sold', text: 'Sold / rented' }) : null,
      listing.flags.isNewPrice ? el('span', { class: 'pill warn', text: 'Price lowered' }) : null,
      listing.price.oldValue !== null
        ? el('span', { class: 'pill warn', text: `Was ${euro(listing.price.oldValue)}` })
        : null,
    ]

    return el('div', { class: 'detail-section' }, [
      el('div', { class: 'detail-price' }, [
        el('strong', { text: euro(listing.price.value) }),
        listing.transaction.kind === 'for-rent'
          ? el('span', { class: 'per-sqm', text: 'per month' })
          : el('span', { class: 'per-sqm', text: euroPerSqm(listing.price.perSqm) }),
      ]),
      el('div', { class: 'detail-badges' }, badges),
    ])
  }

  private buildFacts(listing: Listing): HTMLElement {
    const { area, price, parking, address } = listing
    const items: (HTMLElement | null)[] = [
      fact('Living area', squareMetres(area.living)),
      fact('Plot', squareMetres(area.plot)),
      fact('Garden', area.garden ? squareMetres(area.garden) : null),
      fact('Terrace', area.terrace ? squareMetres(area.terrace) : null),
      fact('Bedrooms', area.bedrooms === null ? null : number(area.bedrooms)),
      fact('Bathrooms', area.bathrooms === null ? null : number(area.bathrooms)),
      fact('Shower rooms', area.showerRooms === null ? null : number(area.showerRooms)),
      fact('Toilets', area.toilets === null ? null : number(area.toilets)),
      fact('Total rooms', area.rooms === null ? null : number(area.rooms)),
      fact('Living room', area.livingRoom ? squareMetres(area.livingRoom) : null),
      fact('Kitchen', area.kitchen ? squareMetres(area.kitchen) : null),
      fact('Year built', area.constructionYear === null ? null : String(area.constructionYear)),
      fact('Floor', area.floor === null ? null : `${number(area.floor)}${area.floorCount ? ` of ${area.floorCount}` : ''}`),
      fact('Facades', area.facadeCount === null ? null : number(area.facadeCount)),
      fact('Street width', area.streetFacadeWidth ? `${number(area.streetFacadeWidth)} m` : null),
      fact(
        'Parking',
        parking.indoor || parking.outdoor || parking.closedBox
          ? [
              parking.indoor ? `${parking.indoor} indoor` : null,
              parking.outdoor ? `${parking.outdoor} outdoor` : null,
              parking.closedBox ? `${parking.closedBox} box` : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : null,
      ),
      fact('Cadastral income', price.cadastralIncome === null ? null : euro(price.cadastralIncome)),
      fact('Monthly costs', area.monthlyCosts === null ? null : euro(area.monthlyCosts)),
      fact('Province', address.province),
      fact('Region', address.region),
      fact('District', address.district),
      fact('Immoweb ID', listing.immowebId === null ? null : String(listing.immowebId)),
      fact('Reference', listing.externalReference),
      fact('Published', listing.publishedAt ? `${date(listing.publishedAt)} (${relativeDays(listing.publishedAt)})` : null),
      fact('Saved', date(listing.capturedAt)),
    ].filter((item): item is HTMLElement => item !== null)

    return el('div', { class: 'detail-section' }, [
      el('h3', { class: 'section-title', text: 'Property' }),
      el('dl', { class: 'fact-grid' }, items),
    ])
  }

  private buildEnergy(listing: Listing): HTMLElement {
    const { energy } = listing
    const items = [
      fact('EPC label', energy.label),
      fact('Energy use', energy.perSqmYear === null ? null : `${number(energy.perSqmYear)} kWh/m²/yr`),
      fact('Total per year', energy.perYear === null ? null : `${number(energy.perYear)} kWh`),
      fact('Heating', energy.heatingLabel ?? energy.heatingType),
      fact('Heat pump', yesNo(energy.heatPump)),
      fact('Solar panels', yesNo(energy.photovoltaicPanels)),
      fact('Solar water heater', yesNo(energy.thermicPanels)),
      fact('Double glazing', yesNo(energy.doubleGlazing)),
      fact('Renovation duty', yesNo(energy.renovationObligation)),
      fact('Electrical cert.', yesNo(energy.electricalCertificate)),
      fact('Asbestos cert.', energy.asbestosCertificate),
      fact('Flood zone', energy.floodZoneLabel),
      fact('EPC reference', energy.reference),
    ].filter((item): item is HTMLElement => item !== null)

    if (items.length === 0) {
      return el('div', { class: 'detail-section' }, [
        el('h3', { class: 'section-title', text: 'Energy' }),
        el('p', { class: 'section-title', text: 'No energy data in this archive.' }),
      ])
    }

    return el('div', { class: 'detail-section' }, [
      el('h3', { class: 'section-title', text: 'Energy & certificates' }),
      el('dl', { class: 'fact-grid' }, items),
    ])
  }

  private buildFeatures(listing: Listing): HTMLElement | null {
    const active = Object.entries(listing.features)
      .filter(([, value]) => value)
      .map(([key]) => FEATURE_LABELS[key] ?? key.replace(/([A-Z])/g, ' $1').toLowerCase())
    if (active.length === 0) return null

    return el('div', { class: 'detail-section' }, [
      el('h3', { class: 'section-title', text: 'Comfort & features' }),
      el(
        'div',
        { class: 'feature-list' },
        active.map((label) => el('span', { class: 'pill', text: label })),
      ),
    ])
  }

  private buildDescription(listing: Listing): HTMLElement | null {
    if (!listing.description) return null
    const body = el('div', { class: 'description', text: listing.description })
    const toggle = el('button', {
      class: 'link-button',
      attrs: { type: 'button' },
      text: 'Show more',
      style: { marginTop: '8px' },
    })
    toggle.addEventListener('click', () => {
      const expanded = body.classList.toggle('is-expanded')
      toggle.textContent = expanded ? 'Show less' : 'Show more'
    })
    const long = listing.description.length > 480
    return el('div', { class: 'detail-section' }, [
      el('h3', { class: 'section-title', text: 'Description' }),
      body,
      long ? toggle : null,
    ])
  }

  private buildLocation(listing: Listing): HTMLElement {
    const { address } = listing
    const items = [
      fact('Address', address.label),
      fact('Property name', address.propertyName),
      fact('Coordinates', address.lat === null ? null : `${address.lat.toFixed(5)}, ${address.lon?.toFixed(5)}`),
    ].filter((item): item is HTMLElement => item !== null)

    const links: HTMLElement[] = []
    if (address.lat !== null && address.lon !== null) {
      links.push(
        el('a', {
          class: 'action',
          text: 'Open in OpenStreetMap',
          attrs: {
            href: `https://www.openstreetmap.org/?mlat=${address.lat}&mlon=${address.lon}#map=17/${address.lat}/${address.lon}`,
            target: '_blank',
            rel: 'noreferrer noopener',
          },
        }),
      )
    }
    for (const [index, plan] of listing.media.floorPlans.entries()) {
      links.push(
        el('a', {
          class: 'action',
          text: `Floor plan ${index + 1} (${plan.name.split('.').pop()?.toUpperCase() ?? 'file'})`,
          attrs: {
            href: floorPlanUrl(listing, plan.index),
            target: '_blank',
            rel: 'noreferrer noopener',
          },
        }),
      )
    }
    if (listing.media.videoUrl) {
      links.push(
        el('a', {
          class: 'action',
          text: 'Watch video',
          attrs: { href: listing.media.videoUrl, target: '_blank', rel: 'noreferrer noopener' },
        }),
      )
    }

    return el('div', { class: 'detail-section' }, [
      el('h3', { class: 'section-title', text: 'Location' }),
      el('dl', { class: 'fact-grid' }, items),
      links.length > 0 ? el('div', { class: 'link-list', style: { marginTop: '10px' } }, links) : null,
    ])
  }

  private buildAgency(listing: Listing): HTMLElement | null {
    const agency = listing.agency[0]
    if (!agency) return null
    const lines = [
      agency.phone ? `Phone ${agency.phone}` : null,
      agency.mobile ? `Mobile ${agency.mobile}` : null,
      agency.email ?? null,
      agency.website ?? null,
      agency.ipiNumber ? `IPI ${agency.ipiNumber}` : null,
    ].filter((line): line is string => line !== null)

    return el('div', { class: 'detail-section' }, [
      el('h3', { class: 'section-title', text: 'Agency' }),
      el('div', { class: 'agency' }, [
        el('strong', { text: agency.name ?? 'Unknown agency' }),
        ...lines.map((line) => el('span', { text: line })),
      ]),
    ])
  }

  private buildActions(listing: Listing): HTMLElement {
    const actions: HTMLElement[] = []
    if (listing.url) {
      actions.push(
        el('a', { class: 'action primary', attrs: { href: listing.url, target: '_blank', rel: 'noreferrer noopener' } }, [
          svgIcon(EXTERNAL_ICON),
          'Open on Immoweb',
        ]),
      )
    }
    actions.push(
      el('a', { class: 'action', attrs: { href: archiveUrl(listing), download: listing.zipFile } }, [
        svgIcon(DOWNLOAD_ICON),
        'Download the ZIP',
      ]),
    )

    return el('div', { class: 'detail-section' }, [
      el('h3', { class: 'section-title', text: 'Listing' }),
      el('div', { class: 'link-list' }, actions),
      el('p', {
        class: 'panel-sub',
        text: `${plural(listing.media.photos.length, 'photo')} · ${plural(listing.media.floorPlans.length, 'floor plan')} · ${plural(listing.media.documents.length, 'document')} in ${listing.zipFile}`,
        style: { marginTop: '10px', marginBottom: '0' },
      }),
    ])
  }

  private syncPhoto(): void {
    const listing = this.listing
    if (!listing) return
    const count = listing.media.photos.length
    const photo = listing.media.photos[this.photoIndex]
    if (this.mainImage && photo) {
      this.mainImage.src = photoUrl(listing, photo.index)
    }
    if (this.counter) this.counter.textContent = `${this.photoIndex + 1} / ${count}`
    if (this.thumbs) {
      const buttons = [...this.thumbs.children]
      buttons.forEach((button, index) => {
        button.classList.toggle('is-active', index === this.photoIndex)
      })
      const active = buttons[this.photoIndex]
      if (active instanceof HTMLElement) {
        active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
      }
    }
  }
}

function fact(label: string, value: string | null | undefined): HTMLElement | null {
  if (value === null || value === undefined || value === '' || value === '—') return null
  return el('div', { class: 'fact' }, [
    el('dt', { text: label }),
    el('dd', { text: value }),
  ])
}

function yesNo(value: boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value ? 'Yes' : 'No'
}
