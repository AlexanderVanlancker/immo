# Immoweb Listing Zipper

A Chrome extension that saves any Immoweb listing — **for sale or for rent** — as a
single ZIP: price, description, surfaces, rooms, EPC, address, agency details,
every photo, floor plans and attachments.

Everything runs locally in your browser. Nothing is uploaded anywhere, and the
extension only talks to `immoweb.be` / `immowebstatic.be` domains.

> **Part of [`immo`](../README.md).** Drop the ZIPs this extension produces into
> `../data/exports/`, then run [`immo-viewer`](../immo-viewer) to browse them on a map, filter
> and search them, and see price-per-m² statistics.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (`immoweb-zipper`).
4. Pin the extension (puzzle-piece icon → pin) so it is one click away.

Works in Chrome, Edge, Brave and other Chromium 116+ browsers.

## Use

1. Open a listing, e.g.
   `https://www.immoweb.be/en/classified/penthouse/for-sale/antwerpen/2000/21807693`
   or
   `https://www.immoweb.be/en/classified/apartment/for-rent/antwerpen/2050/21787646`
2. Click the extension icon.
3. Pick options (photo size, optional raw page snapshot) and press
   **Save this listing as ZIP**.
4. The ZIP lands in your Downloads folder, named after the address:
   `Gentplaats 12  2000 — Antwerpen.zip`. Use **Show in folder** in the popup to
   jump to it.

Options are remembered between saves.

## File naming

Both the ZIP and the folder inside it use the listing address:

```
<street> <number> [box <box>]  <postal code> — <city>
```

Examples:

* `Maria Claessensplein 5  2050 — Antwerpen.zip`
* `Leo J. Krynlaan 1 box 101  2050 — Antwerpen.zip`

The Immoweb ID is not in the name (it stays in `summary.md`, `info.json` and
`listing.json`), so two different listings at the exact same address produce the
same name — Chrome then saves the second as `… — Antwerpen (1).zip`.

If a listing has no street address, the name falls back to
`<id>-<for-sale|for-rent>-<type>-<city>-<postal code>`. Characters that Windows
or macOS refuse in a file name (`< > : " / \ | ? *`) are replaced with `-`, and
city names Immoweb shouts in capitals (`ANTWERPEN`) are normalised to `Antwerpen`.

## What's inside the ZIP

```
Gentplaats 12  2000 — Antwerpen/
├── summary.md          human-readable sheet: price, surfaces, rooms, EPC,
│                       location, description, agency, metadata
├── info.json           the same facts, normalised for scripts/spreadsheets
├── listing.json        raw listing data as Immoweb embedded it in the page
│                       (window.classified) — the complete source of truth
├── README.txt          what each file is
├── photos/01.jpg …     all photos, in display order (default: 2560 px)
├── floorplans/         floor plans, if the listing has any
├── documents/          brochures / certificates, if any
└── page.html           only when "Include raw page snapshot" is ticked
```

`download-errors.txt` appears only if some media could not be downloaded — the
archive is still produced.

### Fields captured

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
  and any other specificities Immoweb lists.
* **Agency** — name, type, phone, mobile, email, website, IPI number, agent.
* **Description** — falls back to `alternativeDescriptions` when Immoweb leaves
  the canonical description empty (common on new-build listings), and records
  which language the text is in.
* **Metadata** — Immoweb ID, external reference, publication/modification dates,
  availability, photo/floor-plan/document counts, virtual tour and video links,
  sold/rented flag.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| Photo size | Max (2560 px) | Large 736 px / Medium / Small if you want smaller archives. A 23-photo listing is ~5 MB at max size. |
| Include raw page snapshot | off | Adds `page.html` (the rendered page at save time). |
| Ask where to save | off | Uses Chrome's save dialog instead of Downloads. |

## How it works

* `background.js` (service worker) reads the listing out of the open tab with
  `chrome.scripting.executeScript` in the page's `MAIN` world, where Immoweb
  exposes the full listing object as `window.classified`. If that object is
  missing, it falls back to scraping the visible page (title, price,
  description, images).
* `offscreen.js` runs in an offscreen document — it downloads the media
  (4 requests in parallel, retries, 60 s timeout each), normalises the data and
  builds the ZIP with [fflate](https://github.com/101arrowz/fflate) (vendored,
  MIT).
* The ZIP blob is handed to `chrome.downloads`, and progress is streamed back to
  the popup through `chrome.storage.session`.

Required permissions: `activeTab`, `scripting`, `downloads`, `offscreen`,
`storage`, plus host access to Immoweb domains (for the page and its photos).

Entries are stored as UTF-8 with the ZIP UTF-8 flag, so the em dash and the
double space survive on Windows, macOS and Linux. (The legacy `unzip` CLI may
*print* the name as mojibake; the stored name is correct.)

## Robustness

Immoweb is not consistent about its data shapes: `media.documents` is a list on
one listing and an object keyed by uuid on the next, `media.floorPlans` may hold
plain URL strings, `specificities` may be an array or an object, and some
listings have no `title` or `description` at all. Every collection is normalised
through the same helper, and a field that cannot be read only costs you that
field — the save still completes with the photos, the raw `listing.json` and a
note in `download-errors.txt`. `test/fixtures/house.json` is a real listing that
exercises all of those variants; `npm test` keeps it that way.

## Limitations

* Only single listing pages (`…/classified/…`). Project/"new build" pages with
  unit groupings save what the page exposes.
* Private or expired listings can't be saved — Immoweb has to serve the page.
* Photo resolution is capped by Immoweb's image service (2560×1440).
* The archive is a snapshot: prices and status can change at any time.

## Development

No build step, no dependencies. Optional dev tooling:

```bash
npm test              # offline: fake media bytes, ZIP integrity, failure + fallback paths
npm run test:network  # same, but downloads the real photos from Immoweb
npm run icons         # regenerate icons/*.png (pure Python, no deps)
```

`test/` and `tools/` are not used at runtime; you can delete them without
affecting the extension.
