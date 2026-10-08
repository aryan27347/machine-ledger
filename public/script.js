(function () {
  "use strict";

  var STORAGE_KEY = "machineLedger.records.v1";
  var NOTIFY_LOG_KEY = "machineLedger.notifyLog.v1";
  var SNO_KEY = "machineLedger.snoCounter.v1";

  var PACKAGE_LABEL = {
    monthly: "Monthly",
    quarterly: "Quarterly",
    halfyearly: "Half yearly",
    yearly: "Yearly",
  };
  var PACKAGE_INTERVAL_MONTHS = {
    monthly: 1,
    quarterly: 1,
    halfyearly: 1,
    yearly: 1,
  };

  var records = [];
  var editingId = null;
  var servicedLog = {}; // { machineId: "YYYY-MM-DD" }

  // ---------- storage helpers ----------
  async function loadRecords() {
    try {
      var response = await fetch("database.json");
      if (response.ok) {
        return await response.json();
      }
      return [];
    } catch (e) {
      console.error("Failed to load records", e);
      return [];
    }
  }
  async function saveRecords() {
    try {
      await fetch("database.json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(records),
      });
    } catch (e) {
      console.error("Failed to save records", e);
    }
  }

  async function loadServicedLog() {
    try {
      var response = await fetch("servicedLog");
      if (response.ok) {
        return await response.json();
      }
      return {};
    } catch (e) {
      return {};
    }
  }

  async function markAsServiced(id) {
    try {
      var response = await fetch("markServiced", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id }),
      });
      if (response.ok) {
        var todayISO = toISODate(todayMidnight());
        servicedLog[id] = todayISO;
        render();
      }
    } catch (e) {
      console.error("Failed to mark as serviced", e);
    }
  }

  async function unmarkAsServiced(id) {
    try {
      var response = await fetch("unmarkServiced", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id }),
      });
      if (response.ok) {
        delete servicedLog[id];
        render();
      }
    } catch (e) {
      console.error("Failed to unmark as serviced", e);
    }
  }

  function nextSno() {
    var n = 0;
    records.forEach(function (r) {
      if (r.sno > n) n = r.sno;
    });
    return n + 1;
  }

  // ---------- date helpers ----------
  function todayMidnight() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
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
  // originalDay is kept separate so day-of-month never slips when passing
  // through short months (e.g. Jan 30 → Feb 28 → Mar 30, not Mar 28).
  function addMonthsClamped(date, months, originalDay) {
    var day = originalDay !== undefined ? originalDay : date.getDate();
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
    var originalDay = install.getDate(); // preserve the install day across all iterations
    var candidate = addMonthsClamped(install, interval, originalDay);
    var guard = 0;
    while (candidate < from && guard < 1200) {
      candidate = addMonthsClamped(candidate, interval, originalDay);
      guard++;
    }
    return candidate;
  }
  function isDueToday(record, today) {
    return sameDate(nextReminderDate(record, today), today);
  }
  function formatDisplayDate(d) {
    var months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    return d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear();
  }

  // ---------- rendering ----------
  var tableBody = document.getElementById("tableBody");
  var emptyState = document.getElementById("emptyState");
  var dueBanner = document.getElementById("dueBanner");
  var todayLabel = document.getElementById("todayLabel");

  function render() {
    var today = todayMidnight();
    todayLabel.textContent = formatDisplayDate(today);

    records.sort(function (a, b) {
      return a.sno - b.sno;
    });

    tableBody.innerHTML = "";
    var dueTodayCount = 0;
    var dueWeekCount = 0;
    var dueTodayNames = [];

    if (records.length === 0) {
      emptyState.style.display = "block";
    } else {
      emptyState.style.display = "none";
    }

    records.forEach(function (r) {
      var next = nextReminderDate(r, today);
      var due = sameDate(next, today);
      var todayISO = toISODate(today);
      var isServiced = servicedLog[r.id] === todayISO;
      var daysUntil = Math.round((next - today) / 86400000);
      if (due && !isServiced) {
        dueTodayCount++;
        dueTodayNames.push(r.clientName + " (" + r.machineCode + ")");
      }
      if (daysUntil >= 0 && daysUntil <= 7) dueWeekCount++;

      var tr = document.createElement("tr");
      if (due && !isServiced) tr.className = "due-row";
      if (due && isServiced) tr.className = "serviced-row";

      var pkgClass = "pkg-" + r.package.replace("halfyearly", "halfyearly");
      var installedDisplay = formatDisplayDate(parseISODate(r.installDate));
      var nextDisplay = due
        ? isServiced
          ? "Serviced"
          : "Today"
        : formatDisplayDate(next);

      // Build the service action button for due-today rows
      var serviceBtn = "";
      if (due && !isServiced) {
        serviceBtn =
          '<button type="button" class="icon-btn serviced-btn" data-action="markServiced" data-id="' +
          r.id +
          '">Mark Serviced</button>';
      } else if (due && isServiced) {
        serviceBtn =
          '<button type="button" class="icon-btn unserviced-btn" data-action="unmarkServiced" data-id="' +
          r.id +
          '">Mark Unserviced</button>';
      }

      tr.innerHTML =
        '<td class="sno">' +
        r.sno +
        "</td>" +
        '<td class="mono">' +
        escapeHtml(r.machineCode) +
        "</td>" +
        "<td>" +
        escapeHtml(r.model) +
        "</td>" +
        "<td>" +
        escapeHtml(r.clientName) +
        "</td>" +
        "<td>" +
        escapeHtml(r.location) +
        "</td>" +
        "<td>" +
        escapeHtml(r.city) +
        "</td>" +
        '<td class="mono">' +
        installedDisplay +
        "</td>" +
        '<td><span class="pkg-badge ' +
        pkgClass +
        '">' +
        PACKAGE_LABEL[r.package] +
        "</span></td>" +
        '<td class="next-service' +
        (due && !isServiced ? " today" : "") +
        (due && isServiced ? " serviced" : "") +
        '">' +
        nextDisplay +
        "</td>" +
        '<td><div class="row-actions">' +
        serviceBtn +
        '<button type="button" class="icon-btn ghost" data-action="edit" data-id="' +
        r.id +
        '">Edit</button>' +
        '<button type="button" class="icon-btn danger-outline" data-action="delete" data-id="' +
        r.id +
        '">Delete</button>' +
        "</div></td>";
      tableBody.appendChild(tr);
    });

    document.getElementById("statTotal").textContent = records.length;
    document.getElementById("statDueToday").textContent = dueTodayCount;
    document.getElementById("statDueWeek").textContent = dueWeekCount;
    document.getElementById("ledDueToday").className =
      "led" + (dueTodayCount > 0 ? " due" : "");

    if (dueTodayCount > 0) {
      dueBanner.className = "due-banner show";
      dueBanner.innerHTML =
        "<strong>" +
        dueTodayCount +
        " machine" +
        (dueTodayCount > 1 ? "s" : "") +
        " due for service today:</strong> " +
        dueTodayNames.map(escapeHtml).join(", ");
    } else {
      dueBanner.className = "due-banner";
      dueBanner.innerHTML = "";
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  // ---------- form handling ----------
  var formPanel = document.getElementById("formPanel");
  var formTitle = document.getElementById("formTitle");
  var recordForm = document.getElementById("recordForm");

  function openFormForAdd() {
    editingId = null;
    formTitle.textContent = "Add machine";
    recordForm.reset();
    document.getElementById("recordId").value = "";
    document.getElementById("btnSaveRecord").textContent = "Save machine";
    formPanel.className = "panel show";
    document.getElementById("machineCode").focus();
  }
  function openFormForEdit(record) {
    editingId = record.id;
    formTitle.textContent = "Edit machine";
    document.getElementById("recordId").value = record.id;
    document.getElementById("machineCode").value = record.machineCode;
    document.getElementById("model").value = record.model;
    document.getElementById("clientName").value = record.clientName;
    document.getElementById("location").value = record.location;
    document.getElementById("city").value = record.city;
    document.getElementById("installDate").value = record.installDate;
    document.getElementById("package").value = record.package;
    document.getElementById("btnSaveRecord").textContent = "Update machine";
    formPanel.className = "panel show";
    document.getElementById("machineCode").focus();
  }
  function closeForm() {
    formPanel.className = "panel";
    recordForm.reset();
    editingId = null;
  }

  document
    .getElementById("btnAddNew")
    .addEventListener("click", openFormForAdd);
  document.getElementById("btnCancelForm").addEventListener("click", closeForm);
  document
    .getElementById("btnRefreshApp")
    .addEventListener("click", function () {
      window.location.reload();
    });

  var btnLogout = document.getElementById("btnLogout");
  if (btnLogout) {
    btnLogout.addEventListener("click", async function () {
      try {
        var res = await fetch("/api/logout", { method: "POST" });
        if (res.ok) {
          window.location.href = "/login.html";
        }
      } catch (err) {
        console.error("Logout failed", err);
      }
    });
  }

  recordForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var data = {
      machineCode: document.getElementById("machineCode").value.trim(),
      model: document.getElementById("model").value.trim(),
      clientName: document.getElementById("clientName").value.trim(),
      location: document.getElementById("location").value.trim(),
      city: document.getElementById("city").value.trim(),
      installDate: document.getElementById("installDate").value,
      package: document.getElementById("package").value,
    };

    if (editingId) {
      var idx = records.findIndex(function (r) {
        return r.id === editingId;
      });
      if (idx > -1) {
        records[idx] = Object.assign({}, records[idx], data);
      }
    } else {
      data.id =
        "m_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      data.sno = nextSno();
      records.push(data);
    }
    saveRecords();
    render();
    closeForm();
  });

  tableBody.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-action]");
    if (!btn) return;
    var id = btn.getAttribute("data-id");
    var action = btn.getAttribute("data-action");
    var record = records.find(function (r) {
      return r.id === id;
    });
    if (!record) return;

    if (action === "edit") {
      openFormForEdit(record);
      window.scrollTo({ top: formPanel.offsetTop - 20, behavior: "smooth" });
    } else if (action === "delete") {
      if (
        confirm(
          "Delete " +
            record.machineCode +
            " (" +
            record.clientName +
            ")? This cannot be undone.",
        )
      ) {
        records = records.filter(function (r) {
          return r.id !== id;
        });
        saveRecords();
        render();
      }
    } else if (action === "markServiced") {
      markAsServiced(id);
    } else if (action === "unmarkServiced") {
      unmarkAsServiced(id);
    }
  });

  // ---------- export / import ----------
  // document.getElementById("btnExport").addEventListener("click", function () {
  //   var blob = new Blob([JSON.stringify(records, null, 2)], {
  //     type: "application/json",
  //   });
  //   var url = URL.createObjectURL(blob);
  //   var a = document.createElement("a");
  //   a.href = url;
  //   a.download = "machine-service-ledger-" + toISODate(new Date()) + ".json";
  //   document.body.appendChild(a);
  //   a.click();
  //   document.body.removeChild(a);
  //   URL.revokeObjectURL(url);
  // });

  // var fileImport = document.getElementById("fileImport");
  // document.getElementById("btnImport").addEventListener("click", function () {
  //   fileImport.click();
  // });
  // fileImport.addEventListener("change", function (e) {
  //   var file = e.target.files[0];
  //   if (!file) return;
  //   var reader = new FileReader();
  //   reader.onload = function (evt) {
  //     try {
  //       var imported = JSON.parse(evt.target.result);
  //       if (!Array.isArray(imported))
  //         throw new Error("JSON file must contain an array of records");
  //       var replace = confirm(
  //         "Replace current data with the " +
  //           imported.length +
  //           " record(s) in this file?\n\nChoose Cancel to merge instead of replace.",
  //       );
  //       if (replace) {
  //         records = imported;
  //       } else {
  //         var existingIds = new Set(
  //           records.map(function (r) {
  //             return r.id;
  //           }),
  //         );
  //         imported.forEach(function (r) {
  //           if (!r.id || existingIds.has(r.id)) {
  //             r.id =
  //               "m_" +
  //               Date.now() +
  //               "_" +
  //               Math.random().toString(36).slice(2, 8);
  //           }
  //           if (!r.sno) r.sno = nextSno();
  //           records.push(r);
  //         });
  //       }
  //       saveRecords();
  //       render();
  //       alert("Import complete.");
  //     } catch (err) {
  //       alert("Could not import this file: " + err.message);
  //     }
  //     fileImport.value = "";
  //   };
  //   reader.readAsText(file);
  // });

  // document.getElementById("btnClear").addEventListener("click", function () {
  //   if (records.length === 0) return;
  //   if (
  //     confirm(
  //       "Delete all " +
  //         records.length +
  //         " machine record(s)? This cannot be undone.",
  //     )
  //   ) {
  //     records = [];
  //     saveRecords();
  //     render();
  //   }
  // });

  // ---------- notifications (web push) ----------
  var ledNotif = document.getElementById("ledNotif");
  var notifStateEl = document.getElementById("notifState");
  var btnEnableNotif = document.getElementById("btnEnableNotif");

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding)
      .replace(/\-/g, "+")
      .replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function refreshNotifUI() {
    var supported = "Notification" in window && "serviceWorker" in navigator;
    if (!supported) {
      notifStateEl.textContent = "N/A";
      btnEnableNotif.style.display = "none";
      ledNotif.className = "led";
      return;
    }

    var perm = Notification.permission;
    if (perm === "denied") {
      notifStateEl.textContent = "Blocked";
      ledNotif.className = "led";
      btnEnableNotif.textContent = "Blocked in browser";
      btnEnableNotif.disabled = true;
      return;
    }

    let isSubscribed = false;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) isSubscribed = true;
      }
    } catch (e) {}

    if (isSubscribed) {
      notifStateEl.textContent = "On";
      ledNotif.className = "led on";
      btnEnableNotif.style.display = "none";
    } else {
      notifStateEl.textContent = "Off";
      ledNotif.className = "led";
      btnEnableNotif.style.display = "inline-block";
      btnEnableNotif.textContent = "Enable";
      btnEnableNotif.disabled = false;
    }
  }

  btnEnableNotif.addEventListener("click", async function () {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) return;

    btnEnableNotif.disabled = true;
    btnEnableNotif.textContent = "Enabling...";
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      refreshNotifUI();
      return;
    }

    try {
      // Forcibly clear ALL old service workers and subscriptions 
      // to resolve any deep browser state issues with old VAPID keys
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const r of registrations) {
        const sub = await r.pushManager.getSubscription();
        if (sub) {
          await sub.unsubscribe();
        }
      }

      const reg = await navigator.serviceWorker.register("./sw.js");
      await navigator.serviceWorker.ready;

      const response = await fetch("./vapidPublicKey");
      const vapidPublicKey = (await response.text()).trim();
      const convertedVapidKey = urlBase64ToUint8Array(vapidPublicKey);

      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedVapidKey,
      });

      await fetch("./subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      });
      console.log("Subscribed to web push!");
    } catch (err) {
      console.error("Failed to subscribe", err);
      alert("Failed to subscribe to push: " + err.message);
    }
    refreshNotifUI();
  });

  // document.getElementById("btnCheckNow").addEventListener("click", function () {
  //   alert(
  //     "Reminders are now handled entirely by the server and will push notifications automatically.",
  //   );
  // });

  // ---------- init ----------
  var updateBanner = document.getElementById("updateBanner");
  var btnUpdateApp = document.getElementById("btnUpdateApp");
  var newWorker;

  btnUpdateApp.addEventListener("click", function () {
    if (newWorker) {
      newWorker.postMessage({ type: "SKIP_WAITING" });
    }
  });

  async function init() {
    if ("serviceWorker" in navigator) {
      try {
        const reg = await navigator.serviceWorker.register("./sw.js");

        reg.addEventListener("updatefound", () => {
          newWorker = reg.installing;
          newWorker.addEventListener("statechange", () => {
            // If the state is 'installed' and we already have a controller,
            // it means an older version is controlling the page and a new
            // version is ready to be activated.
            if (
              newWorker.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              updateBanner.className = "update-banner show";
            }
          });
        });
      } catch (err) {
        console.error("Service worker registration failed", err);
      }

      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (!refreshing) {
          window.location.reload();
          refreshing = true;
        }
      });
    }
    records = await loadRecords();
    servicedLog = await loadServicedLog();
    await refreshNotifUI();
    render();
  }
  init();
})();
