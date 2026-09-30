const webpush = require("web-push");
const { getPool, initDB } = require("../../lib/db");
const { getOrCreateVapidKeys } = require("../../lib/vapid");

module.exports = async (req, res) => {
  await initDB();

  if (req.method === "GET") {
    const pool = getPool();
    const keys = await getOrCreateVapidKeys(pool);
    res.status(200).send(keys.publicKey);
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
