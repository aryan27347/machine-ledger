const { Pool } = require("pg");

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
    });
  }
  return pool;
}

/**
 * Run the DB setup migrations — creates tables if they don't exist.
 * Safe to call on every cold start.
 */
async function initDB() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        endpoint TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notify_log (
        machine_id TEXT PRIMARY KEY,
        notified_date TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS serviced_log (
        machine_id TEXT PRIMARY KEY,
        serviced_date TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vapid_keys (
        id INTEGER PRIMARY KEY DEFAULT 1,
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        CHECK (id = 1)
      );

      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL
      );
    `);
  } finally {
    client.release();
  }
}

module.exports = { getPool, initDB };
