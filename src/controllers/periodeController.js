const db = require('../config/db');

const today = () => new Date().toISOString().split('T')[0];

const normalizeDate = (value) => {
  if (!value) return null;
  const d = new Date(`${value}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : value;
};

const getConfig = async () => {
  const r = await db.query(`
    SELECT c.periode_active, c.periode_id,
           p.date_debut, p.date_fin, p.commentaire, p.created_at
    FROM dashboard_periode_config c
    LEFT JOIN periodes_dashboard p ON p.id = c.periode_id
    WHERE c.id = 1
  `);

  if (!r.rows.length) {
    return { periode_active: false, periode: null };
  }

  const row = r.rows[0];
  return {
    periode_active: row.periode_active,
    periode: row.periode_id ? {
      id: row.periode_id,
      date_debut: row.date_debut,
      date_fin: row.date_fin,
      commentaire: row.commentaire,
      created_at: row.created_at,
    } : null,
  };
};

const listerPeriodes = async (req, res) => {
  try {
    const [periodes, config] = await Promise.all([
      db.query(`
        SELECT p.id, p.date_debut, p.date_fin, p.commentaire, p.created_at,
               p.created_by, u.nom || ' ' || u.prenom AS cree_par
        FROM periodes_dashboard p
        LEFT JOIN users u ON u.id = p.created_by
        ORDER BY p.date_debut DESC, p.id DESC
      `),
      getConfig(),
    ]);
    res.json({ periodes: periodes.rows, ...config });
  } catch (err) {
    console.error('listerPeriodes:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

const creerPeriode = async (req, res) => {
  const { date_debut, date_fin, commentaire } = req.body;
  const debut = normalizeDate(date_debut);
  const fin = normalizeDate(date_fin);

  if (!debut) return res.status(400).json({ message: 'La date de début est obligatoire et invalide.' });
  if (debut > today()) return res.status(400).json({ message: 'La date de début ne peut pas être dans le futur.' });
  if (date_fin && !fin) return res.status(400).json({ message: 'La date de fin est invalide.' });
  if (fin && fin < debut) return res.status(400).json({ message: 'La date de fin doit être supérieure ou égale à la date de début.' });
  if (fin && fin > today()) return res.status(400).json({ message: 'La date de fin ne peut pas être dans le futur.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Deux périodes ne doivent pas se chevaucher : cela rend le calcul du stock
    // et les historiques non ambigus.
    const overlap = await client.query(`
      SELECT id FROM periodes_dashboard
      WHERE daterange(date_debut, COALESCE(date_fin, 'infinity'::date), '[]')
            && daterange($1::date, COALESCE($2::date, 'infinity'::date), '[]')
      LIMIT 1
    `, [debut, fin]);
    if (overlap.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Cette période chevauche déjà une période existante.' });
    }

    const inserted = await client.query(`
      INSERT INTO periodes_dashboard (date_debut, date_fin, commentaire, created_by)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [debut, fin || null, commentaire?.trim() || null, req.user.id]);

    const periode = inserted.rows[0];

    // Une nouvelle période devient immédiatement la période affichée au dashboard.
    await client.query(`
      UPDATE dashboard_periode_config
      SET periode_active = TRUE, periode_id = $1, updated_at = NOW()
      WHERE id = 1
    `, [periode.id]);

    await client.query('COMMIT');
    res.status(201).json({ message: 'Période créée et activée.', periode, periode_active: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('creerPeriode:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

const activerDesactiverPeriode = async (req, res) => {
  try {
    const config = await getConfig();
    if (!config.periode) return res.status(400).json({ message: 'Aucune période n’a encore été créée.' });

    const active = req.body?.active;
    const next = typeof active === 'boolean' ? active : !config.periode_active;
    await db.query(`UPDATE dashboard_periode_config SET periode_active = $1, updated_at = NOW() WHERE id = 1`, [next]);

    res.json({ message: next ? 'Mode période activé.' : 'Mode période désactivé.', periode_active: next, periode: config.periode });
  } catch (err) {
    console.error('activerDesactiverPeriode:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

const selectionnerPeriode = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Identifiant de période invalide.' });

  try {
    const p = await db.query('SELECT * FROM periodes_dashboard WHERE id = $1', [id]);
    if (!p.rows.length) return res.status(404).json({ message: 'Période introuvable.' });

    await db.query(`
      UPDATE dashboard_periode_config
      SET periode_id = $1, periode_active = TRUE, updated_at = NOW()
      WHERE id = 1
    `, [id]);

    res.json({ message: 'Période sélectionnée.', periode_active: true, periode: p.rows[0] });
  } catch (err) {
    console.error('selectionnerPeriode:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

module.exports = { getConfig, listerPeriodes, creerPeriode, activerDesactiverPeriode, selectionnerPeriode };
