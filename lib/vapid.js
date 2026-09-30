const webpush = require("web-push");
const { getPool, initDB } = require("../../lib/db");

async function getOrCreateVapidKeys(pool) {
  // Prefer env-var VAPID keys (most reliable on Vercel)
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
  }

  // Fall back to DB-persisted keys
  const result = await pool.query(
    "SELECT public_key, private_key FROM vapid_keys WHERE id = 1"
  );
  if (result.rows.length > 0) {
    return {
      publicKey: result.rows[0].public_key,
      privateKey: result.rows[0].private_key,
    };
  }

  // Generate and persist new keys
  const keys = webpush.generateVAPIDKeys();
  await pool.query(
    "INSERT INTO vapid_keys (id, public_key, private_key) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET public_key = EXCLUDED.public_key, private_key = EXCLUDED.private_key",
    [keys.publicKey, keys.privateKey]
  );
  return keys;
}

module.exports = { getOrCreateVapidKeys };
