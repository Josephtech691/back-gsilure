-- GSILURE : mémoriser la répartition de chaque vente entre 1 et 3 bacs.
-- À exécuter une seule fois dans Neon avant le déploiement.
ALTER TABLE public.clients_vente
  ADD COLUMN IF NOT EXISTS bacs_repartition JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_clients_vente_bacs_repartition
  ON public.clients_vente USING GIN (bacs_repartition);
