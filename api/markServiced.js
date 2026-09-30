const { getPool, initDB } = require("../../lib/db");
const { getSession } = require("../../lib/auth");

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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

  // Validate id exists in machines table
  const check = await pool.query("SELECT id FROM machines WHERE id = $1", [id]);
  if (check.rows.length === 0) {
    res.status(404).json({ error: "Machine not found" });
    return;
  }

  const todayISO = toISODate(new Date());
  await pool.query(
    "INSERT INTO serviced_log (machine_id, serviced_date) VALUES ($1, $2) ON CONFLICT (machine_id) DO UPDATE SET serviced_date = EXCLUDED.serviced_date",
    [id, todayISO]
  );

  res.status(200).json({ success: true, id, date: todayISO });
};
