const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { logError, ensureTable } = require('../services/errorLogger');
const { BAC_CTE } = require('./stockController');

const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

// ─────────────────────────── ERREURS ───────────────────────────
/** GET /api/dev/erreurs?source&niveau&resolu&q&limit&offset */
const listerErreurs = async (req, res) => {
  try {
    await ensureTable();
    const { source, niveau, resolu, q } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const where = []; const params = [];
    if (source) { params.push(source); where.push(`source = $${params.length}`); }
    if (niveau) { params.push(niveau); where.push(`niveau = $${params.length}`); }
    if (resolu === 'true' || resolu === 'false') { params.push(resolu === 'true'); where.push(`resolu = $${params.length}`); }
    if (q) { params.push(`%${q}%`); where.push(`(message ILIKE $${params.length} OR route ILIKE $${params.length} OR user_email ILIKE $${params.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await db.query(`SELECT COUNT(*)::int AS n FROM app_errors ${w}`, params);
    params.push(limit, offset);
    const r = await db.query(
      `SELECT * FROM app_errors ${w} ORDER BY resolu ASC, derniere_vue DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    res.json({ total: total.rows[0].n, items: r.rows });
  } catch (err) {
    console.error('dev.listerErreurs:', err);
    res.status(500).json({ message: 'Impossible de charger le journal d’erreurs.', detail: err.message });
  }
};

/** GET /api/dev/erreurs/stats — compteurs + courbe 7 jours */
const statsErreurs = async (req, res) => {
  try {
    await ensureTable();
    const [tot, jours, sources] = await Promise.all([
      db.query(`SELECT
          COUNT(*) FILTER (WHERE NOT resolu)::int AS non_resolues,
          COUNT(*) FILTER (WHERE NOT resolu AND niveau='error')::int AS erreurs_ouvertes,
          COUNT(*) FILTER (WHERE derniere_vue > NOW() - INTERVAL '24 hours')::int AS vues_24h,
          COALESCE(SUM(occurrences) FILTER (WHERE derniere_vue > NOW() - INTERVAL '24 hours'),0)::int AS occurrences_24h,
          COUNT(*)::int AS total
        FROM app_errors`),
      db.query(`SELECT to_char(d::date,'YYYY-MM-DD') AS jour,
                       COALESCE((SELECT COUNT(*) FROM app_errors e WHERE e.derniere_vue::date = d::date),0)::int AS nb
                FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, '1 day') d ORDER BY d`),
      db.query(`SELECT source, COUNT(*)::int AS nb FROM app_errors WHERE NOT resolu GROUP BY source ORDER BY nb DESC`),
    ]);
    res.json({ ...tot.rows[0], par_jour: jours.rows, par_source: sources.rows });
  } catch (err) {
    console.error('dev.statsErreurs:', err);
    res.status(500).json({ message: 'Impossible de charger les statistiques.', detail: err.message });
  }
};

/** PATCH /api/dev/erreurs/:id  { resolu?, note? } */
const majErreur = async (req, res) => {
  try {
    const { resolu, note } = req.body || {};
    const r = await db.query(
      `UPDATE app_errors SET
         resolu = COALESCE($1::boolean, resolu),
         resolu_le = CASE WHEN $1::boolean IS TRUE THEN NOW() WHEN $1::boolean IS FALSE THEN NULL ELSE resolu_le END,
         note = COALESCE($2, note)
       WHERE id = $3 RETURNING *`,
      [typeof resolu === 'boolean' ? resolu : null, note ?? null, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ message: 'Erreur introuvable.' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('dev.majErreur:', err);
    res.status(500).json({ message: 'Mise à jour impossible.', detail: err.message });
  }
};

/** DELETE /api/dev/erreurs/resolues — purge les erreurs résolues */
const purgerResolues = async (req, res) => {
  try {
    const r = await db.query('DELETE FROM app_errors WHERE resolu = TRUE');
    res.json({ message: `${r.rowCount} erreur(s) résolue(s) supprimée(s).`, supprimees: r.rowCount });
  } catch (err) {
    console.error('dev.purgerResolues:', err);
    res.status(500).json({ message: 'Purge impossible.', detail: err.message });
  }
};

/** POST /api/dev/erreurs/test — vérifie que le journal fonctionne */
const erreurTest = async (req, res) => {
  await logError({ source: 'backend', niveau: 'warning', message: 'Erreur de test générée par le développeur',
    route: '/api/dev/erreurs/test', methode: 'POST', statut: 200, user: req.user, userAgent: req.headers['user-agent'] });
  res.json({ message: 'Erreur de test enregistrée.' });
};

// ─────────────────────────── INTÉGRITÉ ───────────────────────────
async function lancerControle(id, titre, fn) {
  try { return { id, titre, ...(await fn()) }; }
  catch (err) {
    console.error(`dev.integrite[${id}]:`, err);
    return { id, titre, statut: 'error', resume: 'Le contrôle a échoué : ' + err.message, details: [] };
  }
}

/** GET /api/dev/integrite */
const integrite = async (req, res) => {
  const controles = await Promise.all([
    lancerControle('stock_global', 'Stock global = somme des bacs', async () => {
      const bacs = (await db.query(`${BAC_CTE} SELECT * FROM bac_final ORDER BY bac_numero`)).rows;
      const t = (await db.query(`SELECT
          (SELECT COALESCE(SUM(quantite_kg),0) FROM stocks) AS achete,
          (SELECT COALESCE(SUM(kg_achetes),0) FROM clients_vente) AS vendu,
          (SELECT COALESCE(SUM(kg_perdus),0) FROM pertes_stock) AS perdu,
          (SELECT COALESCE(SUM(quantite_kg),0) FROM retraits_stock) AS retire,
          (SELECT COALESCE(SUM(quantite_kg),0) FROM stocks WHERE bac_numero IS NULL) AS depose_sans_bac,
          (SELECT COALESCE(SUM(kg_perdus),0) FROM pertes_stock WHERE bac_numero IS NULL) AS perdu_sans_bac`)).rows[0];
      const reste = Number(t.achete) - Number(t.vendu) - Number(t.perdu) - Number(t.retire);
      const somme = bacs.reduce((a, b) => a + Number(b.kg_disponible_brut), 0);
      const ecart = r2(reste - somme);
      const venteNonImputee = r2(Number(t.vendu) - bacs.reduce((a, b) => a + Number(b.kg_vendu_bac) + Number(b.kg_vendu_ancien), 0));
      const details = [
        { libelle: 'Stock global', valeur: `${r2(reste)} kg` },
        { libelle: 'Somme des 7 bacs', valeur: `${r2(somme)} kg` },
        { libelle: 'Dépôts sans bac', valeur: `${r2(t.depose_sans_bac)} kg` },
        { libelle: 'Pertes sans bac', valeur: `${r2(t.perdu_sans_bac)} kg` },
        { libelle: 'Ventes non imputées à un bac', valeur: `${venteNonImputee} kg` },
      ];
      if (Math.abs(ecart) < 0.05) return { statut: 'ok', resume: 'Les bacs correspondent au stock global.', details };
      return { statut: Math.abs(ecart) >= 1 ? 'error' : 'warn', resume: `Écart de ${ecart} kg entre le stock global et la somme des bacs.`, details,
        conseil: 'Attribuer un bac aux dépôts/pertes qui n’en ont pas, et vérifier les ventes modifiées.' };
    }),

    lancerControle('bac_negatif', 'Aucun bac négatif', async () => {
      const r = await db.query(`${BAC_CTE} SELECT bac_numero, kg_disponible_brut FROM bac_final WHERE kg_disponible_brut < -0.05 ORDER BY bac_numero`);
      if (!r.rows.length) return { statut: 'ok', resume: 'Aucun bac en négatif.', details: [] };
      return { statut: 'error', resume: `${r.rows.length} bac(s) avec un stock négatif.`,
        details: r.rows.map(b => ({ libelle: `Bac ${b.bac_numero}`, valeur: `${r2(b.kg_disponible_brut)} kg` })),
        conseil: 'Plus de sorties (pertes, retraits, ventes) que d’entrées dans ce bac : vérifier les dépôts ou les affectations.' };
    }),

    lancerControle('ventes_repartition', 'Répartition des ventes = kg vendus', async () => {
      const r = await db.query(`
        SELECT cv.id, vj.date_vente::text AS date, cv.client_nom, cv.kg_achetes,
               (SELECT COALESCE(SUM((p->>'quantite_kg')::numeric),0) FROM jsonb_array_elements(cv.bacs_repartition) p) AS somme
        FROM clients_vente cv JOIN ventes_journees vj ON vj.id = cv.journee_id
        WHERE jsonb_array_length(COALESCE(cv.bacs_repartition,'[]'::jsonb)) > 0
          AND ABS((SELECT COALESCE(SUM((p->>'quantite_kg')::numeric),0) FROM jsonb_array_elements(cv.bacs_repartition) p) - cv.kg_achetes) > 0.01
        ORDER BY vj.date_vente DESC LIMIT 50`);
      if (!r.rows.length) return { statut: 'ok', resume: 'Toutes les répartitions correspondent aux kg vendus.', details: [] };
      return { statut: 'warn', resume: `${r.rows.length} vente(s) dont la répartition par bac ne correspond plus aux kg vendus (vente modifiée).`,
        details: r.rows.map(v => ({ libelle: `${v.date} · ${v.client_nom || 'INCONNU'}`, valeur: `vendu ${Number(v.kg_achetes)} kg / réparti ${r2(v.somme)} kg` })),
        conseil: 'Le calcul des bacs met ces ventes à l’échelle automatiquement : aucun impact sur le stock affiché.' };
    }),

    lancerControle('ventes_sans_bac', 'Ventes sans bac (anciennes)', async () => {
      const r = await db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(kg_achetes),0) AS kg FROM clients_vente WHERE COALESCE(bacs_repartition,'[]'::jsonb) = '[]'::jsonb`);
      const { n, kg } = r.rows[0];
      if (!n) return { statut: 'ok', resume: 'Toutes les ventes sont rattachées à un bac.', details: [] };
      return { statut: 'info', resume: `${n} vente(s) anciennes (${r2(kg)} kg) sans bac, imputées dans l’ordre des bacs.`, details: [] };
    }),

    lancerControle('pertes_sans_bac', 'Pertes sans bac', async () => {
      const r = await db.query(`SELECT id, date_perte::text AS date, type_perte, kg_perdus, commentaire FROM pertes_stock WHERE bac_numero IS NULL ORDER BY date_perte DESC NULLS LAST LIMIT 50`);
      if (!r.rows.length) return { statut: 'ok', resume: 'Toutes les pertes ont un bac.', details: [] };
      return { statut: 'warn', resume: `${r.rows.length} perte(s) sans bac : elles réduisent le stock global mais aucun bac.`,
        details: r.rows.map(p => ({ libelle: `${p.date || '—'} · ${p.type_perte}`, valeur: `${Number(p.kg_perdus)} kg${p.commentaire ? ' — ' + p.commentaire : ''}` })),
        conseil: 'Supprimer puis recréer la perte en choisissant un bac.' };
    }),

    lancerControle('depots_sans_bac', 'Dépôts sans bac', async () => {
      const r = await db.query(`SELECT id, date_depot::text AS date, quantite_kg, type_stock FROM stocks WHERE bac_numero IS NULL ORDER BY date_depot DESC LIMIT 50`);
      if (!r.rows.length) return { statut: 'ok', resume: 'Tous les dépôts ont un bac.', details: [] };
      return { statut: 'warn', resume: `${r.rows.length} dépôt(s) sans bac (comptés au global, absents des bacs).`,
        details: r.rows.map(d => ({ libelle: `${d.date} · ${d.type_stock}`, valeur: `${Number(d.quantite_kg)} kg` })) };
    }),

    lancerControle('pertes_dates', 'Dates des pertes cohérentes', async () => {
      const r = await db.query(`SELECT id, date_perte::text AS date, mois, annee, created_at::date::text AS cree
        FROM pertes_stock WHERE date_perte IS NULL OR mois <> to_char(date_perte,'YYYY-MM') OR annee <> EXTRACT(YEAR FROM date_perte) LIMIT 50`);
      if (!r.rows.length) return { statut: 'ok', resume: 'Les dates (jour, mois, année) des pertes sont cohérentes.', details: [] };
      return { statut: 'warn', resume: `${r.rows.length} perte(s) avec une date incohérente.`,
        details: r.rows.map(p => ({ libelle: `Perte ${p.id.slice(0, 8)}`, valeur: `date ${p.date || 'vide'} · mois ${p.mois} · année ${p.annee} · saisie le ${p.cree}` })) };
    }),

    lancerControle('doublons_clients', 'Numéros de client uniques par journée', async () => {
      const r = await db.query(`SELECT vj.date_vente::text AS date, cv.numero_client, COUNT(*)::int AS n
        FROM clients_vente cv JOIN ventes_journees vj ON vj.id = cv.journee_id
        GROUP BY cv.journee_id, vj.date_vente, cv.numero_client HAVING COUNT(*) > 1 ORDER BY vj.date_vente DESC LIMIT 50`);
      if (!r.rows.length) return { statut: 'ok', resume: 'Aucun numéro de client en double.', details: [] };
      return { statut: 'warn', resume: `${r.rows.length} numéro(s) de client en double.`,
        details: r.rows.map(d => ({ libelle: `${d.date} · client n°${d.numero_client}`, valeur: `${d.n} fois` })) };
    }),

    lancerControle('securite', 'Sécurité de base', async () => {
      const alertes = [];
      if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) alertes.push({ libelle: 'JWT_SECRET', valeur: 'absent ou trop court (< 32 caractères)' });
      if (!process.env.DEVELOPER_OVERRIDE_CODE) alertes.push({ libelle: 'DEVELOPER_OVERRIDE_CODE', valeur: 'non défini : le code par défaut (visible dans le code source) est actif' });
      const adm = await db.query(`SELECT id, email, password_hash FROM users WHERE email = 'admin@poissonnerie.com' AND actif = TRUE`);
      if (adm.rows.length && await bcrypt.compare('Admin1234!', adm.rows[0].password_hash))
        alertes.push({ libelle: 'admin@poissonnerie.com', valeur: 'utilise encore le mot de passe par défaut' });
      const nbAdmin = (await db.query(`SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND actif = TRUE`)).rows[0].n;
      if (nbAdmin < 1) alertes.push({ libelle: 'Administrateur', valeur: 'aucun compte admin actif' });
      if (!alertes.length) return { statut: 'ok', resume: 'Aucun point faible détecté.', details: [] };
      return { statut: 'error', resume: `${alertes.length} point(s) de sécurité à corriger.`, details: alertes };
    }),
  ]);

  const rang = { error: 3, warn: 2, info: 1, ok: 0 };
  const pire = controles.reduce((m, c) => (rang[c.statut] > rang[m] ? c.statut : m), 'ok');
  res.json({ genere_le: new Date().toISOString(), statut_global: pire,
    resume: { ok: controles.filter(c => c.statut === 'ok').length, info: controles.filter(c => c.statut === 'info').length,
              warn: controles.filter(c => c.statut === 'warn').length, error: controles.filter(c => c.statut === 'error').length },
    controles });
};

// ─────────────────────────── SYSTÈME ───────────────────────────
/** GET /api/dev/sante */
const sante = async (req, res) => {
  const out = { serveur: {}, base: {}, variables: {}, tables: [] };
  out.serveur = { node: process.version, uptime_s: Math.round(process.uptime()), environnement: process.env.NODE_ENV || 'development',
    memoire_mo: Math.round(process.memoryUsage().rss / 1048576), heure: new Date().toISOString() };
  try {
    const t0 = Date.now();
    const v = await db.query(`SELECT version() AS v, pg_database_size(current_database()) AS taille, NOW() AS maintenant`);
    out.base = { ok: true, latence_ms: Date.now() - t0, version: String(v.rows[0].v).split(' ').slice(0, 2).join(' '),
      taille_mo: Math.round(Number(v.rows[0].taille) / 1048576 * 10) / 10 };
  } catch (e) { out.base = { ok: false, erreur: e.message }; }

  const vars = ['DATABASE_URL', 'JWT_SECRET', 'FRONTEND_URL', 'DEVELOPER_OVERRIDE_CODE', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CRON_SECRET'];
  out.variables = vars.map(n => ({ nom: n, definie: !!process.env[n] }));

  for (const t of ['users', 'ventes_journees', 'clients_vente', 'stocks', 'pertes_stock', 'retraits_stock', 'app_errors']) {
    try { out.tables.push({ nom: t, lignes: (await db.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n }); }
    catch { out.tables.push({ nom: t, lignes: null, absente: true }); }
  }
  res.json(out);
};

/** GET /api/dev/comptes — lecture seule */
const comptes = async (req, res) => {
  try {
    const r = await db.query(`SELECT id, nom, prenom, email, role, actif, created_at, rattache_a_id FROM users ORDER BY role, nom, prenom`);
    res.json(r.rows);
  } catch (err) {
    console.error('dev.comptes:', err);
    res.status(500).json({ message: 'Impossible de charger les comptes.', detail: err.message });
  }
};

module.exports = { listerErreurs, statsErreurs, majErreur, purgerResolues, erreurTest, integrite, sante, comptes };
