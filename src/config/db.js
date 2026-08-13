const { Pool } = require('pg');

let connectionString = process.env.DATABASE_URL || '';

connectionString = connectionString
  .replace('&channel_binding=require', '')
  .replace('?channel_binding=require&', '?')
  .replace('?channel_binding=require', '');

if (!connectionString) {
  console.warn('DATABASE_URL est absente.');
}

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  // Serverless instances can multiply connections; keep the pool small.
  max: Number(process.env.PG_POOL_MAX || 3),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT || 10000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT || 5000),
});

pool.on('error', (err) => {
  console.error('Erreur inattendue sur le pool PostgreSQL:', err.message);
});

const query = (text, params) => pool.query(text, params);
const getClient = () => pool.connect();

module.exports = { query, getClient, pool };
