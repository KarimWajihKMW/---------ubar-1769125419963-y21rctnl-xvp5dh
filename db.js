const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
const forceSsl = String(process.env.DATABASE_SSL || '').toLowerCase();
const useSsl = forceSsl
    ? ['1', 'true', 'yes'].includes(forceSsl)
    : !isLocal;

const pool = new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false
});

// Test connection
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Database connection error:', err);
    } else {
        console.log('✅ Database connected successfully');
    }
});

module.exports = pool;
