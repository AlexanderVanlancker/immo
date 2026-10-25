# Listing Zipper — Immoweb & Immoscoop

A Chrome extension that saves a property listing — **for sale or for rent**, from
**[Immoweb](https://www.immoweb.be)** or **[Immoscoop](https://www.immoscoop.be)** — as a single
ZIP: price, description, surfaces, rooms, EPC, address, agency details, every photo, floor plans
and attachments.

Both sites produce the *same* `info.json`, so an archive saved from Immoscoop opens in the viewer
exactly like an Immoweb one.

Everything runs locally in your browser. Nothing is uploaded anywhere.

> **Part of [`immo`](../README.md).** Drop the ZIPs this extension produces into
> `../data/exports/`. [`immo-viewer`](../immo-viewer) unpacks them into `../data/listings/`
> (one plain folder per listing) and turns them into a map, a filterable list and
> price-per-m² statistics.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (`immoweb-zipper`).
4. Pin the extension (puzzle-piece icon → pin) so it is one click away.

Works in Chrome, Edge, Brave and other Chromium 116+ browsers.

## Use

1. Open a listing:

   | Site | Example |
   | --- | --- |
   | Immoweb | `https://www.immoweb.be/en/classified/penthouse/for-sale/antwerpen/2000/21807693` |
   | Immoscoop | `https://www.immoscoop.be/te-koop/2050-antwerpen/1196193` |
   | Immoscoop (rent) | `https://www.immoscoop.be/te-huur/2050-antwerpen/1228194` |

2. Click the extension icon — the popup names the site, the listing id and the
   transaction type it found.
3. Pick options (photo size, optional raw page snapshot) and press
   **Save this listing as ZIP**.
4. The ZIP lands in your Downloads folder, named after the address:
   `Maria Claessensplein 5  2050 — Antwerpen.zip`. Use **Show in folder** in the
   popup to jump to it.

Options are remembered between saves.

## File naming

Both the ZIP and the folder inside it use the listing address:

```
<street> <number> [box <box>]  <postal code> — <city>
```

Examples:

* `Maria Claessensplein 5  2050 — Antwerpen.zip`
* `Leo J. Krynlaan 1 box 101  2050 — Antwerpen.zip`
* `Aalscholverlaan 78 box 802  2050 — Antwerpen.zip` (Immoscoop, address published)

The listing id is not in the name (it stays in `summary.md`, `info.json` and
`listing.json`), so two different listings at the exact same address produce the
same name — Chrome then saves the second as `… — Antwerpen (1).zip`.

Immoscoop hides the exact address on some listings (no street, no coordinates).
Those archives are named `<postal code> — <city>` instead, e.g.
`2050 — Antwerpen.zip`. If there is no address at all, the name falls back to
`<id>-<for-sale|for-rent>-<type>-<city>-<postal code>`. Characters that Windows
or macOS refuse in a file name (`< > : " / \ | ? *`) are replaced with `-`, and
city names shouted in capitals (`ANTWERPEN`) are normalised to `Antwerpen`.

## What's inside the ZIP

```
Gentplaats 12  2000 — Antwerpen/
├── summary.md          human-readable sheet: price, surfaces, rooms, EPC,
│                       location, description, agency, metadata
├── info.json           the same facts, normalised for scripts/spreadsheets —
│                       identical shape for Immoweb and Immoscoop
├── listing.json        raw listing data as the site embedded it in the page
│                       (Immoweb: window.classified,
│                        Immoscoop: __NEXT_DATA__ › pageProps.property)
├── README.txt          what each file is
├── photos/01.jpg …     all photos, in display order
├── floorplans/         floor plans, if the listing has any (Immoweb only)
├── documents/          brochures / certificates, if any (Immoweb only)
└── page.html           only when "Include raw page snapshot" is ticked
```

`download-errors.txt` appears only if some media could not be downloaded — the
archive is still produced.

### Fields captured

`info.json` always has the same sections (`transaction`, `price`, `property`,
`location`, `energy`, `heating`, `certificates`, `agency`, `publication`,
`media`, `flags`) plus an extra `details` list holding every label/value pair the
source page printed.

* **Price** — asking price / monthly rent, charges, old price, price per m²,
  cadastral income, VAT status, furnished flag, hidden-price flag.
* **Property** — living area (net habitable), plot area, garden and terrace
  surfaces + orientation, bedrooms (with individual surface areas), bathrooms,
  shower rooms, toilets, total rooms, living room, kitchen type and surface,
  floor, floors in building, construction year, condition, facades, monthly
  charges.
* **Energy & certificates** — EPC score, primary energy use per m² and per year,
  EPC reference, carbon emission, renovation obligation, heating type, heat
  pump, solar (PV / water) panels, double glazing, asbestos/electrical/oil-tank
  certificates, built-plan status, flood zone, urban-planning (P) and building
  (G) scores, construction permit.
* **Location** — street, number, box, postal code, city, district, province,
  region, coordinates with an OpenStreetMap link, plus plot width, plot
  designation, sewer connection and plot flags for houses.
* **Comfort** — lift, garden, terrace, balcony, pool, air conditioning,
  basement, attic, dressing room, laundry room, fireplace, sauna, jacuzzi,
  hammam, alarm, video phone, internet, parking (indoor/outdoor/closed box),
  and any other specificities the site lists.
* **Agency** — name, type, phone, mobile, email, website, IPI number, agent.
* **Description** — falls back to `alternativeDescriptions` when Immoweb leaves
  the canonical description empty (common on new-build listings), and records
  which language the text is in. Immoscoop descriptions are HTML, so they are
  converted to plain text (line breaks kept).
* **Metadata** — listing id, external reference, publication/modification dates,
  availability, photo/floor-plan/document counts, virtual tour and video links,
  sold/rented flag.

### How Immoscoop maps onto that schema

Immoscoop stores numbers inside a flat `features` array plus prose detail groups
(`Gebouw › Bouwjaar: 2017`), and labels them in Dutch. The archiver reads both:

| `info.json` | Immoscoop source |
| --- | --- |
| `transaction.kind` | `offerType.slug` (`te-koop` / `te-huur`, also the French routes) |
| `price.value` | `price.slug`, falling back to parsing `price.label` |
| `property.type/subtype` | `propertyType.label` + detail `Subtype` |
| living area, plot, bedrooms, bathrooms | `features` (`livableSurfaceArea`, `TerrainArea`, …) |
| construction year, floor, facades, terrace area, bedroom surfaces | detail groups |
| `energy.epcScore` / `energyPerSqmYear` | `features[EpcClass]` + detail `EPC-score (kWh/(m² jaar))` |
| `heating.*`, `certificates.*` | details `Type verwarming`, `Dubbele beglazing`, `Keuringsattest elektriciteit`, `Bouwvergunning`, `Overstromingsgevoelig gebied`, … |
| `location.*` | `address` (+ `geo` when the address is public) |
| `agency[]` | `agent` |
| `details[]` | every detail group, verbatim |

Anything that does not fit a normalised field is still kept as a
`<group> · <label>: <value>` line in `property.features.specificities` and in
`details`, so nothing from the page is lost.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| Photo size | Max | Immoweb: 2560 px (a 23-photo listing is ~5 MB). Immoscoop: 1536 px, its largest variant. Large / Medium / Small give smaller archives. |
| Include raw page snapshot | off | Adds `page.html` (the rendered page at save time). |
| Ask where to save | off | Uses Chrome's save dialog instead of Downloads. |

## How it works

* `sites.js` lists the supported sites and which URLs count as a listing page
  (shared by the service worker and the popup).
* `background.js` (service worker) reads the listing out of the open tab with
  `chrome.scripting.executeScript` in the page's `MAIN` world. On Immoweb that
  is `window.classified`; on Immoscoop it is the
  `<script id="__NEXT_DATA__">` payload (`props.pageProps.property`). If the
  structured data is missing, it falls back to scraping the visible page (title,
  price, description, images).
* `offscreen.js` runs in an offscreen document — it downloads the media
  (4 requests in parallel, 60 s timeout each), normalises the data
  (`normalize` for Immoweb, `normalizeScoop` for Immoscoop) and builds the ZIP
  with [fflate](https://github.com/101arrowz/fflate) (vendored, MIT).
* The ZIP blob is handed to `chrome.downloads`, and progress is streamed back to
  the popup through `chrome.storage.session`.

Required permissions: `activeTab`, `scripting`, `downloads`, `offscreen`,
`storage`, plus host access to the Immoweb and Immoscoop domains (page + photos).

Entries are stored as UTF-8 with the ZIP UTF-8 flag, so the em dash and the
double space survive on Windows, macOS and Linux. (The legacy `unzip` CLI may
*print* the name as mojibake; the stored name is correct.)

### Adding a third site

1. Add an entry to `LISTING_SITES` in `sites.js` (host regex, path regex, hint).
2. Add the host permissions to `manifest.json`.
3. Teach the injected `readListing()` in `background.js` how to find the
   structured data on that site, and set `payload.site`.
4. Write a `normalizeX()` in `offscreen.js` that returns the same `info.json`
   shape, plus a photo collector, and dispatch to it in `buildZip()`.

## Robustness

Both sites are inconsistent about their data shapes. Immoweb's
`media.documents` is a list on one listing and an object keyed by uuid on the
next, `media.floorPlans` may hold plain URL strings, `specificities` may be an
array or an object, and some listings have no `title` or `description` at all.
Immoscoop prints numbers as text (`'195 m²'`, `'15 m²; 13 m²'`), repeats labels
across groups, and sometimes hides the address entirely.

Every collection goes through the same helper, every number is parsed
defensively, and a field that cannot be read only costs you that field — the save
still completes with the photos, the raw `listing.json` and a note in
`download-errors.txt`. `test/fixtures/house.json` (Immoweb) and
`test/fixtures/scoop-*.json` (Immoscoop, both transaction types, one with a
hidden address) are real listings that exercise those variants; `npm test` keeps
it that way.

## Limitations

* Single listing pages only. Project/"new build" pages save what the page
  exposes.
* Private or expired listings can't be saved — the site has to serve the page.
* Photo resolution is capped by the image service (Immoweb 2560×1440,
  Immoscoop 1536 px).
* Immoscoop does not publish floor plans, brochures or a publication date, so
  those fields stay empty for its archives (the viewer falls back to the save
  date on its timeline).
* Immoscoop hides the exact address on some listings. Those archives have no
  coordinates and therefore no map pin in the viewer — the listing itself is
  still complete.
* The archive is a snapshot: prices and status can change at any time.

## Development

No build step, no dependencies. Optional dev tooling:

```bash
npm test              # offline: fake media bytes, ZIP integrity, both sites,
                      # failure + DOM-fallback paths, page-reader and matchers
npm run test:network  # same, but downloads the real photos from both sites
npm run icons         # regenerate icons/*.png (pure Python, no deps)
```

`test/` and `tools/` are not used at runtime; you can delete them without
affecting the extension.
