const webpush = require("web-push");
const { getPool, initDB } = require("../../../lib/db");
const { getOrCreateVapidKeys } = require("../../../lib/vapid");

// Validates the CRON_SECRET to prevent unauthorised calls
module.exports = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  await initDB();

  const pool = getPool();
  const keys = await getOrCreateVapidKeys(pool);
  webpush.setVapidDetails(
    "mailto:perryjangid@gmail.com",
    keys.publicKey,
    keys.privateKey
  );

  // ── Date helpers ────────────────────────────────────────────────────────
  const PACKAGE_INTERVAL_MONTHS = {
    monthly: 1,
    quarterly: 3,
    halfyearly: 6,
    yearly: 12,
  };

  function parseISODate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function toISODate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
  }
  function addMonthsClamped(date, months) {
    const day = date.getDate();
    const d = new Date(date.getFullYear(), date.getMonth(), 1);
    d.setMonth(d.getMonth() + months);
    d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
    return d;
  }
  function sameDate(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }
  function nextReminderDate(record, from) {
    const install = parseISODate(record.installDate);
    const interval = PACKAGE_INTERVAL_MONTHS[record.package] || 1;
    let candidate = addMonthsClamped(install, interval);
    let guard = 0;
    while (candidate < from && guard < 1200) {
      candidate = addMonthsClamped(candidate, interval);
      guard++;
    }
    return candidate;
  }
  // ────────────────────────────────────────────────────────────────────────

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = toISODate(today);

  // Load machines, subscriptions, and serviced log in parallel
  // notifyLog is intentionally NOT checked — the cron cadence (every 30 min)
  // is the rate limiter. Notifications keep firing until the machine is serviced.
  const [machinesResult, subsResult, servicedResult] = await Promise.all([
    pool.query("SELECT data FROM machines"),
    pool.query("SELECT data FROM subscriptions"),
    pool.query("SELECT machine_id, serviced_date FROM serviced_log"),
  ]);

  const records = machinesResult.rows.map((r) => r.data);
  const subscriptions = subsResult.rows.map((r) => r.data);

  const servicedLog = {};
  for (const row of servicedResult.rows) {
    servicedLog[row.machine_id] = row.serviced_date;
  }

  if (subscriptions.length === 0) {
    res.status(200).json({ message: "No subscriptions, nothing to do." });
    return;
  }

  let notified = 0;
  let skipped = 0;

  for (const r of records) {
    const next = nextReminderDate(r, today);

    // Skip if service isn't due today
    if (!sameDate(next, today)) {
      skipped++;
      continue;
    }

    // Skip if already marked as serviced today — this is the STOP condition
    if (servicedLog[r.id] === todayISO) {
      skipped++;
      continue;
    }

    const payload = JSON.stringify({
      title: "Machine service due today",
      body: `${r.clientName} — ${r.machineCode} (${r.model})\n${r.location}, ${r.city}`,
      tag: `machine-reminder-${r.id}-${todayISO}`,
    });

    const expiredEndpoints = [];

    await Promise.all(
      subscriptions.map((sub) =>
        webpush
          .sendNotification(sub, payload)
          .catch((err) => {
            if (err.statusCode === 410 || err.statusCode === 404) {
              expiredEndpoints.push(sub.endpoint);
            }
          })
      )
    );

    // Clean up expired push subscriptions
    if (expiredEndpoints.length > 0) {
      await Promise.all(
        expiredEndpoints.map((ep) =>
          pool.query("DELETE FROM subscriptions WHERE endpoint = $1", [ep])
        )
      );
    }

    notified++;
  }

  res.status(200).json({
    success: true,
    date: todayISO,
    notified,
    skipped,
  });
};
