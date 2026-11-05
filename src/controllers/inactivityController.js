const db = require('../config/db');

// Called daily by Vercel Cron. Two reminders maximum, at day 14 and day 28.
const traiterAlertesInactivite = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || supplied !== secret) return res.status(401).json({ message: 'Non autorisé.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const clients = await client.query(`
      SELECT cv.client_nom AS nom, MAX(vj.date_vente)::date AS derniere_visite
      FROM clients_vente cv
      JOIN ventes_journees vj ON vj.id = cv.journee_id
      WHERE COALESCE(NULLIF(TRIM(cv.client_nom), ''), '') <> ''
      GROUP BY cv.client_nom
      HAVING MAX(vj.date_vente) <= CURRENT_DATE - INTERVAL '14 days'
    `);
    let envoyees = 0;
    const admins = await client.query("SELECT id FROM users WHERE role = 'admin' AND COALESCE(actif, TRUE) = TRUE");

    for (const row of clients.rows) {
      const state = await client.query('SELECT * FROM alertes_inactivite_clients WHERE client_nom = $1 FOR UPDATE', [row.nom]);
      let suivi = state.rows[0];
      const lastVisit = String(row.derniere_visite).slice(0, 10);
      if (!suivi) {
        const created = await client.query(
          `INSERT INTO alertes_inactivite_clients (client_nom, derniere_visite, nombre_alertes)
           VALUES ($1, $2, 0) RETURNING *`, [row.nom, lastVisit]
        );
        suivi = created.rows[0];
      } else if (String(suivi.derniere_visite).slice(0, 10) < lastVisit) {
        const reset = await client.query(
          `UPDATE alertes_inactivite_clients SET derniere_visite=$2, nombre_alertes=0, derniere_alerte_at=NULL
           WHERE client_nom=$1 RETURNING *`, [row.nom, lastVisit]
        );
        suivi = reset.rows[0];
      }

      if (suivi.nombre_alertes >= 2) continue;
      const age = await client.query('SELECT (CURRENT_DATE - $1::date)::int AS jours', [lastVisit]);
      const jours = Number(age.rows[0].jours);
      const due = suivi.nombre_alertes === 0 ? jours >= 14 : (jours >= 28 && (!suivi.derniere_alerte_at || Date.now() - new Date(suivi.derniere_alerte_at).getTime() >= 13 * 86400000));
      if (!due) continue;

      const numero = Number(suivi.nombre_alertes) + 1;
      const message = numero === 1
        ? `${row.nom} n'est pas revenu depuis 14 jours (dernière visite : ${lastVisit}). Première alerte.`
        : `${row.nom} n'est pas revenu depuis environ un mois (dernière visite : ${lastVisit}). Deuxième et dernière alerte.`;
      for (const admin of admins.rows) {
        await client.query(
          `INSERT INTO notifications (user_id, type, message, entity_id)
           VALUES ($1, 'client_inactif', $2, $3)`, [admin.id, message, row.nom]
        );
      }
      await client.query(
        `UPDATE alertes_inactivite_clients SET nombre_alertes=$2, derniere_alerte_at=NOW() WHERE client_nom=$1`,
        [row.nom, numero]
      );
      envoyees += admins.rows.length;
    }
    await client.query('COMMIT');
    res.json({ success: true, notifications_creees: envoyees });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('cron inactivite:', err);
    res.status(500).json({ message: 'Erreur lors du traitement des alertes.' });
  } finally { client.release(); }
};
module.exports = { traiterAlertesInactivite };
