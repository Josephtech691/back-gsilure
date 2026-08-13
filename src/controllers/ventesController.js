const db = require('../config/db');
const PRIX_KG = 2500;

const today = () => new Date().toISOString().split('T')[0];

function calculerTotaux(clients) {
  return clients.reduce((acc, c) => ({
    total_kg: acc.total_kg + parseFloat(c.kg_achetes || 0),
    total_recu: acc.total_recu + parseFloat(c.montant_recu || 0),
    valeur_theorique: acc.valeur_theorique + parseFloat(c.kg_achetes || 0) * PRIX_KG,
  }), { total_kg: 0, total_recu: 0, valeur_theorique: 0 });
}

async function estModificationAutorisee(journeeId) {
  const r = await db.query(
    `SELECT id FROM demandes WHERE ref_id = $1 AND type = 'modification_journee'
     AND statut = 'approuvee' AND expire_at > NOW()`,
    [journeeId]
  );
  return r.rows.length > 0;
}

// ─── JOURNÉES ───────────────────────────────────────────────
const getOuCreerJournee = async (req, res) => {
  const { date, employe_id } = req.query;
  const dateVente = date || today();
  const empId = req.user.role === 'admin' ? (employe_id || req.user.id) : req.user.id;
  const isToday = dateVente === today();

  try {
    let result = await db.query(
      'SELECT * FROM ventes_journees WHERE employe_id = $1 AND date_vente = $2',
      [empId, dateVente]
    );

    if (!result.rows.length) {
      if (!isToday && req.user.role !== 'admin')
        return res.status(404).json({ message: 'Aucune journée pour cette date.' });
      result = await db.query(
        'INSERT INTO ventes_journees (employe_id, date_vente) VALUES ($1,$2) RETURNING *',
        [empId, dateVente]
      );
    }

    const journee = result.rows[0];
    const clients = await db.query(
      'SELECT * FROM clients_vente WHERE journee_id = $1 ORDER BY numero_client',
      [journee.id]
    );
    const employe = await db.query(
      'SELECT id, nom, prenom, photo_url FROM users WHERE id = $1', [empId]
    );
    const modifAutorisee = !isToday ? await estModificationAutorisee(journee.id) : true;

    res.json({
      journee: { ...journee, modification_autorisee: modifAutorisee },
      clients: clients.rows,
      employe: employe.rows[0],
      totaux: calculerTotaux(clients.rows),
    });
  } catch (err) {
    console.error('getOuCreerJournee:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── CLIENTS ────────────────────────────────────────────────
const ajouterClient = async (req, res) => {
  const { journeeId } = req.params;
  const { kg_achetes, montant_recu, heure_approx, commentaire, type_stock, poids_categorie } = req.body;

  if (!kg_achetes || isNaN(kg_achetes) || Number(kg_achetes) <= 0)
    return res.status(400).json({ message: 'Kg achetés invalide.' });
  if (montant_recu === undefined || montant_recu === null || isNaN(montant_recu))
    return res.status(400).json({ message: 'Montant reçu invalide.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const journee = await client.query('SELECT * FROM ventes_journees WHERE id = $1', [journeeId]);
    if (!journee.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Journée non trouvée.' });
    }

    const j = journee.rows[0];
    const dateVenteStr = j.date_vente instanceof Date
      ? j.date_vente.toISOString().split('T')[0]
      : String(j.date_vente).split('T')[0];
    const isToday = dateVenteStr === today();

    if (req.user.role === 'employee') {
      if (j.employe_id !== req.user.id) {
        await client.query('ROLLBACK');
        return res.status(403).json({ message: 'Accès refusé.' });
      }
      if (!isToday) {
        const autorisee = await estModificationAutorisee(journeeId);
        if (!autorisee) {
          await client.query('ROLLBACK');
          return res.status(403).json({ message: 'Journée passée. Demandez une autorisation de modification.' });
        }
      }
    }

    const maxNum = await client.query(
      'SELECT COALESCE(MAX(numero_client), 0) AS max FROM clients_vente WHERE journee_id = $1',
      [journeeId]
    );
    const numeroClient = maxNum.rows[0].max + 1;
    const heure = heure_approx || new Date().toTimeString().slice(0, 8);

    const newClient = await client.query(
      `INSERT INTO clients_vente
         (journee_id, numero_client, kg_achetes, montant_recu, heure_approx, commentaire, type_stock, poids_categorie)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [journeeId, numeroClient, kg_achetes, montant_recu, heure,
       commentaire || null, type_stock || null, poids_categorie || null]
    );

    await client.query('COMMIT');
    res.status(201).json({ client: newClient.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ajouterClient:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  } finally { client.release(); }
};

const modifierClient = async (req, res) => {
  const { clientId } = req.params;
  const { kg_achetes, montant_recu, heure_approx, commentaire, type_stock, poids_categorie } = req.body;

  try {
    const existing = await db.query(
      `SELECT cv.*, vj.employe_id, vj.date_vente FROM clients_vente cv
       JOIN ventes_journees vj ON cv.journee_id = vj.id WHERE cv.id = $1`,
      [clientId]
    );
    if (!existing.rows.length) return res.status(404).json({ message: 'Client non trouvé.' });

    const row = existing.rows[0];
    const dateStr = row.date_vente instanceof Date
      ? row.date_vente.toISOString().split('T')[0]
      : String(row.date_vente).split('T')[0];
    const isToday = dateStr === today();

    if (req.user.role === 'employee') {
      if (row.employe_id !== req.user.id) return res.status(403).json({ message: 'Accès refusé.' });
      if (!isToday && !(await estModificationAutorisee(row.journee_id)))
        return res.status(403).json({ message: 'Journée verrouillée.' });
    }

    const r = await db.query(
      `UPDATE clients_vente
       SET kg_achetes      = COALESCE($1, kg_achetes),
           montant_recu    = COALESCE($2, montant_recu),
           heure_approx    = COALESCE($3, heure_approx),
           commentaire     = $4,
           type_stock      = COALESCE($5, type_stock),
           poids_categorie = COALESCE($6, poids_categorie),
           updated_at      = NOW()
       WHERE id = $7 RETURNING *`,
      [kg_achetes ?? null, montant_recu ?? null, heure_approx ?? null,
       commentaire ?? row.commentaire, type_stock ?? null, poids_categorie ?? null, clientId]
    );
    res.json({ client: r.rows[0] });
  } catch (err) {
    console.error('modifierClient:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

const supprimerClient = async (req, res) => {
  const { clientId } = req.params;
  try {
    const existing = await db.query(
      `SELECT cv.*, vj.employe_id, vj.date_vente FROM clients_vente cv
       JOIN ventes_journees vj ON cv.journee_id = vj.id WHERE cv.id = $1`,
      [clientId]
    );
    if (!existing.rows.length) return res.status(404).json({ message: 'Client non trouvé.' });
    const row = existing.rows[0];
    const dateStr = row.date_vente instanceof Date
      ? row.date_vente.toISOString().split('T')[0]
      : String(row.date_vente).split('T')[0];
    const isToday = dateStr === today();
    if (req.user.role === 'employee') {
      if (row.employe_id !== req.user.id) return res.status(403).json({ message: 'Accès refusé.' });
      if (!isToday && !(await estModificationAutorisee(row.journee_id)))
        return res.status(403).json({ message: 'Journée verrouillée.' });
    }
    await db.query('DELETE FROM clients_vente WHERE id = $1', [clientId]);
    res.json({ message: 'Client supprimé.' });
  } catch (err) {
    console.error('supprimerClient:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── ANNULATION RESTE ────────────────────────────────────────
const demanderAnnulationReste = async (req, res) => {
  const { clientId } = req.params;
  const { motif } = req.body;
  if (!motif?.trim()) return res.status(400).json({ message: 'Motif requis.' });

  try {
    const cv = await db.query(
      `SELECT cv.*, vj.employe_id FROM clients_vente cv
       JOIN ventes_journees vj ON cv.journee_id = vj.id WHERE cv.id = $1`,
      [clientId]
    );
    if (!cv.rows.length) return res.status(404).json({ message: 'Client non trouvé.' });
    if (cv.rows[0].employe_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ message: 'Accès refusé.' });

    const reste = parseFloat(cv.rows[0].kg_achetes) * PRIX_KG - parseFloat(cv.rows[0].montant_recu);
    if (reste <= 0) return res.status(400).json({ message: 'Pas de reste à annuler.' });

    await db.query(
      `UPDATE clients_vente SET reste_annule_statut = 'en_attente', reste_annule_motif = $1 WHERE id = $2`,
      [motif.trim(), clientId]
    );

    const r = await db.query(
      `INSERT INTO demandes (employe_id, type, ref_id, ref_table, motif, meta)
       VALUES ($1, 'annulation_reste', $2, 'clients_vente', $3, $4) RETURNING *`,
      [req.user.id, clientId, motif.trim(), JSON.stringify({ reste, client_numero: cv.rows[0].numero_client })]
    );

    res.status(201).json({ message: "Demande d'annulation envoyée.", demande: r.rows[0] });
  } catch (err) {
    console.error('demanderAnnulationReste:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── MOUVEMENTS CAISSE ───────────────────────────────────────
const creerMouvementCaisse = async (req, res) => {
  const { type, montant, commentaire, mois } = req.body;
  if (!['ajout', 'retrait'].includes(type)) return res.status(400).json({ message: 'Type invalide.' });
  if (!montant || isNaN(montant) || Number(montant) <= 0) return res.status(400).json({ message: 'Montant invalide.' });
  if (!commentaire?.trim()) return res.status(400).json({ message: 'Commentaire requis.' });

  try {
    const moisCible = mois || new Date().toISOString().slice(0, 7);
    const mc = await db.query(
      `INSERT INTO mouvements_caisse (employe_id, type, montant, commentaire, mois)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, type, montant, commentaire.trim(), moisCible]
    );
    await db.query(
      `INSERT INTO demandes (employe_id, type, ref_id, ref_table, motif, meta)
       VALUES ($1, 'mouvement_caisse', $2, 'mouvements_caisse', $3, $4)`,
      [req.user.id, mc.rows[0].id, commentaire.trim(),
       JSON.stringify({ type_mouvement: type, montant, mois: moisCible })]
    );
    res.status(201).json({ message: 'Demande de mouvement soumise.', mouvement: mc.rows[0] });
  } catch (err) {
    console.error('creerMouvementCaisse:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

const creerEncaissement = async (req, res) => {
  const { montant, commentaire, mois } = req.body;
  if (!montant || isNaN(montant) || Number(montant) <= 0) return res.status(400).json({ message: 'Montant invalide.' });

  try {
    const moisCible = mois || new Date().toISOString().slice(0, 7);
    const enc = await db.query(
      `INSERT INTO encaissements (employe_id, montant, commentaire, mois)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, montant, commentaire?.trim() || null, moisCible]
    );
    await db.query(
      `INSERT INTO demandes (employe_id, type, ref_id, ref_table, motif, meta)
       VALUES ($1, 'encaissement', $2, 'encaissements', $3, $4)`,
      [req.user.id, enc.rows[0].id,
       `Versement de ${parseFloat(montant).toLocaleString('fr')} FCFA`,
       JSON.stringify({ montant, mois: moisCible })]
    );
    res.status(201).json({ message: 'Encaissement soumis.', encaissement: enc.rows[0] });
  } catch (err) {
    console.error('creerEncaissement:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── GRAPHIQUE EMPLOYÉ ───────────────────────────────────────
const graphiqueEmploye = async (req, res) => {
  const { mois, annee: anneeQuery } = req.query;
  const empId = req.user.role === 'admin' ? req.query.employe_id : req.user.id;
  if (!empId) return res.status(400).json({ message: 'employe_id requis.' });

  const moisFiltre = mois || new Date().toISOString().slice(0, 7);
  const [anneeMois, moisNum] = moisFiltre.split('-');
  // ✅ FIX : utiliser anneeFiltre partout, pas "annee"
  const anneeFiltre = anneeQuery || anneeMois;

  try {
    // Ventes du mois
    const ventes = await db.query(`
      SELECT vj.date_vente::TEXT AS date,
             COALESCE(SUM(cv.kg_achetes), 0) AS kg_vendus,
             COALESCE(SUM(cv.montant_recu), 0) AS montant_encaisse,
             COUNT(cv.id) AS nb_clients
      FROM ventes_journees vj
      LEFT JOIN clients_vente cv ON cv.journee_id = vj.id
      WHERE vj.employe_id = $1
        AND EXTRACT(YEAR FROM vj.date_vente) = $2
        AND EXTRACT(MONTH FROM vj.date_vente) = $3
      GROUP BY vj.date_vente ORDER BY vj.date_vente`,
      // ✅ FIX : anneeFiltre à la place de annee
      [empId, anneeFiltre, moisNum]
    );

    const mouvements = await db.query(
      `SELECT * FROM mouvements_caisse WHERE employe_id = $1 AND mois = $2 AND statut = 'approuvee'`,
      [empId, moisFiltre]
    );

    const encaissements = await db.query(
      `SELECT * FROM encaissements WHERE employe_id = $1 AND mois = $2 AND statut = 'approuvee'`,
      [empId, moisFiltre]
    );

    // Caisse cumulée (toute la durée)
    const cumulVentes = await db.query(
      `SELECT COALESCE(SUM(cv.montant_recu), 0) AS total
       FROM ventes_journees vj LEFT JOIN clients_vente cv ON cv.journee_id = vj.id
       WHERE vj.employe_id = $1`, [empId]
    );

    const cumulMouvements = await db.query(
      `SELECT type, COALESCE(SUM(montant), 0) AS total FROM mouvements_caisse
       WHERE employe_id = $1 AND statut = 'approuvee' GROUP BY type`, [empId]
    );

    const cumulEncaissements = await db.query(
      `SELECT COALESCE(SUM(montant), 0) AS total FROM encaissements
       WHERE employe_id = $1 AND statut = 'approuvee'`, [empId]
    );

    const cumulAjouts = parseFloat(cumulMouvements.rows.find(r => r.type === 'ajout')?.total || 0);
    const cumulRetraits = parseFloat(cumulMouvements.rows.find(r => r.type === 'retrait')?.total || 0);

    const enAttente = await db.query(
      `SELECT type, SUM(montant) AS total FROM mouvements_caisse
       WHERE employe_id = $1 AND mois = $2 AND statut = 'en_attente' GROUP BY type`,
      [empId, moisFiltre]
    );

    const stock = await db.query(`
      SELECT type_stock, poids_categorie, bac_numero,
             SUM(quantite_kg) AS total_kg, MAX(prix_par_kg) AS prix
      FROM stocks GROUP BY type_stock, poids_categorie, bac_numero ORDER BY bac_numero`);

    const totalVendu = await db.query(`SELECT COALESCE(SUM(kg_achetes), 0) AS total FROM clients_vente`);

    const totaux = ventes.rows.reduce((acc, r) => ({
      kg_total: acc.kg_total + parseFloat(r.kg_vendus),
      montant_total: acc.montant_total + parseFloat(r.montant_encaisse),
      clients_total: acc.clients_total + parseInt(r.nb_clients),
    }), { kg_total: 0, montant_total: 0, clients_total: 0 });

    const ajouts = mouvements.rows.filter(m => m.type === 'ajout').reduce((s, m) => s + parseFloat(m.montant), 0);
    const retraits = mouvements.rows.filter(m => m.type === 'retrait').reduce((s, m) => s + parseFloat(m.montant), 0);
    const totalEnc = encaissements.rows.reduce((s, e) => s + parseFloat(e.montant), 0);

    const totalAnneeQ = await db.query(`
      SELECT COALESCE(SUM(cv.montant_recu), 0) AS total
      FROM ventes_journees vj LEFT JOIN clients_vente cv ON cv.journee_id = vj.id
      WHERE vj.employe_id = $1 AND EXTRACT(YEAR FROM vj.date_vente) = $2`,
      [empId, anneeFiltre]
    );

    res.json({
      donnees: ventes.rows,
      totaux_mois: { ...totaux, ajouts, retraits, encaissements: totalEnc },
      mouvements: mouvements.rows,
      encaissements: encaissements.rows,
      en_attente: enAttente.rows,
      stock_global: {
        par_type: stock.rows,
        total_kg_achete: stock.rows.reduce((s, r) => s + parseFloat(r.total_kg || 0), 0),
        total_kg_vendu: parseFloat(totalVendu.rows[0].total),
      },
      caisse_cumulee: {
        ventes: parseFloat(cumulVentes.rows[0].total),
        ajouts: cumulAjouts,
        retraits: cumulRetraits,
        encaissements: parseFloat(cumulEncaissements.rows[0].total),
      },
      total_annee: parseFloat(totalAnneeQ.rows[0].total),
      annee: anneeFiltre,
      mois: moisFiltre,
    });
  } catch (err) {
    console.error('graphiqueEmploye:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── DASHBOARD ADMIN ─────────────────────────────────────────
const dashboard = async (req, res) => {
  const { date, employe_id, mois } = req.query;
  const dateFiltre = date || today();
  const moisFiltre = mois || dateFiltre.slice(0, 7);

  try {
    const params = [dateFiltre];
    let empFilter = '';
    if (employe_id) { params.push(employe_id); empFilter = `AND vj.employe_id = $${params.length}`; }

    const statsJour = await db.query(`
      SELECT u.id AS employe_id, u.nom || ' ' || u.prenom AS employe_nom,
             COALESCE(SUM(cv.kg_achetes), 0) AS kg_vendus_jour,
             COALESCE(SUM(cv.montant_recu), 0) AS ca_jour,
             COALESCE(SUM(cv.kg_achetes) * 2500, 0) AS valeur_theorique_jour,
             COUNT(cv.id) AS nb_clients
      FROM users u
      LEFT JOIN ventes_journees vj ON vj.employe_id = u.id AND vj.date_vente = $1
      LEFT JOIN clients_vente cv ON cv.journee_id = vj.id
      WHERE u.role = 'employee' AND u.actif = TRUE ${empFilter}
      GROUP BY u.id, u.nom, u.prenom ORDER BY u.nom`, params);

    const totauxJour = statsJour.rows.reduce((acc, r) => ({
      kg_vendus: acc.kg_vendus + parseFloat(r.kg_vendus_jour),
      ca_total: acc.ca_total + parseFloat(r.ca_jour),
      nb_clients: acc.nb_clients + parseInt(r.nb_clients),
    }), { kg_vendus: 0, ca_total: 0, nb_clients: 0 });

    const casse = await db.query(`
      SELECT u.id AS employe_id, u.nom || ' ' || u.prenom AS employe_nom,
             COALESCE(SUM(cv.montant_recu), 0) AS total_encaisse_ventes,
             COALESCE(SUM(cv.kg_achetes) * 2500, 0) AS total_valeur_theorique,
             (SELECT COALESCE(SUM(mc.montant), 0) FROM mouvements_caisse mc
              WHERE mc.employe_id = u.id AND mc.statut = 'approuvee' AND mc.type = 'ajout') AS total_ajouts,
             (SELECT COALESCE(SUM(mc.montant), 0) FROM mouvements_caisse mc
              WHERE mc.employe_id = u.id AND mc.statut = 'approuvee' AND mc.type = 'retrait') AS total_retraits,
             (SELECT COALESCE(SUM(e.montant), 0) FROM encaissements e
              WHERE e.employe_id = u.id AND e.statut = 'approuvee') AS total_verse_patron
      FROM users u
      LEFT JOIN ventes_journees vj ON vj.employe_id = u.id
      LEFT JOIN clients_vente cv ON cv.journee_id = vj.id
      WHERE u.role = 'employee' AND u.actif = TRUE
      GROUP BY u.id, u.nom, u.prenom ORDER BY u.nom`);

    const encaissMois = await db.query(
      `SELECT COALESCE(SUM(montant), 0) AS total FROM encaissements WHERE statut = 'approuvee' AND mois = $1`,
      [moisFiltre]
    );
    const encaissTotal = await db.query(
      `SELECT COALESCE(SUM(montant), 0) AS total FROM encaissements WHERE statut = 'approuvee'`
    );

    const stock = await db.query(`
      SELECT COALESCE(SUM(quantite_kg), 0) AS total_achete,
             (SELECT COALESCE(SUM(kg_achetes), 0) FROM clients_vente) AS total_vendu
      FROM stocks`);

    const clientsDuJour = await db.query(`
      SELECT cv.*, u.nom || ' ' || u.prenom AS employe_nom
      FROM clients_vente cv
      JOIN ventes_journees vj ON cv.journee_id = vj.id
      JOIN users u ON vj.employe_id = u.id
      WHERE vj.date_vente = $1 ${empFilter}
      ORDER BY vj.employe_id, cv.numero_client`, params);

    const demandesEnAttente = await db.query(
      `SELECT COUNT(*) AS nb FROM demandes WHERE statut = 'en_attente'`
    );

    const totauxMois = await db.query(`
SELECT
    COALESCE(SUM(CASE WHEN type='retrait' THEN montant END),0) AS retraits,
    COALESCE(SUM(CASE WHEN type='ajout' THEN montant END),0) AS ajouts
FROM mouvements_caisse
WHERE statut='approuvee'
AND mois=$1
`, [moisFiltre]);

const encaissementsMois = await db.query(`
SELECT COALESCE(SUM(montant),0) AS encaissements
FROM encaissements
WHERE statut='approuvee'
AND mois=$1
`, [moisFiltre]);

const retraitsTotal = await db.query(`
SELECT
    COALESCE(SUM(CASE WHEN type='retrait' THEN montant END),0) AS retraits,
    COALESCE(SUM(CASE WHEN type='ajout' THEN montant END),0) AS ajouts
FROM mouvements_caisse
WHERE statut='approuvee'
`);

const encaissementsTotal = await db.query(`
SELECT COALESCE(SUM(montant),0) AS encaissements
FROM encaissements
WHERE statut='approuvee'
`);

    res.json({
      date: dateFiltre,
      mois: moisFiltre,
      stats_par_employe: statsJour.rows,
      totaux_jour: totauxJour,
      casse_employes: casse.rows,
      encaissements: {
        mois: parseFloat(encaissMois.rows[0].total),
        total: parseFloat(encaissTotal.rows[0].total),
        mois_filtre: moisFiltre,
      },
      totaux_mois: {
    retraits: parseFloat(totauxMois.rows[0].retraits),
    ajouts: parseFloat(totauxMois.rows[0].ajouts),
    encaissements: parseFloat(encaissementsMois.rows[0].encaissements),
},

caisse_cumulee: {
    retraits: parseFloat(retraitsTotal.rows[0].retraits),
    ajouts: parseFloat(retraitsTotal.rows[0].ajouts),
    encaissements: parseFloat(encaissementsTotal.rows[0].encaissements),
},
      stock: {
        total_kg_achete: parseFloat(stock.rows[0].total_achete),
        total_kg_vendu: parseFloat(stock.rows[0].total_vendu),
        reste_kg: parseFloat(stock.rows[0].total_achete) - parseFloat(stock.rows[0].total_vendu),
      },
      clients_du_jour: clientsDuJour.rows,
      nb_demandes_attente: parseInt(demandesEnAttente.rows[0].nb),
    });
  } catch (err) {
    console.error('dashboard:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── DEMANDES UNIFIÉES ───────────────────────────────────────
const listerDemandes = async (req, res) => {
  const { statut, type } = req.query;
  try {
    let q = `SELECT d.*, u.nom || ' ' || u.prenom AS employe_nom, u.email AS employe_email, u.photo_url
             FROM demandes d JOIN users u ON d.employe_id = u.id WHERE 1=1`;
    const params = [];
    if (statut) { params.push(statut); q += ` AND d.statut = $${params.length}`; }
    if (type)   { params.push(type);   q += ` AND d.type = $${params.length}`; }
    q += ' ORDER BY d.created_at DESC';
    const r = await db.query(q, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
};

const traiterDemande = async (req, res) => {
  const { id } = req.params;
  const { statut } = req.body;
  if (!['approuvee', 'refusee'].includes(statut))
    return res.status(400).json({ message: 'Statut invalide.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const dr = await client.query("SELECT * FROM demandes WHERE id = $1 AND statut = 'en_attente'", [id]);
    if (!dr.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Demande non trouvée ou déjà traitée.' });
    }
    const demande = dr.rows[0];
    const expireAt = statut === 'approuvee' && demande.type === 'modification_journee'
      ? new Date(Date.now() + 24 * 3600 * 1000).toISOString() : null;

    await client.query(
      `UPDATE demandes SET statut=$1, approuve_par=$2, approuve_at=NOW(), expire_at=$3 WHERE id=$4`,
      [statut, req.user.id, expireAt, id]
    );

    if (statut === 'approuvee') {
      if (demande.type === 'annulation_reste') {
        await client.query(
          `UPDATE clients_vente SET reste_annule = TRUE, reste_annule_statut = 'approuvee' WHERE id = $1`,
          [demande.ref_id]
        );
      } else if (demande.type === 'mouvement_caisse') {
        await client.query(
          `UPDATE mouvements_caisse SET statut = 'approuvee', approuve_par=$1, approuve_at=NOW() WHERE id=$2`,
          [req.user.id, demande.ref_id]
        );
      } else if (demande.type === 'encaissement') {
        await client.query(
          `UPDATE encaissements SET statut = 'approuvee', approuve_par=$1, approuve_at=NOW() WHERE id=$2`,
          [req.user.id, demande.ref_id]
        );
      }
    } else {
      if (demande.type === 'annulation_reste') {
        await client.query(`UPDATE clients_vente SET reste_annule_statut = 'refusee' WHERE id = $1`, [demande.ref_id]);
      } else if (demande.type === 'mouvement_caisse') {
        await client.query(`UPDATE mouvements_caisse SET statut = 'refusee' WHERE id = $1`, [demande.ref_id]);
      } else if (demande.type === 'encaissement') {
        await client.query(`UPDATE encaissements SET statut = 'refusee' WHERE id = $1`, [demande.ref_id]);
      }
    }

    await client.query('COMMIT');
    const updated = await db.query('SELECT * FROM demandes WHERE id = $1', [id]);
    res.json({ message: `Demande ${statut}.`, demande: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('traiterDemande:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  } finally { client.release(); }
};

const demanderModification = async (req, res) => {
  const { journee_id, motif } = req.body;
  if (!journee_id || !motif) return res.status(400).json({ message: 'journee_id et motif requis.' });

  try {
    const j = await db.query(
      'SELECT * FROM ventes_journees WHERE id = $1 AND employe_id = $2', [journee_id, req.user.id]
    );
    if (!j.rows.length) return res.status(404).json({ message: 'Journée non trouvée.' });

    const existante = await db.query(
      `SELECT id FROM demandes WHERE ref_id = $1 AND type = 'modification_journee' AND statut = 'en_attente'`,
      [journee_id]
    );
    if (existante.rows.length)
      return res.status(409).json({ message: 'Une demande est déjà en cours.' });

    const r = await db.query(
      `INSERT INTO demandes (employe_id, type, ref_id, ref_table, date_cible, motif, meta)
       VALUES ($1, 'modification_journee', $2, 'ventes_journees', $3, $4, $5) RETURNING *`,
      [req.user.id, journee_id, j.rows[0].date_vente, motif,
       JSON.stringify({ journee_id, date: j.rows[0].date_vente })]
    );
    res.status(201).json({ message: "Demande envoyée.", demande: r.rows[0] });
  } catch (err) {
    console.error('demanderModification:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── REVENUS (admin) ─────────────────────────────────────────
const revenusVentes = async (req, res) => {
  const { mois, annee, type_stock } = req.query;
  const moisFiltre = mois || new Date().toISOString().slice(0, 7);
  const anneeFiltre = annee || new Date().getFullYear();

  try {
    const revenuMois = await db.query(`
      SELECT COALESCE(SUM(cv.montant_recu), 0) AS total
      FROM ventes_journees vj LEFT JOIN clients_vente cv ON cv.journee_id = vj.id
      WHERE TO_CHAR(vj.date_vente, 'YYYY-MM') = $1`, [moisFiltre]
    );

    const revenuAnnee = await db.query(`
      SELECT COALESCE(SUM(cv.montant_recu), 0) AS total
      FROM ventes_journees vj LEFT JOIN clients_vente cv ON cv.journee_id = vj.id
      WHERE EXTRACT(YEAR FROM vj.date_vente) = $1`, [anneeFiltre]
    );

    let revenuStock = 0;
    if (type_stock) {
      const r = await db.query(
        `SELECT COALESCE(SUM(montant_recu), 0) AS total FROM clients_vente WHERE type_stock = $1`,
        [type_stock]
      );
      revenuStock = parseFloat(r.rows[0].total);
    }

    res.json({
      mois: parseFloat(revenuMois.rows[0].total),
      annee: parseFloat(revenuAnnee.rows[0].total),
      stock: revenuStock,
    });
  } catch (err) {
    console.error('revenusVentes:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── VENTES JOURNALIER (admin) ───────────────────────────────
const ventesJournalier = async (req, res) => {
  const moisFiltre = req.query.mois || new Date().toISOString().slice(0, 7);
  try {
    const r = await db.query(`
      SELECT vj.date_vente::TEXT AS date,
             COUNT(cv.id) AS nb_clients,
             COALESCE(SUM(cv.kg_achetes), 0) AS kg_total,
             COALESCE(SUM(cv.montant_recu), 0) AS montant_encaisse
      FROM ventes_journees vj
      LEFT JOIN clients_vente cv ON cv.journee_id = vj.id
      WHERE TO_CHAR(vj.date_vente, 'YYYY-MM') = $1
      GROUP BY vj.date_vente ORDER BY vj.date_vente DESC`, [moisFiltre]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('ventesJournalier:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

module.exports = {
  getOuCreerJournee, ajouterClient, modifierClient, supprimerClient,
  demanderAnnulationReste, creerMouvementCaisse, creerEncaissement,
  graphiqueEmploye, dashboard, listerDemandes, traiterDemande, demanderModification,
  revenusVentes, ventesJournalier,
};
