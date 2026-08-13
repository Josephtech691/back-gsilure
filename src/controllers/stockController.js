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
      SELECT bac_numero, type_stock, poids_categorie,
             SUM(quantite_kg) AS kg_total,
             MAX(prix_par_kg) AS dernier_prix,
             COUNT(*) AS nb_depots,
             MAX(date_depot) AS dernier_depot
      FROM stocks
      WHERE bac_numero IS NOT NULL
      GROUP BY bac_numero, type_stock, poids_categorie
      ORDER BY bac_numero, poids_categorie`);

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
    const totaux = await db.query(`
      SELECT
        COALESCE(SUM(s.quantite_kg), 0) AS total_kg_achete,
        COALESCE(SUM(s.quantite_kg * s.prix_par_kg), 0) AS valeur_totale_achat,
        (SELECT COALESCE(SUM(cv.kg_achetes), 0) FROM clients_vente cv) AS total_kg_vendu,
        (SELECT COALESCE(SUM(cv.montant_recu), 0) FROM clients_vente cv) AS total_encaisse
      FROM stocks s`);

    const t = totaux.rows[0];
    const reste_kg = parseFloat(t.total_kg_achete) - parseFloat(t.total_kg_vendu);

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
    const r = await db.query(`
      SELECT
        COALESCE(SUM(quantite_kg), 0) AS total_kg_achete,
        COALESCE(SUM(quantite_kg * prix_par_kg), 0) AS valeur_totale_achat,
        (SELECT COALESCE(SUM(kg_achetes), 0) FROM clients_vente) AS total_kg_vendu,
        (SELECT COALESCE(SUM(montant_recu), 0) FROM clients_vente) AS total_encaisse
      FROM stocks`);
    const row = r.rows[0];
    const reste = parseFloat(row.total_kg_achete) - parseFloat(row.total_kg_vendu);
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

/** DELETE /api/stocks/:id */
const supprimerDepot = async (req, res) => {
  try {
    await db.query('DELETE FROM stocks WHERE id = $1', [req.params.id]);
    res.json({ message: 'Dépôt supprimé.' });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
};

module.exports = { ajouterDepot, listerDepots, etatBacs, resumeStock, listerPrix, modifierPrix, supprimerDepot };
