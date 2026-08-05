# Cave — data model & build handoff

Context lives in the Claude chat "Building a cross-platform database interface".
Stack decided there: Cloudflare Workers + D1 + Workers static assets, TypeScript,
Cloudflare Access, offline-first (IndexedDB + dirty queue) added later. The spike
(a fake `ping` table read/written from PC and Android behind Access) is done and
worked. This doc is about replacing it with the real app.

## What the Access file actually is

`Cave.accdb` is **not a finished target schema to implement faithfully** — it's a
normalization that was started and left half-wired. The evidence:

- `_Ma cave` (the intended bottle→location join table) is **empty**. Location was
  in the flat data and got dropped when it was normalized into `Bouteilles`.
- `Vins.ID Appellation` (the wine→appellation FK) is set on **0 of 133** rows.
  Appellation is still a denormalized text string.
- `Régions`, `Sous-régions`, `Millésimes`, `Capacités` lookup tables are empty.
- The real, complete data only exists in the flat `~TMPCLP*` staging tables.

So: take the *intent* (normalize wines vs stock, reference lists for
country/colour) but not the table layout, and rebuild the schema from what the
data actually is.

## The model: wines + lots

The source data models stock as **lots with a quantity**, not individual bottles:
104 located lots totalling 156 physical bottles. "12 in the Piquey vrac" is one
row with `quantite=12`. Every one of the 104 lots links cleanly to a wine on
`(nom, capacité, millésime)`.

- **`wines`** — the identity of a wine: producer, name, vintage, format, colour,
  appellation, drinking window. 133 of these (some have no stock — it's also a
  catalogue).
- **`lots`** — a quantity of one wine at one place. Drinking one = decrement
  `quantite`.

Two deliberate departures from the `.accdb`:
1. **Location lives on the lot, not in a separate join table.** A lot is in
   exactly one place, so `_Ma cave` was over-normalization. One row owns its
   location.
2. **Maturité ("en retard" / "à conserver" / "à boire") is computed, not
   stored.** It's a function of `millesime`, `apogee_min/max`, and the current
   year. Storing it means it goes stale every January.

Schema is in `migrations/0001_init.sql`.

## Open questions for the client (cheap to change — don't block on them)

The data answers most modelling questions; these it can't. Defaults are chosen so
that if the answer flips, it's an additive change, not a rebuild.

- **A — Etagère slots: can two lots share one hole?** v1 assumes a slot
  (`cave, ligne, colonne`) holds one lot. If they stack, nothing breaks (the
  schema doesn't enforce slot uniqueness), but the "what's in this slot" view
  needs to expect a list.
- **B — Drinking window source.** v1 stores `apogee_min/max` per wine (nullable).
  If they'd rather it default from the appellation, that's a v2 lookup — the
  per-wine field still wins as an override.
- **C — Vrac location.** v1 treats Vrac as just `cave = Piquey|Vence`,
  `emplacement = 'Vrac'`, no coordinates. Confirm a vrac lot needs no finer
  position than "the pile in that cellar".
- **D — Appellation / geography as free text vs reference table.** v1 is free
  text on the wine. Loses spelling consistency and country/region rollups; gains
  simplicity. The reference table is a clean v2 extraction once the text is
  deduped.

## The one non-obvious tech choice

**TEXT uuid primary keys, not autoincrement integers.** Changing a PK type later
is the single most expensive migration (re-key every FK, re-import everything),
and offline-first is already committed: a phone must mint ids offline without
colliding with the PC. So pay the tiny cost now (`crypto.randomUUID()` on insert)
and never migrate the PK. Everything else in the schema is cheap to change — this
is the part that isn't, so it's decided up front.

## Sync columns (present now, used later)

Every mutable table has `updated_at` (epoch ms) and `deleted` (tombstone). Not
needed until the offline/IndexedDB phase, but adding them now avoids a migration
then, and they're free until used. Pull-changes-since-T is indexed on
`updated_at`.

## Seed data

Two clean CSVs extracted straight from the Access file (so the build machine
doesn't need `mdbtools`):

- `seed/wines_raw.csv` — 133 wines from the `Vins` table.
- `seed/stock_raw.csv` — the 104 located lots from the flat staging (with
  cave / emplacement / ligne / colonne / quantite / prix / commentaire).

These are **raw dumps, not final seed**. The ETL that turns them into
`INSERT`s (mint uuids, link each lot to its wine, normalise `A boire` → drinking
window, blank-vs-null cleanup) is a task to do in the repo *with the client
reachable*, because that's where questions A–D get answered. Don't bake the ETL
into migration `0001`.

## Build order (each step shippable)

0. **Schema.** Apply `0001_init.sql` local then remote. Seed `colors`/`caves`
   (already in the migration). Gate: `SELECT * FROM caves` returns 2 rows.
1. **Read API + list UI.** `GET /api/wines` (join lot counts), one plain page
   listing wines with total quantity and locations. No framework yet. Gate: list
   renders from D1 in the browser.
2. **Wine detail + lots.** `GET /api/wines/:id`, show its lots and computed
   maturité. Gate: click a wine, see where its bottles are and whether they're
   ready.
3. **Writes.** Add/edit a wine; add a lot; "drink one" (decrement, delete lot at
   0). `POST/PATCH` with `updated_at = Date.now()`. Gate: full round-trip PC and
   phone, behind Access.
4. **Real data in.** Run the ETL from the seed CSVs, client on the line for
   questions A–D. Gate: their actual cellar shows up correctly on both devices.
5. **Make it not ugly.** Lit components, search/filter (colour, cave, "ready to
   drink"), the maturité view they actually asked for.
6. **Offline.** Service worker, IndexedDB mirror, dirty-write queue,
   last-write-wins using the sync columns. Gate: airplane mode, drink a bottle,
   reconnect, it syncs.

Phases 0–3 are the app existing at all. 4 is real data. 5–6 are quality. Ship and
show the client after 3 and after 4.
