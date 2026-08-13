const db = require('../config/db');

const PRIX_KG = 2500;

const declarerPerte = async (req, res) => {
  const { type_perte, stock_id, type_stock, poids_categorie, bac_numero, kg_perdus, commentaire } = req.body;

  if (!['perte_poids', 'mort'].includes(type_perte))
    return res.status(400).json({ message: 'type_perte invalide.' });
  if (!kg_perdus || isNaN(kg_perdus) || Number(kg_perdus) <= 0)
    return res.status(400).json({ message: 'kg_perdus invalide.' });
  if (!type_stock)
    return res.status(400).json({ message: 'type_stock requis.' });

  try {
    const now = new Date();
    const mois = now.toISOString().slice(0, 7);
    const annee = now.getFullYear();

    const r = await db.query(
      `INSERT INTO pertes_stock
         (type_perte, stock_id, type_stock, poids_categorie, bac_numero, kg_perdus, commentaire, declare_par, mois, annee)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [type_perte, stock_id||null, type_stock, poids_categorie||null,
       bac_numero||null, kg_perdus, commentaire||null, req.user.id, mois, annee]
    );
    res.status(201).json({
      message: `Perte de ${kg_perdus} kg déclarée.`,
      perte: r.rows[0],
      valeur_perdue: parseFloat(kg_perdus) * PRIX_KG,
    });
  } catch (err) {
    console.error('declarerPerte:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

const listerPertes = async (req, res) => {
  const { mois, annee, type_perte, type_stock } = req.query;
  try {
    let q = `SELECT p.*, u.nom || ' ' || u.prenom AS declare_par_nom, u.role AS declare_par_role
             FROM pertes_stock p LEFT JOIN users u ON p.declare_par = u.id WHERE 1=1`;
    const params = [];
    if (mois)       { params.push(mois);      q += ` AND p.mois = $${params.length}`; }
    if (annee)      { params.push(annee);     q += ` AND p.annee = $${params.length}`; }
    if (type_perte) { params.push(type_perte);q += ` AND p.type_perte = $${params.length}`; }
    if (type_stock) { params.push(type_stock);q += ` AND p.type_stock = $${params.length}`; }
    q += ' ORDER BY p.created_at DESC';
    const r = await db.query(q, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
};

const statsPertes = async (req, res) => {
  const moisFiltre  = req.query.mois  || new Date().toISOString().slice(0,7);
  const anneeFiltre = req.query.annee || new Date().getFullYear();
  try {
    const [pm, pa, pt] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(kg_perdus),0) AS kg, COALESCE(SUM(kg_perdus)*${PRIX_KG},0) AS val FROM pertes_stock WHERE mois=$1`, [moisFiltre]),
      db.query(`SELECT COALESCE(SUM(kg_perdus),0) AS kg, COALESCE(SUM(kg_perdus)*${PRIX_KG},0) AS val FROM pertes_stock WHERE annee=$1`, [anneeFiltre]),
      db.query(`SELECT type_perte, type_stock, COALESCE(SUM(kg_perdus),0) AS total_kg FROM pertes_stock WHERE mois=$1 GROUP BY type_perte, type_stock ORDER BY total_kg DESC`, [moisFiltre]),
    ]);
    res.json({
      mois:  { kg_perdus: parseFloat(pm.rows[0].kg), valeur_perdue: parseFloat(pm.rows[0].val), mois_filtre: moisFiltre },
      annee: { kg_perdus: parseFloat(pa.rows[0].kg), valeur_perdue: parseFloat(pa.rows[0].val), annee_filtre: anneeFiltre },
      par_type: pt.rows,
    });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
};

const supprimerPerte = async (req, res) => {
  try {
    const r = await db.query('DELETE FROM pertes_stock WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ message: 'Perte non trouvée.' });
    res.json({ message: 'Perte supprimée.' });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
};

module.exports = { declarerPerte, listerPertes, statsPertes, supprimerPerte };
