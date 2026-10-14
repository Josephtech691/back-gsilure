-- Migration : rattachement d'un employé à un compte principal.
-- À exécuter une seule fois sur la même base PostgreSQL que l'application.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS rattache_a_id UUID NULL
  REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_rattache_a_id
  ON users(rattache_a_id);

-- Empêche qu'un compte principal soit lui-même rattaché à un autre compte.
-- La validation applicative complète cette règle.
