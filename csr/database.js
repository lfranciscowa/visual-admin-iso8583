const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');



const { Pool } = require('pg');
require('dotenv').config();

// 1. Configuración centralizada del Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 2. Verificación de conexión (Log)
pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ Error de conexión a Neon:', err.stack);
  }
  console.log('✅ Conexión exitosa a la base de datos Neon (Postgres)');
  release();
});

// 3. Exportación unificada
module.exports = {
  query: (text, params) => pool.query(text, params),
  get: async (sql, params) => {
    const res = await pool.query(sql, params);
    return res.rows[0];
  },
  all: async (sql, params) => {
    const res = await pool.query(sql, params);
    return res.rows;
  },
  run: async (sql, params) => {
    return await pool.query(sql, params);
  }
};