/**
 * Offline (and optional network) test harness for offscreen.js.
 *
 * Runs the real archiver in a vm sandbox with a fake `chrome` API, then writes
 * the produced ZIP to test/out/ so it can be inspected with `unzip`.
 *
 *   node test/run.mjs             # fake bytes from fixtures (fast, deterministic)
 *   node test/run.mjs --network   # real Immoweb photos over the network
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const outDir = path.join(here, 'out');
const useNetwork = process.argv.includes('--network');

fs.mkdirSync(outDir, { recursive: true });

const fflate = require(path.join(root, 'vendor', 'fflate.js'));
const fakeImage = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb004300' + 'ff'.repeat(64) + 'ffd9',
  'hex'
);

let capturedBlob = null;
let blobCounter = 0;

function makeChromeStub(progressLog) {
  let listener = null;
  return {
    api: {
      runtime: {
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
        sendMessage(message) {
          if (message && message.type === 'job-state') progressLog.push(message.job);
          return Promise.resolve({ ok: true });
        },
      },
    },
    getListener() {
      return listener;
    },
  };
}

function loadArchiver(progressLog) {
  const chromeStub = makeChromeStub(progressLog);
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    TextEncoder,
    TextDecoder,
    Intl,
    chrome: chromeStub.api,
    Blob: class Blob {
      constructor(parts, options) {
        this.parts = parts;
        this.type = options && options.type;
      }
    },
    URL: {
      createObjectURL(blob) {
        capturedBlob = blob;
        blobCounter += 1;
        return 'blob:chrome-extension://test/' + blobCounter;
      },
      revokeObjectURL() {
        capturedBlob = null;
      },
    },
    fetch: makeFetchStub(),
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  // Load fflate inside the sandbox, exactly like offscreen.html does, so the
  // archiver and the zip writer share one realm.
  vm.runInContext(fs.readFileSync(path.join(root, 'vendor', 'fflate.js'), 'utf8'), sandbox, {
    filename: 'vendor/fflate.js',
  });
  if (!sandbox.fflate || typeof sandbox.fflate.zip !== 'function') {
    throw new Error('fflate did not load inside the sandbox');
  }
  const source = fs.readFileSync(path.join(root, 'offscreen.js'), 'utf8');
  vm.runInContext(source, sandbox, { filename: 'offscreen.js' });

  return { listener: chromeStub.getListener(), sandbox };
}

let failCounter = 0;
function makeFetchStub() {
  return async function fetchStub(url) {
    const target = String(url);
    if (!useNetwork) {
      failCounter += 1;
      // Deterministic failure injection: every 5th request 404s.
      if (process.env.FAIL_EVERY && failCounter % Number(process.env.FAIL_EVERY) === 0) {
        return {
          ok: false,
          status: 404,
          headers: { get: () => '' },
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      const isPdf = /\.pdf(\?|$)/i.test(target);
      return {
        ok: true,
        status: 200,
        headers: { get: () => (isPdf ? 'application/pdf' : 'image/jpeg') },
        arrayBuffer: async () => {
          const buffer = isPdf ? Buffer.from('%PDF-1.4 fake') : fakeImage;
          return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        },
      };
    }

    const response = await fetch(target, { credentials: 'omit' });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        headers: { get: () => '' },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => response.headers.get(name) },
      arrayBuffer: () => response.arrayBuffer(),
    };
  };
}

async function build(payloadFile, options) {
  const progress = [];
  const { listener } = loadArchiver(progress);
  if (!listener) throw new Error('offscreen.js registered no message listener');

  const classified = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', payloadFile), 'utf8'));
  const payload = {
    url: 'https://www.immoweb.be/en/classified/x/' + classified.id,
    lang: 'en',
    capturedAt: new Date().toISOString(),
    classified,
    fallback: null,
    html: options.includePageHtml ? '<html><body>snapshot</body></html>' : null,
  };

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('build-zip timed out')), 180000);
    listener({ type: 'build-zip', payload, options }, {}, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });

  if (!result || result.error) throw new Error('build-zip failed: ' + (result && result.error));

  const bytes = capturedBlob && capturedBlob.parts[0];
  if (!bytes) throw new Error('no blob produced');
  const zipPath = path.join(outDir, result.filename);
  fs.writeFileSync(zipPath, Buffer.from(bytes));
  return { result, zipPath, progress };
}

/**
 * The legacy `unzip` CLI re-encodes non-ASCII entry names for display, so names
 * are read with Python's zipfile (UTF-8 aware) instead.
 */
function zipNames(zipPath) {
  const out = execFileSync(
    'python3',
    ['-c', 'import sys,zipfile\nfor n in zipfile.ZipFile(sys.argv[1]).namelist(): print(n)', zipPath],
    { encoding: 'utf8' }
  );
  return out.split('\n').filter(Boolean);
}

function unzipTo(zipPath, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync(
    'python3',
    ['-c', 'import sys,zipfile\nzipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipPath, dir],
    { encoding: 'utf8' }
  );
}

function inspect(zipPath) {
  const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  const test = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
  return { listing, test };
}

function assert(condition, message) {
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

const runs = [];

const FIXTURES = [
  // `documents` dedupes against the floor plan PDF on the house listing.
  { file: 'sale.json', kind: 'for-sale', photos: 23, floorPlans: 0, documents: 0 },
  { file: 'rent.json', kind: 'for-rent', photos: 10, floorPlans: 0, documents: 0 },
  { file: 'house.json', kind: 'for-sale', photos: 16, floorPlans: 1, documents: 0 },
];

for (const spec of FIXTURES) {
  const fixture = spec.file;
  const { result, zipPath, progress } = await build(fixture, {
    photoSize: 'extra',
    includePageHtml: false,
  });
  const { listing, test } = inspect(zipPath);
  const entries = zipNames(zipPath);

  console.log('\n=== ' + fixture + ' → ' + result.filename);
  console.log('zip size:', (result.size / 1024).toFixed(1) + ' KB', '| entries:', entries.length);
  console.log('integrity:', test.trim().split('\n').pop());
  console.log('progress reports:', progress.length);
  console.log('warnings:', result.warnings.length);

  assert(entries.includes(result.filename.replace('.zip', '') + '/summary.md'), 'summary.md present');
  assert(entries.includes(result.filename.replace('.zip', '') + '/listing.json'), 'listing.json present');
  assert(entries.includes(result.filename.replace('.zip', '') + '/info.json'), 'info.json present');
  assert(entries.includes(result.filename.replace('.zip', '') + '/README.txt'), 'README.txt present');
  assert(entries.some((p) => p.includes('/photos/01.jpg')), 'first photo present');
  const expectedEntries = 4 + spec.photos + spec.floorPlans + spec.documents;
  assert(
    entries.length === expectedEntries,
    'expected ' + expectedEntries + ' entries, got ' + entries.length + ': ' + entries.join(', ')
  );
  assert(
    entries.every((p) => !/\/\d+$/.test(p)),
    'no bogus per-byte entries: ' + entries.filter((p) => /\/\d+$/.test(p)).slice(0, 5)
  );
  assert(/No errors detected/.test(test), 'zip passes unzip -t');
  assert(result.size > 1000, 'zip is not empty');

  // Round-trip: listing.json must equal the fixture byte-for-byte once parsed.
  const extractDir = path.join(outDir, 'x-' + fixture.replace('.json', ''));
  unzipTo(zipPath, extractDir);
  const folder = result.filename.replace('.zip', '');
  const roundTripped = JSON.parse(
    fs.readFileSync(path.join(extractDir, folder, 'listing.json'), 'utf8')
  );
  const fixtureData = JSON.parse(
    fs.readFileSync(path.join(here, 'fixtures', fixture), 'utf8')
  );
  assert(
    JSON.stringify(roundTripped) === JSON.stringify(fixtureData),
    'listing.json round-trips the source data'
  );

  const info = JSON.parse(fs.readFileSync(path.join(extractDir, folder, 'info.json'), 'utf8'));
  const summary = fs.readFileSync(path.join(extractDir, folder, 'summary.md'), 'utf8');
  assert(
    /  \d{4} — \S/.test(folder),
    'folder is "<address>  <postal> — <city>": ' + folder
  );
  console.log('folder:', folder);
  console.log('kind:', info.transaction.kind, '| price:', info.price.display);
  console.log('livingArea:', info.property.livingArea, '| bedrooms:', info.property.bedrooms);
  console.log('address:', info.location.address, info.location.postalCode, info.location.locality);
  console.log('agency:', info.agency.map((a) => a.name).join(', '));
  console.log('summary.md:', summary.split('\n').length, 'lines');

  assert(info.transaction.kind === spec.kind, 'kind');
  if (spec.floorPlans) {
    assert(entries.some((p) => p.includes('/floorplans/01.pdf')), 'floor plan PDF saved');
    assert(!entries.some((p) => p.includes('/documents/')), 'duplicate plan not saved twice');
  }
  assert(info.displayTitle, 'display title derived (raw title may be missing)');
  assert(info.property.description, 'description captured');
  assert(typeof info.property.livingArea === 'number', 'living area captured');
  assert(info.price.display, 'price display captured');

  runs.push({ fixture, filename: result.filename, size: result.size, entries: entries.length });
}

/* --- failure handling: some media 404s (offline fixtures only) --------- */
if (!useNetwork) {
process.env.FAIL_EVERY = '5';
const failing = await build('sale.json', { photoSize: 'large', includePageHtml: true });
const extracted = path.join(outDir, 'x-failing');
unzipTo(failing.zipPath, extracted);
const failingFolder = path.join(extracted, failing.result.filename.replace('.zip', ''));
assert(fs.existsSync(path.join(failingFolder, 'download-errors.txt')), 'download-errors.txt written');
assert(fs.existsSync(path.join(failingFolder, 'page.html')), 'page.html written when enabled');
assert(failing.result.warnings.length > 0, 'warnings reported');
console.log(
  '\n=== failure handling: ' + failing.result.warnings.length + ' failed downloads recorded, zip still valid'
);
delete process.env.FAIL_EVERY;
}

/* --- DOM fallback (no window.classified) ------------------------------- */
{
  const progress = [];
  const { listener } = loadArchiver(progress);
  // A real thumbnail URL from the rent fixture (passed twice, to test dedupe).
  const rentFixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'rent.json'), 'utf8'));
  const realThumb = rentFixture.media.pictures[0].smallUrl;
  const payload = {
    url: 'https://www.immoweb.be/en/classified/apartment/for-rent/x/12345678',
    lang: 'en',
    capturedAt: new Date().toISOString(),
    title: 'Fallback listing',
    classified: null,
    html: null,
    fallback: {
      title: 'Cosy studio in the centre',
      priceText: '€950/month',
      description: 'A small studio.',
      address: 'Kerkstraat 1, 2000 Antwerpen',
      images: [realThumb, realThumb],
      pageText: 'Cosy studio…',
    },
  };
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fallback timed out')), 60000);
    listener({ type: 'build-zip', payload, options: { photoSize: 'extra' } }, {}, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  assert(!result.error, 'fallback build succeeds: ' + result.error);
  const folder = result.filename.replace('.zip', '');
  assert(/^Kerkstraat 1, 2000 Antwerpen$/.test(folder), 'fallback folder name uses the scraped address: ' + folder);
  const zipPath = path.join(outDir, result.filename);
  fs.writeFileSync(zipPath, Buffer.from(capturedBlob.parts[0]));
  const names = zipNames(zipPath);
  assert(names.some((n) => n.endsWith('/summary.md')), 'fallback archive has summary');
  assert(names.some((n) => n.endsWith('/photos/01.jpg')), 'fallback photo downloaded and deduped');
  assert(!names.some((n) => n.endsWith('/photos/02.jpg')), 'duplicate fallback photo deduped');
  console.log('\n=== DOM fallback: ' + folder + ' — ok');
}

/* --- malformed structured data must still yield a usable archive ------ */
{
  const progress = [];
  const { listener } = loadArchiver(progress);
  const broken = {
    id: 99999999,
    transaction: null,
    price: null,
    media: { pictures: 'not-a-list', documents: 42, floorPlans: { weird: true } },
    customers: 'nope',
    publication: null,
  };
  // A field that blows up on access: the archiver must survive it.
  Object.defineProperty(broken, 'property', {
    enumerable: true,
    get() {
      throw new Error('unexpected listing shape');
    },
  });
  const payload = {
    url: 'https://www.immoweb.be/en/classified/house/for-sale/x/99999999',
    lang: 'en',
    capturedAt: new Date().toISOString(),
    title: 'Odd listing',
    classified: broken,
    fallback: { title: 'Odd listing', images: [], priceText: '€1' },
    html: null,
  };
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('malformed build timed out')), 60000);
    listener({ type: 'build-zip', payload, options: {} }, {}, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  assert(!result.error, 'malformed listing does not crash the archiver: ' + result.error);
  const zipPath = path.join(outDir, result.filename);
  fs.writeFileSync(zipPath, Buffer.from(capturedBlob.parts[0]));
  const entries = zipNames(zipPath);
  assert(entries.some((p) => p.endsWith('/info.json')), 'normalised info still written');
  assert(entries.some((p) => p.endsWith('/summary.md')), 'a summary is still produced');
  assert(result.warnings.length > 0, 'the problem is reported in download-errors.txt');
  console.log('\n=== malformed data: ' + result.filename + ' — still saved, ' + result.warnings.length + ' warning(s)');
}

console.log('\nAll checks passed.');
console.log(JSON.stringify(runs, null, 2));
