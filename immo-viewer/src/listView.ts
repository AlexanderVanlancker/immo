import { archiveUrl, photoUrl } from './api'
import { clear, el } from './dom'
import { epcColor } from './epc'
import { date, euro, euroPerSqm, plural, squareMetres } from './format'
import type { Listing } from './types'

export interface ListViewOptions {
  onSelect: (key: string) => void
  onHover: (key: string | null) => void
}

export interface ListView {
  render(listings: Listing[], selectedKey: string | null, totalCount: number): void
  setSelected(key: string | null): void
  setHover(key: string | null): void
  scrollTo(key: string): void
}

export function createListView(root: HTMLElement, options: ListViewOptions): ListView {
  const cards = new Map<string, HTMLElement>()

  const buildCard = (listing: Listing): HTMLElement => {
    const photo = listing.media.photos[0]
    const thumb = photo
      ? el('img', {
          attrs: {
            src: photoUrl(listing, photo.index),
            alt: '',
            loading: 'lazy',
            decoding: 'async',
          },
        })
      : el('span', { class: 'no-photo', text: listing.propertyTypeLabel ?? 'No photo' })

    const facts: string[] = []
    if (listing.area.living) facts.push(squareMetres(listing.area.living))
    if (listing.area.bedrooms) facts.push(plural(listing.area.bedrooms, 'bed'))
    if (listing.area.plot) facts.push(`plot ${squareMetres(listing.area.plot)}`)
    if (listing.propertyTypeLabel) facts.push(listing.propertyTypeLabel)
    if (listing.address.district && listing.address.district !== listing.address.city) {
      facts.push(listing.address.district)
    }

    const savedAt = listing.capturedAt

    const card = el(
      'button',
      {
        class: 'card',
        attrs: { type: 'button', 'data-key': listing.key },
        on: {
          click: () => options.onSelect(listing.key),
          mouseenter: () => options.onHover(listing.key),
          mouseleave: () => options.onHover(null),
          focus: () => options.onHover(listing.key),
          blur: () => options.onHover(null),
        },
      },
      [
        el('div', { class: 'card-thumb' }, [
          thumb,
          photo && listing.media.photos.length > 1
            ? el('span', {
                class: 'photo-count',
                text: String(listing.media.photos.length),
              })
            : null,
        ]),
        el('div', { class: 'card-body' }, [
          el('div', { class: 'card-price-row' }, [
            el('span', { class: 'card-price', text: euro(listing.price.value) }),
            el('span', {
              class: 'card-price-sqm',
              text: listing.transaction.kind === 'for-rent' ? '/month' : euroPerSqm(listing.price.perSqm),
            }),
            listing.energy.label
              ? el('span', {
                  class: 'pill epc',
                  text: listing.energy.label,
                  style: { '--epc-color': epcColor(listing.energy.label) } as Partial<CSSStyleDeclaration>,
                })
              : null,
          ]),
          el('div', { class: 'card-address', text: listing.address.label }),
          el(
            'div',
            { class: 'card-facts' },
            facts.map((fact) => el('span', { text: fact })),
          ),
          el('div', { class: 'card-foot' }, [
            el('span', { text: `Saved ${date(savedAt)}` }),
            listing.flags.isSoldOrRented ? el('span', { class: 'pill sold', text: 'Sold / rented' }) : null,
            listing.flags.isNewPrice ? el('span', { class: 'pill warn', text: 'New price' }) : null,
            listing.address.lat === null ? el('span', { class: 'pill warn', text: 'No map pin' }) : null,
          ]),
        ]),
      ],
    )
    return card
  }

  const renderEmpty = (totalCount: number): void => {
    clear(root)
    cards.clear()
    root.append(
      el('div', { class: 'empty-state' }, [
        el('p', { text: totalCount === 0 ? 'No saved listings found.' : 'No listing matches these filters.' }),
        el('p', {
          text:
            totalCount === 0
              ? 'Save a listing with the Immoweb Zipper extension (ZIP downloads folder), drop the ZIP into data/exports/ and reload this page.'
              : 'Loosen a filter, or clear them all to see every saved listing again.',
        }),
      ]),
    )
  }

  return {
    render(listings, selectedKey, totalCount) {
      const scrollTop = root.scrollTop
      cards.clear()
      clear(root)
      if (listings.length === 0) {
        renderEmpty(totalCount)
        return
      }
      const fragment = document.createDocumentFragment()
      for (const listing of listings) {
        const card = buildCard(listing)
        if (listing.key === selectedKey) card.classList.add('is-selected')
        cards.set(listing.key, card)
        fragment.append(card)
      }
      root.append(fragment)
      root.scrollTop = scrollTop
    },

    setSelected(key) {
      for (const [cardKey, card] of cards) {
        card.classList.toggle('is-selected', cardKey === key)
      }
    },

    setHover(key) {
      for (const [cardKey, card] of cards) {
        card.classList.toggle('is-hover', cardKey === key)
      }
    },

    scrollTo(key) {
      const card = cards.get(key)
      if (!card) return
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    },
  }
}

/** The ZIP download link reused by the detail panel. */
export { archiveUrl }
