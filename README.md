# immo

A private, local property database built from [Immoweb](https://www.immoweb.be) and
[Immoscoop](https://www.immoscoop.be) listings — no accounts, no scraping service, no database
server. Two small projects that talk to each other through plain files on disk.

| Folder | What it is |
| --- | --- |
| [`immoweb-zipper/`](immoweb-zipper) | Chrome extension. Saves one listing (for sale or for rent) from Immoweb **or** Immoscoop as a ZIP: every field, every photo, floor plans, documents. |
| [`immo-viewer/`](immo-viewer) | Local web app. Unpacks those ZIPs into folders and gives you a map, a filterable list and a stats view — price per m², by EPC label, by neighbourhood, over time. |
| `data/exports/` | Inbox: the ZIPs the extension downloads. **Git-ignored.** |
| `data/listings/` | Store: one plain folder per listing (`info.json`, photos, floor plans). **Git-ignored** — your listings never leave your machine. |

## Quick start

```bash
# 1. Save a few listings with the extension (see immoweb-zipper/README.md).
#    Works on Immoweb and Immoscoop; the ZIPs land in ~/Downloads.

# 2. Drop them in the inbox
cp ~/Downloads/*.zip data/exports/

# 3. Run the viewer
cd immo-viewer
npm install
npm run dev          # → http://localhost:5173
```

Adding a listing later is just dropping another ZIP into `data/exports/` and pressing
**Refresh** — the app unpacks it into `data/listings/` on the spot (macOS `ditto`, `bsdtar` or
`unzip`; no ZIP code of our own) and reads it from there. Unpack without starting the server:

```bash
cd immo-viewer && npm run unpack
```

To read from somewhere else entirely:

```bash
IMMOWEB_EXPORTS_DIR=~/Downloads IMMO_LISTINGS_DIR=~/listings npm run dev
```

## Why ZIPs in, folders out?

* **ZIP is a transport, not a storage format.** The extension can only hand the browser a
  single download, so it writes one ZIP per listing. Everything after that works on folders:
  no ZIP parsing or writing in the viewer, and you can open, edit or delete anything with
  Finder.
* **Self-describing.** Each folder holds `info.json` (normalised facts for machines),
  `summary.md` (the same, readable), `listing.json` (the site's raw payload) and the photos.
  If this repository disappears tomorrow, the folders are still complete.
* **Portable and private.** Copy `data/listings/` to another machine and everything works.
  Nothing is uploaded anywhere.

The archive is kept in `data/exports/` after import, so a folder you delete (or damage) is
restored from it on the next scan.

## The contract between the two projects

`immoweb-zipper` writes `info.json` (inside its ZIP); `immo-viewer` unpacks it and reads
`info.json` plus `photos/`, `floorplans/` and `documents/`. The only thing it writes back is a
hand-placed map location, which lands in the same `info.json`.

`immo-viewer/server/normalise.ts` is the only place that knows the JSON shape, and it is
defensive about it — neither site is consistent between listings, so every field is optional.
The extension normalises both sites into the same `info.json` (and records which one in
`source`), so the viewer never needs to care where a listing came from.

```
immo/
├── data/                        # git-ignored (only .gitkeep files are committed)
│   ├── exports/                 # inbox: the ZIPs the extension downloads
│   └── listings/                # store: one plain folder per listing
├── immoweb-zipper/              # browser extension, no build step
│   ├── manifest.json
│   ├── background.js
│   ├── offscreen.js             # downloads media, normalises data, writes the ZIP
│   └── test/                    # offline tests for the above
└── immo-viewer/                 # Vite + TypeScript app
    ├── server/                  # inbox import, folder store, normaliser, /api middleware
    ├── src/                     # map, list, filters, detail panel, stats
    └── test/                    # vitest unit tests + a Playwright smoke test
```

## Status

The viewer covers searching, filtering, map browsing, a detail panel with the full photo
gallery, and a stats tab that already answers "what does an EPC label cost per m² here?" and
"how has the median €/m² moved over time?".

Everything price-history related gets more useful the longer you collect listings: the
timeline groups by publication month, so with one month of archives it is a single dot, and
with a year of archives it becomes a real curve.
