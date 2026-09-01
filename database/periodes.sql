-- Migration du système de périodes du dashboard admin.
-- À exécuter une seule fois sur la base PostgreSQL.

CREATE TABLE IF NOT EXISTS periodes_dashboard (
  id SERIAL PRIMARY KEY,
  date_debut DATE NOT NULL,
  date_fin DATE NULL,
  commentaire TEXT NULL,
  created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (date_fin IS NULL OR date_fin >= date_debut)
);

CREATE TABLE IF NOT EXISTS dashboard_periode_config (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  periode_active BOOLEAN NOT NULL DEFAULT FALSE,
  periode_id INTEGER NULL REFERENCES periodes_dashboard(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO dashboard_periode_config (id, periode_active, periode_id)
VALUES (1, FALSE, NULL)
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_periodes_dashboard_dates
  ON periodes_dashboard (date_debut, date_fin);

CREATE INDEX IF NOT EXISTS idx_periodes_dashboard_created_at
  ON periodes_dashboard (created_at DESC);
