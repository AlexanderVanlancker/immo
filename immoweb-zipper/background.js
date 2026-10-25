'use strict';

importScripts('sites.js');

/**
 * Listing Zipper — service worker.
 *
 * Responsibilities:
 *  1. Read the listing JSON out of the active tab: `window.classified` on
 *     Immoweb, `<script id="__NEXT_DATA__">` on Immoscoop.
 *  2. Hand the payload to the offscreen document, which downloads the photos and
 *     assembles the ZIP (offscreen documents live long enough for a multi-MB job
 *     and can create the blob URL the downloads API needs).
 *  3. Save the ZIP via chrome.downloads and publish progress for the popup.
 */

const OFFSCREEN_URL = 'offscreen.html';
const JOB_KEY = 'job';
const DOWNLOAD_TIMEOUT_MS = 180000;

let creatingOffscreen = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJob() {
  const stored = await chrome.storage.session.get(JOB_KEY);
  return stored[JOB_KEY] || null;
}

async function patchJob(patch, broadcast = true) {
  const previous = (await readJob()) || {};
  const job = { ...previous, ...patch };
  await chrome.storage.session.set({ [JOB_KEY]: job });
  if (broadcast) {
    // No receiver (popup closed) is fine — swallow the error.
    chrome.runtime.sendMessage({ type: 'job-state', job }).catch(() => {});
  }
  return job;
}

/* ------------------------------------------------------------------ *
 * Offscreen document lifecycle
 * ------------------------------------------------------------------ */

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'],
        justification:
          'Download the listing photos and turn them into a ZIP blob that the downloads API can save.',
      })
      .catch((error) => {
        // Another context may have created it a moment earlier.
        if (!/single offscreen/i.test(String(error && error.message))) throw error;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;

  // Wait until the document's message listener is actually up.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const pong = await chrome.runtime.sendMessage({ type: 'ping' });
      if (pong && pong.ok) return;
    } catch (error) {
      /* not ready yet */
    }
    await sleep(50);
  }
  throw new Error('The offscreen archiver did not start.');
}

async function closeOffscreenDocument(blobUrl) {
  try {
    await chrome.runtime.sendMessage({ type: 'revoke-blob', url: blobUrl || null });
  } catch (error) {
    /* document already gone */
  }
  await sleep(200);
  try {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  } catch (error) {
    /* already closed */
  }
}

/* ------------------------------------------------------------------ *
 * Page extraction (runs in the page's MAIN world)
 * ------------------------------------------------------------------ */

/**
 * Note: this function is serialised and injected, so it must be completely
 * self-contained (no closures over this file).
 */
function readListing(wantHtml) {
  const isScoop = /(^|\.)immoscoop\.be$/i.test(location.hostname);
  const text = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const value = (el.innerText || el.textContent || '').trim();
    return value || null;
  };
  const meta = (name) => {
    const el = document.querySelector(
      'meta[property="' + name + '"], meta[name="' + name + '"]'
    );
    return el && el.content ? el.content.trim() : null;
  };

  const payload = {
    site: isScoop ? 'immoscoop' : 'immoweb',
    url: location.href,
    lang: document.documentElement.lang || null,
    capturedAt: new Date().toISOString(),
    title: document.title || null,
    classified: null,
    scoop: null,
    fallback: null,
    html: null,
  };

  if (isScoop) {
    // Immoscoop is a Next.js app: the whole property lives in __NEXT_DATA__.
    try {
      const node = document.getElementById('__NEXT_DATA__');
      const json = node && node.textContent ? JSON.parse(node.textContent) : null;
      const property =
        json && json.props && json.props.pageProps && json.props.pageProps.property;
      if (property && property.id) {
        // Round-trip so anything non-serialisable is dropped before messaging.
        payload.scoop = JSON.parse(JSON.stringify(property));
        payload.lang = property.descriptionLanguage || payload.lang;
      }
    } catch (error) {
      /* fall through to the DOM fallback */
    }
  } else {
    try {
      const raw = window.classified;
      if (raw && typeof raw === 'object' && raw.id) {
        payload.classified = JSON.parse(JSON.stringify(raw));
        payload.lang = (raw.price && raw.price.language) || payload.lang;
      }
    } catch (error) {
      /* fall through to the DOM fallback */
    }
  }

  const selector = isScoop
    ? 'img[src*="images.immoscoop"], img[src*="immoscoop.be"]'
    : 'img[src*="immowebstatic"], img[src*="immoweb.be/photos"]';
  const images = Array.from(document.querySelectorAll(selector))
    .map((img) => img.currentSrc || img.src)
    .filter((src) => src && /^https?:/.test(src));

  payload.fallback = {
    title: text('h1') || meta('og:title') || document.title || null,
    priceText: text('[class*="classified-price"], [class*="price__value"], .price'),
    description: text('#description, [class*="description__content"], [class*="classified-description"]'),
    address: text('[class*="classified-address"], address, [class*="location__address"]'),
    ogImage: meta('og:image'),
    images: images.length > 500 ? images.slice(0, 500) : images,
    pageText: document.body ? (document.body.innerText || '').slice(0, 40000) : null,
  };

  if (wantHtml) payload.html = document.documentElement.outerHTML;
  return payload;
}

async function extractFromTab(tabId, options) {
  if (typeof tabId !== 'number') throw new Error('No active tab to read from.');
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [Boolean(options && options.includePageHtml)],
    func: readListing,
  });
  const payload = injection && injection.result;
  if (!payload) {
    throw new Error('Could not read this page. Open the listing itself, then try again.');
  }
  if (!payload.classified && !payload.scoop && !(payload.fallback && payload.fallback.title)) {
    const site = siteForUrl(payload.url);
    throw new Error(
      site
        ? 'This page does not look like a ' + site.label + ' listing.'
        : 'This page does not look like an Immoweb or Immoscoop listing.'
    );
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * Job orchestration
 * ------------------------------------------------------------------ */

async function waitForDownload(downloadId) {
  if (downloadId === undefined || downloadId === null) {
    return { error: 'Chrome did not start the download.' };
  }
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item) {
      if (item.state === 'complete') return { ok: true };
      if (item.state === 'interrupted') {
        return { error: 'Download interrupted: ' + (item.error || 'unknown reason') };
      }
    }
    await sleep(250);
  }
  return { error: 'Timed out while saving the ZIP.' };
}

async function startJob({ tabId, options }) {
  const previous = await readJob();
  if (previous && previous.status === 'running') {
    return { error: 'A save is already running. Give it a moment.' };
  }

  const opts = {
    photoSize: 'extra',
    includePageHtml: false,
    saveAs: false,
    ...(options || {}),
  };

  await patchJob({
    id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()),
    status: 'running',
    phase: 'reading',
    message: 'Reading the listing…',
    percent: 2,
    done: 0,
    total: 0,
    filename: null,
    size: null,
    downloadId: null,
    error: null,
    warnings: [],
    startedAt: Date.now(),
    finishedAt: null,
  });

  let blobUrl = null;
  try {
    const payload = await extractFromTab(tabId, opts);

    await patchJob({ phase: 'preparing', message: 'Preparing the archive…', percent: 4 });
    await ensureOffscreenDocument();

    const result = await chrome.runtime.sendMessage({ type: 'build-zip', payload, options: opts });
    if (!result || result.error) {
      throw new Error((result && result.error) || 'The archive could not be built.');
    }
    blobUrl = result.blobUrl;

    await patchJob({ phase: 'downloading', message: 'Saving ' + result.filename + '…', percent: 97 });
    const downloadId = await chrome.downloads.download({
      url: result.blobUrl,
      filename: result.filename,
      conflictAction: 'uniquify',
      saveAs: Boolean(opts.saveAs),
    });
    const outcome = await waitForDownload(downloadId);
    await closeOffscreenDocument(result.blobUrl);
    blobUrl = null;
    if (outcome.error) throw new Error(outcome.error);

    await patchJob({
      status: 'done',
      phase: 'done',
      percent: 100,
      message: 'Saved ' + result.filename,
      filename: result.filename,
      size: result.size,
      downloadId,
      warnings: result.warnings || [],
      finishedAt: Date.now(),
    });
    return { ok: true, filename: result.filename, size: result.size };
  } catch (error) {
    await closeOffscreenDocument(blobUrl);
    const message = String((error && error.message) || error);
    const cancelled = /cancel/i.test(message);
    await patchJob({
      status: 'error',
      phase: 'error',
      message: cancelled ? 'Save cancelled.' : 'Could not save the listing.',
      error: cancelled ? '' : message,
      finishedAt: Date.now(),
    });
    return { error: message };
  }
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  switch (message.type) {
    case 'start-job':
      startJob(message).then(sendResponse, (error) =>
        sendResponse({ error: String((error && error.message) || error) })
      );
      return true;

    case 'job-state':
      // Progress from the offscreen archiver: persist (and rebroadcast to the popup).
      patchJob(message.job || {}).then(() => sendResponse({ ok: true }));
      return true;

    case 'get-job':
      readJob().then((job) => sendResponse({ job }));
      return true;

    case 'clear-job':
      chrome.storage.session.remove(JOB_KEY).then(() => sendResponse({ ok: true }));
      return true;

    default:
      return undefined;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.remove(JOB_KEY).catch(() => {});
});
