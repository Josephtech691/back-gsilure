const db = require('../config/db');

// ─── Prix courant pour un type/catégorie ───────────────────
async function getPrixCourant(type_stock, poids_categorie) {
  const r = await db.query(
    `SELECT prix_par_kg FROM prix_stock
     WHERE type_stock = $1 AND (poids_categorie = $2 OR poids_categorie IS NULL)
       AND actif = TRUE AND (date_fin IS NULL OR date_fin >= CURRENT_DATE)
     ORDER BY poids_categorie NULLS LAST, date_debut DESC
     LIMIT 1`,
    [type_stock, poids_categorie || null]
  );
  return r.rows[0]?.prix_par_kg || 2500;
}

/** POST /api/stocks — Nouveau dépôt */
const ajouterDepot = async (req, res) => {
  const { date_depot, quantite_kg, type_stock, poids_categorie, bac_numero, note } = req.body;

  if (!quantite_kg || isNaN(quantite_kg) || Number(quantite_kg) <= 0)
    return res.status(400).json({ message: 'Quantité invalide.' });
  if (!type_stock)
    return res.status(400).json({ message: 'Type de stock requis.' });
  if (bac_numero && (bac_numero < 1 || bac_numero > 7))
    return res.status(400).json({ message: 'Numéro de bac invalide (1-7).' });

  try {
    const prix = await getPrixCourant(type_stock, poids_categorie);
    const valeur = parseFloat(quantite_kg) * prix;

    const r = await db.query(
      `INSERT INTO stocks (date_depot, quantite_kg, prix_par_kg, type_stock, poids_categorie, bac_numero, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *, (quantite_kg * prix_par_kg) AS valeur_totale`,
      [date_depot || new Date().toISOString().split('T')[0],
       quantite_kg, prix, type_stock, poids_categorie || null,
       bac_numero || null, note || null, req.user.id]
    );
    res.status(201).json({ message: 'Dépôt enregistré.', depot: r.rows[0] });
  } catch (err) {
    console.error('ajouterDepot:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

/** GET /api/stocks — Liste dépôts filtrables */
const listerDepots = async (req, res) => {
  const { date_debut, date_fin, type_stock, bac_numero } = req.query;
  try {
    let q = `
      SELECT s.*, u.nom || ' ' || u.prenom AS cree_par,
             (s.quantite_kg * s.prix_par_kg) AS valeur_totale
      FROM stocks s LEFT JOIN users u ON s.created_by = u.id
      WHERE 1=1`;
    const params = [];
    if (date_debut) { params.push(date_debut); q += ` AND s.date_depot >= $${params.length}`; }
    if (date_fin)   { params.push(date_fin);   q += ` AND s.date_depot <= $${params.length}`; }
    if (type_stock) { params.push(type_stock); q += ` AND s.type_stock = $${params.length}`; }
    if (bac_numero) { params.push(bac_numero); q += ` AND s.bac_numero = $${params.length}`; }
    q += ' ORDER BY s.date_depot DESC, s.created_at DESC';

    const r = await db.query(q, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
};

/** GET /api/stocks/bacs — Vue par bac (état actuel) */
const etatBacs = async (req, res) => {
  try {
    // Stock total entré par bac/type
    const entrees = await db.query(`
      SELECT s.bac_numero, s.type_stock, s.poids_categorie,
             SUM(s.quantite_kg) AS kg_total,
             GREATEST(0,
               (SELECT COALESCE(SUM(s2.quantite_kg),0) FROM stocks s2 WHERE s2.bac_numero=s.bac_numero)
               - (SELECT COALESCE(SUM(p.kg_perdus),0) FROM pertes_stock p WHERE p.bac_numero=s.bac_numero)
               - (SELECT COALESCE(SUM(r.quantite_kg),0) FROM retraits_stock r WHERE r.bac_numero=s.bac_numero)
               - COALESCE((
                   SELECT SUM((part->>'quantite_kg')::numeric)
                   FROM clients_vente cv
                   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(cv.bacs_repartition, '[]'::jsonb)) AS part
                   WHERE (part->>'bac_numero')::integer = s.bac_numero
                 ), 0)
               - LEAST(
                   (SELECT COALESCE(SUM(s3.quantite_kg),0) FROM stocks s3 WHERE s3.bac_numero=s.bac_numero),
                   GREATEST(0,
                     (SELECT COALESCE(SUM(cv.kg_achetes),0) FROM clients_vente cv
                      WHERE COALESCE(cv.bacs_repartition, '[]'::jsonb) = '[]'::jsonb)
                     - (SELECT COALESCE(SUM(s4.quantite_kg),0) FROM stocks s4 WHERE s4.bac_numero < s.bac_numero)
                   )
                 )
             ) AS kg_disponible_bac,
             MAX(s.prix_par_kg) AS dernier_prix,
             COUNT(*) AS nb_depots,
             MAX(s.date_depot) AS dernier_depot
      FROM stocks s
      WHERE s.bac_numero IS NOT NULL
      GROUP BY s.bac_numero, s.type_stock, s.poids_categorie
      ORDER BY s.bac_numero, s.poids_categorie`);

    // Stock vendu (par type) — on associe les ventes aux stocks du même type
    const ventes = await db.query(`
      SELECT
        COALESCE(SUM(cv.kg_achetes), 0) AS total_kg_vendu
      FROM clients_vente cv`);

    // Résumé global par type de stock
    const parType = await db.query(`
      SELECT type_stock, poids_categorie,
             COALESCE(SUM(quantite_kg), 0) AS total_achete,
             MAX(prix_par_kg) AS dernier_prix
      FROM stocks
      GROUP BY type_stock, poids_categorie
      ORDER BY type_stock, poids_categorie`);

    // Total général
// ✅ APRÈS
const totaux = await db.query(`
  SELECT
    COALESCE(SUM(s.quantite_kg), 0) AS total_kg_achete,
    COALESCE(SUM(s.quantite_kg * s.prix_par_kg), 0) AS valeur_totale_achat,
    (SELECT COALESCE(SUM(cv.kg_achetes), 0) FROM clients_vente cv) AS total_kg_vendu,
    (SELECT COALESCE(SUM(cv.montant_recu), 0) FROM clients_vente cv) AS total_encaisse,
    (SELECT COALESCE(SUM(p.kg_perdus), 0) FROM pertes_stock p) AS total_kg_perdu,
    (SELECT COALESCE(SUM(r.quantite_kg), 0) FROM retraits_stock r) AS total_kg_retire
  FROM stocks s`);
const t = totaux.rows[0];
const reste_kg = parseFloat(t.total_kg_achete) - parseFloat(t.total_kg_vendu) - parseFloat(t.total_kg_perdu) - parseFloat(t.total_kg_retire || 0);

    

    res.json({
      bacs: entrees.rows,
      par_type: parType.rows,
      totaux: { ...t, reste_kg },
    });
  } catch (err) {
    console.error('etatBacs:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

/** GET /api/stocks/resume */
const resumeStock = async (req, res) => {
  try {
// ✅ APRÈS
const r = await db.query(`
  SELECT
    COALESCE(SUM(s.quantite_kg), 0) AS total_kg_achete,
    COALESCE(SUM(s.quantite_kg * s.prix_par_kg), 0) AS valeur_totale_achat,
    (SELECT COALESCE(SUM(cv.kg_achetes), 0) FROM clients_vente cv) AS total_kg_vendu,
    (SELECT COALESCE(SUM(cv.montant_recu), 0) FROM clients_vente cv) AS total_encaisse,
    (SELECT COALESCE(SUM(p.kg_perdus), 0) FROM pertes_stock p) AS total_kg_perdu,
    (SELECT COALESCE(SUM(r.quantite_kg), 0) FROM retraits_stock r) AS total_kg_retire
  FROM stocks s`);

  const row = r.rows[0];
const reste = parseFloat(row.total_kg_achete) - parseFloat(row.total_kg_vendu) - parseFloat(row.total_kg_perdu) - parseFloat(row.total_kg_retire || 0);
    
    
    res.json({ ...row, reste_stock_kg: reste });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
};

/** GET /api/stocks/prix — Liste des prix par type */
const listerPrix = async (req, res) => {
  try {
    const r = await db.query(
      `SELECT * FROM prix_stock WHERE actif = TRUE ORDER BY type_stock, poids_categorie`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
};

/** POST /api/stocks/prix — Modifier le prix d'un type (sans toucher aux anciennes données) */
const modifierPrix = async (req, res) => {
  const { type_stock, poids_categorie, nouveau_prix } = req.body;
  if (!type_stock || !nouveau_prix || isNaN(nouveau_prix) || Number(nouveau_prix) <= 0)
    return res.status(400).json({ message: 'type_stock et nouveau_prix (>0) requis.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const today = new Date().toISOString().split('T')[0];

    // Fermer l'ancien prix actif
    await client.query(
      `UPDATE prix_stock SET actif = FALSE, date_fin = $1
       WHERE type_stock = $2 AND (poids_categorie = $3 OR ($3::TEXT IS NULL AND poids_categorie IS NULL))
         AND actif = TRUE`,
      [today, type_stock, poids_categorie || null]
    );

    // Créer le nouveau prix
    const r = await client.query(
      `INSERT INTO prix_stock (type_stock, poids_categorie, prix_par_kg, date_debut, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [type_stock, poids_categorie || null, nouveau_prix, today, req.user.id]
    );

    await client.query('COMMIT');
    res.json({ message: 'Prix mis à jour. Les dépôts passés sont conservés avec leurs prix d\'origine.', prix: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('modifierPrix:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  } finally { client.release(); }
};


/** POST /api/stocks/retraits — Retirer une quantité d'un bac avec contrôle transactionnel. */
const retirerStock = async (req, res) => {
  const bac = Number(req.body.bac_numero);
  const kg = Number(req.body.quantite_kg);
  const commentaire = String(req.body.commentaire || '').trim();
  const dateRetrait = req.body.date_retrait || new Date().toISOString().split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateRetrait)) || Number.isNaN(Date.parse(`${dateRetrait}T00:00:00Z`)))
    return res.status(400).json({ message: 'Sélectionne une date de retrait valide.' });
  if (!Number.isInteger(bac) || bac < 1 || bac > 7)
    return res.status(400).json({ message: 'Sélectionne un bac valide (1 à 7).' });
  if (!Number.isFinite(kg) || kg <= 0)
    return res.status(400).json({ message: 'La quantité doit être supérieure à 0 kg.' });
  if (commentaire.length > 500)
    return res.status(400).json({ message: 'Le commentaire ne doit pas dépasser 500 caractères.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Verrou global + lignes du bac : empêche deux retraits concurrents de dépasser le stock total.
    await client.query('SELECT pg_advisory_xact_lock($1)', [741025]);
    await client.query('SELECT id FROM stocks WHERE bac_numero=$1 FOR UPDATE', [bac]);
    const dispo = await client.query(`
      SELECT
        COALESCE((SELECT SUM(quantite_kg) FROM stocks WHERE bac_numero=$1),0)
        - COALESCE((SELECT SUM(kg_perdus) FROM pertes_stock WHERE bac_numero=$1),0)
        - COALESCE((SELECT SUM(quantite_kg) FROM retraits_stock WHERE bac_numero=$1),0)
        AS disponible_bac,
        COALESCE((SELECT SUM(s.quantite_kg) FROM stocks s),0)
        - COALESCE((SELECT SUM(cv.kg_achetes) FROM clients_vente cv),0)
        - COALESCE((SELECT SUM(p.kg_perdus) FROM pertes_stock p),0)
        - COALESCE((SELECT SUM(r.quantite_kg) FROM retraits_stock r),0)
        AS disponible_global
    `, [bac]);
    const bacRestant = Math.max(0, Number(dispo.rows[0].disponible_bac || 0));
    const globalRestant = Math.max(0, Number(dispo.rows[0].disponible_global || 0));
    const disponible = Math.min(bacRestant, globalRestant);
    if (kg > disponible + 0.0001) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Quantité trop élevée. Stock disponible estimé : ${disponible.toFixed(2)} kg (bac ${bac} : ${bacRestant.toFixed(2)} kg).`,
        disponible_kg: disponible
      });
    }
    const r = await client.query(`
      INSERT INTO retraits_stock (bac_numero, quantite_kg, commentaire, retire_par, date_retrait)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [bac, kg, commentaire || null, req.user.id, dateRetrait]);
    await client.query('COMMIT');
    return res.status(201).json({ message: 'Retrait de stock enregistré.', retrait: r.rows[0], disponible_apres_kg: disponible - kg });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('retirerStock:', err);
    return res.status(500).json({ message: 'Impossible d’enregistrer le retrait de stock.', detail: err.message });
  } finally { client.release(); }
};

const listerRetraitsStock = async (req, res) => {
  try {
    const r = await db.query(`
      SELECT r.*, u.nom || ' ' || u.prenom AS retire_par_nom
      FROM retraits_stock r LEFT JOIN users u ON u.id=r.retire_par
      ORDER BY r.date_retrait DESC, r.created_at DESC LIMIT 200
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('listerRetraitsStock:', err);
    res.status(500).json({ message: 'Impossible de charger les retraits.', detail: err.message });
  }
};

/** DELETE /api/stocks/retraits/:id — Supprimer un retrait et réintégrer sa quantité au stock disponible. */
const supprimerRetraitStock = async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ message: 'Identifiant de retrait invalide.' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Sérialise la suppression avec les créations de retraits pour garder un stock cohérent.
    await client.query('SELECT pg_advisory_xact_lock($1)', [741025]);
    const result = await client.query(
      'DELETE FROM retraits_stock WHERE id = $1 RETURNING id, bac_numero, quantite_kg',
      [id]
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Ce retrait n’existe plus ou a déjà été supprimé.' });
    }
    await client.query('COMMIT');
    return res.json({
      message: `Retrait supprimé. ${Number(result.rows[0].quantite_kg).toFixed(2)} kg sont de nouveau disponibles dans le stock.`,
      retrait: result.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('supprimerRetraitStock:', err);
    return res.status(500).json({ message: 'Impossible de supprimer ce retrait.', detail: err.message });
  } finally {
    client.release();
  }
};

/** DELETE /api/stocks/:id */
const supprimerDepot = async (req, res) => {
  try {
    await db.query('DELETE FROM stocks WHERE id = $1', [req.params.id]);
    res.json({ message: 'Dépôt supprimé.' });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
};

module.exports = { ajouterDepot, listerDepots, etatBacs, resumeStock, listerPrix, modifierPrix, retirerStock, listerRetraitsStock, supprimerRetraitStock, supprimerDepot };
