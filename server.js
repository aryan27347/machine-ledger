const http = require("http");
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");
const crypto = require("crypto");

const PORT = process.env.PORT || 3001;
const REMINDER_TIME = 1000; // time is in milliseconds, 1s = 1000ms;

// Load users
const usersPath = path.join(__dirname, "users.json");
let users = [];
if (fs.existsSync(usersPath)) {
  users = JSON.parse(fs.readFileSync(usersPath, "utf-8"));
}

// Session store
const sessions = {};

// Setup VAPID keys
const vapidKeysPath = path.join(__dirname, "vapidKeys.json");
let vapidKeys;
if (fs.existsSync(vapidKeysPath)) {
  vapidKeys = JSON.parse(fs.readFileSync(vapidKeysPath, "utf-8"));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(vapidKeysPath, JSON.stringify(vapidKeys, null, 2));
}

webpush.setVapidDetails(
  "mailto:perryjangid@gmail.com",
  vapidKeys.publicKey,
  vapidKeys.privateKey,
);

// Storage for subscriptions
const subscriptionsPath = path.join(__dirname, "subscriptions.json");
let subscriptions = [];
if (fs.existsSync(subscriptionsPath)) {
  subscriptions = JSON.parse(fs.readFileSync(subscriptionsPath, "utf-8"));
}

function saveSubscriptions() {
  fs.writeFileSync(subscriptionsPath, JSON.stringify(subscriptions, null, 2));
}

// Storage for notify log (to prevent duplicate reminders)
const notifyLogPath = path.join(__dirname, "notifyLog.json");
let notifyLog = {};
if (fs.existsSync(notifyLogPath)) {
  notifyLog = JSON.parse(fs.readFileSync(notifyLogPath, "utf-8"));
}

function saveNotifyLog() {
  fs.writeFileSync(notifyLogPath, JSON.stringify(notifyLog, null, 2));
}

// Storage for serviced log (machines marked as serviced for a date)
const servicedLogPath = path.join(__dirname, "servicedLog.json");
let servicedLog = {};
if (fs.existsSync(servicedLogPath)) {
  servicedLog = JSON.parse(fs.readFileSync(servicedLogPath, "utf-8"));
}

function saveServicedLog() {
  fs.writeFileSync(servicedLogPath, JSON.stringify(servicedLog, null, 2));
}

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
};

// Date helper logic for reminders (ported from frontend)
const PACKAGE_INTERVAL_MONTHS = {
  monthly: 1,
  quarterly: 1,
  halfyearly: 1,
  yearly: 1, // Matching the user's updated values
};

function parseISODate(iso) {
  var parts = iso.split("-");
  return new Date(
    parseInt(parts[0], 10),
    parseInt(parts[1], 10) - 1,
    parseInt(parts[2], 10),
  );
}
function toISODate(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}
function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}
function addMonthsClamped(date, months) {
  var day = date.getDate();
  var d = new Date(date.getFullYear(), date.getMonth(), 1);
  d.setMonth(d.getMonth() + months);
  var maxDay = daysInMonth(d.getFullYear(), d.getMonth());
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
function nextReminderDate(record, from) {
  var install = parseISODate(record.installDate);
  var interval = PACKAGE_INTERVAL_MONTHS[record.package] || 1;
  var candidate = addMonthsClamped(install, interval);
  var guard = 0;
  while (candidate < from && guard < 1200) {
    candidate = addMonthsClamped(candidate, interval);
    guard++;
  }
  return candidate;
}
function todayMidnight() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Background Task: Check Reminders
setInterval(() => {
  const dbPath = path.join(__dirname, "database.json");
  if (!fs.existsSync(dbPath)) return;

  let records = [];
  try {
    records = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
  } catch (e) {
    return;
  }

  const today = todayMidnight();
  const todayISO = toISODate(today);

  let fired = 0;

  records.forEach((r) => {
    const next = nextReminderDate(r, today);
    const due = sameDate(next, today);
    if (!due) return;

    // Skip if already notified today
    if (notifyLog[r.id] === todayISO) return;

    // Skip if already marked as serviced for today
    if (servicedLog[r.id] === todayISO) return;

    if (subscriptions.length === 0) return;

    // Send push to all subscriptions
    const payload = JSON.stringify({
      title: "Machine service due today",
      body: `${r.clientName} — ${r.machineCode} (${r.model})\n${r.location}, ${r.city}`,
      tag: `machine-reminder-${r.id}-${todayISO}`,
    });

    const activeSubscriptions = [];
    let removals = 0;

    // To ensure notifyLog is only set if we at least TRIED to send to a valid subscription
    let sentCount = 0;

    Promise.all(
      subscriptions.map((sub) => {
        sentCount++;
        return webpush
          .sendNotification(sub, payload)
          .then(() => {
            activeSubscriptions.push(sub);
          })
          .catch((err) => {
            if (err.statusCode === 410 || err.statusCode === 404) {
              removals++; // Subscription expired
            } else {
              activeSubscriptions.push(sub);
            }
          });
      }),
    ).then(() => {
      if (removals > 0) {
        subscriptions = activeSubscriptions;
        saveSubscriptions();
      }
      if (sentCount > 0) {
        notifyLog[r.id] = todayISO;
        saveNotifyLog();
      }
    });
  });
}, REMINDER_TIME); // Check every minute

const server = http.createServer((req, res) => {
  const parseCookies = (cookieHeader) => {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(";").forEach((cookie) => {
      let [name, ...rest] = cookie.split("=");
      name = name?.trim();
      if (!name) return;
      const value = rest.join("=").trim();
      if (!value) return;
      list[name] = decodeURIComponent(value);
    });
    return list;
  };

  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies.sessionId;
  const isAuthenticated = sessionId && sessions[sessionId];

  const protectedRoutes = [
    "/subscribe",
    "/markServiced",
    "/unmarkServiced",
    "/database.json",
  ];

  // Service-worker-initiated mark serviced (no session cookie available in SW context)
  if (req.method === "POST" && req.url === "/sw-markServiced") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const { id } = JSON.parse(body);
        if (!id) throw new Error("Missing id");
        // Validate id exists in database before accepting
        const dbPath = path.join(__dirname, "database.json");
        let records = [];
        if (fs.existsSync(dbPath)) {
          try {
            records = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
          } catch (e) {}
        }
        const exists = records.some((r) => r.id === id);
        if (!exists) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Machine not found" }));
          return;
        }
        const todayISO = toISODate(todayMidnight());
        servicedLog[id] = todayISO;
        saveServicedLog();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ success: true, id, date: todayISO }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request" }));
      }
    });
    return;
  }
  const isProtectedRoute = protectedRoutes.some((route) =>
    req.url.startsWith(route),
  );

  if (req.method === "POST" && req.url === "/api/login") {
    let body = "";
    req.on("data", (chunk) => (body += chunk.toString()));
    req.on("end", () => {
      try {
        const { username, password } = JSON.parse(body);
        const user = users.find(
          (u) => u.username === username && u.password === password,
        );
        if (user) {
          const sid = crypto.randomBytes(16).toString("hex");
          sessions[sid] = user.username;
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": `sessionId=${sid}; HttpOnly; Path=/; Max-Age=86400`,
          });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid credentials" }));
        }
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request" }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/logout") {
    if (sessionId) {
      delete sessions[sessionId];
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `sessionId=; HttpOnly; Path=/; Max-Age=0`,
    });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  const currentReqPath = req.url.split("?")[0];
  if (!isAuthenticated) {
    if (isProtectedRoute) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (currentReqPath === "/" || currentReqPath === "/index.html") {
      res.writeHead(302, { Location: "/login.html" });
      res.end();
      return;
    }
  }

  if (req.method === "GET" && req.url === "/vapidPublicKey") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(vapidKeys.publicKey);
    return;
  }

  if (req.method === "POST" && req.url === "/subscribe") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const subscription = JSON.parse(body);
        const existing = subscriptions.find(
          (s) => s.endpoint === subscription.endpoint,
        );
        if (!existing) {
          subscriptions.push(subscription);
          saveSubscriptions();
        }
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // Return the serviced log so the frontend knows which machines are serviced today
  if (req.method === "GET" && req.url === "/servicedLog") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(servicedLog));
    return;
  }

  // Mark a machine as serviced for today (stops further notifications)
  if (req.method === "POST" && req.url === "/markServiced") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const { id } = JSON.parse(body);
        if (!id) throw new Error("Missing id");
        const todayISO = toISODate(todayMidnight());
        servicedLog[id] = todayISO;
        saveServicedLog();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, id, date: todayISO }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request" }));
      }
    });
    return;
  }

  // Unmark a machine as serviced (resumes notifications)
  if (req.method === "POST" && req.url === "/unmarkServiced") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const { id } = JSON.parse(body);
        if (!id) throw new Error("Missing id");
        delete servicedLog[id];
        delete notifyLog[id];
        saveServicedLog();
        saveNotifyLog();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, id }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request" }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/database.json") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        JSON.parse(body); // Validate JSON
        fs.writeFileSync(path.join(__dirname, "database.json"), body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // Basic static file server
  let reqPath = req.url.split("?")[0]; // Remove query params
  let filePath = path.join(__dirname, reqPath === "/" ? "index.html" : reqPath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  let extname = path.extname(filePath);
  let contentType = MIME_TYPES[extname] || "application/octet-stream";

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404);
        res.end("File not found");
      } else {
        res.writeHead(500);
        res.end("Server error: " + err.code);
      }
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content, "utf-8");
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log(
    `Web push enabled. Reminders checked automatically every minute.`,
  );
});
