const crypto = require('crypto');
const db = require('../config/db');

const SQL_TABLE = `
CREATE TABLE IF NOT EXISTS app_errors (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empreinte     VARCHAR(40) NOT NULL,
  source        VARCHAR(20) NOT NULL,
  niveau        VARCHAR(10) NOT NULL DEFAULT 'error',
  message       TEXT NOT NULL,
  stack         TEXT,
  route         VARCHAR(300),
  methode       VARCHAR(10),
  statut_http   SMALLINT,
  user_id       UUID,
  user_email    VARCHAR(200),
  user_role     VARCHAR(20),
  user_agent    VARCHAR(300),
  contexte      JSONB,
  occurrences   INTEGER NOT NULL DEFAULT 1,
  premiere_vue  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  derniere_vue  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolu        BOOLEAN NOT NULL DEFAULT FALSE,
  resolu_le     TIMESTAMPTZ,
  note          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_errors_empreinte ON app_errors(empreinte);
CREATE INDEX IF NOT EXISTS idx_app_errors_derniere ON app_errors(derniere_vue DESC);
CREATE INDEX IF NOT EXISTS idx_app_errors_resolu ON app_errors(resolu, derniere_vue DESC);
`;

let tablePrete = null;
function ensureTable() {
  if (!tablePrete) {
    tablePrete = db.query(SQL_TABLE).catch((e) => { tablePrete = null; throw e; });
  }
  return tablePrete;
}

const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

// Remplace ce qui varie (uuid, nombres) pour regrouper les erreurs identiques
function normaliser(txt) {
  return String(txt || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\d+([.,]\d+)?/g, '#')
    .slice(0, 200);
}

/**
 * Enregistre (ou incrémente) une erreur. Ne lève JAMAIS d'exception :
 * le journal ne doit jamais casser l'application.
 */
async function logError({ source, niveau = 'error', message, stack, route, methode, statut, user, userAgent, contexte }) {
  try {
    await ensureTable();
    const msg = cut(message || 'Erreur inconnue', 2000);
    const empreinte = crypto.createHash('sha1')
      .update([source, niveau, methode || '', normaliser(route), statut || '', normaliser(msg)].join('|'))
      .digest('hex');
    let ctx = null;
    if (contexte) { try { ctx = JSON.stringify(contexte).slice(0, 6000); JSON.parse(ctx); } catch { ctx = null; } }
    await db.query(
      `INSERT INTO app_errors
         (empreinte, source, niveau, message, stack, route, methode, statut_http, user_id, user_email, user_role, user_agent, contexte)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT (empreinte) DO UPDATE SET
         occurrences  = app_errors.occurrences + 1,
         derniere_vue = NOW(),
         resolu       = FALSE,
         resolu_le    = NULL,
         user_id      = COALESCE(EXCLUDED.user_id, app_errors.user_id),
         user_email   = COALESCE(EXCLUDED.user_email, app_errors.user_email),
         user_role    = COALESCE(EXCLUDED.user_role, app_errors.user_role),
         stack        = COALESCE(EXCLUDED.stack, app_errors.stack),
         contexte     = COALESCE(EXCLUDED.contexte, app_errors.contexte)`,
      [empreinte, cut(source, 20), cut(niveau, 10), msg, cut(stack, 8000), cut(route, 300), cut(methode, 10),
       statut || null, user?.id || null, cut(user?.email, 200), cut(user?.role, 20), cut(userAgent, 300), ctx]
    );
  } catch (e) {
    console.warn('[errorLogger] impossible d’enregistrer :', e.message);
  }
}

module.exports = { logError, ensureTable, SQL_TABLE };
