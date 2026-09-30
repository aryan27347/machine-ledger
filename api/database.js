const { getPool, initDB } = require("../../lib/db");
const { getSession } = require("../../lib/auth");

module.exports = async (req, res) => {
  await initDB();

  // GET — return all machine records
  if (req.method === "GET") {
    if (!getSession(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const pool = getPool();
    const result = await pool.query(
      "SELECT data FROM machines ORDER BY (data->>'clientName') ASC"
    );
    const records = result.rows.map((r) => r.data);
    res.status(200).json(records);
    return;
  }

  // POST — replace entire machines dataset
  if (req.method === "POST") {
    if (!getSession(req)) {
      res.status(401).json({ error: "Unauthorized" });
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

    if (!Array.isArray(body)) {
      res.status(400).json({ error: "Expected an array of machine records" });
      return;
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM machines");
      for (const record of body) {
        await client.query(
          "INSERT INTO machines (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
          [record.id, JSON.stringify(record)]
        );
      }
      await client.query("COMMIT");
      res.status(200).json({ success: true });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("DB write error:", err);
      res.status(500).json({ error: "Database error" });
    } finally {
      client.release();
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
