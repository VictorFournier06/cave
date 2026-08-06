-- Cave — degustations (tastings)
--
-- One tasting note for a wine: a date, a mark out of 20, and a free comment.
-- Same identity + sync conventions as the rest of the schema (TEXT uuid PK,
-- updated_at epoch ms, deleted tombstone). Maturité stays computed; a degustation
-- is its human counterpart — what the bottle was actually like on the day.
CREATE TABLE degustations (
  id          TEXT PRIMARY KEY,            -- uuid (crypto.randomUUID()); minted offline-safe
  wine_id     TEXT NOT NULL REFERENCES wines(id),
  date        TEXT,                        -- ISO 8601 date; NULL = undated note
  note        REAL,                        -- mark out of 20 (half-points allowed); NULL = comment only
  commentaire TEXT,
  updated_at  INTEGER NOT NULL,            -- epoch ms; last-write-wins on sync
  deleted     INTEGER NOT NULL DEFAULT 0   -- tombstone so deletes propagate offline
);
CREATE INDEX idx_degustations_wine    ON degustations(wine_id);
CREATE INDEX idx_degustations_updated ON degustations(updated_at);
