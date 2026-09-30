#!/usr/bin/env node
/**
 * scripts/setup-db.js
 *
 * Run this ONCE after connecting your PostgreSQL database to:
 *   1. Create all required tables
 *   2. Insert the default admin user
 *   3. Optionally import existing database.json records
 *
 * Usage:
 *   DATABASE_URL="postgres://..." node scripts/setup-db.js
 *
 * Or set DATABASE_URL in a .env file and use:
 *   node -e "require('dotenv').config()" scripts/setup-db.js
 */

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌  DATABASE_URL environment variable is not set.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

async function main() {
  const client = await pool.connect();
  try {
    console.log("📦  Creating tables...");
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
    console.log("✅  Tables ready.");

    // Insert default admin user if not present
    const adminUsername = process.env.ADMIN_USERNAME || "admin";
    const adminPassword = process.env.ADMIN_PASSWORD || "admin";
    await client.query(
      `INSERT INTO users (username, password) VALUES ($1, $2)
       ON CONFLICT (username) DO NOTHING`,
      [adminUsername, adminPassword]
    );
    console.log(`✅  Admin user '${adminUsername}' ensured.`);

    // Import existing database.json if it exists and has records
    const dbPath = path.join(__dirname, "..", "database.json");
    if (fs.existsSync(dbPath)) {
      let records = [];
      try {
        records = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
      } catch (e) {
        console.warn("⚠️  Could not parse database.json, skipping import.");
      }
      if (Array.isArray(records) && records.length > 0) {
        console.log(`📥  Importing ${records.length} machine records...`);
        for (const record of records) {
          await client.query(
            `INSERT INTO machines (id, data) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
            [record.id, JSON.stringify(record)]
          );
        }
        console.log("✅  Machine records imported.");
      } else {
        console.log("ℹ️  database.json is empty, nothing to import.");
      }
    }

    console.log("\n🎉  Database setup complete! You can now deploy to Vercel.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌  Setup failed:", err.message);
  process.exit(1);
});
