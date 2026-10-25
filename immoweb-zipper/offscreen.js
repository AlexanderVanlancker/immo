'use strict';

/* global fflate */

/**
 * Immoweb Listing Zipper — offscreen archiver.
 *
 * Receives the listing payload scraped from the tab, downloads the photos /
 * floor plans / documents, and turns everything into a ZIP blob. The blob URL is
 * handed back to the service worker, which passes it to chrome.downloads.
 */

const ENCODER = new TextEncoder();
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 60000;

const SIZE_KEYS = {
  extra: 'extralargeUrl',
  large: 'largeUrl',
  medium: 'mediumUrl',
  small: 'smallUrl',
};

const SIZE_DIMENSIONS = {
  extra: '2560x1440',
  large: '736x736',
  medium: '300x300',
  small: '100x100',
};

let activeBlobUrl = null;

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  if (message.type === 'ping') {
    sendResponse({ ok: true });
    return undefined;
  }

  if (message.type === 'build-zip') {
    buildZip(message.payload || {}, message.options || {}).then(sendResponse, (error) =>
      sendResponse({ error: String((error && error.message) || error) })
    );
    return true;
  }

  if (message.type === 'revoke-blob') {
    releaseBlob();
    sendResponse({ ok: true });
    return undefined;
  }

  return undefined;
});

function report(patch) {
  try {
    chrome.runtime.sendMessage({ type: 'job-state', job: patch }).catch(() => {});
  } catch (error) {
    /* popup/service worker not listening */
  }
}

function releaseBlob() {
  if (activeBlobUrl) {
    try {
      URL.revokeObjectURL(activeBlobUrl);
    } catch (error) {
      /* ignore */
    }
    activeBlobUrl = null;
  }
}

/* ------------------------------------------------------------------ *
 * Main flow
 * ------------------------------------------------------------------ */

async function buildZip(payload, options) {
  const opts = { photoSize: 'extra', includePageHtml: false, ...options };
  const site = payload.site === 'immoscoop' ? 'immoscoop' : 'immoweb';
  const data = site === 'immoscoop' ? payload.scoop || null : payload.classified || null;
  const normalise = site === 'immoscoop' ? normalizeScoop : normalize;
  const files = [];
  const warnings = [];

  // Both sites keep changing the shape of their listing objects. A surprise in
  // the structured data must never cost the user the photos or the raw JSON.
  let info;
  try {
    info = data ? normalise(data, payload) : normalizeFallback(payload);
  } catch (error) {
    warnings.push({
      url: payload.url,
      error: 'listing details could not be read (' + errorMessage(error) + ')',
    });
    info = normalizeFallback(payload);
  }
  info.displayTitle = safeDisplayTitle(info);
  const folder = folderName(info);

  let summary;
  try {
    summary = buildSummary(info);
  } catch (error) {
    warnings.push({ url: payload.url, error: 'summary could not be generated (' + errorMessage(error) + ')' });
    summary = '# ' + info.displayTitle + '\n\n_The readable summary could not be generated; see info.json and listing.json._\n';
  }

  // --- text files -----------------------------------------------------
  files.push({ path: folder + '/summary.md', bytes: ENCODER.encode(summary) });
  files.push({ path: folder + '/info.json', bytes: ENCODER.encode(JSON.stringify(info, null, 2)) });
  files.push({ path: folder + '/README.txt', bytes: ENCODER.encode(buildReadme(info, folder)) });
  if (data) {
    try {
      files.push({ path: folder + '/listing.json', bytes: ENCODER.encode(JSON.stringify(data, null, 2)) });
    } catch (error) {
      warnings.push({
        url: payload.url,
        error: 'raw listing could not be serialised (' + errorMessage(error) + ')',
      });
    }
  }
  if (opts.includePageHtml && payload.html) {
    files.push({ path: folder + '/page.html', bytes: ENCODER.encode(payload.html) });
  }

  // --- media ----------------------------------------------------------
  const usedUrls = new Set();
  const safely = (fn) => {
    try {
      return fn();
    } catch (error) {
      warnings.push({ url: payload.url, error: 'media list unreadable (' + errorMessage(error) + ')' });
      return [];
    }
  };
  const photos = safely(() =>
    site === 'immoscoop'
      ? collectScoopPictures(data, payload, opts, usedUrls)
      : collectPictures(data, payload, opts, 'pictures', usedUrls)
  );
  const floorPlans =
    site === 'immoscoop' ? [] : safely(() => collectPictures(data, payload, opts, 'floorPlans', usedUrls));
  const documents =
    site === 'immoscoop' || opts.includeDocuments === false
      ? []
      : safely(() => collectDocuments(data, usedUrls));
  const totalItems = photos.length + floorPlans.length + documents.length;

  let done = 0;
  const progress = (phase, message) => {
    const ratio = totalItems ? done / totalItems : 1;
    report({
      phase,
      message,
      done,
      total: totalItems,
      percent: Math.round(5 + 82 * ratio),
    });
  };

  report({
    phase: 'photos',
    message: totalItems
      ? 'Downloading ' + totalItems + ' file' + (totalItems === 1 ? '' : 's') + '…'
      : 'No media to download.',
    done: 0,
    total: totalItems,
    percent: 5,
  });

  const mediaFiles = [];
  mediaFiles.push(
    ...(await downloadPictures(photos, folder + '/photos', warnings, () => {
      done += 1;
      progress('photos', 'Downloading photos… (' + done + '/' + totalItems + ')');
    }))
  );
  mediaFiles.push(
    ...(await downloadPictures(floorPlans, folder + '/floorplans', warnings, () => {
      done += 1;
      progress('floorplans', 'Downloading floor plans… (' + done + '/' + totalItems + ')');
    }))
  );
  mediaFiles.push(
    ...(await downloadDocuments(documents, folder + '/documents', warnings, () => {
      done += 1;
      progress('documents', 'Downloading documents… (' + done + '/' + totalItems + ')');
    }))
  );

  if (warnings.length) {
    const lines = warnings.map((w) => '- ' + w.url + ' — ' + w.error);
    files.push({
      path: folder + '/download-errors.txt',
      bytes: ENCODER.encode('Some files could not be downloaded:\n\n' + lines.join('\n') + '\n'),
    });
  }

  // --- zip ------------------------------------------------------------
  report({ phase: 'zipping', message: 'Compressing the archive…', percent: 90 });

  const allFiles = files.concat(mediaFiles);
  const mtime = pickMtime(info);
  const zippable = {};
  for (const file of allFiles) {
    zippable[file.path] = [
      asBytes(file.bytes),
      { level: isMediaPath(file.path) ? 0 : 6, mtime },
    ];
  }

  const zipBytes = await zipFiles(zippable);

  releaseBlob();
  activeBlobUrl = URL.createObjectURL(new Blob([zipBytes], { type: 'application/zip' }));

  return {
    filename: folder + '.zip',
    size: zipBytes.length,
    blobUrl: activeBlobUrl,
    warnings: warnings.map((w) => w.url + ' — ' + w.error),
    info,
  };
}

function errorMessage(error) {
  return String((error && error.message) || error);
}

function safeDisplayTitle(info) {
  try {
    return displayTitle(info);
  } catch (error) {
    return ((info && info.source) || 'Listing') + ' ' + ((info && info.id) || '');
  }
}

function zipFiles(zippable) {
  return new Promise((resolve, reject) => {
    fflate.zip(zippable, { level: 6 }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

/**
 * Guarantees a binary payload in our own realm: the zip writer decides between
 * "file contents" and "nested tree" with an instanceof check, so a typed array
 * from another realm would be expanded byte-by-byte into bogus entries.
 */
function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value);
}

function isMediaPath(path) {
  return /\.(jpe?g|png|webp|gif|avif|pdf|zip|heic)$/i.test(path);
}

function pickMtime(info) {
  const candidates = [
    info.publication && info.publication.lastModification,
    info.publication && info.publication.created,
    info.capturedAt,
  ];
  for (const value of candidates) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

/* ------------------------------------------------------------------ *
 * Media collection + download
 * ------------------------------------------------------------------ */

function pictureUrl(picture, opts) {
  if (!picture) return null;
  if (typeof picture === 'string') return /^https?:/.test(picture) ? picture : null;
  const preferred = SIZE_KEYS[opts.photoSize] || SIZE_KEYS.extra;
  const order = [preferred, 'extralargeUrl', 'largeUrl', 'mediumUrl', 'smallUrl'];
  for (const key of order) {
    const value = picture[key];
    if (typeof value === 'string' && /^https?:/.test(value)) return value;
  }
  return null;
}

function collectPictures(data, payload, opts, field, usedUrls) {
  const out = [];
  const seen = usedUrls || new Set();
  const push = (url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url });
  };

  if (data && data.media) {
    for (const picture of toArray(data.media[field])) push(pictureUrl(picture, opts));
  }

  if (field === 'pictures' && !out.length && payload.fallback) {
    const dimension = SIZE_DIMENSIONS[opts.photoSize] || SIZE_DIMENSIONS.extra;
    const urls = [];
    if (payload.fallback.ogImage) urls.push(payload.fallback.ogImage);
    for (const url of payload.fallback.images || []) urls.push(upgradeImageSize(url, dimension));
    for (const url of urls) push(url);
  }

  return out;
}

function upgradeImageSize(url, dimension) {
  return String(url).replace(/\/(\d{2,4}x\d{2,4})\//, '/' + dimension + '/');
}

function collectDocuments(data, usedUrls) {
  const media = (data && data.media) || {};
  const seen = usedUrls || new Set();
  const out = [];
  const push = (doc) => {
    const url = firstUrl(doc);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, title: firstTitle(doc) });
  };
  for (const doc of toArray(media.documents)) push(doc);
  for (const doc of toArray(media.specifications)) push(doc);
  return out;
}

function firstUrl(value) {
  if (!value) return null;
  if (typeof value === 'string') return /^https?:/.test(value) ? value : null;
  if (typeof value !== 'object') return null;
  const keys = [
    'url',
    'fileUrl',
    'documentUrl',
    'link',
    'href',
    'largeUrl',
    'mediumUrl',
    'smallUrl',
    'extralargeUrl',
  ];
  for (const key of keys) {
    if (typeof value[key] === 'string' && /^https?:/.test(value[key])) return value[key];
  }
  for (const candidate of Object.values(value)) {
    if (typeof candidate === 'string' && /^https?:\/\/\S+\.(pdf|jpe?g|png|docx?|xlsx?|zip)$/i.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function firstTitle(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['title', 'originalName', 'name', 'filename', 'label', 'description']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return null;
}

async function fetchBinary(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { credentials: 'omit', signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error('empty response');
    return {
      bytes,
      contentType: String(response.headers.get('content-type') || '').toLowerCase(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function extensionFor(contentType, url, fallback) {
  if (/jpeg|jpg/.test(contentType)) return 'jpg';
  if (/png/.test(contentType)) return 'png';
  if (/webp/.test(contentType)) return 'webp';
  if (/avif/.test(contentType)) return 'avif';
  if (/gif/.test(contentType)) return 'gif';
  if (/pdf/.test(contentType)) return 'pdf';
  const match = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(url || '');
  if (match) return match[1].toLowerCase();
  return fallback || 'bin';
}

async function downloadPictures(entries, dir, warnings, onEach) {
  if (!entries.length) return [];
  const results = new Array(entries.length).fill(null);
  let cursor = 0;

  const worker = async () => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      const entry = entries[index];
      try {
        const { bytes, contentType } = await fetchBinary(entry.url);
        const extension = extensionFor(contentType, entry.url, 'jpg');
        const name = String(index + 1).padStart(2, '0') + '.' + extension;
        results[index] = { path: dir + '/' + name, bytes };
      } catch (error) {
        warnings.push({ url: entry.url, error: String((error && error.message) || error) });
      }
      onEach();
    }
  };

  const workers = Math.min(CONCURRENCY, entries.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results.filter(Boolean);
}

async function downloadDocuments(entries, dir, warnings, onEach) {
  if (!entries.length) return [];
  const results = new Array(entries.length).fill(null);
  let cursor = 0;

  const worker = async () => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      const entry = entries[index];
      try {
        const { bytes, contentType } = await fetchBinary(entry.url);
        const extension = extensionFor(contentType, entry.url, 'pdf');
        const base = slugify(entry.title || 'document', 40);
        const name = String(index + 1).padStart(2, '0') + '-' + base + '.' + extension;
        results[index] = { path: dir + '/' + name, bytes };
      } catch (error) {
        warnings.push({ url: entry.url, error: String((error && error.message) || error) });
      }
      onEach();
    }
  };

  const workers = Math.min(CONCURRENCY, entries.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results.filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const LABELS = {
  FOR_SALE: 'For sale',
  FOR_RENT: 'For rent',
  BUY_REGULAR: 'Standard sale',
  RENT_REGULAR: 'Standard rental',
  APARTMENT: 'Apartment',
  HOUSE: 'House',
  PENTHOUSE: 'Penthouse',
  GROUND_FLOOR: 'Ground floor',
  DUPLEX: 'Duplex',
  TRIPLEX: 'Triplex',
  VILLA: 'Villa',
  MANSION: 'Mansion',
  CASTLE: 'Castle',
  CHALET: 'Chalet',
  BUNGALOW: 'Bungalow',
  COUNTRY_COTTAGE: 'Country cottage',
  FARMHOUSE: 'Farmhouse',
  TOWN_HOUSE: 'Town house',
  COTTAGE: 'Cottage',
  EXCEPTIONAL_PROPERTY: 'Exceptional property',
  MIXED_USE_BUILDING: 'Mixed-use building',
  APARTMENT_BLOCK: 'Apartment block',
  LOFT: 'Loft',
  SERVICE_FLAT: 'Service flat',
  STUDIO: 'Studio',
  STUDENT_APARTMENT: 'Student apartment',
  HOLIDAY_PROPERTY: 'Holiday property',
  BUSINESS_PROPERTY: 'Business property',
  INDUSTRIAL_PROPERTY: 'Industrial property',
  OFFICE: 'Office',
  RETAIL: 'Retail',
  WAREHOUSE: 'Warehouse',
  GARAGE: 'Garage',
  PARKING: 'Parking space',
  LAND: 'Land',
  OTHER_PROPERTY: 'Other property',
  AS_NEW: 'As new',
  GOOD: 'Good',
  NORMAL: 'Normal',
  TO_RENOVATE: 'To renovate',
  TO_BE_RENOVATED: 'To be renovated',
  TO_RESTORE: 'To restore',
  NEW: 'New',
  INSTALLED: 'Installed',
  HYPER_EQUIPPED: 'Hyper equipped',
  SEMI_EQUIPPED: 'Semi equipped',
  NOT_INSTALLED: 'Not installed',
  URBAN: 'Urban area',
  RURAL: 'Rural area',
  NON_FLOOD_ZONE: 'Not in a flood zone',
  AGENCY: 'Agency',
  SELLER: 'Private seller',
  N: 'North',
  S: 'South',
  E: 'East',
  W: 'West',
  NE: 'North-east',
  NW: 'North-west',
  SE: 'South-east',
  SW: 'South-west',
  NORTH: 'North',
  SOUTH: 'South',
  EAST: 'East',
  WEST: 'West',
  NORTH_EAST: 'North-east',
  NORTH_WEST: 'North-west',
  SOUTH_EAST: 'South-east',
  SOUTH_WEST: 'South-west',
  RES: 'Residential',
  CONNECTED: 'Connected',
  NOT_CONNECTED: 'Not connected',
  NOT_SPECIFIED: 'Not specified',
  YES_CONFORM: 'Yes, in conformity',
  NO_NOT_CONFORM: 'No, not in conformity',
};

function humanize(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  if (LABELS[text]) return LABELS[text];
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!words) return null;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * The canonical `description` is empty on some listings; the text only exists in
 * `alternativeDescriptions` ({nl: ..., fr: ...}), so fall back to that.
 */
function pickDescription(property, language) {
  const direct = property.description;
  if (typeof direct === 'string' && direct.trim()) {
    return { text: direct, language: language || null };
  }
  const alternatives = property.alternativeDescriptions;
  if (!alternatives || typeof alternatives !== 'object') return { text: null, language: null };
  const order = [language, 'en', 'nl', 'fr', 'de'].filter(Boolean);
  for (const key of order) {
    const value = alternatives[key];
    if (typeof value === 'string' && value.trim()) return { text: value, language: key };
  }
  for (const [key, value] of Object.entries(alternatives)) {
    if (typeof value === 'string' && value.trim()) return { text: value, language: key };
  }
  return { text: null, language: null };
}

function firstNumber(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = numberOrNull(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function boolOrNull(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const normalised = value.trim().toUpperCase();
    if (normalised === 'YES' || normalised === 'TRUE') return true;
    if (normalised === 'NO' || normalised === 'FALSE') return false;
  }
  return null;
}

/**
 * Immoweb is inconsistent about collections: `media.documents` is sometimes an
 * array, sometimes an object keyed by uuid; `floorPlans` may hold plain URL
 * strings. Everything that needs to be iterated goes through this.
 */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function formatEuro(value) {
  const number = numberOrNull(value);
  if (number === null) return null;
  try {
    return new Intl.NumberFormat('en-BE', {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: 0,
    }).format(number);
  } catch (error) {
    return '€' + Math.round(number).toLocaleString('en-US');
  }
}

function slugify(value, maxLength) {
  const slug = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const limit = maxLength || 60;
  return slug.slice(0, limit).replace(/-+$/, '') || 'listing';
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

function normalize(data, payload) {
  const property = data.property || {};
  const location = property.location || {};
  const transaction = data.transaction || {};
  const rental = transaction.rental || {};
  const sale = transaction.sale || {};
  const price = data.price || {};
  const certificates = transaction.certificates || {};
  const building = property.building || {};
  const media = data.media || {};
  const publication = data.publication || {};
  const flags = data.flags || {};

  const kind = /RENT/i.test(String(transaction.type || '')) ? 'for-rent' : 'for-sale';
  const language = price.language || payload.lang || null;
  const description = pickDescription(property, language);
  const livingArea = numberOrNull(property.netHabitableSurface);
  const mainValue = numberOrNull(price.mainValue);
  const monthlyRent = numberOrNull(rental.monthlyRentalPrice);
  const priceForPerSqm = kind === 'for-rent' ? monthlyRent : mainValue;

  const features = {};
  const featureFlags = {
    lift: 'hasLift',
    garden: 'hasGarden',
    terrace: 'hasTerrace',
    balcony: 'hasBalcony',
    swimmingPool: 'hasSwimmingPool',
    airConditioning: 'hasAirConditioning',
    basement: 'hasBasement',
    attic: 'hasAttic',
    dressingRoom: 'hasDressingRoom',
    diningRoom: 'hasDiningRoom',
    livingRoom: 'hasLivingRoom',
    laundryRoom: 'hasLaundryRoom',
    fireplace: 'fireplaceExists',
    disabledAccess: 'hasDisabledAccess',
    caretaker: 'hasCaretakerOrConcierge',
    fitnessRoom: 'hasFitnessRoom',
    tennisCourt: 'hasTennisCourt',
    sauna: 'hasSauna',
    jacuzzi: 'hasJacuzzi',
    hammam: 'hasHammam',
    barbecue: 'hasBarbecue',
    armoredDoor: 'hasArmoredDoor',
    visiophone: 'hasVisiophone',
    doorPhone: 'hasDoorPhone',
    alarm: 'hasSecureAccessAlarm',
    internet: 'hasInternet',
    cableTv: 'hasCableTV',
    firstOccupation: 'isFirstOccupation',
  };

  for (const [key, source] of Object.entries(featureFlags)) {
    const value = boolOrNull(property[source]);
    if (value !== null) features[key] = value;
  }

  // `specificities` is a string array on some listings and an object of flags
  // on others — flatten both into a readable list.
  const specificities = [];
  for (const value of toArray(property.specificities)) {
    if (typeof value === 'string' && value.trim()) specificities.push(value.trim());
  }
  if (property.specificities && !Array.isArray(property.specificities)) {
    for (const [key, value] of Object.entries(property.specificities)) {
      if (value === true) specificities.push(humanize(key));
      else if (typeof value === 'string' && value.trim()) {
        specificities.push(humanize(key) + ': ' + humanize(value));
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        specificities.push(humanize(key) + ': ' + value);
      }
    }
  }
  if (specificities.length) features.specificities = specificities;

  return {
    source: 'Immoweb',
    url: payload.url,
    id: data.id,
    externalReference: data.externalReference === undefined ? null : data.externalReference,
    cloudId: data.cloudId === undefined ? null : data.cloudId,
    capturedAt: payload.capturedAt || new Date().toISOString(),
    language,
    transaction: {
      type: transaction.type || null,
      typeLabel: humanize(transaction.type),
      subtype: transaction.subtype || null,
      subtypeLabel: humanize(transaction.subtype),
      kind,
      availabilityDate: transaction.availabilityDate || null,
      availabilityPeriodType: transaction.availabilityPeriodType || null,
      status: flags.isSoldOrRented ? 'sold-or-rented' : 'available',
    },
    price: {
      display: price.mainDisplayPrice || formatEuro(mainValue),
      value: mainValue,
      currency: 'EUR',
      label: price.label || null,
      oldValue: numberOrNull(price.oldValue),
      oldDisplay: price.oldDisplayPrice || null,
      hidden: Boolean(price.hidePrice),
      pricePerSqm: numberOrNull(sale.pricePerSqm),
      computedPricePerSqm:
        priceForPerSqm !== null && livingArea ? Math.round(priceForPerSqm / livingArea) : null,
      cadastralIncome: numberOrNull(sale.cadastralIncome),
      subjectToVat: boolOrNull(sale.isSubjectToVat),
      isFurnished: boolOrNull(sale.isFurnished),
      rent:
        kind === 'for-rent'
          ? {
              monthly: monthlyRent,
              monthlyCosts: numberOrNull(rental.monthlyRentalCosts),
              excludingCharges: numberOrNull(rental.amountExcludingChargesAmount),
              yearly: numberOrNull(rental.yearlyRentalPrice),
              furnished: boolOrNull(rental.isFurnished),
              smallPetsAllowed: boolOrNull(rental.areSmallPetsAllowed),
              bigPetsAllowed: boolOrNull(rental.areBigPetsAllowed),
            }
          : null,
    },
    property: {
      type: property.type || null,
      typeLabel: humanize(property.type),
      subtype: property.subtype || null,
      subtypeLabel: humanize(property.subtype),
      title: property.title || null,
      name: property.name || null,
      description: description.text,
      descriptionLanguage: description.language,
      livingArea,
      plotArea: firstNumber(property.land, ['surface', 'surfaceOfPlot', 'area', 'plotSurface']),
      plotWidth: numberOrNull(property.land && property.land.landWidth),
      plotUse: humanize(property.land && property.land.latestUseDesignation),
      plotFlat: boolOrNull(property.land && property.land.isFlat),
      plotWooded: boolOrNull(property.land && property.land.isWooded),
      plotFacingStreet: boolOrNull(property.land && property.land.isFacingStreet),
      plotToRear: boolOrNull(property.land && property.land.hasPlotToRear),
      sewerConnection: humanize(property.land && property.land.sewerConnection),
      gardenArea: numberOrNull(property.gardenSurface),
      gardenOrientation: property.gardenOrientation || null,
      terraceArea: numberOrNull(property.terraceSurface),
      terraceOrientation: property.terraceOrientation || null,
      bedrooms: numberOrNull(property.bedroomCount),
      bedroomSurfaces: toArray(property.bedrooms)
        .map((bedroom) => numberOrNull(bedroom && bedroom.surface))
        .filter((value) => value !== null),
      bathrooms: numberOrNull(property.bathroomCount),
      showerRooms: numberOrNull(property.showerRoomCount),
      toilets: numberOrNull(property.toiletCount),
      rooms: numberOrNull(property.roomCount),
      floor: numberOrNull(location.floor),
      floorCount: numberOrNull(building.floorCount),
      constructionYear: numberOrNull(building.constructionYear),
      condition: building.condition || null,
      conditionLabel: humanize(building.condition),
      facadeCount: numberOrNull(building.facadeCount),
      streetFacadeWidth: numberOrNull(building.streetFacadeWidth),
      annexCount: numberOrNull(building.annexCount),
      heritageProtected: boolOrNull(building.isHeritageProtected),
      basementSurface: numberOrNull(property.basement && property.basement.surface),
      monthlyCosts: numberOrNull(property.monthlyCosts),
      habitableUnits: numberOrNull(property.habitableUnitCount),
      kitchen: property.kitchen
        ? {
            type: property.kitchen.type || null,
            typeLabel: humanize(property.kitchen.type),
            surface: numberOrNull(property.kitchen.surface),
            equipped: boolOrNull(property.kitchen.isFullyEquipped),
          }
        : null,
      livingRoomSurface: numberOrNull(property.livingRoom && property.livingRoom.surface),
      parking: {
        indoor: numberOrNull(property.parkingCountIndoor),
        outdoor: numberOrNull(property.parkingCountOutdoor),
        closedBox: numberOrNull(property.parkingCountClosedBox),
      },
      features,
    },
    location: {
      street: location.street || null,
      number: location.number || null,
      box: location.box || null,
      postalCode: location.postalCode || null,
      locality: location.locality || null,
      district: location.district || null,
      province: location.province || null,
      region: location.region || null,
      country: location.country || null,
      propertyName: location.propertyName || null,
      areaType: location.type || null,
      floor: numberOrNull(location.floor),
      latitude: numberOrNull(location.latitude),
      longitude: numberOrNull(location.longitude),
      seaView: boolOrNull(location.hasSeaView),
      address:
        [location.street, location.number, location.box && 'box ' + location.box]
          .filter(Boolean)
          .join(' ') || null,
    },
    energy: {
      epcScore: certificates.epcScore || null,
      energyPerSqmYear: numberOrNull(certificates.primaryEnergyConsumptionPerSqm),
      energyPerYear: numberOrNull(certificates.primaryEnergyConsumptionYearly),
      epcReference: certificates.epcReference || null,
      carbonEmission: numberOrNull(certificates.carbonEmission),
      renovationObligation: boolOrNull(certificates.renovationObligation),
      epcImageUrl: certificates.epcUrl || null,
    },
    heating: property.energy
      ? {
          type: property.energy.heatingType || null,
          typeLabel: humanize(property.energy.heatingType),
          heatPump: boolOrNull(property.energy.hasHeatPump),
          photovoltaicPanels: boolOrNull(property.energy.hasPhotovoltaicPanels),
          thermicPanels: boolOrNull(property.energy.hasThermicPanels),
          doubleGlazing: boolOrNull(property.energy.hasDoubleGlazing),
          collectiveWaterHeater: boolOrNull(property.energy.hasCollectiveWaterHeater),
          performance: numberOrNull(property.energy.performance),
        }
      : null,
    certificates: {
      asbestosCertificate: boolOrNull(property.propertyCertificates && property.propertyCertificates.hasAsbestosCertificate),
      builtPlanStatus: humanize(property.propertyCertificates && property.propertyCertificates.builtPlanStatus),
      oilTankCertificate: humanize(property.propertyCertificates && property.propertyCertificates.oilTankCertificateStatus),
      electricalCertificate: boolOrNull(
        property.propertyCertificates && property.propertyCertificates.hasElectricalInstallationComplianceCertificate
      ),
      floodZoneType: (property.constructionPermit && property.constructionPermit.floodZoneType) || null,
      floodZoneLabel: humanize(property.constructionPermit && property.constructionPermit.floodZoneType),
      urbanPlanningScore: (property.constructionPermit && property.constructionPermit.pScore) || null,
      buildingScore: (property.constructionPermit && property.constructionPermit.gScore) || null,
      constructionPermitObtained: boolOrNull(property.constructionPermit && property.constructionPermit.isObtained),
      renovationObligation: boolOrNull(certificates.renovationObligation),
    },
    agency: toArray(data.customers)
      .filter((customer) => customer && typeof customer === 'object')
      .map((customer) => ({
      name: customer.name || null,
      type: customer.type || null,
      typeLabel: /^AGENCY/i.test(String(customer.type || '')) ? 'Agency' : humanize(customer.type),
      phone: customer.phoneNumber || null,
      mobile: customer.mobileNumber || null,
      email: customer.email || null,
      website: customer.website || null,
      ipiNumber: customer.ipiNo || null,
      address:
        [
          customer.location && customer.location.street,
          customer.location && customer.location.postalCode,
          customer.location && customer.location.locality,
        ]
          .filter(Boolean)
          .join(', ') || null,
      agent: customer.agent
        ? {
            name: [customer.agent.firstName, customer.agent.lastName].filter(Boolean).join(' ') || null,
            email: customer.agent.email || null,
            phone: customer.agent.phoneNumber || null,
          }
        : null,
    })),
    publication: {
      created: publication.creationDate || null,
      lastModification: publication.lastModificationDate || null,
      expiration: publication.expirationDate || null,
    },
    media: {
      pictureCount: toArray(media.pictures).length,
      floorPlanCount: toArray(media.floorPlans).length,
      documentCount: toArray(media.documents).length,
      virtualTourUrl: media.virtualTourUrl || null,
      virtualExperienceUrl: media.virtualExperienceUrl || null,
      videoUrl: media.externalVideoUrl || null,
    },
    flags: {
      isNew: boolOrNull(flags.isNewClassified),
      isNewPrice: boolOrNull(flags.isNewPrice),
      isSoldOrRented: boolOrNull(flags.isSoldOrRented),
      isInvestmentProject: boolOrNull(flags.isInvestmentProject),
      isNotarySale: boolOrNull(flags.isNotarySale),
      isLifeAnnuitySale: boolOrNull(flags.isLifeAnnuitySale),
      isPublicSale: boolOrNull(flags.isPublicSale),
      isNewlyBuilt: boolOrNull(flags.isNewlyBuilt),
    },
    investor: transaction.investor
      ? {
          isInvestmentProperty: boolOrNull(transaction.investor.isInvestmentProperty),
          currentMonthlyRentalIncome: numberOrNull(transaction.investor.currentMonthlyRentalIncome),
          expectedMonthlyRentalIncome: numberOrNull(transaction.investor.expectedMonthlyRentalIncome),
          currentReturnOnInvestment: numberOrNull(transaction.investor.currentReturnOnInvestment),
          expectedReturnOnInvestment: numberOrNull(transaction.investor.expectedReturnOnInvestment),
          occupancyRate: numberOrNull(transaction.investor.occupancyRate),
        }
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * Immoscoop
 * ------------------------------------------------------------------ */

/**
 * Immoscoop is a Next.js app; `pageProps.property` carries the listing. It is
 * shaped completely differently from Immoweb's: the numbers live in a flat
 * `features` array plus prose detail groups ("Gebouw › Bouwjaar: 2017"), so
 * everything numeric is parsed out of Dutch labels.
 */
const SCOOP_SIZE_KEYS = { extra: '1536', large: '1280', medium: '768', small: '320' };

const SCOOP_TYPE_TOKENS = {
  appartement: 'APARTMENT',
  studio: 'STUDIO',
  duplex: 'DUPLEX',
  penthouse: 'PENTHOUSE',
  loft: 'LOFT',
  huis: 'HOUSE',
  woning: 'HOUSE',
  eengezinswoning: 'HOUSE',
  villa: 'VILLA',
  bungalow: 'BUNGALOW',
  chalet: 'CHALET',
  hoeve: 'FARMHOUSE',
  kasteel: 'CASTLE',
  grond: 'LAND',
  bouwgrond: 'LAND',
  garage: 'GARAGE',
  parking: 'PARKING',
  kantoor: 'OFFICE',
  handelspand: 'RETAIL',
  winkel: 'RETAIL',
  magazijn: 'WAREHOUSE',
  opbrengsteigendom: 'APARTMENT_BLOCK',
  serviceflat: 'SERVICE_FLAT',
  kot: 'STUDENT_APARTMENT',
  // French labels, same site
  maison: 'HOUSE',
  terrain: 'LAND',
  'maison de rapport': 'APARTMENT_BLOCK',
};

/**
 * Immoscoop descriptions are HTML fragments (`<br />`, `<span><strong>…`), and
 * the summary sheet plus the viewer both render plain text.
 */
function plainText(value) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

/** Flattens `propertyDetailGroups` into [{ group, title, value }]. */
function scoopDetails(property) {
  const out = [];
  for (const group of toArray(property && property.propertyDetailGroups)) {
    const groupName = (group && group.group) || '';
    for (const item of toArray(group && group.propertyDetails)) {
      if (!item || typeof item !== 'object') continue;
      const value = item.description === undefined || item.description === null
        ? ''
        : String(item.description).trim();
      if (!value) continue;
      out.push({ group: groupName, title: String(item.title || '').trim(), value });
    }
  }
  return out;
}

/** First detail value whose title matches exactly, then by prefix. */
function scoopDetail(details, title) {
  const wanted = String(title).toLowerCase();
  const exact = details.find((entry) => entry.title.toLowerCase() === wanted);
  if (exact) return exact.value;
  const prefixed = details.find((entry) => entry.title.toLowerCase().startsWith(wanted));
  return prefixed ? prefixed.value : null;
}

/** "195 m²" → 195, "57" → 57, "1.250.000" → 1250000, "15 m²; 13 m²" → 15. */function scoopNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || value === '') return null;
  const text = String(value)
    .replace(/\s/g, '')
    .replace(/(\d)[.,](?=\d{3}\b)/g, '$1');
  const match = /-?\d+(?:[.,]\d+)?/.exec(text);
  if (!match) return null;
  const number = Number(match[0].replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

/** Every number in a list-ish string: "15 m²; 13 m²" → [15, 13]. */
function scoopNumbers(value) {
  if (value === null || value === undefined || value === '') return [];
  return String(value)
    .split(/[;,/]|\ben\b|\bet\b/)
    .map((part) => scoopNumber(part))
    .filter((number) => number !== null);
}

/** "Ja" → true, "Nee" → false, anything else → null. */
function scoopFlag(value) {
  if (value === true || value === false) return value;
  const text = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  if (!text) return null;
  if (/^(ja|yes|oui)\b/.test(text)) return true;
  if (/^(nee|neen|no|non)\b/.test(text)) return false;
  return null;
}

/** Electrical certificates say "Ja, conform" / "Nee, niet conform". */
function scoopConformity(value) {
  const text = String(value === null || value === undefined ? '' : value).toLowerCase();
  if (!text) return null;
  if (/niet\s+conform|non\s+conforme/.test(text)) return false;
  if (/conform/.test(text)) return true;
  return null;
}

function scoopFeature(property, id) {
  const entry = toArray(property && property.features).find(
    (feature) => feature && String(feature.id).toLowerCase() === String(id).toLowerCase()
  );
  return entry ? entry.value : null;
}

function scoopNumberFromDetail(details, title) {
  return scoopNumber(scoopDetail(details, title));
}

function scoopTypeToken(label) {
  const text = String(label || '').trim().toLowerCase();
  if (!text) return null;
  if (SCOOP_TYPE_TOKENS[text]) return SCOOP_TYPE_TOKENS[text];
  const first = text.split(/[\s/]+/)[0];
  if (SCOOP_TYPE_TOKENS[first]) return SCOOP_TYPE_TOKENS[first];
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || null;
}

function normalizeScoop(property, payload) {
  const details = scoopDetails(property);
  const detail = (title) => scoopDetail(details, title);
  const kind = /(huur|louer|rent)/i.test(String((property.offerType && property.offerType.slug) || ''))
    ? 'for-rent'
    : 'for-sale';

  const address = property.address || {};
  const geo = address.geo || {};
  const houseNumber = address.houseNumber || {};
  const street = address.street ? String(address.street).trim() : null;
  const number = houseNumber.number === undefined || houseNumber.number === null
    ? null
    : String(houseNumber.number);
  const box = houseNumber.extension === undefined || houseNumber.extension === null
    ? null
    : String(houseNumber.extension);
  const postalCode = address.postalCode === undefined || address.postalCode === null
    ? null
    : String(address.postalCode);
  const locality =
    (address.city && address.city.label) ||
    (address.municipality && address.municipality.label) ||
    null;

  const rawType = (property.propertyType && property.propertyType.label) || null;
  const typeToken = scoopTypeToken(rawType);
  const rawSubtype =
    detail('Subtype') ||
    (Array.isArray(property.enhancedFeatureValues && property.enhancedFeatureValues.propertySubtypes)
      ? toArray(property.enhancedFeatureValues.propertySubtypes)[0]
      : null) ||
    null;
  const subtypeToken = rawSubtype ? scoopTypeToken(rawSubtype) : null;

  const livingArea =
    numberOrNull(scoopFeature(property, 'livableSurfaceArea')) ??
    scoopNumberFromDetail(details, 'Bewoonbare oppervlakte');
  const plotArea =
    numberOrNull(scoopFeature(property, 'TerrainArea')) ??
    scoopNumberFromDetail(details, 'Perceeloppervlakte');

  const priceLabel = (property.price && property.price.label) || null;
  const priceValue =
    numberOrNull(property.price && property.price.slug) ?? scoopNumber(priceLabel);
  const priceForPerSqm = kind === 'for-rent' ? priceValue : priceValue;

  const heatingType = detail('Type verwarming');

  const features = {};
  const flag = (key, value) => {
    if (value === true || value === false) features[key] = value;
  };
  flag('terrace', scoopFlag(detail('Terras')));
  flag('lift', scoopFlag(detail('Lift')));
  flag('basement', scoopFlag(detail('Kelder')));
  flag('attic', scoopFlag(detail('Zolder')));
  flag('garden', scoopFlag(detail('Tuin')));
  flag('swimmingPool', scoopFlag(detail('Zwembad')));
  flag('airConditioning', scoopFlag(detail('Airconditioning')));
  flag('alarm', scoopFlag(detail('Alarm')));
  flag('fitnessRoom', scoopFlag(detail('Fitnessruimte')));
  flag('sauna', scoopFlag(detail('Sauna')));
  flag('disabledAccess', scoopFlag(detail('Toegankelijk voor mindervaliden')));
  flag('parking', scoopFlag(detail('Parking binnen')) ?? scoopFlag(scoopFeature(property, 'ParkingAvailable')));
  features.specificities = details.map((entry) => entry.group + ' · ' + entry.title + ': ' + entry.value);

  const agent = property.agent || {};
  const hasAgent = Boolean(agent.name || agent.email || agent.phone);

  return {
    source: 'Immoscoop',
    url: payload.url,
    id: property.id || null,
    externalReference:
      property.canonicalId === undefined || property.canonicalId === null
        ? null
        : String(property.canonicalId),
    cloudId: null,
    capturedAt: payload.capturedAt || new Date().toISOString(),
    language: property.descriptionLanguage || payload.lang || null,
    transaction: {
      type: (property.offerType && property.offerType.slug) || null,
      typeLabel: kind === 'for-rent' ? 'For rent' : 'For sale',
      subtype: null,
      subtypeLabel: null,
      kind,
      availabilityDate: null,
      availabilityPeriodType: null,
      status: property.offline === true ? 'offline' : 'available',
    },
    price: {
      display: priceLabel,
      value: priceValue,
      currency: 'EUR',
      label: priceLabel,
      oldValue: null,
      oldDisplay: null,
      hidden: priceValue === null,
      pricePerSqm: null,
      computedPricePerSqm:
        priceForPerSqm !== null && livingArea ? Math.round(priceForPerSqm / livingArea) : null,
      cadastralIncome: scoopNumberFromDetail(details, 'Kadastraal inkomen'),
      subjectToVat: scoopFlag(detail('BTW van toepassing')),
      isFurnished: kind === 'for-rent' ? scoopFlag(detail('Gemeubeld')) : null,
      rent:
        kind === 'for-rent'
          ? {
              monthly: priceValue,
              monthlyCosts: scoopNumberFromDetail(details, 'Maandelijkse kosten'),
              excludingCharges: scoopNumberFromDetail(details, 'Kosten (exclusief)'),
              yearly: null,
              furnished: scoopFlag(detail('Gemeubeld')),
              smallPetsAllowed: scoopFlag(detail('Kleine huisdieren toegelaten')),
              bigPetsAllowed: scoopFlag(detail('Grote huisdieren toegelaten')),
            }
          : null,
    },
    property: {
      type: typeToken,
      typeLabel: humanize(typeToken) || rawType,
      subtype: subtypeToken,
      subtypeLabel: humanize(subtypeToken) || rawSubtype,
      typeRaw: rawType,
      title: property.title || null,
      name: null,
      description: plainText(property.description),
      descriptionTitle: property.descriptionTitle || null,
      descriptionLanguage: property.descriptionLanguage || null,
      livingArea,
      plotArea,
      plotWidth: scoopNumberFromDetail(details, 'Breedte perceel'),
      plotUse: detail('Meest recente bestemming terrein'),
      plotFlat: scoopFlag(detail('Vlak terrein')),
      plotWooded: scoopFlag(detail('Bebost terrein')),
      plotFacingStreet: scoopFlag(detail('Terrein grenst aan straat')),
      plotToRear: null,
      sewerConnection:
        scoopFlag(detail('Aansluiting riolering')) === true
          ? 'Connected'
          : scoopFlag(detail('Aansluiting riolering')) === false
            ? 'Not connected'
            : null,
      gardenArea: scoopNumberFromDetail(details, 'Oppervlakte tuin'),
      gardenOrientation: detail('Oriëntatie tuin'),
      terraceArea: scoopNumberFromDetail(details, 'Oppervlakte terras'),
      terraceOrientation: detail('Oriëntatie terras'),
      bedrooms:
        numberOrNull(scoopFeature(property, 'BedroomNumber')) ??
        scoopNumberFromDetail(details, 'Aantal slaapkamers'),
      bedroomSurfaces: scoopNumbers(detail('Oppervlakte slaapkamers')),
      bathrooms:
        numberOrNull(scoopFeature(property, 'BathroomNumber')) ??
        scoopNumberFromDetail(details, 'Aantal badkamers'),
      bathroomsSurface: scoopNumberFromDetail(details, 'Oppervlakte badkamer'),
      showerRooms: scoopNumberFromDetail(details, 'Aantal douchekamers'),
      toilets: scoopNumberFromDetail(details, 'Aantal toiletten'),
      rooms: scoopNumberFromDetail(details, 'Aantal leefruimtes'),
      floor: scoopNumberFromDetail(details, 'Verdieping'),
      floorCount: scoopNumberFromDetail(details, 'Aantal verdiepingen'),
      constructionYear: scoopNumberFromDetail(details, 'Bouwjaar'),
      condition: null,
      conditionLabel: detail('Staat') || detail('Conditie'),
      facadeCount: scoopNumberFromDetail(details, 'Aantal gevels'),
      streetFacadeWidth: scoopNumberFromDetail(details, 'Breedte voorgevel'),
      annexCount: scoopNumberFromDetail(details, 'Aantal bijgebouwen'),
      heritageProtected: scoopFlag(detail('Beschermd erfgoed')),
      basementSurface: scoopNumberFromDetail(details, 'Oppervlakte kelder'),
      monthlyCosts: scoopNumberFromDetail(details, 'Maandelijkse kosten'),
      habitableUnits: null,
      kitchen: {
        type: detail('Type keuken'),
        typeLabel: detail('Type keuken'),
        surface: scoopNumberFromDetail(details, 'Oppervlakte keuken'),
        equipped: scoopFlag(detail('Keuken')),
      },
      livingRoomSurface: scoopNumberFromDetail(details, 'Oppervlakte leefruimte'),
      parking: {
        indoor: scoopNumberFromDetail(details, 'Parkeerplaatsen binnen'),
        outdoor: scoopNumberFromDetail(details, 'Parkeerplaatsen buiten'),
        closedBox: null,
      },
      features,
    },
    location: {
      street,
      number,
      box,
      postalCode,
      locality,
      district: null,
      province: null,
      region: (address.region && address.region.name) || null,
      country: 'Belgium',
      propertyName: null,
      areaType: null,
      surroundings: detail('Omgeving / buurt'),
      floor: scoopNumberFromDetail(details, 'Verdieping'),
      latitude: numberOrNull(geo.lat),
      longitude: numberOrNull(geo.long),
      seaView: scoopFlag(detail('Zeezicht')),
      // Immoscoop hides the exact address on some listings (address.visible).
      exact: Boolean(address.visible === true && (geo.lat || geo.lng)),
      // Street-based, like Immoweb's; postal code and city have their own fields.
      address:
        [street, number, box && 'box ' + box].filter(Boolean).join(' ') || null,
    },
    energy: {
      epcScore: scoopFeature(property, 'EpcClass') || detail('EPC-label') || null,
      energyPerSqmYear: scoopNumberFromDetail(details, 'EPC-score (kWh/(m² jaar))'),
      energyPerYear: null,
      epcReference: detail('Unieke code EPC'),
      epcValidUntil: detail('Vervaldatum EPC'),
      carbonEmission: null,
      renovationObligation: scoopFlag(detail('Renovatieverplichting')),
      epcImageUrl: null,
    },
    heating: {
      type: heatingType ? String(heatingType).toUpperCase().replace(/[^A-Z0-9]+/g, '_') : null,
      typeLabel: heatingType || null,
      heatPump: heatingType ? /warmtepomp|heat\s*pump|pompe\s*à\s*chaleur/i.test(heatingType) : null,
      photovoltaicPanels: scoopFlag(detail('Zonnepanelen')),
      thermicPanels: scoopFlag(detail('Zonneboiler')),
      doubleGlazing: scoopFlag(detail('Dubbele beglazing')),
      collectiveWaterHeater: scoopFlag(detail('Collectieve boiler')),
      performance: null,
    },
    certificates: {
      asbestosCertificate: scoopFlag(detail('Asbestattest')),
      builtPlanStatus: detail('Stedenbouwkundige vergunning'),
      oilTankCertificate: detail('Certificaat olietank'),
      electricalCertificate: scoopConformity(detail('Keuringsattest elektriciteit')),
      floodZoneLabel: detail('Overstromingsgevoelig gebied'),
      urbanPlanningScore: detail('P(erceel)-score'),
      buildingScore: detail('G(ebouw)-score'),
      constructionPermitObtained: scoopFlag(detail('Bouwvergunning')),
      renovationObligation: scoopFlag(detail('Renovatieverplichting')),
    },
    agency: hasAgent
      ? [
          {
            name: agent.name || null,
            type: 'AGENCY',
            typeLabel: 'Agency',
            phone: agent.phone || null,
            mobile: null,
            email: agent.email || null,
            website: agent.website || null,
            ipiNumber: null,
            address: agent.address || null,
            logo: (agent.logo && agent.logo.url) || null,
            description: agent.description || null,
          },
        ]
      : [],
    publication: {
      created: null,
      lastModification: null,
      expiration: property.scoopDeadline || null,
    },
    media: {
      pictureCount: toArray(property.images).length,
      floorPlanCount: 0,
      documentCount: 0,
      virtualTourUrl: null,
      virtualExperienceUrl: null,
      videoUrl: null,
    },
    flags: {
      isNew: null,
      isNewPrice: null,
      isSoldOrRented: property.offline === true ? true : null,
      isInvestmentProject: null,
      isNotarySale: null,
      isLifeAnnuitySale: null,
      isPublicSale: null,
      isNewlyBuilt: null,
      isPrivateAd: property.isPrivateAd === true ? true : null,
      isScoopDeal: property.scoop === true ? true : null,
    },
    investor:
      property.enhancedFeatureValues && property.enhancedFeatureValues.isInvestmentProperty !== undefined
        ? {
            isInvestmentProperty: boolOrNull(property.enhancedFeatureValues.isInvestmentProperty),
            currentMonthlyRentalIncome: null,
            expectedMonthlyRentalIncome: null,
            currentReturnOnInvestment: null,
            expectedReturnOnInvestment: null,
            occupancyRate: null,
          }
        : null,
    // Every detail group, verbatim — the raw material for the summary sheet.
    details: details.map((entry) => ({
      group: entry.group,
      title: entry.title,
      value: entry.value,
    })),
    note:
      address.visible === true
        ? null
        : 'Immoscoop does not publish the exact address of this listing, so the archive has no coordinates.',
  };
}

/** Immoscoop photos carry a `sizes` map; pick the same size the user asked for. */
function scoopPictureUrl(image, opts) {
  if (!image) return null;
  if (typeof image === 'string') return /^https?:/.test(image) ? image : null;
  const sizes = image.sizes || {};
  const preferred = SCOOP_SIZE_KEYS[opts.photoSize] || SCOOP_SIZE_KEYS.extra;
  const order = [preferred, '1536', '1280', '1024', '768', '640', '320'];
  for (const key of order) {
    const value = sizes[key];
    if (typeof value === 'string' && /^https?:/.test(value)) return value;
  }
  return typeof image.url === 'string' && /^https?:/.test(image.url) ? image.url : null;
}

function collectScoopPictures(data, payload, opts, usedUrls) {
  const out = [];
  const seen = usedUrls || new Set();
  const push = (url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url });
  };

  for (const image of toArray(data && data.images)) push(scoopPictureUrl(image, opts));

  if (!out.length && payload.fallback) {
    if (payload.fallback.ogImage) push(payload.fallback.ogImage);
    for (const url of toArray(payload.fallback.images)) push(url);
  }

  return out;
}

/**
 * Used when the structured listing JSON is unavailable (page variants, partial
 * loads): build a lean record out of the DOM fallback instead of failing.
 */
function normalizeFallback(payload) {
  const fallback = payload.fallback || {};
  const scoop = payload.site === 'immoscoop';
  return {
    source: scoop ? 'Immoscoop' : 'Immoweb',
    url: payload.url,
    id: (/\/(\d{4,})(?:[/?#]|$)/.exec(payload.url || '') || [])[1] || null,
    capturedAt: payload.capturedAt || new Date().toISOString(),
    language: payload.lang || null,
    partial: true,
    transaction: {
      kind: /for-rent|\/rent\/|te-huur|a-louer/i.test(payload.url || '') ? 'for-rent' : 'for-sale',
      type: null,
      typeLabel: null,
    },
    price: { display: fallback.priceText || null, value: null },
    property: {
      title: fallback.title || payload.title || null,
      description: fallback.description || null,
    },
    location: { address: fallback.address || null },
    media: { pictureCount: (fallback.images || []).length },
    note: 'Only the page itself could be read (no structured listing data), so this archive is partial.',
  };
}

/** Immoweb sometimes only fills in the property type, e.g. title = "House". */
function displayTitle(info) {
  const property = info.property || {};
  const location = info.location || {};
  const raw = property.title || property.name || '';
  const generic = /^(apartment|house|studio|land|garage|villa|penthouse|ground floor|duplex)$/i.test(raw);
  if (raw && !generic) return raw;
  const kind = info.transaction && info.transaction.kind === 'for-rent' ? ' for rent' : ' for sale';
  const type = property.subtypeLabel || property.typeLabel || 'Property';
  const place = location.locality ? ' in ' + location.locality : '';
  const postal = location.postalCode ? ' (' + location.postalCode + ')' : '';
  return (type + kind + place + postal).trim();
}

/**
 * Folder/zip name, address first: "Maria Claessensplein 5  2050 — Antwerpen".
 * Falls back to the old id-based scheme when a listing has no usable address.
 */
function addressLabel(info) {
  const location = info.location || {};
  const street = [location.street, location.number].filter(Boolean).join(' ');
  const box = location.box ? ' box ' + location.box : '';
  const postal = location.postalCode ? String(location.postalCode) : '';
  const city = smartCase(location.locality || '');
  const head = (street + box).trim();

  if (head && (postal || city)) {
    return head + '  ' + [postal, city].filter(Boolean).join(' — ');
  }
  if (head) return head;
  // Fallback payloads only carry a pre-formatted address string.
  const raw = String(location.address || location.propertyName || '').trim();
  if (raw) return raw;
  if (postal || city) return [postal, city].filter(Boolean).join(' — ');
  return '';
}

/** Immoweb sometimes shouts the city name ("ANTWERPEN") — normalise that only. */
function smartCase(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text !== text.toUpperCase()) return text;
  return text
    .toLowerCase()
    .replace(/(^|[\s\-'])([a-z\u00e0-\u00ff])/g, (match, separator, letter) => separator + letter.toUpperCase());
}

/** Strips everything Windows/macOS refuse in a file name. */
function safeFilename(value) {
  let name = String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (name.length > 120) name = name.slice(0, 120).replace(/[\s.-]+$/, '');
  return name;
}

function folderName(info) {
  const label = safeFilename(addressLabel(info));
  if (label.length >= 3) return label;

  const id = info.id || 'listing';
  const kind = (info.transaction && info.transaction.kind) || 'listing';
  const subtype = slugify(
    (info.property && (info.property.subtype || info.property.type)) || '',
    24
  );
  const place = slugify(
    (info.location &&
      (info.location.locality ||
        info.location.postalCode ||
        (info.location.address && info.location.address.split(',')[0]))) ||
      '',
    28
  );
  const postal = info.location && info.location.postalCode ? String(info.location.postalCode) : '';
  const parts = [id, kind];
  if (subtype && subtype !== 'listing') parts.push(subtype);
  if (place) parts.push(place);
  if (postal) parts.push(postal);
  return parts.join('-');
}

/* ------------------------------------------------------------------ *
 * Human-readable output
 * ------------------------------------------------------------------ */

function buildSummary(info) {
  const property = info.property || {};
  const location = info.location || {};
  const price = info.price || {};
  const lines = [];
  const push = (line) => lines.push(line === undefined ? '' : line);

  const meta = (label, value, unit) => {
    if (value === null || value === undefined || value === '' || value === false) {
      if (value === false) {
        push('- **' + label + ':** No');
      }
      return;
    }
    push('- **' + label + ':** ' + value + (unit || ''));
  };
  const yesNo = (label, value) => {
    if (value === true) push('- **' + label + ':** Yes');
    else if (value === false) push('- **' + label + ':** No');
  };
  const area = (label, value) => meta(label, value, ' m²');

  const title = info.displayTitle || displayTitle(info) || 'Immoweb listing ' + (info.id || '');
  push('# ' + title);
  push();
  const headline = [];
  if (price.display) headline.push('**' + price.display + '**');
  if (info.transaction && info.transaction.typeLabel) headline.push(info.transaction.typeLabel);
  const typeBits = [property.typeLabel, property.subtypeLabel]
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
  if (typeBits.length) headline.push(typeBits.join(' · '));
  if (location.locality) {
    headline.push(
      [location.postalCode, location.locality].filter(Boolean).join(' ')
    );
  }
  if (headline.length) {
    push(headline.join(' — '));
    push();
  }
  push((info.source || 'Immoweb') + ' listing ' + (info.id || '?') + ' · saved ' + (info.capturedAt || ''));
  if (info.url) push('<' + info.url + '>');
  push();

  push('## Price');
  meta('Asking price', price.display);
  if (!price.display) meta('Price (raw value)', price.value);
  if (price.rent) {
    meta('Monthly rent', formatEuro(price.rent.monthly));
    meta('Monthly charges', formatEuro(price.rent.monthlyCosts));
    meta('Excluding charges', formatEuro(price.rent.excludingCharges));
    meta('Yearly rent', formatEuro(price.rent.yearly));
    yesNo('Furnished', price.rent.furnished);
    yesNo('Small pets allowed', price.rent.smallPetsAllowed);
    yesNo('Big pets allowed', price.rent.bigPetsAllowed);
  }
  meta('Price per m²', formatEuro(price.pricePerSqm));
  meta('Price per m² (computed)', formatEuro(price.computedPricePerSqm));
  meta('Old price', price.oldDisplay || formatEuro(price.oldValue));
  meta('Cadastral income', formatEuro(price.cadastralIncome));
  yesNo('Subject to VAT', price.subjectToVat);
  yesNo('Price hidden on the listing site', price.hidden);
  if (price.note) meta('Note', price.note);
  push();

  push('## Property');
  meta('Type', property.typeLabel);
  meta('Subtype', property.subtypeLabel);
  meta('Living area (net habitable)', property.livingArea, ' m²');
  meta('Plot area', property.plotArea, ' m²');
  meta('Garden', property.gardenArea, ' m²');
  meta('Garden orientation', humanize(property.gardenOrientation));
  meta('Terrace', property.terraceArea, ' m²');
  meta('Terrace orientation', humanize(property.terraceOrientation));
  meta('Bedrooms', property.bedrooms);
  if (property.bedroomSurfaces && property.bedroomSurfaces.length) {
    meta(
      'Bedroom surfaces',
      property.bedroomSurfaces.join(' m² · ') + ' m²'
    );
  }
  meta('Bathrooms', property.bathrooms);
  meta('Shower rooms', property.showerRooms);
  meta('Toilets', property.toilets);
  meta('Rooms (total)', property.rooms);
  meta('Living room', property.livingRoomSurface, ' m²');
  if (property.kitchen) {
    meta('Kitchen', property.kitchen.typeLabel || property.kitchen.type);
    meta('Kitchen surface', property.kitchen.surface, ' m²');
  }
  meta('Floor', property.floor);
  meta('Floors in building', property.floorCount);
  meta('Construction year', property.constructionYear);
  meta('Condition', property.conditionLabel || property.condition);
  meta('Facades', property.facadeCount);
  meta('Street facade width', property.streetFacadeWidth, ' m');
  meta('Basement', property.basementSurface, ' m²');
  meta('Monthly costs / charges', formatEuro(property.monthlyCosts));
  yesNo('Heritage protected', property.heritageProtected);
  push();

  const parking = property.parking || {};
  const hasParking = parking.indoor || parking.outdoor || parking.closedBox;
  push('## Outdoor, parking & comfort');
  meta('Parking indoor', parking.indoor);
  meta('Parking outdoor', parking.outdoor);
  meta('Parking (closed box)', parking.closedBox);
  const features = property.features || {};
  const featureLabels = {
    lift: 'Lift',
    garden: 'Garden',
    terrace: 'Terrace',
    balcony: 'Balcony',
    swimmingPool: 'Swimming pool',
    airConditioning: 'Air conditioning',
    basement: 'Basement',
    attic: 'Attic',
    dressingRoom: 'Dressing room',
    diningRoom: 'Dining room',
    laundryRoom: 'Laundry room',
    fireplace: 'Fireplace',
    disabledAccess: 'Disabled access',
    caretaker: 'Caretaker / concierge',
    fitnessRoom: 'Fitness room',
    tennisCourt: 'Tennis court',
    sauna: 'Sauna',
    jacuzzi: 'Jacuzzi',
    hammam: 'Hammam',
    barbecue: 'Barbecue',
    armoredDoor: 'Armoured door',
    visiophone: 'Video phone',
    doorPhone: 'Door phone',
    alarm: 'Alarm',
    internet: 'Internet',
    cableTv: 'Cable TV',
  };
  for (const [key, label] of Object.entries(featureLabels)) {
    yesNo(label, features[key]);
  }
  if (Array.isArray(features.specificities) && features.specificities.length) {
    push('- **Specificities:** ' + features.specificities.join(', '));
  }
  if (!hasParking) push('- **Parking:** none mentioned');
  push();

  push('## Energy & certificates');
  const energy = info.energy || {};
  meta('EPC score', energy.epcScore);
  meta('Primary energy use', energy.energyPerSqmYear, ' kWh/m²/year');
  meta('Primary energy use (yearly)', energy.energyPerYear, ' kWh/year');
  meta('EPC reference', energy.epcReference);
  meta('Carbon emission', energy.carbonEmission, ' kg CO₂/m²/year');
  yesNo('Renovation obligation', energy.renovationObligation);
  const heating = info.heating;
  if (heating) {
    meta('Heating', heating.typeLabel || heating.type);
    yesNo('Heat pump', heating.heatPump);
    yesNo('Solar panels (PV)', heating.photovoltaicPanels);
    yesNo('Solar water heater', heating.thermicPanels);
    yesNo('Double glazing', heating.doubleGlazing);
    yesNo('Collective water heater', heating.collectiveWaterHeater);
  }
  const certificates = info.certificates || {};
  yesNo('Asbestos certificate', certificates.asbestosCertificate);
  meta('Built-plan status', certificates.builtPlanStatus);
  meta('Oil tank certificate', certificates.oilTankCertificate);
  yesNo('Electrical installation certificate', certificates.electricalCertificate);
  meta('Flood zone', certificates.floodZoneLabel);
  meta('Urban planning score', certificates.urbanPlanningScore);
  meta('Building score', certificates.buildingScore);
  yesNo('Construction permit obtained', certificates.constructionPermitObtained);
  push();

  push('## Location');
  meta('Address', location.address);
  meta('Property name', location.propertyName);
  meta('Postal code', location.postalCode);
  meta('City', location.locality);
  meta('District', location.district);
  meta('Province', location.province);
  meta('Region', location.region);
  meta('Country', location.country);
  meta('Area type', humanize(location.areaType));
  meta('Plot width', property.plotWidth, ' m');
  meta('Plot designation', property.plotUse);
  meta('Sewer connection', property.sewerConnection);
  yesNo('Plot is flat', property.plotFlat);
  yesNo('Plot facing the street', property.plotFacingStreet);
  yesNo('Wooded plot', property.plotWooded);
  yesNo('Sea view', location.seaView);
  if (location.latitude !== null && location.longitude !== null) {
    const coords = location.latitude + ',' + location.longitude;
    meta('Coordinates', coords + ' — https://www.openstreetmap.org/?mlat=' + location.latitude + '&mlon=' + location.longitude + '#map=17/' + coords);
  }
  push();

  push('## Description');
  push();
  if (property.descriptionLanguage && property.descriptionLanguage !== info.language) {
    push('_Description language: ' + property.descriptionLanguage + '_');
    push();
  }
  push(property.description ? String(property.description).trim() : '_No description provided._');
  push();

  const agencies = info.agency || [];
  if (agencies.length) {
    push('## Agency / contact');
    for (const agency of agencies) {
      push('### ' + (agency.name || 'Unknown') + (agency.typeLabel ? ' (' + agency.typeLabel + ')' : ''));
      if (agency.address) push('- **Address:** ' + agency.address);
      if (agency.phone) push('- **Phone:** ' + agency.phone);
      if (agency.mobile) push('- **Mobile:** ' + agency.mobile);
      if (agency.email) push('- **Email:** ' + agency.email);
      if (agency.website) push('- **Website:** ' + agency.website);
      if (agency.ipiNumber) push('- **IPI number:** ' + agency.ipiNumber);
      if (agency.agent && agency.agent.name) {
        push(
          '- **Agent:** ' +
            agency.agent.name +
            (agency.agent.phone ? ' · ' + agency.agent.phone : '') +
            (agency.agent.email ? ' · ' + agency.agent.email : '')
        );
      }
      push();
    }
  }

  push('## Listing metadata');
  meta((info.source || 'Immoweb') + ' ID', info.id);
  meta('External reference', info.externalReference);
  meta('Transaction type', info.transaction && (info.transaction.typeLabel || info.transaction.type));
  meta('Availability', info.transaction && info.transaction.availabilityDate);
  const publication = info.publication || {};
  meta('Published', publication.created);
  meta('Last modified', publication.lastModification);
  meta('Expires', publication.expiration);
  const media = info.media || {};
  meta('Photos', media.pictureCount);
  meta('Floor plans', media.floorPlanCount);
  meta('Documents', media.documentCount);
  meta('Virtual tour', media.virtualTourUrl);
  meta('Video', media.videoUrl);
  const flags = info.flags || {};
  yesNo('Marked as sold / rented', flags.isSoldOrRented);
  yesNo('Newly built', flags.isNewlyBuilt);
  yesNo('Notary sale', flags.isNotarySale);
  yesNo('Investment project', flags.isInvestmentProject);
  if (info.investor && info.investor.isInvestmentProperty) {
    meta('Current monthly rental income', formatEuro(info.investor.currentMonthlyRentalIncome));
    meta('Expected monthly rental income', formatEuro(info.investor.expectedMonthlyRentalIncome));
    meta('Expected return', info.investor.expectedReturnOnInvestment);
  }
  if (info.note) {
    push();
    push('> ' + info.note);
  }
  push();
  push('---');
  push();
  push('_Saved with Immoweb Listing Zipper — ' + (info.capturedAt || '') + '_');
  push();

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function buildReadme(info, folder) {
  const lines = [
    (info.source || 'Immoweb') + ' listing archive',
    '=======================',
    '',
    'Listing: ' + (info.displayTitle || (info.property && info.property.title) || info.id || ''),
    'URL:     ' + (info.url || ''),
    'Saved:   ' + (info.capturedAt || ''),
    '',
    'Contents of ' + folder + '/',
    '-----------------------',
    'summary.md    Human-readable sheet: price, surfaces, rooms, EPC, description, agency.',
    'info.json     The same facts, normalised for scripts/spreadsheets.',
    info.source === 'Immoscoop'
      ? 'listing.json  Raw listing data exactly as Immoscoop embedded it in the page'
      : 'listing.json  Raw listing data exactly as Immoweb embedded it in the page',
    info.source === 'Immoscoop'
      ? '              (__NEXT_DATA__ › pageProps.property) — the full source of truth.'
      : '              (window.classified) — the complete source of truth.',
    'photos/       All listing photos, numbered in display order.',
    'floorplans/   Floor plans, if the listing had any.',
    'documents/    Brochures, EPC certificates and other attachments, if any.',
    'page.html     Optional snapshot of the page as it was rendered (only if enabled).',
    'download-errors.txt  Only present if some files could not be downloaded',
    '                     or a part of the data could not be read.',
    '',
    "Note: prices, surfaces and other facts come from " + (info.source || 'Immoweb') + " and were accurate at",
    'the time of saving. Always verify with the agency before making decisions.',
    '',
  ];
  return lines.join('\n');
}
