"""ETL: wines_raw.csv + stock_raw.csv + Appellations dict -> 0002_data.sql

Deterministic (uuid5) so re-running yields identical ids. Prints verification
stats; writes cave/seed/0002_data.sql. Not baked into a migration on purpose.
"""
import csv, json, os, re, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
DICT_JSON = r"C:\Users\victo\AppData\Local\Temp\claude\C--Users-victo-Documents-Code\67bed296-ee65-4250-99ee-ef25624ab555\scratchpad\accdb_dump.json"
OUT = os.path.join(HERE, "0002_data.sql")
NS = uuid.UUID("00000000-0000-0000-0000-00000000cafe")
TS = 1785679200000

def U(kind, k): return str(uuid.uuid5(NS, f"{kind}:{k}"))
def norm(s): return re.sub(r"\s+", " ", str(s or "")).strip()
def keyn(s): return norm(s).casefold()

def read_csv(name):
    with open(os.path.join(HERE, name), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))

def as_int(s):
    s = norm(s)
    if not s: return None
    try: return int(float(s.replace(",", ".")))
    except ValueError: return None

def as_real(s):
    s = norm(s)
    if not s: return None
    try: return float(s.replace(",", "."))
    except ValueError: return None

# ---- SQL literal helpers -------------------------------------------------
def q(s):
    s = norm(s)
    return "NULL" if s == "" else "'" + s.replace("'", "''") + "'"
def n(v): return "NULL" if v is None else str(v)

wines_raw = read_csv("wines_raw.csv")
stock_raw = read_csv("stock_raw.csv")
adict = json.load(open(DICT_JSON, encoding="utf-8"))["Appellations"]

# ---- geography dictionary maps -------------------------------------------
# free-text appellation/sous-region (casefolded) -> (pays, region, sous_region)
by_app, by_sr = {}, {}
for r in adict:
    pays, reg, sr, app = norm(r.get("Pays")), norm(r.get("Région")), norm(r.get("Sous-Région")), norm(r.get("Appellation"))
    if app: by_app.setdefault(keyn(app), (pays or None, reg or None, sr or None))
    if sr:  by_sr.setdefault(keyn(sr), (pays or None, reg or None, sr or None))

def resolve_geo(app_text, pays=None, region=None):
    """Return (pays, region, sous_region, appellation) best-effort."""
    a = keyn(app_text)
    if a in by_app:
        p, rg, sr = by_app[a]
        return (pays or p, region or rg, sr, norm(app_text) or None)
    if a in by_sr:
        p, rg, sr = by_sr[a]
        return (pays or p, region or rg, sr, None)
    return (pays or None, region or None, None, norm(app_text) or None)

# ---- link stock lots to wines on (nom, capacite, millesime) --------------
def wkey(nom, cap, mill): return (keyn(nom), cap, mill)
wine_by_key = {}
dupe_keys = 0
for w in wines_raw:
    k = wkey(w["nom"], as_real(w["capacite_l"]), as_int(w["millesime"]))
    if k in wine_by_key: dupe_keys += 1
    wine_by_key.setdefault(k, w["source_id_vin"])

# aggregate colour + geography per wine from its stock lots
from collections import defaultdict, Counter
wine_colour = {}
wine_geo = {}
lots = []
unlinked = []
for i, s in enumerate(stock_raw):
    k = wkey(s["nom"], as_real(s["capacite_l"]), as_int(s["millesime"]))
    sid = wine_by_key.get(k)
    if sid is None:
        unlinked.append(s["ref"]); continue
    lots.append((sid, s, i))
    if norm(s.get("couleur")): wine_colour.setdefault(sid, norm(s["couleur"]))
    if sid not in wine_geo:
        wine_geo[sid] = (norm(s.get("pays")) or None, norm(s.get("region")) or None, norm(s.get("appellation")) or None)

# ---- build wine rows ------------------------------------------------------
wine_rows = []
resolved_sr = 0
for w in wines_raw:
    sid = w["source_id_vin"]
    stock_geo = wine_geo.get(sid)
    if stock_geo:
        pays, region, appellation = stock_geo
    else:
        pays = region = None; appellation = norm(w.get("appellation_text")) or None
    p2, r2, sr, app2 = resolve_geo(appellation or w.get("appellation_text"), pays, region)
    if sr: resolved_sr += 1
    wine_rows.append({
        "id": U("wine", sid),
        "nom": w["nom"],
        "couleur": wine_colour.get(sid),
        "capacite_l": as_real(w["capacite_l"]),
        "millesime": as_int(w["millesime"]),
        "pays": p2, "region": r2, "sous_region": sr,
        "appellation": app2 if app2 else appellation,
        "producteur": w.get("producteur"),
        "degre": as_real(w.get("degre")) or None,
        "recompenses": w.get("recompenses"),
        "remarques": w.get("remarques"),
    })

# ---- build appellation dictionary rows (curated 74 + combos from stock) ----
dict_rows = []
seen = set()
for r in adict:
    pays, reg, sr, app = norm(r.get("Pays")), norm(r.get("Région")), norm(r.get("Sous-Région")), norm(r.get("Appellation"))
    key = (keyn(pays), keyn(reg), keyn(sr), keyn(app))
    if key in seen: continue
    seen.add(key)
    dict_rows.append((U("app", r["ID Appellation"]), pays or None, reg or None, sr or None, app or None, norm(r.get("Couleur")) or None))
added_from_stock = 0
for wr in wine_rows:
    key = (keyn(wr["pays"]), keyn(wr["region"]), keyn(wr["sous_region"]), keyn(wr["appellation"]))
    if any(key) and key not in seen:
        seen.add(key); added_from_stock += 1
        dict_rows.append((U("appx", "|".join(map(str, key))), wr["pays"], wr["region"], wr["sous_region"], wr["appellation"], None))

# ---- emit SQL -------------------------------------------------------------
out = []
out.append("-- Generated by etl.py — real cellar data. Do not hand-edit; re-run etl.py.")
out.append("-- No BEGIN/COMMIT: D1 remote manages transactions itself and rejects raw ones.")
out.append("DELETE FROM lots; DELETE FROM wines; DELETE FROM appellations;")
out.append("\n-- appellations dictionary")
for (aid, pays, reg, sr, app, coul) in dict_rows:
    out.append(f"INSERT INTO appellations (id,pays,region,sous_region,appellation,apogee_min,apogee_max,couleur,updated_at,deleted) VALUES ({q(aid)},{q(pays)},{q(reg)},{q(sr)},{q(app)},NULL,NULL,{q(coul)},{TS},0);")
out.append("\n-- wines")
for w in wine_rows:
    out.append(
        "INSERT INTO wines (id,nom,couleur,capacite_l,millesime,pays,region,sous_region,appellation,producteur,degre,recompenses,remarques,apogee_min,apogee_max,updated_at,deleted) VALUES ("
        f"{q(w['id'])},{q(w['nom'])},{q(w['couleur'])},{n(w['capacite_l'])},{n(w['millesime'])},"
        f"{q(w['pays'])},{q(w['region'])},{q(w['sous_region'])},{q(w['appellation'])},{q(w['producteur'])},"
        f"{n(w['degre'])},{q(w['recompenses'])},{q(w['remarques'])},NULL,NULL,{TS},0);")
out.append("\n-- lots")
for (sid, s, i) in lots:
    lot_key = f"{i}:{s['ref']}"
    out.append(
        "INSERT INTO lots (id,wine_id,cave,emplacement,ligne,colonne,quantite,fournisseur,prix,date_entree,commentaire,updated_at,deleted) VALUES ("
        f"{q(U('lot', lot_key))},{q(U('wine', sid))},"
        f"{q(s.get('cave'))},{q(s.get('emplacement'))},{n(as_int(s.get('ligne')))},{n(as_int(s.get('colonne')))},"
        f"{n(as_int(s.get('quantite')) or 1)},{q(s.get('fournisseur'))},{n(as_real(s.get('prix')))},{q(s.get('date_entree'))},{q(s.get('commentaire'))},{TS},0);")
open(OUT, "w", encoding="utf-8").write("\n".join(out) + "\n")

# ---- report ---------------------------------------------------------------
total_bottles = sum((as_int(s.get("quantite")) or 1) for _, s, _ in lots)
stocked = len(set(sid for sid, _, _ in lots))
print(f"wines_raw rows      : {len(wines_raw)}")
print(f"  duplicate (nom,cap,mill) keys: {dupe_keys}")
print(f"stock_raw rows      : {len(stock_raw)}")
print(f"lots linked to wine : {len(lots)}")
print(f"lots UNLINKED       : {len(unlinked)}  {unlinked[:5]}")
print(f"distinct stocked wines: {stocked}   catalogue-only wines: {len(wines_raw)-stocked}")
print(f"total physical bottles: {total_bottles}")
print(f"wines with sous_region resolved: {resolved_sr}/{len(wine_rows)}")
print(f"appellation dict rows: {len(dict_rows)} (curated {len(dict_rows)-added_from_stock} + {added_from_stock} from stock)")
print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")
