/**
 * Orchestration test: runs background.js and offscreen.js in two vm contexts
 * connected by a mock chrome.runtime message bus, with stubbed chrome.* APIs.
 *
 * Verifies the full save flow without a browser:
 *   start-job → executeScript → offscreen create → build-zip → downloads → cleanup
 *
 *   node test/orchestration.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

const contexts = [];
const storage = new Map();
const downloads = [];
let nextDownloadId = 1;
let offscreenOpen = false;
let closedDocuments = 0;
let failExtraction = false;

function assert(condition, message) {
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

/* --- mock message bus (Chrome never delivers a message to its sender) --- */
function sendMessage(from, message) {
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  let responded = false;
  let anyAsync = false;
  const respond = (value) => {
    if (!responded) {
      responded = true;
      settle(value);
    }
  };
  for (const context of contexts) {
    if (context === from || context.closed) continue;
    for (const listener of context.listeners) {
      try {
        if (listener(message, { name: from.name }, respond) === true) anyAsync = true;
      } catch (error) {
        /* a throwing listener behaves like an unresponsive one */
      }
    }
  }
  if (!responded && !anyAsync) settle(undefined);
  return promise;
}

function makeRuntime(name) {
  const context = { name, listeners: [], closed: false };
  contexts.push(context);
  context.runtime = {
    onMessage: { addListener: (fn) => context.listeners.push(fn) },
    onInstalled: { addListener: () => {} },
    sendMessage: (message) => sendMessage(context, message),
    getURL: (file) => 'chrome-extension://test/' + file,
    getManifest: () => ({ version: '1.0.0' }),
    getContexts: async () => (offscreenOpen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
  };
  return context;
}

const fakeImage = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

function baseSandbox() {
  return {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    TextEncoder,
    TextDecoder,
    Intl,
    crypto,
    Blob: class Blob {
      constructor(parts, options) {
        this.parts = parts;
        this.type = options && options.type;
      }
    },
    URL: {
      createObjectURL: () => 'blob:chrome-extension://test/zip-1',
      revokeObjectURL: () => {},
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => fakeImage.buffer.slice(fakeImage.byteOffset, fakeImage.byteOffset + fakeImage.byteLength),
    }),
  };
}

/* --- service worker context ------------------------------------------- */
const worker = makeRuntime('service-worker');
const workerChrome = {
  runtime: worker.runtime,
  storage: {
    session: {
      get: async (key) => ({ [key]: storage.get(key) }),
      set: async (values) => {
        for (const [key, value] of Object.entries(values)) storage.set(key, value);
      },
      remove: async (key) => {
        storage.delete(key);
      },
    },
  },
  scripting: {
    executeScript: async ({ args }) => {
      if (failExtraction) throw new Error('Cannot access contents of the page');
      const classified = JSON.parse(
        fs.readFileSync(path.join(here, 'fixtures', 'sale.json'), 'utf8')
      );
      return [
        {
          result: {
            url: 'https://www.immoweb.be/en/classified/penthouse/for-sale/antwerpen/2000/21807693',
            lang: 'en',
            capturedAt: new Date().toISOString(),
            classified,
            fallback: null,
            html: args[0] ? '<html>snapshot</html>' : null,
          },
        },
      ];
    },
  },
  offscreen: {
    createDocument: async () => {
      offscreenOpen = true;
      createOffscreenContext();
    },
    closeDocument: async () => {
      offscreenOpen = false;
      closedDocuments += 1;
      for (const context of contexts) {
        if (context.name === 'offscreen') context.closed = true;
      }
    },
  },
  downloads: {
    download: async (options) => {
      const id = nextDownloadId++;
      downloads.push({ id, ...options });
      return id;
    },
    search: async ({ id }) => downloads.filter((item) => item.id === id).map((item) => ({ ...item, state: 'complete' })),
    show: async () => {},
  },
};

const workerSandbox = baseSandbox();
workerSandbox.chrome = workerChrome;
workerSandbox.self = workerSandbox;
vm.createContext(workerSandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), workerSandbox, {
  filename: 'background.js',
});
assert(worker.listeners.length === 1, 'background.js registered a message listener');

/* --- offscreen document context (created on demand) -------------------- */
function createOffscreenContext() {
  const page = makeRuntime('offscreen');
  const sandbox = baseSandbox();
  sandbox.chrome = { runtime: page.runtime };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'vendor', 'fflate.js'), 'utf8'), sandbox, {
    filename: 'vendor/fflate.js',
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'offscreen.js'), 'utf8'), sandbox, {
    filename: 'offscreen.js',
  });
  assert(page.listeners.length === 1, 'offscreen.js registered a message listener');
  return page;
}

/* --- the actual test --------------------------------------------------- */
function callWorker(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no response from service worker')), 120000);
    worker.listeners[0](message, { name: 'popup' }, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

console.log('running save flow…');
const response = await callWorker({ type: 'start-job', tabId: 7, options: { photoSize: 'large' } });

assert(response && response.ok, 'job succeeded: ' + JSON.stringify(response));
assert(
  /^Gentplaats 12  2000 — Antwerpen\.zip$/.test(response.filename),
  'zip is named after the address: ' + response.filename
);
assert(response.size > 1000, 'zip has size: ' + response.size);

assert(downloads.length === 1, 'exactly one download requested');
assert(downloads[0].url === 'blob:chrome-extension://test/zip-1', 'downloaded the offscreen blob URL');
assert(downloads[0].filename === response.filename, 'download filename matches the zip');
assert(downloads[0].saveAs === false, 'saveAs defaults to false');
assert(downloads[0].conflictAction === 'uniquify', 'no silent overwrites');

const job = storage.get('job');
assert(job && job.status === 'done', 'job persisted as done');
assert(job.percent === 100, 'job percent reaches 100');
assert(job.downloadId === downloads[0].id, 'job remembers the download id');
assert(job.error === null, 'no error on the finished job');

assert(closedDocuments === 1, 'offscreen document was closed after the save');
assert(offscreenOpen === false, 'no offscreen document left open');

/* --- second run: extraction failure must not leave state hanging ------- */
failExtraction = true;
storage.delete('job');
const failed = await callWorker({ type: 'start-job', tabId: 7, options: {} });
assert(failed && failed.error, 'failure surfaces an error');
const failedJob = storage.get('job');
assert(failedJob.status === 'error', 'failed job persisted as error');
assert(/Cannot access contents/.test(failedJob.error), 'error message passed through: ' + failedJob.error);
assert(downloads.length === 1, 'no download attempted on failure');
failExtraction = false;

/* --- concurrent saves are rejected ------------------------------------ */
storage.set('job', { status: 'running' });
const busy = await callWorker({ type: 'start-job', tabId: 7, options: {} });
assert(/already running/i.test(busy.error), 'second concurrent save rejected: ' + busy.error);
storage.delete('job');

/* --- the injected page reader (runs in the page's MAIN world) ---------- */
{
  const classified = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'sale.json'), 'utf8'));
  const doc = {
    documentElement: { lang: 'nl', outerHTML: '<html><body>page snapshot</body></html>' },
    title: 'Penthouse te koop | Immoweb',
    body: { innerText: 'visible page text' },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  workerSandbox.document = doc;
  workerSandbox.location = {
    href: 'https://www.immoweb.be/nl/classified/penthouse/te-koop/antwerpen/2000/21807693',
  };
  workerSandbox.window = { classified };

  const payload = workerSandbox.readListing(true);
  assert(payload.classified && payload.classified.id === 21807693, 'window.classified is read');
  assert(payload.lang === 'en', 'language comes from the listing: ' + payload.lang);
  assert(payload.url.includes('/classified/'), 'url captured');
  assert(typeof payload.html === 'string' && payload.html.includes('page snapshot'), 'html snapshot');
  assert(payload.fallback.title === doc.title, 'DOM fallback title captured');
  assert(
    JSON.stringify(JSON.parse(JSON.stringify(payload.classified))) === JSON.stringify(classified),
    'listing data survives the structured-clone trip'
  );

  // Page without window.classified → fallback payload, no crash.
  workerSandbox.window = {};
  const fallbackPayload = workerSandbox.readListing(false);
  assert(fallbackPayload.classified === null, 'no classified → null');
  assert(fallbackPayload.html === null, 'html skipped unless requested');
  assert(fallbackPayload.fallback.title === doc.title, 'fallback still usable');
  console.log('page reader (MAIN world): ok');
}

console.log('service worker + offscreen integration: ok');
console.log('  filename: ' + response.filename + ' (' + (response.size / 1024).toFixed(1) + ' KB)');
console.log('  download: ' + downloads[0].url);
console.log('All orchestration checks passed.');
