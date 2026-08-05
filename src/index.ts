// Cave backend — Phase 5.
// Read: enriched wine list (with computed maturité), wine detail.
// Write: add wine, add lot (fill), drink one (appraise/use), teach the geography
// dictionary. Geography auto-deduce resolves Appellation -> Sous-région -> Région
// -> Pays from the `appellations` table.
//
// Only ~133 wines, so the list endpoint returns everything enriched and the
// client does search/sort/filter in memory (also the right shape for offline later).

type Json = Record<string, unknown>;
const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (msg: string, status = 400) => new Response(msg, { status });

type Maturite = {
  status: "a_conserver" | "a_boire" | "en_retard" | "inconnu";
  ready_from: number | null;
  drink_by: number | null;
  // years until it enters the window (a_conserver), left in it (a_boire),
  // or past it (en_retard). urgency sorts the whole list: higher = drink sooner.
  delta: number | null;
  urgency: number | null;
};

function maturite(
  millesime: number | null,
  amin: number | null,
  amax: number | null,
  year: number,
): Maturite {
  if (millesime == null || amin == null || amax == null) {
    return { status: "inconnu", ready_from: null, drink_by: null, delta: null, urgency: null };
  }
  const ready_from = millesime + amin;
  const drink_by = millesime + amax;
  const urgency = year - drink_by;
  if (year < ready_from) {
    return { status: "a_conserver", ready_from, drink_by, delta: ready_from - year, urgency };
  }
  if (year <= drink_by) {
    return { status: "a_boire", ready_from, drink_by, delta: drink_by - year, urgency };
  }
  return { status: "en_retard", ready_from, drink_by, delta: year - drink_by, urgency };
}

const now = () => Date.now();
const currentYear = () => new Date().getUTCFullYear();

// ---- read: enriched wine list -------------------------------------------
const WINE_SELECT = `
  SELECT w.id, w.nom, w.couleur, w.capacite_l, w.millesime,
         w.pays, w.region, w.sous_region, w.appellation, w.producteur,
         w.degre, w.recompenses, w.remarques, w.apogee_min, w.apogee_max,
         COALESCE(SUM(CASE WHEN l.deleted=0 THEN l.quantite END), 0) AS total_quantite,
         COUNT(CASE WHEN l.deleted=0 THEN l.id END)                  AS lot_count,
         GROUP_CONCAT(DISTINCT CASE WHEN l.deleted=0 THEN l.cave END) AS caves,
         ca.apogee_min AS color_apogee_min,
         ca.apogee_max AS color_apogee_max,
         (SELECT ap.apogee_min FROM appellations ap WHERE ap.deleted=0
            AND ap.appellation = w.appellation COLLATE NOCASE
            AND ap.couleur = w.couleur COLLATE NOCASE LIMIT 1) AS app_apogee_min,
         (SELECT ap.apogee_max FROM appellations ap WHERE ap.deleted=0
            AND ap.appellation = w.appellation COLLATE NOCASE
            AND ap.couleur = w.couleur COLLATE NOCASE LIMIT 1) AS app_apogee_max
  FROM wines w
  LEFT JOIN lots l         ON l.wine_id = w.id
  LEFT JOIN color_apogee ca ON ca.couleur = w.couleur
  WHERE w.deleted = 0
  GROUP BY w.id`;

interface WineRow {
  id: string; nom: string; couleur: string | null; capacite_l: number | null;
  millesime: number | null; pays: string | null; region: string | null;
  sous_region: string | null; appellation: string | null; producteur: string | null;
  degre: number | null; recompenses: string | null; remarques: string | null;
  apogee_min: number | null; apogee_max: number | null;
  total_quantite: number; lot_count: number; caves: string | null;
  color_apogee_min: number | null; color_apogee_max: number | null;
  app_apogee_min: number | null; app_apogee_max: number | null;
}

// Pick the drinking window from the best available source, most authoritative first:
//   1. a value set on the wine itself   2. the appellation+couleur dictionary
//   3. the colour fallback. Only the colour fallback counts as an "estimate".
function enrich(w: WineRow, year: number) {
  let amin: number | null, amax: number | null, src: "wine" | "appellation" | "couleur" | null;
  if (w.apogee_min != null) { amin = w.apogee_min; amax = w.apogee_max; src = "wine"; }
  else if (w.app_apogee_min != null) { amin = w.app_apogee_min; amax = w.app_apogee_max; src = "appellation"; }
  else if (w.color_apogee_min != null) { amin = w.color_apogee_min; amax = w.color_apogee_max; src = "couleur"; }
  else { amin = null; amax = null; src = null; }
  const m = maturite(w.millesime, amin, amax, year);
  const estimated = m.status !== "inconnu" && src === "couleur";
  return { ...w, maturite: { ...m, estimated, window_src: src } };
}

const LOT_SELECT =
  `SELECT id, wine_id, cave, emplacement, ligne, colonne, quantite, fournisseur, prix, date_entree, commentaire
   FROM lots WHERE deleted = 0`;

async function listWines(env: Env): Promise<Response> {
  const year = currentYear();
  const [wr, lr] = await Promise.all([
    env.DB.prepare(`${WINE_SELECT} ORDER BY w.nom COLLATE NOCASE`).all<WineRow>(),
    env.DB.prepare(`${LOT_SELECT} ORDER BY cave, emplacement, ligne, colonne`).all<{ wine_id: string }>(),
  ]);
  const byWine = new Map<string, unknown[]>();
  for (const l of lr.results) { const a = byWine.get(l.wine_id) ?? []; a.push(l); byWine.set(l.wine_id, a); }
  return json({ year, wines: wr.results.map((w) => ({ ...enrich(w, year), lots: byWine.get(w.id) ?? [] })) });
}

async function getWine(env: Env, id: string): Promise<Response> {
  const year = currentYear();
  const w = await env.DB.prepare(`${WINE_SELECT} HAVING w.id = ?1`).bind(id).first<WineRow>();
  if (!w) return bad("wine not found", 404);
  const { results: lots } = await env.DB.prepare(`${LOT_SELECT} AND wine_id = ?1 ORDER BY cave, emplacement, ligne, colonne`).bind(id).all();
  return json({ year, wine: { ...enrich(w, year), lots } });
}

// ---- reference lists + geography auto-deduce ----------------------------
async function meta(env: Env): Promise<Response> {
  const [colors, caves, apogee, apps, pays, regions, sousRegions, millesimes] = await Promise.all([
    env.DB.prepare("SELECT name FROM colors ORDER BY name").all(),
    env.DB.prepare("SELECT name FROM caves ORDER BY name").all(),
    env.DB.prepare("SELECT couleur, apogee_min, apogee_max FROM color_apogee").all(),
    env.DB.prepare(
      `SELECT pays, region, sous_region, appellation, couleur, apogee_min, apogee_max FROM appellations WHERE deleted = 0`,
    ).all(),
    env.DB.prepare("SELECT name FROM pays ORDER BY name").all(),
    env.DB.prepare("SELECT name FROM regions ORDER BY name").all(),
    env.DB.prepare("SELECT name FROM sous_regions ORDER BY name").all(),
    env.DB.prepare("SELECT annee FROM millesimes ORDER BY annee DESC").all(),
  ]);
  const names = (r: { results: unknown[] }) => r.results.map((x) => (x as { name: string }).name);
  return json({
    colors: names(colors),
    caves: names(caves),
    color_apogee: apogee.results,
    appellations: apps.results,
    pays: names(pays),
    regions: names(regions),
    sous_regions: names(sousRegions),
    millesimes: millesimes.results.map((x) => (x as { annee: number }).annee),
  });
}

// Grow the controlled vocabulary as new values are entered (mirrors teachAppellation).
// Keeps the pickers offering everything the cellar has actually used.
async function teachVocab(env: Env, body: Json): Promise<void> {
  const stmts = [];
  const p = str(body.pays), r = str(body.region), s = str(body.sous_region);
  if (p) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO pays (name) VALUES (?1)").bind(p));
  if (r) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO regions (name) VALUES (?1)").bind(r));
  if (s) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO sous_regions (name) VALUES (?1)").bind(s));
  const y = body.millesime == null || body.millesime === "" ? NaN : Number(body.millesime);
  if (Number.isFinite(y)) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO millesimes (annee) VALUES (?1)").bind(Math.round(y)));
  if (stmts.length) await env.DB.batch(stmts);
}

// Resolve the coarser geography levels from the finest one the user typed.
async function resolveGeo(env: Env, term: string) {
  const t = term.trim();
  if (!t) return null;
  const byApp = await env.DB.prepare(
    `SELECT pays, region, sous_region, appellation FROM appellations
     WHERE deleted=0 AND appellation IS NOT NULL AND appellation = ?1 COLLATE NOCASE LIMIT 1`,
  ).bind(t).first();
  if (byApp) return byApp;
  const bySr = await env.DB.prepare(
    `SELECT pays, region, sous_region FROM appellations
     WHERE deleted=0 AND sous_region = ?1 COLLATE NOCASE LIMIT 1`,
  ).bind(t).first();
  return bySr ?? null;
}

// ---- writes -------------------------------------------------------------
async function addWine(env: Env, body: Json): Promise<Response> {
  const nom = String(body.nom ?? "").trim();
  if (!nom) return bad("nom required");
  const id = crypto.randomUUID();
  const ts = now();
  const num = (v: unknown) => (v === "" || v == null ? null : Number(v));
  // Fill any missing geography level from the dictionary (client-provided wins).
  let pays = str(body.pays), region = str(body.region), sous_region = str(body.sous_region);
  const appellation = str(body.appellation);
  if (appellation && (!pays || !region || !sous_region)) {
    const g = (await resolveGeo(env, appellation)) as { pays?: string; region?: string; sous_region?: string } | null;
    if (g) { pays ??= g.pays ?? null; region ??= g.region ?? null; sous_region ??= g.sous_region ?? null; }
  }
  await env.DB.prepare(
    `INSERT INTO wines (id,nom,couleur,capacite_l,millesime,pays,region,sous_region,appellation,
       producteur,degre,recompenses,remarques,apogee_min,apogee_max,updated_at,deleted)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,0)`,
  ).bind(
    id, nom, str(body.couleur), num(body.capacite_l), num(body.millesime),
    pays, region, sous_region, appellation,
    str(body.producteur), num(body.degre), str(body.recompenses), str(body.remarques),
    num(body.apogee_min), num(body.apogee_max), ts,
  ).run();
  await teachAppellation(env, body); await teachVocab(env, body);
  return getWine(env, id);
}

async function addLot(env: Env, wineId: string, body: Json): Promise<Response> {
  const w = await env.DB.prepare("SELECT id FROM wines WHERE id=?1 AND deleted=0").bind(wineId).first();
  if (!w) return bad("wine not found", 404);
  const id = crypto.randomUUID();
  const num = (v: unknown) => (v === "" || v == null ? null : Number(v));
  const qte = Math.max(1, Number(body.quantite ?? 1) || 1);
  await env.DB.prepare(
    `INSERT INTO lots (id,wine_id,cave,emplacement,ligne,colonne,quantite,fournisseur,prix,date_entree,commentaire,updated_at,deleted)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0)`,
  ).bind(
    id, wineId, str(body.cave), str(body.emplacement), num(body.ligne), num(body.colonne),
    qte, str(body.fournisseur), num(body.prix), str(body.date_entree), str(body.commentaire), now(),
  ).run();
  return getWine(env, wineId);
}

// Drink one bottle from a lot: decrement; tombstone the lot when it hits zero.
async function drinkLot(env: Env, lotId: string): Promise<Response> {
  const lot = await env.DB.prepare(
    "SELECT id, wine_id, quantite FROM lots WHERE id=?1 AND deleted=0",
  ).bind(lotId).first<{ id: string; wine_id: string; quantite: number }>();
  if (!lot) return bad("lot not found", 404);
  const ts = now();
  if (lot.quantite <= 1) {
    await env.DB.prepare("UPDATE lots SET quantite=0, deleted=1, updated_at=?2 WHERE id=?1")
      .bind(lotId, ts).run();
  } else {
    await env.DB.prepare("UPDATE lots SET quantite=quantite-1, updated_at=?2 WHERE id=?1")
      .bind(lotId, ts).run();
  }
  return getWine(env, lot.wine_id);
}

// Reverse a drink (the Undo action): put one bottle back, un-tombstoning the lot
// if it had hit zero. Looks the lot up regardless of `deleted`.
async function undrinkLot(env: Env, lotId: string): Promise<Response> {
  const lot = await env.DB.prepare("SELECT wine_id FROM lots WHERE id=?1")
    .bind(lotId).first<{ wine_id: string }>();
  if (!lot) return bad("lot not found", 404);
  await env.DB.prepare("UPDATE lots SET quantite=quantite+1, deleted=0, updated_at=?2 WHERE id=?1")
    .bind(lotId, now()).run();
  return getWine(env, lot.wine_id);
}

// Edit a wine: update only the fields present in the body.
const EDITABLE = ["nom", "couleur", "capacite_l", "millesime", "pays", "region",
  "sous_region", "appellation", "producteur", "degre", "recompenses", "remarques",
  "apogee_min", "apogee_max"] as const;
const NUMERIC = new Set(["capacite_l", "millesime", "degre", "apogee_min", "apogee_max"]);

async function updateWine(env: Env, id: string, body: Json): Promise<Response> {
  const w = await env.DB.prepare("SELECT id FROM wines WHERE id=?1 AND deleted=0").bind(id).first();
  if (!w) return bad("wine not found", 404);
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of EDITABLE) {
    if (!(k in body)) continue;
    const raw = body[k];
    const v = NUMERIC.has(k) ? (raw === "" || raw == null ? null : Number(raw)) : str(raw);
    sets.push(`${k}=?${vals.length + 1}`);
    vals.push(v);
  }
  if (sets.length) {
    sets.push(`updated_at=?${vals.length + 1}`); vals.push(now());
    vals.push(id);
    await env.DB.prepare(`UPDATE wines SET ${sets.join(",")} WHERE id=?${vals.length}`).bind(...vals).run();
    await teachAppellation(env, body); await teachVocab(env, body);
  }
  return getWine(env, id);
}

async function deleteWine(env: Env, id: string): Promise<Response> {
  const w = await env.DB.prepare("SELECT id FROM wines WHERE id=?1 AND deleted=0").bind(id).first();
  if (!w) return bad("wine not found", 404);
  const ts = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE wines SET deleted=1, updated_at=?2 WHERE id=?1").bind(id, ts),
    env.DB.prepare("UPDATE lots SET deleted=1, updated_at=?2 WHERE wine_id=?1 AND deleted=0").bind(id, ts),
  ]);
  return json({ ok: true, id });
}

async function deleteLot(env: Env, lotId: string): Promise<Response> {
  const lot = await env.DB.prepare("SELECT wine_id FROM lots WHERE id=?1 AND deleted=0")
    .bind(lotId).first<{ wine_id: string }>();
  if (!lot) return bad("lot not found", 404);
  await env.DB.prepare("UPDATE lots SET deleted=1, updated_at=?2 WHERE id=?1").bind(lotId, now()).run();
  return getWine(env, lot.wine_id);
}

// Teach the dictionary a geography combo it doesn't know yet (idempotent-ish).
async function teachAppellation(env: Env, body: Json): Promise<void> {
  const appellation = str(body.appellation);
  const sous_region = str(body.sous_region);
  if (!appellation && !sous_region) return;
  const existing = await env.DB.prepare(
    `SELECT id FROM appellations WHERE deleted=0
       AND IFNULL(appellation,'')=IFNULL(?1,'') AND IFNULL(sous_region,'')=IFNULL(?2,'')
       AND IFNULL(region,'')=IFNULL(?3,'') AND IFNULL(pays,'')=IFNULL(?4,'') LIMIT 1`,
  ).bind(appellation, sous_region, str(body.region), str(body.pays)).first();
  if (existing) return;
  await env.DB.prepare(
    `INSERT INTO appellations (id,pays,region,sous_region,appellation,apogee_min,apogee_max,couleur,updated_at,deleted)
     VALUES (?1,?2,?3,?4,?5,NULL,NULL,NULL,?6,0)`,
  ).bind(crypto.randomUUID(), str(body.pays), str(body.region), sous_region, appellation, now()).run();
}

function str(v: unknown): string | null {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
}

async function readJson(req: Request): Promise<Json> {
  try { return (await req.json()) as Json; } catch { return {}; }
}

// Routing table using the platform URLPattern API (not ad-hoc path regexes).
// Each route names its params via :id groups; the dispatcher decodes them.
type Ctx = { env: Env; req: Request; url: URL; params: Record<string, string> };
type Route = { method: string; pattern: URLPattern; handler: (c: Ctx) => Promise<Response> };
const pat = (pathname: string) => new URLPattern({ pathname });

const ROUTES: Route[] = [
  { method: "GET",    pattern: pat("/api/wines"),            handler: (c) => listWines(c.env) },
  { method: "POST",   pattern: pat("/api/wines"),            handler: async (c) => addWine(c.env, await readJson(c.req)) },
  { method: "GET",    pattern: pat("/api/meta"),             handler: (c) => meta(c.env) },
  { method: "GET",    pattern: pat("/api/geo/resolve"),      handler: async (c) => json((await resolveGeo(c.env, c.url.searchParams.get("q") ?? "")) ?? {}) },
  { method: "GET",    pattern: pat("/api/wines/:id"),        handler: (c) => getWine(c.env, c.params.id) },
  { method: "PATCH",  pattern: pat("/api/wines/:id"),        handler: async (c) => updateWine(c.env, c.params.id, await readJson(c.req)) },
  { method: "DELETE", pattern: pat("/api/wines/:id"),        handler: (c) => deleteWine(c.env, c.params.id) },
  { method: "POST",   pattern: pat("/api/wines/:id/lots"),   handler: async (c) => addLot(c.env, c.params.id, await readJson(c.req)) },
  { method: "POST",   pattern: pat("/api/lots/:id/drink"),   handler: (c) => drinkLot(c.env, c.params.id) },
  { method: "POST",   pattern: pat("/api/lots/:id/undrink"), handler: (c) => undrinkLot(c.env, c.params.id) },
  { method: "DELETE", pattern: pat("/api/lots/:id"),         handler: (c) => deleteLot(c.env, c.params.id) },
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      for (const route of ROUTES) {
        if (route.method !== request.method) continue;
        const match = route.pattern.exec(url);
        if (!match) continue;
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(match.pathname.groups)) params[k] = v ? decodeURIComponent(v) : "";
        return await route.handler({ env, req: request, url, params });
      }
      // Unmatched: /api falls through to 404; everything else is served by static assets.
      return bad("not found", 404);
    } catch (err) {
      return bad(`server error: ${(err as Error).message}`, 500);
    }
  },
} satisfies ExportedHandler<Env>;
