self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", function (event) {
  // We no longer skipWaiting automatically so the user can be prompted.
});

self.addEventListener("activate", function (event) {
  event.waitUntil(clients.claim());
});

self.addEventListener("push", function (event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    console.error("Failed to parse push data", e);
  }
  const title = data.title || "Machine Service Reminder";
  const tag = data.tag || "reminder";
  const options = {
    body: data.body || "A machine is due for service.",
    tag: tag,
    icon: "./favicon.png",
    badge: "./favicon.png",
    vibrate: [200, 100, 200],
    requireInteraction: true,
    actions: [
      { action: "mark_serviced", title: "Mark Serviced" },
      { action: "open_app", title: "Open App" },
    ],
    data: { tag: tag },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  if (event.action === "mark_serviced") {
    // Extract machine ID from tag: "machine-reminder-{id}-{date}"
    var tag = event.notification.tag || "";
    var parts = tag.split("-");
    // tag format: machine-reminder-{id}-{date}
    // id can contain hyphens (e.g. m_123456_abc), date is YYYY-MM-DD at the end
    // Remove "machine-reminder-" prefix and last 3 segments (YYYY-MM-DD)
    if (parts.length >= 5) {
      var datePart = parts.slice(-3).join("-"); // YYYY-MM-DD
      var idPart = parts.slice(2, -3).join("-"); // everything between "machine-reminder-" and date

      event.waitUntil(
        fetch("./sw-markServiced", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: idPart }),
        })
          .then(function () {
            return self.registration.showNotification("Service Marked", {
              body: "Machine marked as serviced. No more reminders today.",
              icon: "./favicon.png",
              badge: "./favicon.png",
              tag: "serviced-confirm-" + idPart,
            });
          })
          .catch(function (err) {
            console.error("Failed to mark serviced from notification", err);
          }),
      );
    }
    return;
  }

  // Default click or dismiss: open the app
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (clientList) {
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if ("focus" in client) return client.focus();
        }
        if (clients.openWindow) return clients.openWindow("./");
      }),
  );
});
