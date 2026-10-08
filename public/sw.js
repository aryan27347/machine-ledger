// ─── Lifecycle ────────────────────────────────────────────────────────────────
self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", function () {
  // Don't skipWaiting automatically — let the user choose via the update banner.
});

self.addEventListener("activate", function (event) {
  event.waitUntil(clients.claim());
});

// ─── Push: show notification even when the app tab is closed ──────────────────
self.addEventListener("push", function (event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    console.error("SW: failed to parse push data", e);
  }

  const title = data.title || "Machine Service Reminder";
  const options = {
    body: data.body || "A machine is due for service.",
    icon: "/favicon.png",
    badge: "/favicon.png",
    vibrate: [200, 100, 200, 100, 200],
    requireInteraction: true, // keeps the notification visible until dismissed
    tag: data.tag || "machine-reminder",
    // Store machineId in notification.data so the click handler can read it
    // without fragile tag-string parsing.
    data: { machineId: data.machineId || null },
    actions: [
      { action: "mark_serviced", title: "✅ Mark Serviced" },
      { action: "open_app",      title: "Open App" },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ─── Notification click ───────────────────────────────────────────────────────
self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  if (event.action === "mark_serviced") {
    const machineId = event.notification.data && event.notification.data.machineId;

    if (machineId) {
      event.waitUntil(
        fetch("/sw-markServiced", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: machineId }),
        })
          .then(function () {
            // Dismiss all pending notifications for this machine
            return self.registration.getNotifications().then(function (notes) {
              notes.forEach(function (n) {
                if (
                  n.data &&
                  n.data.machineId === machineId &&
                  n.tag !== event.notification.tag
                ) {
                  n.close();
                }
              });
            });
          })
          .then(function () {
            return self.registration.showNotification("Serviced ✅", {
              body: "Machine marked as serviced. No more reminders today.",
              icon: "/favicon.png",
              badge: "/favicon.png",
              tag: "serviced-confirm-" + machineId,
            });
          })
          .catch(function (err) {
            console.error("SW: failed to mark serviced", err);
          }),
      );
    }
    return;
  }

  // "Open App" action or tapping the notification body → focus or open the app
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (clientList) {
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if ("focus" in client) return client.focus();
        }
        if (clients.openWindow) return clients.openWindow("/");
      }),
  );
});
