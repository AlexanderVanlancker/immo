/**
 * Turns the `info.json` inside a saved Immoweb ZIP into a `Listing` DTO.
 * Every field is optional in Immoweb's data, so each read is defensive: a
 * missing value costs that value, never the whole listing.
 */
import type {
  Listing,
  ListingAddress,
  ListingArea,
  ListingAgency,
  ListingEnergy,
  ListingMedia,
  ListingParking,
  ListingPrice,
  TransactionKind,
} from '../src/types.ts'

type Raw = Record<string, unknown>

const isObject = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const asObject = (value: unknown): Raw => (isObject(value) ? value : {})

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

export const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export const asString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export const asBool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

export interface MediaEntryInfo {
  name: string
  bytes: number
}

export interface NormaliseInput {
  key: string
  zipFile: string
  info: Raw
  photos: MediaEntryInfo[]
  floorPlans: MediaEntryInfo[]
  documents: MediaEntryInfo[]
}

export function normaliseListing({ key, zipFile, info, photos, floorPlans, documents }: NormaliseInput): Listing {
  const warnings: string[] = []

  const transaction = asObject(info.transaction)
  const kind: TransactionKind = asString(transaction.kind) === 'for-rent' ? 'for-rent' : 'for-sale'
  const property = asObject(info.property)
  const location = asObject(info.location)
  const priceRaw = asObject(info.price)
  const energyRaw = asObject(info.energy)
  const heating = asObject(info.heating)
  const certificates = asObject(info.certificates)
  const publication = asObject(info.publication)
  const mediaRaw = asObject(info.media)
  const flags = asObject(info.flags)

  const address: ListingAddress = {
    street: asString(location.street),
    number: asString(location.number),
    box: asString(location.box),
    postalCode: asString(location.postalCode),
    city: asString(location.locality),
    district: asString(location.district),
    province: asString(location.province),
    region: asString(location.region),
    propertyName: asString(location.propertyName),
    label: '',
    lat: asNumber(location.latitude),
    lon: asNumber(location.longitude),
  }
  address.label = buildAddressLabel(address)

  if (address.lat === null || address.lon === null) {
    warnings.push('No coordinates: this listing cannot be shown on the map.')
  }

  const area: ListingArea = {
    living: asNumber(property.livingArea),
    plot: asNumber(property.plotArea),
    garden: asNumber(property.gardenArea),
    terrace: asNumber(property.terraceArea),
    basement: asNumber(property.basementSurface),
    plotWidth: asNumber(property.plotWidth),
    streetFacadeWidth: asNumber(property.streetFacadeWidth),
    bedrooms: asNumber(property.bedrooms),
    bathrooms: asNumber(property.bathrooms),
    bathroomSurfaces: asNumber(property.bathroomsSurface),
    showerRooms: asNumber(property.showerRooms),
    toilets: asNumber(property.toilets),
    rooms: asNumber(property.rooms),
    livingRoom: asNumber(property.livingRoomSurface),
    kitchen: asNumber(asObject(property.kitchen).surface),
    facadeCount: asNumber(property.facadeCount),
    constructionYear: asNumber(property.constructionYear),
    floor: asNumber(property.floor),
    floorCount: asNumber(property.floorCount),
    monthlyCosts: asNumber(property.monthlyCosts),
  }

  const rentRaw = asObject(priceRaw.rent)
  const hasRent = Object.keys(rentRaw).length > 0
  const priceValue = asNumber(priceRaw.value) ?? (hasRent ? asNumber(rentRaw.monthly) : null)
  const perSqmListed = asNumber(priceRaw.pricePerSqm)
  const perSqmComputed = asNumber(priceRaw.computedPricePerSqm)
  const perSqm =
    perSqmComputed ??
    (priceValue !== null && (area.living ?? 0) > 0 && area.living !== null
      ? Math.round(priceValue / area.living)
      : null)

  const price: ListingPrice = {
    value: priceValue,
    display: asString(priceRaw.display),
    currency: asString(priceRaw.currency) ?? 'EUR',
    oldValue: asNumber(priceRaw.oldValue),
    hidden: asBool(priceRaw.hidden) ?? false,
    perSqm,
    perSqmListed,
    cadastralIncome: asNumber(priceRaw.cadastralIncome),
    subjectToVat: asBool(priceRaw.subjectToVat),
    rentedFurnished: asBool(priceRaw.isFurnished),
    rent: hasRent
      ? {
          monthly: asNumber(rentRaw.monthly),
          monthlyCosts: asNumber(rentRaw.monthlyCosts),
          excludingCharges: asNumber(rentRaw.excludingCharges),
          yearly: asNumber(rentRaw.yearly),
          furnished: asBool(rentRaw.furnished),
          smallPetsAllowed: asBool(rentRaw.smallPetsAllowed),
          bigPetsAllowed: asBool(rentRaw.bigPetsAllowed),
        }
      : null,
  }

  if (priceValue === null) warnings.push('No price found in this archive.')

  const energy: ListingEnergy = {
    label: asString(energyRaw.epcScore) ?? asString(energyRaw.epcScoreLabel),
    perSqmYear: asNumber(energyRaw.energyPerSqmYear),
    perYear: asNumber(energyRaw.energyPerYear),
    reference: asString(energyRaw.epcReference),
    carbonEmission: asNumber(energyRaw.carbonEmission),
    renovationObligation: asBool(energyRaw.renovationObligation) ?? asBool(certificates.renovationObligation),
    heatingType: asString(heating.type),
    heatingLabel: asString(heating.typeLabel),
    heatPump: asBool(heating.heatPump),
    photovoltaicPanels: asBool(heating.photovoltaicPanels),
    thermicPanels: asBool(heating.thermicPanels),
    doubleGlazing: asBool(heating.doubleGlazing),
    floodZoneLabel: asString(certificates.floodZoneLabel),
    electricalCertificate: asBool(certificates.electricalCertificate),
    asbestosCertificate: asString(certificates.asbestosCertificate),
  }

  const parkingRaw = asObject(property.parking)
  const parking: ListingParking = {
    indoor: asNumber(parkingRaw.indoor),
    outdoor: asNumber(parkingRaw.outdoor),
    closedBox: asNumber(parkingRaw.closedBox),
  }

  const features: Record<string, boolean> = {}
  for (const [name, value] of Object.entries(asObject(property.features))) {
    if (typeof value === 'boolean') features[name] = value
  }

  const agency: ListingAgency[] = asArray(info.agency).map((entry) => {
    const raw = asObject(entry)
    return {
      name: asString(raw.name),
      phone: asString(raw.phone),
      mobile: asString(raw.mobile),
      email: asString(raw.email),
      website: asString(raw.website),
      ipiNumber: asString(raw.ipiNumber),
    }
  })

  const media: ListingMedia = {
    photos: photos.map((photo, index) => ({ index, name: photo.name, bytes: photo.bytes })),
    floorPlans: floorPlans.map((file, index) => ({ index, name: file.name, bytes: file.bytes })),
    documents: documents.map((file, index) => ({ index, name: file.name, bytes: file.bytes })),
    pictureCount: asNumber(mediaRaw.pictureCount) ?? photos.length,
    videoUrl: asString(mediaRaw.videoUrl),
    virtualTourUrl: asString(mediaRaw.virtualTourUrl),
  }

  const title =
    asString(property.title) ??
    asString(info.displayTitle) ??
    buildTitle(kind, asString(property.typeLabel), address)

  return {
    key,
    zipFile,
    immowebId: asNumber(info.id),
    externalReference: asString(info.externalReference),
    source: asString(info.source) ?? 'Immoweb',
    url: asString(info.url),
    title,
    capturedAt: asString(info.capturedAt),
    publishedAt: asString(publication.created),
    modifiedAt: asString(publication.lastModification),
    transaction: {
      kind,
      label: asString(transaction.typeLabel),
      subtypeLabel: asString(transaction.subtypeLabel),
      status: asString(transaction.status),
    },
    propertyType: asString(property.type)?.toLowerCase() ?? null,
    propertyTypeLabel: asString(property.typeLabel) ?? asString(property.type),
    subtypeLabel: asString(property.subtypeLabel),
    condition: asString(property.condition),
    conditionLabel: asString(property.conditionLabel),
    description: asString(property.description),
    descriptionLanguage: asString(property.descriptionLanguage),
    address,
    price,
    area,
    energy,
    parking,
    features,
    agency,
    media,
    flags: {
      isSoldOrRented: asBool(flags.isSoldOrRented) ?? false,
      isNewPrice: asBool(flags.isNewPrice) ?? false,
      isNewlyBuilt: asBool(flags.isNewlyBuilt) ?? false,
      isNotarySale: asBool(flags.isNotarySale),
      isLifeAnnuitySale: asBool(flags.isLifeAnnuitySale),
    },
    warnings,
  }
}

function buildAddressLabel(address: ListingAddress): string {
  const street = [address.street, address.number].filter(Boolean).join(' ')
  const withBox = address.box ? `${street} box ${address.box}` : street
  const city = [address.postalCode, address.city].filter(Boolean).join(' ')
  if (withBox && city) return `${withBox}, ${city}`
  return withBox || city || address.propertyName || 'Unknown address'
}

function buildTitle(kind: TransactionKind, typeLabel: string | null, address: ListingAddress): string {
  const what = typeLabel ?? 'Property'
  const action = kind === 'for-rent' ? 'for rent' : 'for sale'
  return `${what} ${action} in ${address.city ?? 'Belgium'}`
}
