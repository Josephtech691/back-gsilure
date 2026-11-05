const db = require('../config/db');

const lister = async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, type, message, entity_id, lu, created_at
       FROM notifications WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 60`, [req.user.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('notifications lister:', err);
    res.status(500).json({ message: 'Impossible de charger les notifications.' });
  }
};

const marquerLue = async (req, res) => {
  try {
    const r = await db.query(
      'UPDATE notifications SET lu = TRUE WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!r.rowCount) return res.status(404).json({ message: 'Notification introuvable.' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: 'Impossible de modifier la notification.' }); }
};

const effacerToutes = async (req, res) => {
  try { await db.query('DELETE FROM notifications WHERE user_id = $1', [req.user.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ message: 'Impossible de supprimer les notifications.' }); }
};

module.exports = { lister, marquerLue, effacerToutes };
