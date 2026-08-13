const jwt = require('jsonwebtoken');

/**
 * Middleware : vérifie le token JWT dans l'en-tête Authorization.
 * Injecte req.user = { id, email, role, nom, prenom }
 */
const authenticate = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"

  if (!token) {
    return res.status(401).json({ message: 'Token manquant. Accès refusé.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ message: 'Token invalide ou expiré.' });
  }
};

/**
 * Middleware : restreint l'accès aux admins uniquement.
 * Doit être utilisé APRÈS authenticate.
 */
const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Accès réservé à l\'administrateur.' });
  }
  next();
};

module.exports = { authenticate, adminOnly };
