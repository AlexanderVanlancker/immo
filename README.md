# immo

A private, local property database built from [Immoweb](https://www.immoweb.be) and
[Immoscoop](https://www.immoscoop.be) listings — no accounts, no scraping service, no database
server. Two small projects that talk to each other through a plain file format.

| Folder | What it is |
| --- | --- |
| [`immoweb-zipper/`](immoweb-zipper) | Chrome extension. Saves one listing (for sale or for rent) from Immoweb **or** Immoscoop as a ZIP: every field, every photo, floor plans, documents. |
| [`immo-viewer/`](immo-viewer) | Local web app. Reads those ZIPs and gives you a map, a filterable list and a stats view — price per m², by EPC label, by neighbourhood, over time. |
| `data/exports/` | Where the ZIPs live. **Git-ignored** — your listings never leave your machine. |

## Quick start

```bash
# 1. Save a few listings with the extension (see immoweb-zipper/README.md).
#    Works on Immoweb and Immoscoop; the ZIPs land in ~/Downloads.

# 2. Put them where the viewer looks
cp ~/Downloads/*.zip data/exports/

# 3. Run the viewer
cd immo-viewer
npm install
npm run dev          # → http://localhost:5173
```

Adding a listing later is just dropping another ZIP into `data/exports/` and pressing
**Refresh** in the app (or reloading the page). Nothing is extracted, imported or migrated.

To read ZIPs from somewhere else:

```bash
IMMOWEB_EXPORTS_DIR=~/Downloads npm run dev
```

## Why ZIPs in a folder?

* **Self-describing.** Each archive holds `info.json` (normalised facts for machines),
  `summary.md` (the same, readable), `listing.json` (the site's raw payload) and the photos.
  If this repository disappears tomorrow, the archives are still complete.
* **No import step.** The viewer reads `info.json` straight out of the archive and streams
  photos from it, so the folder of ZIPs *is* the database.
* **Portable and private.** Copy the folder to another machine and everything works. Nothing
  is uploaded anywhere.

## The contract between the two projects

`immoweb-zipper` writes `info.json`; `immo-viewer` reads it and never touches anything else
except `photos/`, `floorplans/` and `documents/`. `immo-viewer/server/normalise.ts` is the only
place that knows the JSON shape, and it is defensive about it — neither site is consistent
between listings, so every field is optional. The extension normalises both sites into the same
`info.json` (and records which one in `source`), so the viewer never needs to care where a
listing came from.

```
immo/
├── data/
│   └── exports/                 # your ZIPs (git-ignored, only .gitkeep is committed)
├── immoweb-zipper/              # browser extension, no build step
│   ├── manifest.json
│   ├── background.js
│   ├── offscreen.js             # downloads media, normalises data, writes the ZIP
│   └── test/                    # offline tests for the above
└── immo-viewer/                 # Vite + TypeScript app
    ├── server/                  # ZIP reader, normaliser, /api middleware
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
