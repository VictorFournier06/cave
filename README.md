# Cave

A personal wine‑cellar app — find a bottle to drink *now*, see what's past its window, and know what to rebuy. Built as an installable, offline‑capable PWA on Cloudflare's edge.

## Stack

- **Cloudflare Workers** (TypeScript) — JSON API + static‑asset hosting, one Worker
- **D1** (SQLite) — storage
- **Vanilla‑JS PWA** — no framework, no bundler: a single `public/index.html` on top of a small design‑system stylesheet; installable and works offline

## Features

- **Search** across every field (name, producer, appellation, geography, supplier, comments…)
- **Filters**: maturité, colour, cave, a **cascading** geography (pays → région → sous‑région → appellation), millésime and capacité
- **Maturité** (drinking window) computed per wine from its vintage + apogee, sorted "à boire d'abord"; falls back to an appellation dictionary, then a colour default
- **Geography auto‑deduce**: type an appellation and région / sous‑région / pays fill in from a curated dictionary (which also learns new entries)
- Add wines & bottles, drink / undo, edit; per‑cave and total cellar value in the header
- **Offline‑first**: reads cached by a service worker; writes are optimistic, queued in `localStorage`, and replayed on reconnect

## Layout

| Path | What |
|------|------|
| `src/index.ts` | the Worker — API + `URLPattern` routing + maturité logic |
| `public/index.html` | the whole SPA (markup + inline JS) |
| `public/styles.css` | design system (tokens → semantics → components) |
| `public/sw.js`, `manifest.webmanifest`, `icon-*.png` | PWA shell |
| `migrations/` | D1 schema (`0001_init.sql`, `0002_geography.sql`) |
| `seed/etl.py` | Access `.accdb` → D1 import script |
| `DATA_MODEL.md`, `DESIGN_SYSTEM.md` | design notes |

## Develop

```bash
npm install
npx wrangler types      # regenerates worker-configuration.d.ts (gitignored)
npx wrangler dev
```

You'll need a D1 database: create one, put its id in `wrangler.jsonc`, then apply the schema, e.g.

```bash
npx wrangler d1 execute cave-db --local --file migrations/0001_init.sql
npx wrangler d1 execute cave-db --local --file migrations/0002_geography.sql
```

## Deploy

```bash
npx wrangler deploy
```

## Data

The owner's cellar data (the source Access database and the seeded inventory) is **not** committed. The schema in `migrations/` seeds only generic reference rows (colours, caves, colour‑based drinking windows); add your own wines through the app.
