-- GSILURE : historique des retraits physiques de stock
CREATE TABLE IF NOT EXISTS retraits_stock (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bac_numero SMALLINT NOT NULL CHECK (bac_numero BETWEEN 1 AND 7),
  quantite_kg NUMERIC(10,2) NOT NULL CHECK (quantite_kg > 0),
  commentaire TEXT,
  retire_par UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_retraits_stock_bac_date
  ON retraits_stock (bac_numero, created_at DESC);

-- Date métier du retrait (modifiable lors de la saisie, indépendante de la date technique).
ALTER TABLE retraits_stock ADD COLUMN IF NOT EXISTS date_retrait DATE NOT NULL DEFAULT CURRENT_DATE;
CREATE INDEX IF NOT EXISTS idx_retraits_stock_date_retrait ON retraits_stock (date_retrait DESC);
