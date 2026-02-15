const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error('❌ DATABASE_URL is not set.');
}

const sslExplicit = process.env.DATABASE_SSL;
const shouldUseSsl = sslExplicit === '1' || sslExplicit === 'true'
    ? true
    : sslExplicit === '0' || sslExplicit === 'false'
        ? false
        : (() => {
            if (!connectionString) return false;
            // Default: SSL for non-local hosts, no SSL for localhost
            return !/localhost|127\.0\.0\.1/i.test(connectionString);
        })();

const pool = new Pool({
    connectionString,
    ...(shouldUseSsl
        ? {
            ssl: {
                rejectUnauthorized: false
            }
        }
        : {})
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
