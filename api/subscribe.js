const webpush = require("web-push");
const { getPool, initDB } = require("../../lib/db");
const { getSession } = require("../../lib/auth");
const { getOrCreateVapidKeys } = require("../../lib/vapid");

module.exports = async (req, res) => {
  await initDB();

  if (!getSession(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let subscription = req.body;
  if (typeof subscription === "string") {
    try {
      subscription = JSON.parse(subscription);
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }
  }

  if (!subscription?.endpoint) {
    res.status(400).json({ error: "Missing endpoint" });
    return;
  }

  const pool = getPool();

  // Initialise webpush with current VAPID keys
  const keys = await getOrCreateVapidKeys(pool);
  webpush.setVapidDetails(
    "mailto:perryjangid@gmail.com",
    keys.publicKey,
    keys.privateKey
  );

  await pool.query(
    "INSERT INTO subscriptions (endpoint, data) VALUES ($1, $2) ON CONFLICT (endpoint) DO UPDATE SET data = EXCLUDED.data",
    [subscription.endpoint, JSON.stringify(subscription)]
  );

  res.status(201).json({ success: true });
};
