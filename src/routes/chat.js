const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const db = require('../config/db');

router.get('/:date', authenticate, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT mc.*, u.nom || ' ' || u.prenom AS auteur_nom, u.role AS auteur_role, u.photo_url AS auteur_photo
       FROM messages_chat mc JOIN users u ON mc.auteur_id = u.id
       WHERE mc.date_salon = $1 ORDER BY mc.created_at ASC`,
      [req.params.date]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
});

router.post('/:date', authenticate, async (req, res) => {
  const { contenu } = req.body;
  if (!contenu?.trim()) return res.status(400).json({ message: 'Contenu requis.' });
  try {
    const ins = await db.query(
      'INSERT INTO messages_chat (date_salon, auteur_id, contenu) VALUES ($1,$2,$3) RETURNING *',
      [req.params.date, req.user.id, contenu.trim()]
    );
    const msg = await db.query(
      `SELECT mc.*, u.nom || ' ' || u.prenom AS auteur_nom, u.role AS auteur_role, u.photo_url AS auteur_photo
       FROM messages_chat mc JOIN users u ON mc.auteur_id = u.id WHERE mc.id = $1`,
      [ins.rows[0].id]
    );
    res.status(201).json(msg.rows[0]);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
});

module.exports = router;
