require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://gsilure.vercel.app',
  'http://localhost:5173',
].filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;

  // Optional: allow Vercel preview deployments for the configured project.
  if (process.env.ALLOW_VERCEL_PREVIEWS === 'true') {
    return /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
  }
  return false;
}

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('Origine non autorisée par CORS.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Vercel/serverless: keep payload limits explicit.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/ventes', require('./routes/ventes'));
app.use('/api/stocks', require('./routes/stocks'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/pertes', require('./routes/pertes'));
app.use('/api/periodes', require('./routes/periodes'));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

app.use((req, res) => {
  res.status(404).json({ message: 'Route non trouvée.' });
});

app.use((err, req, res, next) => {
  console.error(err);

  if (err && err.message && err.message.includes('CORS')) {
    return res.status(403).json({ message: err.message });
  }

  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: 'Fichier trop volumineux.' });
  }

  res.status(err.status || 500).json({
    message: err.message || 'Erreur serveur.',
  });
});

module.exports = app;
