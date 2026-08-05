-- Cave — schema v1
--
-- Model in one line: a WINE is an identity (producer / name / vintage / format);
-- a LOT is "N bottles of that wine sitting at one location".
--
-- Why lots and not one-row-per-bottle: the source data already models stock as
-- lots with a quantity (104 lots = 156 physical bottles). "12 in the Piquey vrac"
-- is one lot with quantite=12, not 12 rows. Drinking one = decrement quantite.
--
-- IDs are TEXT uuids (not autoincrement integers) on purpose: this is the one
-- schema choice that is expensive to change later, and offline-first is a
-- committed requirement — a phone must be able to mint an id offline without
-- colliding with the PC. Everything else here is cheap to migrate; this isn't.

CREATE TABLE wines (
  id          TEXT PRIMARY KEY,            -- uuid (crypto.randomUUID())
  nom         TEXT NOT NULL,
  couleur     TEXT,                        -- references colors.name (not enforced in v1)
  capacite_l  REAL,                        -- 0.75, 1.5, ...
  millesime   INTEGER,                     -- vintage year; NULL = non-vintage (e.g. champagne)
  pays        TEXT,                        -- free text in v1 (see DATA_MODEL.md, open q. D)
  region      TEXT,
  appellation TEXT,
  producteur  TEXT,
  degre       REAL,
  recompenses TEXT,
  remarques   TEXT,
  apogee_min  INTEGER,                     -- drinking window: years after vintage, lower bound
  apogee_max  INTEGER,                     -- upper bound. Maturité is COMPUTED, never stored.
  updated_at  INTEGER NOT NULL,            -- epoch ms; last-write-wins on sync
  deleted     INTEGER NOT NULL DEFAULT 0   -- tombstone so deletes propagate offline
);

CREATE TABLE lots (
  id          TEXT PRIMARY KEY,
  wine_id     TEXT NOT NULL REFERENCES wines(id),
  cave        TEXT,                        -- references caves.name (not enforced in v1)
  emplacement TEXT,                        -- 'Vrac' | 'Etagère' (app-level constant in v1)
  ligne       INTEGER,                     -- Etagère only; NULL for Vrac
  colonne     INTEGER,                     -- Etagère only; NULL for Vrac
  quantite    INTEGER NOT NULL DEFAULT 1,
  fournisseur TEXT,
  prix        REAL,                        -- unit price paid
  date_entree TEXT,                        -- ISO 8601 date string
  commentaire TEXT,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_lots_wine     ON lots(wine_id);
CREATE INDEX idx_wines_updated ON wines(updated_at);   -- pull "changes since T" for sync
CREATE INDEX idx_lots_updated  ON lots(updated_at);

-- Reference lists: drive the pickers, seeded once, rarely change.
CREATE TABLE colors (name TEXT PRIMARY KEY);
CREATE TABLE caves  (name TEXT PRIMARY KEY);

INSERT INTO colors (name) VALUES
  ('Rouge'), ('Rosé'), ('Blanc sec'), ('Blanc liquoreux'), ('Blanc pétillant'),
  ('Champagne'), ('Champagne rosé'), ('Crémant rosé'), ('Effervescent'),
  ('Rouge pétillant'), ('Jaune');

INSERT INTO caves (name) VALUES ('Piquey'), ('Vence');
