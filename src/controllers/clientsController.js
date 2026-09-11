const db = require('../config/db');

const TYPES_VALIDES = ['simple', 'revendeur', 'fournisseur'];

// GET /clients/recherche?q=xxx — autocomplete pendant la saisie du nom
const rechercherClients = async (req, res) => {
  const q = (req.query.q || '').trim().toUpperCase();
  if (!q) return res.json([]);
  try {
    const r = await db.query(`
      SELECT nom FROM (
        SELECT DISTINCT client_nom AS nom FROM clients_vente WHERE client_nom LIKE $1
        UNION
        SELECT nom FROM clients WHERE nom LIKE $1
      ) t
      ORDER BY nom LIMIT 8
    `, [q + '%']);
    res.json(r.rows.map(row => row.nom));
  } catch (err) {
    console.error('rechercherClients:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// POST /clients — enregistrer ou mettre à jour un "client important"
const creerClient = async (req, res) => {
  const { nom, telephone, type, commentaire } = req.body;
  const nomMaj = (nom || '').trim().toUpperCase();
  if (!nomMaj) return res.status(400).json({ message: 'Nom requis.' });
  if (nomMaj === 'INCONNU') return res.status(400).json({ message: 'Ce nom est réservé.' });
  const typeFinal = TYPES_VALIDES.includes(type) ? type : 'simple';

  try {
    const r = await db.query(`
      INSERT INTO clients (nom, telephone, type, commentaire, created_by)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (nom) DO UPDATE
        SET telephone = EXCLUDED.telephone, type = EXCLUDED.type, commentaire = EXCLUDED.commentaire
      RETURNING *
    `, [nomMaj, telephone?.trim() || null, typeFinal, commentaire?.trim() || null, req.user.id]);
    res.status(201).json({ message: 'Client enregistré ✓', client: r.rows[0] });
  } catch (err) {
    console.error('creerClient:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// GET /clients — liste complète (admin)
const listerClients = async (req, res) => {
  try {
    const r = await db.query(`
      SELECT cv.client_nom AS nom,
             c.telephone, COALESCE(c.type,'simple') AS type, c.commentaire,
             COUNT(DISTINCT vj.date_vente) AS nb_visites,
             COALESCE(SUM(cv.kg_achetes),0) AS kg_total,
             COALESCE(SUM(cv.montant_recu),0) AS montant_total,
             MAX(vj.date_vente) AS derniere_visite
      FROM clients_vente cv
      JOIN ventes_journees vj ON vj.id = cv.journee_id
      LEFT JOIN clients c ON c.nom = cv.client_nom
      GROUP BY cv.client_nom, c.telephone, c.type, c.commentaire
      ORDER BY kg_total DESC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('listerClients:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// GET /clients/:nom — détail (admin) avec stats mois/année/période/semaine
const detailClient = async (req, res) => {
  const nom = decodeURIComponent(req.params.nom).toUpperCase();
  const { mois, annee, periode_id } = req.query;
  const moisFiltre = mois || new Date().toISOString().slice(0, 7);
  const anneeFiltre = annee || new Date().getFullYear();

  try {
    const profil = await db.query('SELECT * FROM clients WHERE nom = $1', [nom]);
    const info = profil.rows[0] || { nom, telephone: null, type: 'simple', commentaire: null };

    const totalQ = db.query(`
      SELECT COALESCE(SUM(cv.kg_achetes),0) AS kg, COALESCE(SUM(cv.montant_recu),0) AS montant, COUNT(*) AS nb
      FROM clients_vente cv JOIN ventes_journees vj ON vj.id = cv.journee_id
      WHERE cv.client_nom = $1`, [nom]);

    const moisQ = db.query(`
      SELECT COALESCE(SUM(cv.kg_achetes),0) AS kg
      FROM clients_vente cv JOIN ventes_journees vj ON vj.id = cv.journee_id
      WHERE cv.client_nom = $1 AND TO_CHAR(vj.date_vente,'YYYY-MM') = $2`, [nom, moisFiltre]);

    const anneeQ = db.query(`
      SELECT COALESCE(SUM(cv.kg_achetes),0) AS kg
      FROM clients_vente cv JOIN ventes_journees vj ON vj.id = cv.journee_id
      WHERE cv.client_nom = $1 AND EXTRACT(YEAR FROM vj.date_vente) = $2`, [nom, anneeFiltre]);

    // Semaine actuelle (lundi → dimanche)
    const now = new Date();
    const decalage = (now.getDay() + 6) % 7; // 0 = lundi
    const lundi = new Date(now); lundi.setDate(now.getDate() - decalage);
    const dimanche = new Date(lundi); dimanche.setDate(lundi.getDate() + 6);
    const debutSemaine = lundi.toISOString().slice(0, 10);
    const finSemaine = dimanche.toISOString().slice(0, 10);
    const semaineQ = db.query(`
      SELECT COALESCE(SUM(cv.kg_achetes),0) AS kg
      FROM clients_vente cv JOIN ventes_journees vj ON vj.id = cv.journee_id
      WHERE cv.client_nom = $1 AND vj.date_vente BETWEEN $2::date AND $3::date`,
      [nom, debutSemaine, finSemaine]);

    let periodeInfo = null;
    let periodeKg = 0;
    if (periode_id) {
      const pr = await db.query('SELECT * FROM periodes_dashboard WHERE id = $1', [periode_id]);
      if (pr.rows.length) {
        periodeInfo = pr.rows[0];
        const fin = periodeInfo.date_fin || new Date().toISOString().slice(0, 10);
        const pq = await db.query(`
          SELECT COALESCE(SUM(cv.kg_achetes),0) AS kg
          FROM clients_vente cv JOIN ventes_journees vj ON vj.id = cv.journee_id
          WHERE cv.client_nom = $1 AND vj.date_vente BETWEEN $2::date AND $3::date`,
          [nom, periodeInfo.date_debut, fin]);
        periodeKg = parseFloat(pq.rows[0].kg);
      }
    }

    const [total, moisR, anneeR, semaineR] = await Promise.all([totalQ, moisQ, anneeQ, semaineQ]);

    res.json({
      info,
      kg_total: parseFloat(total.rows[0].kg),
      montant_total: parseFloat(total.rows[0].montant),
      nb_achats: parseInt(total.rows[0].nb),
      kg_mois: parseFloat(moisR.rows[0].kg), mois_filtre: moisFiltre,
      kg_annee: parseFloat(anneeR.rows[0].kg), annee_filtre: anneeFiltre,
      kg_semaine: parseFloat(semaineR.rows[0].kg),
      semaine: { debut: debutSemaine, fin: finSemaine },
      kg_periode: periodeKg,
      periode: periodeInfo ? { id: periodeInfo.id, date_debut: periodeInfo.date_debut, date_fin: periodeInfo.date_fin } : null,
    });
  } catch (err) {
    console.error('detailClient:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

module.exports = { rechercherClients, creerClient, listerClients, detailClient };
