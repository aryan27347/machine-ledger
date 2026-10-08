require("dotenv").config();

const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const webpush = require("web-push");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;
const PUBLIC_DIR = path.join(__dirname, "public");

// ─── DB Pool ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── DB Init ──────────────────────────────────────────────────────────────────
async function initDB() {
  // Users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id       SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);
  const { rowCount } = await pool.query("SELECT 1 FROM users LIMIT 1");
  if (rowCount === 0) {
    await pool.query(
      "INSERT INTO users (username, password) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      ["admin", "admin"],
    );
  }

  // Session store (connect-pg-simple requires this table)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session (
      sid    VARCHAR NOT NULL COLLATE "default",
      sess   JSON    NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire)`,
  );

  // Machines
  await pool.query(`
    CREATE TABLE IF NOT EXISTS machines (
      id           TEXT PRIMARY KEY,
      sno          INTEGER NOT NULL,
      machine_code TEXT NOT NULL,
      model        TEXT NOT NULL,
      client_name  TEXT NOT NULL,
      location     TEXT NOT NULL,
      city         TEXT NOT NULL,
      install_date TEXT NOT NULL,
      package      TEXT NOT NULL
    )
  `);

  // Push subscriptions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id       SERIAL PRIMARY KEY,
      endpoint TEXT UNIQUE NOT NULL,
      data     JSONB NOT NULL
    )
  `);

  // Serviced log — tracks which machines are marked serviced today
  await pool.query(`
    CREATE TABLE IF NOT EXISTS serviced_log (
      machine_id   TEXT PRIMARY KEY,
      serviced_date TEXT NOT NULL
    )
  `);

  // VAPID keys (stored in DB so they survive deploys)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vapid_keys (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      public_key  TEXT NOT NULL,
      private_key TEXT NOT NULL
    )
  `);

  console.log("DB tables ready.");
}

// ─── VAPID ────────────────────────────────────────────────────────────────────
let vapidPublicKey, vapidPrivateKey;

async function initVapid() {
  const { rows } = await pool.query("SELECT * FROM vapid_keys WHERE id = 1");
  if (rows.length === 0) {
    const keys = webpush.generateVAPIDKeys();
    await pool.query(
      "INSERT INTO vapid_keys (id, public_key, private_key) VALUES (1, $1, $2)",
      [keys.publicKey, keys.privateKey],
    );
    vapidPublicKey = keys.publicKey;
    vapidPrivateKey = keys.privateKey;
  } else {
    vapidPublicKey = rows[0].public_key;
    vapidPrivateKey = rows[0].private_key;
  }
  webpush.setVapidDetails(
    "mailto:perryjangid@gmail.com",
    vapidPublicKey,
    vapidPrivateKey,
  );
  console.log("VAPID keys ready.");
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
// All machines use a fixed 1-month service interval regardless of package label.
const SERVICE_INTERVAL_MONTHS = 1;

function parseISODate(iso) {
  const [y, m, d] = iso.split("-");
  return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
}
function toISODate(d) {
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}
function addMonthsClamped(date, months, originalDay) {
  const day = originalDay !== undefined ? originalDay : date.getDate();
  const d = new Date(date.getFullYear(), date.getMonth(), 1);
  d.setMonth(d.getMonth() + months);
  const maxDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, maxDay));
  return d;
}
function sameDate(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Returns the next service date for a machine.
 * Always uses SERVICE_INTERVAL_MONTHS (1) regardless of package.
 */
function nextServiceDate(installDate, from) {
  const install = parseISODate(installDate);
  const originalDay = install.getDate();
  let candidate = addMonthsClamped(
    install,
    SERVICE_INTERVAL_MONTHS,
    originalDay,
  );
  let guard = 0;
  while (candidate < from && guard < 1200) {
    candidate = addMonthsClamped(
      candidate,
      SERVICE_INTERVAL_MONTHS,
      originalDay,
    );
    guard++;
  }
  return candidate;
}

function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── Background: send push every 30 min for unserviced due machines ───────────
const REMINDER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function checkAndNotify() {
  try {
    const { rows: machines } = await pool.query("SELECT * FROM machines");
    if (machines.length === 0) return;

    const { rows: subs } = await pool.query("SELECT data FROM subscriptions");
    if (subs.length === 0) return;

    const today = todayMidnight();
    const todayISO = toISODate(today);

    // Build serviced-today map
    const { rows: slRows } = await pool.query(
      "SELECT machine_id, serviced_date FROM serviced_log",
    );
    const servicedToday = new Set(
      slRows
        .filter((r) => r.serviced_date === todayISO)
        .map((r) => r.machine_id),
    );

    for (const machine of machines) {
      const next = nextServiceDate(machine.install_date, today);
      if (!sameDate(next, today)) continue; // not due today
      if (servicedToday.has(machine.id)) continue; // already serviced

      // Use a tag that changes every 30-minute window so the browser shows
      // a new notification each interval instead of silently replacing it.
      const intervalBucket = Math.floor(Date.now() / REMINDER_INTERVAL_MS);
      const payload = JSON.stringify({
        title: "Machine service due today",
        body: `${machine.client_name} — ${machine.machine_code} (${machine.model})\n${machine.location}, ${machine.city}`,
        // Unique per machine per 30-min window → always shown as a new alert
        tag: `machine-reminder-${machine.id}-${intervalBucket}`,
        // machineId in data so the service worker can read it without tag-parsing
        machineId: machine.id,
      });

      const expiredEndpoints = [];
      await Promise.all(
        subs.map(({ data }) =>
          webpush.sendNotification(data, payload).catch((err) => {
            if (err.statusCode === 410 || err.statusCode === 404) {
              expiredEndpoints.push(data.endpoint);
            }
          }),
        ),
      );

      for (const ep of expiredEndpoints) {
        await pool.query("DELETE FROM subscriptions WHERE endpoint = $1", [ep]);
      }
    }
  } catch (err) {
    console.error("Reminder check error:", err.message);
  }
}

// ─── Express middleware ───────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function setupSession() {
  app.use(
    session({
      store: new pgSession({
        pool,
        tableName: "session",
        createTableIfMissing: false,
      }),
      secret:
        process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 h
        secure: process.env.NODE_ENV === "production",
      },
    }),
  );
}

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Missing credentials" });
  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE username = $1 AND password = $2",
      [username, password],
    );
    if (rows.length === 0)
      return res.status(401).json({ error: "Invalid credentials" });
    req.session.user = rows[0].username;
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

app.get("/vapidPublicKey", (req, res) => {
  res.type("text/plain").send(vapidPublicKey);
});

app.post("/subscribe", requireAuth, async (req, res) => {
  const subscription = req.body;
  if (!subscription?.endpoint)
    return res.status(400).json({ error: "Invalid subscription" });
  try {
    await pool.query(
      `INSERT INTO subscriptions (endpoint, data) VALUES ($1, $2)
       ON CONFLICT (endpoint) DO NOTHING`,
      [subscription.endpoint, JSON.stringify(subscription)],
    );
    return res.status(201).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Serviced log — public so the frontend can read it on load
app.get("/servicedLog", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT machine_id, serviced_date FROM serviced_log",
    );
    const log = {};
    rows.forEach((r) => (log[r.machine_id] = r.serviced_date));
    return res.json(log);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/markServiced", requireAuth, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Missing id" });
  try {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM machines WHERE id = $1",
      [id],
    );
    if (rowCount === 0)
      return res.status(404).json({ error: "Machine not found" });
    const todayISO = toISODate(todayMidnight());
    await pool.query(
      `INSERT INTO serviced_log (machine_id, serviced_date) VALUES ($1, $2)
       ON CONFLICT (machine_id) DO UPDATE SET serviced_date = EXCLUDED.serviced_date`,
      [id, todayISO],
    );
    return res.json({ success: true, id, date: todayISO });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/unmarkServiced", requireAuth, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Missing id" });
  try {
    await pool.query("DELETE FROM serviced_log WHERE machine_id = $1", [id]);
    return res.json({ success: true, id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Called from service worker (no session cookie available in SW context)
app.post("/sw-markServiced", async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Missing id" });
  try {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM machines WHERE id = $1",
      [id],
    );
    if (rowCount === 0)
      return res.status(404).json({ error: "Machine not found" });
    const todayISO = toISODate(todayMidnight());
    await pool.query(
      `INSERT INTO serviced_log (machine_id, serviced_date) VALUES ($1, $2)
       ON CONFLICT (machine_id) DO UPDATE SET serviced_date = EXCLUDED.serviced_date`,
      [id, todayISO],
    );
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.json({ success: true, id, date: todayISO });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /database.json — all machine records
app.get("/database.json", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM machines ORDER BY sno ASC",
    );
    const records = rows.map((r) => ({
      id: r.id,
      sno: r.sno,
      machineCode: r.machine_code,
      model: r.model,
      clientName: r.client_name,
      location: r.location,
      city: r.city,
      installDate: r.install_date,
      package: r.package,
    }));
    return res.json(records);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /database.json — full sync of machine records
app.post("/database.json", requireAuth, async (req, res) => {
  const records = req.body;
  if (!Array.isArray(records))
    return res.status(400).json({ error: "Expected JSON array" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: existing } = await client.query("SELECT id FROM machines");
    const existingIds = new Set(existing.map((r) => r.id));
    const incomingIds = new Set(records.map((r) => r.id));

    for (const id of existingIds) {
      if (!incomingIds.has(id)) {
        await client.query("DELETE FROM machines WHERE id = $1", [id]);
      }
    }

    for (const r of records) {
      await client.query(
        `INSERT INTO machines
           (id, sno, machine_code, model, client_name, location, city, install_date, package)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           sno          = EXCLUDED.sno,
           machine_code = EXCLUDED.machine_code,
           model        = EXCLUDED.model,
           client_name  = EXCLUDED.client_name,
           location     = EXCLUDED.location,
           city         = EXCLUDED.city,
           install_date = EXCLUDED.install_date,
           package      = EXCLUDED.package`,
        [
          r.id,
          r.sno,
          r.machineCode,
          r.model,
          r.clientName,
          r.location,
          r.city,
          r.installDate,
          r.package,
        ],
      );
    }

    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ─── Static files from public/ ────────────────────────────────────────────────
app.use(express.static(PUBLIC_DIR, { index: false }));

app.get(["/", "/index.html"], (req, res) => {
  if (!req.session?.user) return res.redirect("/login.html");
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((_req, res) => res.status(404).send("Not found"));

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDB();
    await initVapid();
    setupSession();
    // Fire immediately on startup, then every 30 minutes
    checkAndNotify();
    setInterval(checkAndNotify, REMINDER_INTERVAL_MS);
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}/`);
      console.log(
        `Reminders fire every 30 minutes for unserviced due machines.`,
      );
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

start();
