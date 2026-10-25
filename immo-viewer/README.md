# immo-viewer

A local web app that turns the listings saved by
[`immoweb-zipper`](../immoweb-zipper) into a map, a filterable list and a stats view.

```bash
npm install
npm run dev        # http://localhost:5173
```

Two folders, both outside git:

| Folder | What it is |
| --- | --- |
| `../data/exports/` | **Inbox.** The ZIPs the extension downloads, exactly as they arrived. |
| `../data/listings/` | **Store.** One plain folder per listing: `info.json`, photos, floor plans, documents. |

The inbox is imported on every scan (`ditto` on macOS, `bsdtar`/`unzip` elsewhere), so dropping
a ZIP and pressing **Refresh** is still the whole workflow. Nothing in this app understands
ZIP: it reads folders. Import without starting the server with:

```bash
npm run unpack
```

Point it elsewhere with `IMMOWEB_EXPORTS_DIR=~/Downloads` and/or
`IMMO_LISTINGS_DIR=/path/to/folders`. Archives stay in the inbox after import and are skipped
until they change; deleting a listing folder makes the next scan re-import it from its ZIP.

The one thing written back is the location: pinning a listing on the map rewrites its
`info.json` (atomically, source data untouched). Everything else stays as saved.

## What you get

**List + filters.** Transaction type, source site (Immoweb / Immoscoop), property type,
location, EPC label, price, €/m², living area, plot size, bedrooms, must-have features, and
free-text search across address, city, agency, source site, listing id, reference and
description. Filters live in the URL hash, so a filtered view can be bookmarked. `Filters`
collapses; the count badge shows how many are active.

Chip counts are faceted: each shows what clicking it would return *given the other active
filters*, so a chip reading `Immoscoop 0` is honest (and not clickable) while a search or a
price range rules those listings out. When a combination matches nothing, the empty state lists
the filters that are narrowing the list and offers **Clear all filters**.

**Listings from more than one site.** Every archive records where it came from
(`info.json › source`). Cards carry a small source pill, the detail panel names it, and the
`Source` filter group appears as soon as two sites are present. Listings without coordinates
(Immoscoop hides the address on some of them) still appear in the list with a `No map pin`
pill — they are simply left out of the map.

**Map.** MapLibre GL with a price pill per listing, auto-fitted to whatever the filters
return. Hovering a card highlights its pin and vice versa; clicking either opens the detail
panel. The basemap is [OpenFreeMap](https://openfreemap.org)'s key-less `liberty` style, with
an OpenStreetMap raster fallback if that style cannot be loaded.

**Detail panel.** Full photo gallery from the listing folder (arrow keys work), price and €/m²,
around 25 property facts, energy certificate details, comfort features, description, agency,
an OpenStreetMap link, floor-plan links, a link back to the original listing page, a download
of the normalised `info.json`, and **Place this listing on the map** for anything that arrived
without coordinates.

**Stats.** KPIs (count, median price, median €/m², median living area, geocoded share) plus
six charts, all computed over the *currently filtered* set:

| Chart | Question it answers |
| --- | --- |
| Price vs living area (+ trend line) | What does an extra m² cost? |
| Median €/m² by EPC label | How much is an energy label worth? |
| Median €/m² by postal code | Which neighbourhood is expensive? |
| Median €/m² over time | How is the market moving? |
| Median €/m² by bedrooms | Does an extra bedroom pay off per m²? |
| Median price by property type | Houses vs apartments |

Alongside the charts, the app says what it cannot show: mixing rentals into price
comparisons, listings with no living area, or a single month of publication dates.

## How it works

It is a Vite + TypeScript single-page app with a small server side, both in this folder:

```
server/
  unpack.ts      imports the inbox with the platform extractor (ditto / bsdtar / unzip)
  normalise.ts   info.json  →  Listing DTO (defensive: every field is optional)
  store.ts       reads the listing folders, caches them, serves files, writes the pin back
  api.ts         Connect middleware mounted by Vite for both dev and preview
src/
  main.ts        bootstrap + wiring
  state.ts       tiny store (listings, filters, selection, view) with change reasons
  filters.ts     filter model, matching, facets, URL-hash serialisation
  stats.ts       median/regression/bucketing — pure functions, unit tested
  mapView.ts     MapLibre map, price markers, auto-fit
  listView.ts    result cards
  detailView.ts  the side panel
  statsView.ts   KPI cards + chart layout
  charts.ts      hand-rolled SVG bar / scatter / line charts
```

### API

Served by the same process as the app (`vite dev` and `vite preview` both mount it):

| Route | Returns |
| --- | --- |
| `GET /api/listings` | `{ scannedAt, sourceDir, listings: Listing[], errors: [{ folder, message }], imported }` |
| `GET /api/listings/:key/photos/:index` | Photo bytes, `image/jpeg` (immutable cache headers) |
| `GET /api/listings/:key/floorplans/:index` | Floor plan (PDF or image) |
| `GET /api/listings/:key/documents/:index` | Brochure / certificate |
| `GET /api/listings/:key/files/:name` | A text file from the folder (`info.json`, `summary.md`, …) |
| `POST /api/listings/:key/location` | `{ lat, lon, label?, street?, … }` → writes `info.json`, returns the listing |
| `GET /api/health` | `{ ok, sourceDir }` |

`:key` is a stable slug derived from the folder name, e.g.
`maria-claessensplein-5-2050-antwerpen-c5f6a1`.

Each `GET /api/listings` imports whatever is new in the inbox and rescans the store
(`readdir` + `stat`), so new listings appear without a restart; folders whose `info.json` has
not changed are served from the parsed cache.

### Adding a field

1. Add it to the `Listing` type in `src/types.ts`.
2. Map it in `server/normalise.ts` (use `asNumber` / `asString` / `asBool` / `asObject` — never
   assume a value exists).
3. Show it in `src/detailView.ts` with `fact('Label', value)`.
4. If it should be filterable, add the predicate in `src/filters.ts` and, if it is a "must
   have", an entry in `FEATURE_FILTERS`.

If the extension does not capture the field yet, add it to `offscreen.js` in
`immoweb-zipper/` first — that is where `info.json` is written.

## Tests

```bash
npm test        # vitest: inbox import, folder store, pin write-back, normaliser,
                # filters, stats (no network, no personal data)
npm run typecheck
npm run build
npm run smoke   # Playwright end-to-end against a running dev server (needs `npm i -D playwright`)
```

The unit tests build their own folders and archives in a temp directory, so they never depend
on (or write to) your own listings. The smoke test drives the real app against whatever is in
`data/listings/` and checks listing cards, map pins, the detail gallery, filtering, search and
the stats charts — its expectations are derived from `/api/listings`, so it survives a growing
collection.

## Shortcuts

| Key | Action |
| --- | --- |
| `/` | Focus search |
| `↓` / `j`, `↑` / `k` | Move through the results |
| `←` / `→` | Previous / next photo while a listing is open |
| `Esc` | Close the detail panel, or clear the search |
