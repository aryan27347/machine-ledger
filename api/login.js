const crypto = require("crypto");
const { getPool, initDB } = require("../../lib/db");

// In-memory session store (resets on cold starts, acceptable for serverless)
// For production-grade persistence, move sessions to DB too.
const sessions = global._sessions || (global._sessions = {});

module.exports = async (req, res) => {
  await initDB();

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ error: "Missing credentials" });
    return;
  }

  const pool = getPool();
  const result = await pool.query(
    "SELECT username FROM users WHERE username = $1 AND password = $2",
    [username, password]
  );

  if (result.rows.length === 0) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const sid = crypto.randomBytes(16).toString("hex");
  sessions[sid] = result.rows[0].username;

  res.setHeader(
    "Set-Cookie",
    `sessionId=${sid}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`
  );
  res.status(200).json({ success: true });
};
