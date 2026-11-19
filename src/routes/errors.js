const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { logError } = require('../services/errorLogger');

// Limite simple en mémoire (par IP) : 40 signalements / minute
const compteur = new Map();
function limite(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  const now = Date.now();
  const e = compteur.get(ip) || { debut: now, n: 0 };
  if (now - e.debut > 60000) { e.debut = now; e.n = 0; }
  e.n += 1; compteur.set(ip, e);
  if (compteur.size > 500) compteur.clear();
  if (e.n > 40) return res.status(429).json({ message: 'Trop de signalements.' });
  next();
}

/** POST /api/errors/report — erreurs détectées par l'application (navigateur). Auth facultative. */
router.post('/report', limite, async (req, res) => {
  const b = req.body || {};
  if (!b.message) return res.status(400).json({ message: 'message requis.' });
  let user = null;
  try {
    const t = (req.headers.authorization || '').split(' ')[1];
    if (t) user = jwt.verify(t, process.env.JWT_SECRET);
  } catch { /* anonyme */ }
  const source = ['frontend', 'api', 'offline'].includes(b.source) ? b.source : 'frontend';
  await logError({
    source,
    niveau: b.niveau === 'warning' ? 'warning' : 'error',
    message: b.message, stack: b.stack, route: b.route, methode: b.methode,
    statut: Number.isInteger(b.statut) ? b.statut : null,
    user, userAgent: req.headers['user-agent'], contexte: b.contexte,
  });
  res.status(204).end();
});

module.exports = router;
