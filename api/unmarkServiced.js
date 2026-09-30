const { getPool, initDB } = require("../../lib/db");
const { getSession } = require("../../lib/auth");

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

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }
  }

  const { id } = body || {};
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }

  const pool = getPool();
  await pool.query("DELETE FROM serviced_log WHERE machine_id = $1", [id]);
  await pool.query("DELETE FROM notify_log WHERE machine_id = $1", [id]);

  res.status(200).json({ success: true, id });
};
