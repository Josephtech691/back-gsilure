const db = require('../config/db');

/**
 * GET /api/chat/:date
 * Récupère l'historique du chat pour une date donnée (salon)
 */
const getMessages = async (req, res) => {
  const { date } = req.params;

  try {
    const result = await db.query(
      `SELECT mc.*, u.nom || ' ' || u.prenom AS auteur_nom, u.role AS auteur_role
       FROM messages_chat mc
       JOIN users u ON mc.auteur_id = u.id
       WHERE mc.date_salon = $1
       ORDER BY mc.created_at ASC`,
      [date]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erreur getMessages:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

/**
 * POST /api/chat/:date
 * Enregistre un message (fallback REST si Socket.io indisponible)
 */
const envoyerMessage = async (req, res) => {
  const { date } = req.params;
  const { contenu } = req.body;

  if (!contenu || !contenu.trim()) {
    return res.status(400).json({ message: 'Contenu du message requis.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO messages_chat (date_salon, auteur_id, contenu)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [date, req.user.id, contenu.trim()]
    );

    const msg = await db.query(
      `SELECT mc.*, u.nom || ' ' || u.prenom AS auteur_nom, u.role AS auteur_role
       FROM messages_chat mc
       JOIN users u ON mc.auteur_id = u.id
       WHERE mc.id = $1`,
      [result.rows[0].id]
    );

    res.status(201).json(msg.rows[0]);
  } catch (err) {
    console.error('Erreur envoyerMessage:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

module.exports = { getMessages, envoyerMessage };
