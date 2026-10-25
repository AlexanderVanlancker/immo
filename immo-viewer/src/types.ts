/**
 * The wire format between the API (which reads `info.json` out of each saved
 * ZIP) and the browser. Everything is normalised here so the UI never has to
 * deal with Immoweb's inconsistent raw shape.
 */

export type TransactionKind = 'for-sale' | 'for-rent'

export interface ListingAddress {
  street: string | null
  number: string | null
  box: string | null
  postalCode: string | null
  city: string | null
  district: string | null
  province: string | null
  region: string | null
  propertyName: string | null
  /** Human label, e.g. `Maria Claessensplein 5, 2050 Antwerpen`. */
  label: string
  lat: number | null
  lon: number | null
}

export interface ListingRent {
  monthly: number | null
  monthlyCosts: number | null
  /** Amount excluding charges, when Immoweb reports a separate figure. */
  excludingCharges: number | null
  yearly: number | null
  furnished: boolean | null
  smallPetsAllowed: boolean | null
  bigPetsAllowed: boolean | null
}

export interface ListingPrice {
  /** Asking price for a sale, monthly rent for a rental. */
  value: number | null
  display: string | null
  currency: string
  oldValue: number | null
  hidden: boolean
  /** price / living area, computed by the zipper or by us. */
  perSqm: number | null
  /** Only when Immoweb itself published a €/m² figure. */
  perSqmListed: number | null
  cadastralIncome: number | null
  subjectToVat: boolean | null
  rentedFurnished: boolean | null
  rent: ListingRent | null
}

export interface ListingArea {
  living: number | null
  plot: number | null
  garden: number | null
  terrace: number | null
  basement: number | null
  plotWidth: number | null
  streetFacadeWidth: number | null
  bedrooms: number | null
  bathroomSurfaces: number | null
  bathrooms: number | null
  showerRooms: number | null
  toilets: number | null
  rooms: number | null
  livingRoom: number | null
  kitchen: number | null
  facadeCount: number | null
  constructionYear: number | null
  floor: number | null
  floorCount: number | null
  monthlyCosts: number | null
}

export interface ListingEnergy {
  label: string | null
  perSqmYear: number | null
  perYear: number | null
  reference: string | null
  carbonEmission: number | null
  renovationObligation: boolean | null
  heatingType: string | null
  heatingLabel: string | null
  heatPump: boolean | null
  photovoltaicPanels: boolean | null
  thermicPanels: boolean | null
  doubleGlazing: boolean | null
  floodZoneLabel: string | null
  electricalCertificate: boolean | null
  asbestosCertificate: string | null
}

export interface ListingParking {
  indoor: number | null
  outdoor: number | null
  closedBox: number | null
}

export interface ListingAgency {
  name: string | null
  phone: string | null
  mobile: string | null
  email: string | null
  website: string | null
  ipiNumber: string | null
}

export interface MediaFile {
  /** Index inside its folder, used to build the asset URL. */
  index: number
  name: string
  bytes: number
}

export interface ListingMedia {
  photos: MediaFile[]
  floorPlans: MediaFile[]
  documents: MediaFile[]
  pictureCount: number
  videoUrl: string | null
  virtualTourUrl: string | null
}

export interface Listing {
  /** Stable, URL-safe identifier derived from the ZIP file name. */
  key: string
  /** File name of the source archive, e.g. `Gentplaats 12  2000 — Antwerpen.zip`. */
  zipFile: string
  immowebId: number | null
  externalReference: string | null
  /** Which site the archive came from: `Immoweb` or `Immoscoop`. */
  source: string
  url: string | null
  title: string
  /** ISO timestamp of the moment the extension saved the listing. */
  capturedAt: string | null
  publishedAt: string | null
  modifiedAt: string | null
  transaction: {
    kind: TransactionKind
    label: string | null
    subtypeLabel: string | null
    status: string | null
  }
  propertyType: string | null
  propertyTypeLabel: string | null
  subtypeLabel: string | null
  condition: string | null
  conditionLabel: string | null
  description: string | null
  descriptionLanguage: string | null
  address: ListingAddress
  price: ListingPrice
  area: ListingArea
  energy: ListingEnergy
  parking: ListingParking
  features: Record<string, boolean>
  agency: ListingAgency[]
  media: ListingMedia
  flags: {
    isSoldOrRented: boolean
    isNewPrice: boolean
    isNewlyBuilt: boolean
    isNotarySale: boolean | null
    isLifeAnnuitySale: boolean | null
  }
  /** Non-fatal data problems found while normalising this archive. */
  warnings: string[]
}

export interface ScanError {
  zipFile: string
  message: string
}

export interface ListingsResponse {
  scannedAt: string
  sourceDir: string
  listings: Listing[]
  errors: ScanError[]
}
