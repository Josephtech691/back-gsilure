const db = require('../config/db');

const cashBalancesSql = `
  WITH employes AS (
    SELECT id, nom, prenom
    FROM users
    WHERE role='employee' AND actif=TRUE AND rattache_a_id IS NULL
  ), ventes AS (
    SELECT owner.id AS employe_id, COALESCE(SUM(cv.montant_recu),0) AS total
    FROM employes owner
    LEFT JOIN users u ON (u.id=owner.id OR u.rattache_a_id=owner.id)
    LEFT JOIN ventes_journees vj ON vj.employe_id=u.id
    LEFT JOIN clients_vente cv ON cv.journee_id=vj.id
    GROUP BY owner.id
  ), ajouts AS (
    SELECT employe_id, COALESCE(SUM(montant),0) AS total
    FROM mouvements_caisse WHERE statut='approuvee' AND type='ajout' GROUP BY employe_id
  ), retraits AS (
    SELECT employe_id, COALESCE(SUM(montant),0) AS total
    FROM mouvements_caisse WHERE statut='approuvee' AND type='retrait' GROUP BY employe_id
  ), versements AS (
    SELECT employe_id, COALESCE(SUM(montant),0) AS total
    FROM encaissements WHERE statut='approuvee' GROUP BY employe_id
  )
  SELECT e.id AS employe_id, e.nom || ' ' || e.prenom AS employe_nom,
         COALESCE(v.total,0)::numeric AS ventes,
         COALESCE(a.total,0)::numeric AS ajouts,
         COALESCE(r.total,0)::numeric AS retraits,
         COALESCE(x.total,0)::numeric AS versements,
         (COALESCE(v.total,0)+COALESCE(a.total,0)-COALESCE(r.total,0)-COALESCE(x.total,0))::numeric AS solde
  FROM employes e
  LEFT JOIN ventes v ON v.employe_id=e.id
  LEFT JOIN ajouts a ON a.employe_id=e.id
  LEFT JOIN retraits r ON r.employe_id=e.id
  LEFT JOIN versements x ON x.employe_id=e.id
  ORDER BY e.nom, e.prenom
`;

const resumeCaisse = async (req, res) => {
  try {
    const r = await db.query(cashBalancesSql);
    const totals = r.rows.reduce((a, e) => ({
      ventes: a.ventes + Number(e.ventes),
      ajouts: a.ajouts + Number(e.ajouts),
      retraits: a.retraits + Number(e.retraits),
      versements: a.versements + Number(e.versements),
      solde: a.solde + Number(e.solde),
    }), { ventes: 0, ajouts: 0, retraits: 0, versements: 0, solde: 0 });
    res.json({ employes: r.rows, totaux: totals });
  } catch (err) {
    console.error('resumeCaisse:', err);
    res.status(500).json({ message: 'Impossible de charger la caisse.' });
  }
};

const historiqueCaisse = async (req, res) => {
  const { date_debut, date_fin, type, employe_id, limit } = req.query;
  const params = [];
  let where = ' WHERE 1=1';
  if (date_debut) { params.push(date_debut); where += ` AND h.date_operation >= $${params.length}::date`; }
  if (date_fin) { params.push(date_fin); where += ` AND h.date_operation < ($${params.length}::date + INTERVAL '1 day')`; }
  if (type && ['entree','sortie'].includes(type)) { params.push(type); where += ` AND h.sens = $${params.length}`; }
  if (employe_id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(employe_id)) return res.status(400).json({ message: 'Identifiant employé invalide.' });
    params.push(employe_id); where += ` AND h.employe_id = $${params.length}::uuid`;
  }
  const maxRows = Math.min(Math.max(parseInt(limit || '300', 10) || 300, 1), 1000);
  params.push(maxRows);
  try {
    const r = await db.query(`
      SELECT * FROM (
        SELECT vj.date_vente::date AS date_operation, cv.created_at AS horodatage,
               'vente'::text AS categorie, 'entree'::text AS sens,
               cv.montant_recu::numeric AS montant,
               ('Vente client ' || cv.numero_client)::text AS commentaire,
               owner.id AS employe_id, owner.nom || ' ' || owner.prenom AS employe_nom,
               cv.id::text AS reference, NULL::uuid AS operation_id
        FROM clients_vente cv
        JOIN ventes_journees vj ON vj.id=cv.journee_id
        JOIN users vendeur ON vendeur.id=vj.employe_id
        JOIN users owner ON owner.id=COALESCE(vendeur.rattache_a_id,vendeur.id)
        WHERE owner.role='employee'
        UNION ALL
        SELECT mc.date_mouvement::date AS date_operation, mc.created_at AS horodatage,
               CASE WHEN mc.type='ajout' THEN 'Ajout caisse' ELSE 'Retrait caisse' END,
               CASE WHEN mc.type='ajout' THEN 'entree' ELSE 'sortie' END,
               mc.montant::numeric, mc.commentaire,
               u.id, u.nom || ' ' || u.prenom, mc.id::text, NULL::uuid
        FROM mouvements_caisse mc JOIN users u ON u.id=mc.employe_id
        WHERE mc.statut='approuvee'
        UNION ALL
        SELECT e.date_encaissement::date AS date_operation, e.created_at AS horodatage, 'Versement à la direction',
               'sortie', e.montant::numeric, COALESCE(e.commentaire,'Versement'),
               u.id, u.nom || ' ' || u.prenom, e.id::text, NULL::uuid
        FROM encaissements e JOIN users u ON u.id=e.employe_id
        WHERE e.statut='approuvee'
      ) h ${where}
      ORDER BY h.date_operation DESC, h.horodatage DESC NULLS LAST
      LIMIT $${params.length}
    `, params);
    res.json(r.rows);
  } catch (err) {
    console.error('historiqueCaisse:', err);
    res.status(500).json({ message: 'Impossible de charger l’historique de caisse.' });
  }
};

const retirerCaisseAdmin = async (req, res) => {
  const { portee, employe_id, montant, commentaire, date_operation } = req.body;
  const total = Math.round(Number(montant) * 100) / 100;
  if (!['employe','globale'].includes(portee))
    return res.status(400).json({ message: 'Choisissez une caisse individuelle ou globale.' });
  if (!Number.isFinite(total) || total <= 0)
    return res.status(400).json({ message: 'Le montant doit être supérieur à zéro.' });
  if (!commentaire || !String(commentaire).trim())
    return res.status(400).json({ message: 'Le motif du retrait est obligatoire.' });
  const date = date_operation || new Date().toISOString().slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ message: 'Date de retrait invalide.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Sérialise les retraits concurrents en verrouillant les comptes de caisse concernés.
    const locked = await client.query(`
      SELECT id, nom, prenom FROM users
      WHERE role='employee' AND actif=TRUE AND rattache_a_id IS NULL
      ${portee === 'employe' ? 'AND id=$1::uuid' : ''}
      ORDER BY id FOR UPDATE
    `, portee === 'employe' ? [employe_id] : []);
    if (!locked.rows.length) throw new Error(portee === 'employe' ? 'Employé introuvable.' : 'Aucun employé actif ne possède une caisse.');

    const balances = await client.query(`
      SELECT u.id,
        (COALESCE((SELECT SUM(cv.montant_recu)
          FROM users child
          JOIN ventes_journees vj ON vj.employe_id=child.id
          JOIN clients_vente cv ON cv.journee_id=vj.id
          WHERE child.id=u.id OR child.rattache_a_id=u.id),0)
         + COALESCE((SELECT SUM(m.montant) FROM mouvements_caisse m WHERE m.employe_id=u.id AND m.statut='approuvee' AND m.type='ajout'),0)
         - COALESCE((SELECT SUM(m.montant) FROM mouvements_caisse m WHERE m.employe_id=u.id AND m.statut='approuvee' AND m.type='retrait'),0)
         - COALESCE((SELECT SUM(e.montant) FROM encaissements e WHERE e.employe_id=u.id AND e.statut='approuvee'),0)
        )::numeric AS solde
      FROM users u
      WHERE u.id = ANY($1::uuid[])
      ORDER BY u.id
    `, [locked.rows.map(x => x.id)]);
    const soldeMap = new Map(balances.rows.map(x => [x.id, Number(x.solde)]));
    let allocations;
    if (portee === 'employe') {
      if (!employe_id) throw new Error('Sélectionnez un employé.');
      if (Number(soldeMap.get(employe_id) || 0) + 0.00001 < total)
        throw new Error(`Solde insuffisant. Solde disponible : ${Math.max(0, Number(soldeMap.get(employe_id)||0)).toLocaleString('fr-FR')} FCFA.`);
      allocations = [{ employe_id, montant: total }];
    } else {
      // Partage strictement égal en centimes; les centimes restants sont attribués
      // dans l'ordre stable des comptes. Chaque compte doit pouvoir supporter sa part.
      const cents = Math.round(total * 100);
      const base = Math.floor(cents / locked.rows.length);
      const extra = cents % locked.rows.length;
      allocations = locked.rows.map((e, i) => ({
        employe_id: e.id,
        montant: (base + (i < extra ? 1 : 0)) / 100,
      })).filter(x => x.montant > 0);
      const insuffisant = allocations.find(a => (soldeMap.get(a.employe_id) || 0) + 0.00001 < a.montant);
      if (insuffisant) {
        const nom = locked.rows.find(e => e.id === insuffisant.employe_id);
        throw new Error(`Retrait global impossible : la part égale de ${insuffisant.montant.toLocaleString('fr-FR')} FCFA dépasse la caisse disponible de ${nom?.prenom || 'un employé'}.`);
      }
    }

    const op = await client.query(`
      INSERT INTO admin_caisse_operations (portee, montant_total, commentaire, date_operation, created_by)
      VALUES ($1,$2,$3,$4,$5) RETURNING id
    `, [portee, total, String(commentaire).trim(), date, req.user.id]);
    for (const a of allocations) {
      await client.query(`
        INSERT INTO mouvements_caisse
          (employe_id, type, montant, commentaire, statut, approuve_par, approuve_at, mois, date_mouvement, operation_admin_id)
        VALUES ($1,'retrait',$2,$3,'approuvee',$4,NOW(),$5,$6,$7)
      `, [a.employe_id, a.montant, `Retrait administrateur (${portee === 'globale' ? 'caisse globale' : 'caisse individuelle'}) : ${String(commentaire).trim()}`,
          req.user.id, date.slice(0,7), date, op.rows[0].id]);
    }
    await client.query('COMMIT');
    res.status(201).json({ message: 'Retrait de caisse enregistré.', operation_id: op.rows[0].id, montant_total: total, nombre_employes: allocations.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('retirerCaisseAdmin:', err);
    res.status(400).json({ message: err.message || 'Impossible d’effectuer le retrait.' });
  } finally {
    client.release();
  }
};

module.exports = { resumeCaisse, historiqueCaisse, retirerCaisseAdmin };
