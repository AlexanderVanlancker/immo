'use strict';

/**
 * The listing sites the zipper understands.
 *
 * The extension has no build step, so this file is plain and shared two ways:
 * `background.js` pulls it in with importScripts(), `popup.html` with a script
 * tag. Keep it free of DOM and chrome.* access.
 *
 * NOTE: the reader that runs inside the page (`readListing` in background.js)
 * is serialised into the tab and cannot import anything, so it repeats the host
 * patterns. Change a pattern here, change it there too.
 */

const LISTING_SITES = [
  {
    id: 'immoweb',
    label: 'Immoweb',
    host: /(^|\.)immoweb\.(be|com)$/i,
    path: /\/classified\//i,
    hint: 'Open a listing page (…/classified/…), then click save.',
  },
  {
    id: 'immoscoop',
    label: 'Immoscoop',
    // Localised routes: te-koop / te-huur (nl), a-vendre / a-louer (fr).
    host: /(^|\.)immoscoop\.be$/i,
    path: /^\/(?:[a-z]{2}\/)?(?:te-koop|te-huur|a-vendre|a-louer|for-sale|for-rent)\//i,
    hint: 'Open a listing page (…/te-koop/… or …/te-huur/…), then click save.',
  },
];

function parseListingUrl(url) {
  try {
    return new URL(String(url));
  } catch (error) {
    return null;
  }
}

/** The site whose domain matches, listing page or not. */
function siteForUrl(url) {
  const parsed = parseListingUrl(url);
  if (!parsed) return null;
  return LISTING_SITES.find((site) => site.host.test(parsed.hostname)) || null;
}

/** The site *and* a listing page — what the save button requires. */
function siteForListingUrl(url) {
  const parsed = parseListingUrl(url);
  if (!parsed) return null;
  const site = LISTING_SITES.find((candidate) => candidate.host.test(parsed.hostname));
  if (!site || !site.path.test(parsed.pathname)) return null;
  return site;
}

/** "for rent" / "for sale", read off the URL path. */
function listingKindFromUrl(url) {
  const parsed = parseListingUrl(url);
  const path = parsed ? parsed.pathname : '';
  if (/(?:te-huur|a-louer|for-rent)/i.test(path)) return 'for rent';
  if (/(?:te-koop|a-vendre|for-sale)/i.test(path)) return 'for sale';
  return 'listing';
}

/**
 * The trailing number in the path is the listing id on both sites. Taking the
 * *last* one matters on Immoweb, where the postal code sits in the path too
 * (`…/antwerpen/2000/21807693`).
 */
function listingIdFromUrl(url) {
  const parsed = parseListingUrl(url);
  const path = parsed ? parsed.pathname : String(url || '');
  const matches = path.match(/\/\d+(?=\/|$)/g);
  if (!matches) return null;
  const id = matches[matches.length - 1].slice(1);
  return id.length >= 4 ? id : null;
}

/* Node-only (the test harness loads this file to check the matchers). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LISTING_SITES,
    siteForUrl,
    siteForListingUrl,
    listingKindFromUrl,
    listingIdFromUrl,
  };
}
