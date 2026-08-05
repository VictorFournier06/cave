-- Cave — schema v2: geography dictionary + drinking-window defaults.
--
-- Direction comes from the `Appellations` table the client built in Access: a
-- 4-level hierarchy Pays > Région > Sous-Région > Appellation, where entering the
-- finest known level lets the app deduce the coarser ones. The wine still stores
-- its geography as denormalised text (v1 choice); this dictionary is what powers
-- the auto-fill and what the app writes back to when the user teaches it a new
-- appellation.

-- 4th geography level on the wine (v1 had pays/region/appellation).
ALTER TABLE wines ADD COLUMN sous_region TEXT;

-- The geography dictionary. `appellation` is the finest, optional level; when NULL
-- the sous_region is the leaf. `apogee_min/max` and `couleur` are optional defaults
-- the client can fill over time (they exist in the Access design but are empty now).
CREATE TABLE appellations (
  id          TEXT PRIMARY KEY,
  pays        TEXT,
  region      TEXT,
  sous_region TEXT,
  appellation TEXT,
  apogee_min  INTEGER,
  apogee_max  INTEGER,
  couleur     TEXT,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_appellations_updated ON appellations(updated_at);
CREATE INDEX idx_appellations_geo     ON appellations(appellation, sous_region);

-- Fallback drinking window by colour (years after vintage), used when neither the
-- wine nor its appellation gives one. A table (not a constant) so it stays editable.
CREATE TABLE color_apogee (
  couleur     TEXT PRIMARY KEY,
  apogee_min  INTEGER NOT NULL,
  apogee_max  INTEGER NOT NULL
);
INSERT INTO color_apogee (couleur, apogee_min, apogee_max) VALUES
  ('Rouge', 3, 12),
  ('Rosé', 0, 2),
  ('Blanc sec', 1, 5),
  ('Blanc liquoreux', 5, 30),
  ('Blanc pétillant', 0, 3),
  ('Champagne', 2, 10),
  ('Champagne rosé', 2, 8),
  ('Crémant rosé', 0, 3),
  ('Effervescent', 0, 3),
  ('Rouge pétillant', 0, 2),
  ('Jaune', 10, 50);
