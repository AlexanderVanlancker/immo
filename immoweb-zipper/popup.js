'use strict';

const OPTIONS_KEY = 'options';
const DEFAULT_OPTIONS = { photoSize: 'extra', includePageHtml: false, saveAs: false };

const el = (id) => document.getElementById(id);

let currentTab = null;
let job = null;
let pollTimer = null;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function isListingUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)immoweb\.(be|com)$/i.test(parsed.hostname)) return false;
    return /\/classified\//i.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}

function listingId(url) {
  const match = /\/(\d{5,})(?:[/?#]|$)/.exec(url || '');
  return match ? match[1] : null;
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

async function loadOptions() {
  const stored = await chrome.storage.local.get(OPTIONS_KEY);
  const options = { ...DEFAULT_OPTIONS, ...(stored[OPTIONS_KEY] || {}) };
  el('photo-size').value = options.photoSize;
  el('page-html').checked = Boolean(options.includePageHtml);
  el('save-as').checked = Boolean(options.saveAs);
}

function readOptions() {
  return {
    photoSize: el('photo-size').value || DEFAULT_OPTIONS.photoSize,
    includePageHtml: el('page-html').checked,
    saveAs: el('save-as').checked,
  };
}

async function persistOptions() {
  await chrome.storage.local.set({ [OPTIONS_KEY]: readOptions() });
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderPageInfo() {
  const info = el('page-info');
  const url = currentTab && currentTab.url;
  if (url && isListingUrl(url)) {
    const id = listingId(url);
    const kind = /\/for-rent\//i.test(url) ? 'for rent' : /\/for-sale\//i.test(url) ? 'for sale' : 'listing';
    info.textContent = 'Listing ' + (id || '') + ' · ' + kind + ' · ready to save';
    info.classList.add('on-listing');
    return true;
  }
  info.classList.remove('on-listing');
  info.textContent =
    url && /(^|\.)immoweb\.(be|com)$/i.test(safeHostname(url))
      ? 'Open a listing page (…/classified/…), then click save.'
      : 'Open an Immoweb listing page to save it as a ZIP.';
  return false;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return '';
  }
}

function renderJob() {
  const running = Boolean(job && job.status === 'running');
  const onListing = renderPageInfo();

  el('save').disabled = running || !onListing;
  el('photo-size').disabled = running;
  el('page-html').disabled = running;
  el('save-as').disabled = running;

  el('status').classList.toggle('hidden', !job);
  el('status-error').classList.add('hidden');
  el('reveal').classList.add('hidden');
  if (!job) return;

  const bar = el('bar-fill');
  const percent = Math.max(2, Math.min(100, Number(job.percent) || 0));
  bar.style.width = percent + '%';
  bar.classList.toggle('done', job.status === 'done');
  bar.classList.toggle('failed', job.status === 'error');

  const text = el('status-text');
  if (job.status === 'done') {
    const size = formatBytes(job.size);
    text.textContent = 'Saved ' + job.filename + (size ? ' (' + size + ')' : '');
    if (job.downloadId !== null && job.downloadId !== undefined) {
      el('reveal').classList.remove('hidden');
    }
    if (Array.isArray(job.warnings) && job.warnings.length) {
      el('status-error').textContent =
        job.warnings.length + ' file(s) could not be downloaded — see download-errors.txt in the ZIP.';
      el('status-error').classList.remove('hidden');
    }
  } else if (job.status === 'error') {
    text.textContent = job.message || 'Something went wrong.';
    el('status-error').textContent = job.error || '';
    el('status-error').classList.remove('hidden');
  } else {
    text.textContent =
      (job.message || 'Working…') +
      (job.total ? ' — ' + (job.done || 0) + '/' + job.total : '');
  }

  if (job.status === 'running' && !pollTimer) startPolling();
  if (job.status !== 'running' && pollTimer) stopPolling();
}

/* ------------------------------------------------------------------ *
 * State sync
 * ------------------------------------------------------------------ */

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const stored = await chrome.storage.session.get('job');
    if (stored.job) {
      job = stored.job;
      renderJob();
    }
  }, 600);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'job-state' && message.job) {
    job = message.job;
    renderJob();
  }
});

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function onSave() {
  if (!currentTab || !currentTab.id) return;
  const options = readOptions();
  await persistOptions();

  job = {
    status: 'running',
    phase: 'reading',
    message: 'Reading the listing…',
    percent: 2,
    done: 0,
    total: 0,
  };
  renderJob();

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'start-job',
      tabId: currentTab.id,
      options,
    });
    if (response && response.error) {
      const stored = await chrome.storage.session.get('job');
      job = stored.job || {
        status: 'error',
        message: 'Could not save the listing.',
        error: response.error,
      };
      renderJob();
    }
  } catch (error) {
    job = {
      status: 'error',
      message: 'Could not save the listing.',
      error: String((error && error.message) || error),
    };
    renderJob();
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function init() {
  const manifest = chrome.runtime.getManifest();
  el('version').textContent = 'v' + manifest.version;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs && tabs[0] ? tabs[0] : null;

  await loadOptions();

  const stored = await chrome.storage.session.get('job');
  job = stored.job || null;
  // Don't show a save result from half an hour ago as if it just happened.
  const isStale =
    job &&
    job.status !== 'running' &&
    job.finishedAt &&
    Date.now() - job.finishedAt > 30 * 60 * 1000;
  if (isStale) {
    job = null;
    chrome.storage.session.remove('job').catch(() => {});
  }
  renderJob();

  el('save').addEventListener('click', onSave);
  for (const id of ['photo-size', 'page-html', 'save-as']) {
    el(id).addEventListener('change', persistOptions);
  }
  el('reveal').addEventListener('click', async () => {
    if (job && job.downloadId !== null && job.downloadId !== undefined) {
      try {
        await chrome.downloads.show(job.downloadId);
      } catch (error) {
        /* download already cleared */
      }
    }
  });
}

init();
