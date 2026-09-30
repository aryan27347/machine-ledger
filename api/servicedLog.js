const { getPool, initDB } = require("../../lib/db");
const { getSession } = require("../../lib/auth");

module.exports = async (req, res) => {
  await initDB();

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const pool = getPool();
  const result = await pool.query(
    "SELECT machine_id, serviced_date FROM serviced_log"
  );

  const log = {};
  for (const row of result.rows) {
    log[row.machine_id] = row.serviced_date;
  }

  res.status(200).json(log);
};
