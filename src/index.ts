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

// ---- auth: a signed session cookie gates every request -------------------
// Only the three of us should get in. A single shared password (the AUTH_PASSWORD
// secret) is exchanged at /login for an HMAC-signed, HttpOnly session cookie; the
// Worker (run_worker_first) then checks that cookie on every request — static app
// shell and API alike. No Cloudflare plan, no third party. Rotate access by
// changing the secret: `wrangler secret put AUTH_PASSWORD` invalidates every
// existing cookie (the signing key is derived from the password itself).
const COOKIE = "cave_session";
const SESSION_TTL = 60 * 60 * 24 * 365; // seconds (~1 year)
const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const hmacKey = (secret: string, use: ("sign" | "verify")[]) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, use);

async function signSession(secret: string, exp: number): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ exp })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}
async function validSession(secret: string, token: string | null): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const body = token.slice(0, dot);
  let sig: Uint8Array;
  try { sig = unb64url(token.slice(dot + 1)); } catch { return false; }
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), sig, enc.encode(body));
  if (!ok) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(unb64url(body)));
    return typeof exp === "number" && exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
// Constant-time compare over fixed-length digests: leaks neither content nor length.
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}
function cookie(req: Request, name: string): string | null {
  const raw = req.headers.get("Cookie");
  if (!raw) return null;
  for (const p of raw.split(/;\s*/)) {
    const i = p.indexOf("=");
    if (i > 0 && p.slice(0, i) === name) return decodeURIComponent(p.slice(i + 1));
  }
  return null;
}
// Only ever redirect to a local path (blocks open-redirects via ?next=).
const localPath = (next: string | null) =>
  next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function loginPage(opts: { error?: boolean; next?: string } = {}): Response {
  const next = esc(localPath(opts.next ?? "/"));
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#7A2E39"><title>In Vino Veritas — Connexion</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;
    font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    background:#f4efec;color:#241a1c}
  @media (prefers-color-scheme:dark){body{background:#181113;color:#efe7e8}}
  .card{width:100%;max-width:340px;text-align:center;background:#fff;
    border-radius:16px;padding:32px 28px;box-shadow:0 10px 40px rgba(0,0,0,.12)}
  @media (prefers-color-scheme:dark){.card{background:#251c1f;box-shadow:0 10px 40px rgba(0,0,0,.45)}}
  .logo{font-size:40px;line-height:1}
  h1{margin:.4em 0 0;font-size:clamp(1rem,5.2vw,1.5rem);letter-spacing:.06em;text-transform:uppercase}
  .sub{margin:.25em 0 1.4em;opacity:.6;font-size:.95rem}
  label{display:block;text-align:left;font-size:.85rem;opacity:.7;margin-bottom:6px}
  input{width:100%;padding:12px 14px;font-size:1rem;border-radius:10px;color:inherit;
    background:transparent;border:1px solid rgba(122,46,57,.35)}
  input:focus{outline:2px solid #7A2E39;outline-offset:1px;border-color:transparent}
  button{width:100%;margin-top:16px;padding:12px 14px;font-size:1rem;font-weight:600;
    border:0;border-radius:10px;background:#7A2E39;color:#fff;cursor:pointer}
  button:hover{background:#682430}
  .err{margin:14px 0 0;color:#c0392b;font-size:.9rem}
  @media (prefers-color-scheme:dark){.err{color:#ff8a80}}
</style></head><body>
  <main class="card">
    <div class="logo">🍷</div>
    <h1>In Vino Veritas</h1>
    <p class="sub">Accès réservé</p>
    <form method="POST" action="/login">
      <input type="hidden" name="next" value="${next}">
      <label for="pw">Mot de passe</label>
      <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
      ${opts.error ? `<p class="err">Mot de passe incorrect.</p>` : ""}
      <button type="submit">Entrer</button>
    </form>
  </main>
</body></html>`;
  return new Response(html, {
    status: opts.error ? 401 : 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleLogin(req: Request, secret: string | undefined, url: URL): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const password = form ? String(form.get("password") ?? "") : "";
  const next = localPath(form ? String(form.get("next") ?? "/") : "/");
  if (!secret || !(await sameSecret(password, secret))) {
    // Post/redirect/get so a refresh doesn't re-submit; GET /login renders the error.
    const to = new URL(`/login?e=1${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`, url);
    return new Response(null, { status: 303, headers: { Location: to.toString(), "cache-control": "no-store" } });
  }
  const token = await signSession(secret, Math.floor(Date.now() / 1000) + SESSION_TTL);
  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL(next, url).toString(),
      "Set-Cookie": `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`,
      "cache-control": "no-store",
    },
  });
}

// Serve a static file through the ASSETS binding; never let the edge share-cache
// an authenticated HTML page (also makes deploys land immediately).
async function serveAsset(req: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(req);
  if ((res.headers.get("content-type") || "").includes("text/html")) {
    const h = new Headers(res.headers);
    h.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
  return res;
}

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

// Rename an appellation across the cellar: repoint every wine still using `from`
// to `to` (unifying their geography when provided) and rename it in the dictionary
// so the old spelling drops out of the pickers. Powers the "all wines" choice when
// editing a wine's appellation. The edited wine is already `to`, so it no longer
// matches `from` and isn't touched twice.
async function renameAppellation(env: Env, body: Json): Promise<Response> {
  const from = str(body.from), to = str(body.to);
  if (!from || !to) return bad("from and to required");
  const sr = str(body.sous_region), rg = str(body.region), py = str(body.pays);
  const ts = now();
  const r = await env.DB.prepare(
    `UPDATE wines SET appellation=?2,
       sous_region=COALESCE(?3,sous_region), region=COALESCE(?4,region), pays=COALESCE(?5,pays),
       updated_at=?6
     WHERE appellation=?1 COLLATE NOCASE AND deleted=0`,
  ).bind(from, to, sr, rg, py, ts).run();
  await env.DB.prepare(
    `UPDATE appellations SET appellation=?2 WHERE appellation=?1 COLLATE NOCASE AND deleted=0`,
  ).bind(from, to).run();
  return json({ ok: true, updated: r.meta?.changes ?? null });
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
  { method: "POST",   pattern: pat("/api/appellations/rename"), handler: async (c) => renameAppellation(c.env, await readJson(c.req)) },
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
    const secret = env.AUTH_PASSWORD;
    try {
      // --- public auth endpoints (reachable without a session) ---
      if (url.pathname === "/login") {
        if (request.method === "POST") return await handleLogin(request, secret, url);
        if (secret && (await validSession(secret, cookie(request, COOKIE))))
          return new Response(null, { status: 302, headers: { Location: new URL("/", url).toString() } });
        return loginPage({ error: url.searchParams.get("e") === "1", next: url.searchParams.get("next") ?? "/" });
      }
      if (url.pathname === "/logout") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: new URL("/", url).toString(),
            "Set-Cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
            "cache-control": "no-store",
          },
        });
      }

      // --- gate: everything else needs a valid session ---
      const authed = !!secret && (await validSession(secret, cookie(request, COOKIE)));
      if (!authed) {
        if (url.pathname.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
        // A browser navigation gets the login form; anything else gets a plain 401.
        const nav = request.method === "GET" &&
          (request.headers.get("Sec-Fetch-Mode") === "navigate" ||
            (request.headers.get("Accept") || "").includes("text/html"));
        if (nav) return loginPage({ next: url.pathname + url.search });
        return json({ error: "unauthorized" }, 401);
      }

      // --- authenticated: API routes first, otherwise the static app shell ---
      if (url.pathname.startsWith("/api/")) {
        for (const route of ROUTES) {
          if (route.method !== request.method) continue;
          const match = route.pattern.exec(url);
          if (!match) continue;
          const params: Record<string, string> = {};
          for (const [k, v] of Object.entries(match.pathname.groups)) params[k] = v ? decodeURIComponent(v) : "";
          return await route.handler({ env, req: request, url, params });
        }
        return bad("not found", 404);
      }
      return await serveAsset(request, env);
    } catch (err) {
      return bad(`server error: ${(err as Error).message}`, 500);
    }
  },
} satisfies ExportedHandler<Env>;
