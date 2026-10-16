/* ==========================================================================
   PLANER-BOARD LOGIK (planer.js) - System-Version 2.7 (Mit DB-Schutz)
   ========================================================================== */

firebase.initializeApp({
  apiKey: "AIzaSyBPOYRYyUm5gA-j7YSAZl7EJoxedFhDTl4", authDomain: "schichtplan-bayer.firebaseapp.com",
  projectId: "schichtplan-bayer", storageBucket: "schichtplan-bayer.firebasestorage.app",
  messagingSenderId: "152929285194", appId: "1:152929285194:web:00b73aa6058a70aed3a2b3"
});
const db = firebase.firestore();
const boardRef = db.collection("shiftplan").doc("live_board");
const shifts = [{ id: "frueh", name: "Früh" }, { id: "spaet", name: "Spät" }, { id: "nacht", name: "Nacht" }];
const shiftsLabel = { frueh: "Früh", spaet: "Spät", nacht: "Nacht" };
const defaultLines = ["32","33","34","09","22","39","36","37","38","54"].map(function(n) { return { id: "L" + n, name: "Linie " + n, prio: "", tag: "", note: "" }; });

let shiftRotation = { frueh: "team-1", spaet: "team-2", nacht: "team-3", frei: "team-4" };
let lines = defaultLines.slice();
let roles = ["Bediener", "LOP", "TL", "Schichtexperte", "Waschraumoperator"];
let employees = [], sickLeaves = [], leaveRequests = [], extraShifts = [], cachedHistoryData = [];
let teamsConfig = {
  "team-1": { name: "Team 1", color: "#0091df", rotates: true },
  "team-2": { name: "Team 2", color: "#f59e0b", rotates: true },
  "team-3": { name: "Team 3", color: "#10b981", rotates: true },
  "team-4": { name: "Team 4", color: "#f43f5e", rotates: true }
};
let activeTeamFilters = {}, activeRoleFilters = {}, poolSearchQuery = "";
let inboxSearchQuery = "", inboxUnreadFilter = "all", inboxActiveFilter = "all";
let selectedManualSickEmpId = null, selectedLoginPlannerId = null;
let isPlanner = false, plannerLevel = 0, currentPlannerName = "", currentPlannerEmpId = null, pendingPinChangeEmpId = null;
let sortableInstances = [], backupDoneToday = false;

const PLANER_INACTIVITY_MS = 3 * 60 * 60 * 1000;
let planerLastActivityTime = Date.now();
function resetPlanerActivity() {
  planerLastActivityTime = Date.now();
  if (isPlanner) sessionStorage.setItem("planner_last_active", String(planerLastActivityTime));
}
setInterval(function() {
  if (isPlanner && (Date.now() - planerLastActivityTime > PLANER_INACTIVITY_MS)) {
    logoutPlanner();
    alert("🔒 Wegen Inaktivität (3 Stunden) wurdest du automatisch abgemeldet.");
  }
}, 30000);

let lastCheckedDateIso = getTodayIso();
setInterval(function() {
  const curDate = getTodayIso();
  if (curDate !== lastCheckedDateIso) {
    lastCheckedDateIso = curDate;
    const changed = processSickLeavesAutomation();
    if (changed) saveToFirebase();
    updateHeaderDateKw();
    initBoard();
  }
}, 60000);

function getTodayIso() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function formatDateDe(s) { return (s && s.indexOf("-") !== -1) ? s.split("-").reverse().join(".") : (s || ""); }
function fullName(e) { return ((e.firstName || "") + " " + (e.lastName || "")).trim(); }
function extractLineIdFromZone(z) { return (!z || ["pool","absent","extra"].indexOf(z) !== -1 || z.indexOf("_") === -1) ? null : z.split("_").slice(0, -1).join("_"); }
function extractShiftIdFromZone(z) { return (!z || ["pool","absent","extra"].indexOf(z) !== -1 || z.indexOf("_") === -1) ? null : z.split("_").pop(); }
function isTeamRotating(teamKey) { return teamsConfig[teamKey] ? (teamsConfig[teamKey].rotates !== false) : true; }
function isEmpProtectedFromRotation(emp) { return !!(emp.noRotation || !isTeamRotating(emp.team)); }

function parseIsoLocal(iso) {
  if (!iso || iso.indexOf("-") === -1) return 0;
  const p = iso.split("-").map(Number);
  return new Date(p[0], p[1] - 1, p[2], 12, 0, 0).getTime();
}
function canMergeDateRanges(s1, e1, s2, e2) {
  const msDay = 86400000, tS1 = parseIsoLocal(s1), tE1 = parseIsoLocal(e1), tS2 = parseIsoLocal(s2), tE2 = parseIsoLocal(e2);
  return (tS1 && tE1 && tS2 && tE2) ? (tS1 <= tE2 + msDay * 1.1) && (tS2 <= tE1 + msDay * 1.1) : false;
}
function calcSickDays(s, e) {
  const diff = Math.round((parseIsoLocal(e) - parseIsoLocal(s)) / 86400000) + 1;
  return diff > 0 ? diff : 1;
}
function mergeReasonsText(r1, r2) {
  const a = (r1 || "").trim(), b = (r2 || "").trim();
  if (!a || a === "Vom Planer eingetragen") return b || a;
  if (!b || b === "Vom Planer eingetragen") return a;
  if (a.toLowerCase().indexOf(b.toLowerCase()) !== -1) return a;
  if (b.toLowerCase().indexOf(a.toLowerCase()) !== -1) return b;
  return a + " | " + b;
}

function getPredeterminedLineForEmp(emp) {
  if (emp.lastLineId && lines.some(function(l) { return l.id === emp.lastLineId; })) return emp.lastLineId;
  if (emp.mainLines && emp.mainLines.length > 0 && lines.some(function(l) { return l.id === emp.mainLines[0]; })) {
    emp.lastLineId = emp.mainLines[0];
    return emp.mainLines[0];
  }
  return null;
}

function returnEmpFromAbsentOrExtra(emp) {
  const l = getPredeterminedLineForEmp(emp);
  if (isEmpProtectedFromRotation(emp) && emp.lastShiftId && l) emp.zone = l + "_" + emp.lastShiftId;
  else if (emp.team === shiftRotation.frueh && l && !isEmpProtectedFromRotation(emp)) emp.zone = l + "_frueh";
  else if (emp.team === shiftRotation.spaet && l && !isEmpProtectedFromRotation(emp)) emp.zone = l + "_spaet";
  else if (emp.team === shiftRotation.nacht && l && !isEmpProtectedFromRotation(emp)) emp.zone = l + "_nacht";
  else emp.zone = "pool";
}

window.deletePin = function(id) {
  const emp = employees.find(function(e) { return e.id === id; });
  if (emp) { delete emp.lastLineId; saveToFirebase(); renderEmployees(); }
};

function getCalendarWeek(d) {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) target.setMonth(0, 1 + ((4 - target.getDay() + 7) % 7));
  return Math.ceil((firstThursday - target) / (7 * 86400000) + 1);
}

function updateHeaderDateKw() {
  const el = document.getElementById("headerDateKw");
  if (!el) return;
  const now = new Date();
  const dateStr = now.toLocaleDateString("de-DE", { weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" });
  el.textContent = "📅 " + dateStr + " · KW " + getCalendarWeek(now);
}

function showToast(msg) {
  const t = document.getElementById("toastBanner");
  if (!t) return;
  t.textContent = msg;
  t.style.display = "block";
  setTimeout(function() { t.style.display = "none"; }, 4000);
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = "none";
  if (id === "settingsModal") resetEmpForm();
}

function styleShiftDropdown(selEl, teamKey) {
  if (!selEl) return;
  const tObj = teamsConfig[teamKey];
  if (tObj) {
    selEl.style.borderLeft = "6px solid " + tObj.color;
    selEl.style.color = tObj.color;
    selEl.style.fontWeight = "700";
  }
}

function initBoard() {
  const headerRow = document.getElementById("headerRow");
  if (!headerRow) return;
  if (!Array.isArray(lines) || lines.length === 0) lines = defaultLines.slice();

  headerRow.innerHTML = '<th class="shift-header"><div>Schicht</div><div class="shift-controls"><button class="shift-rotate-btn" onclick="rotateAllShifts()">🔄 Rotieren</button><button class="shift-clear-btn" onclick="clearEntireBoard()">🧹 Alle leeren</button></div></th>';
  lines.forEach(function(line) {
    const th = document.createElement("th"); th.className = "line-header";
    if (isPlanner) th.onclick = function() { openLineEditModal(line.id); };
    let pCls = line.prio && (line.prio.indexOf("1") !== -1 || line.prio.indexOf("2") !== -1) ? "prio-high" : (line.prio ? "prio-mid" : "");
    th.innerHTML = '<div class="line-title">' + line.name + '</div><div class="badge-container">' + (line.prio ? '<span class="line-prio ' + pCls + '">' + line.prio + '</span>' : '') + (line.tag ? '<span class="line-status-tag">' + line.tag + '</span>' : '') + '</div>' + (line.note ? '<div class="line-notes">' + line.note + '</div>' : '');
    headerRow.appendChild(th);
  });

  const matrixBody = document.getElementById("matrixBody"); matrixBody.innerHTML = "";
  const keys = Object.keys(teamsConfig).sort();
  shifts.forEach(function(shift) {
    const curKey = shiftRotation[shift.id] || keys[0], curObj = teamsConfig[curKey] || { name: "Team", color: "#0091df" };
    const opts = keys.map(function(k) {
      return '<option value="' + k + '" style="color:' + teamsConfig[k].color + '; font-weight:700;" ' + (k === curKey ? 'selected' : '') + '>■ ' + teamsConfig[k].name + (isTeamRotating(k) ? ' 🔄' : '') + '</option>';
    }).join("");
    const tr = document.createElement("tr"), thS = document.createElement("th");
    thS.className = "shift-header";
    thS.innerHTML = '<div>' + shift.name + '</div><div class="shift-team-badge"><span style="color:' + curObj.color + ';">■</span> ' + curObj.name + '</div><div class="shift-controls"><div style="display:flex; gap:4px;"><select id="teamSelect_' + shift.id + '" class="shift-team-select" style="flex:1; border-left:6px solid ' + curObj.color + '; color:' + curObj.color + ';" onchange="styleShiftDropdown(this, this.value)">' + opts + '</select><button class="shift-clear-btn" style="width:26px; padding:0; color:var(--bayer-blue); border-color:var(--bayer-blue);" onclick="loadTeamToShift(\'' + shift.id + '\')" title="Team auf Linien laden">📥</button></div><button class="shift-clear-btn" onclick="clearShiftRow(\'' + shift.id + '\', \'' + shift.name + '\')">🧹 Leeren</button></div>';
    tr.appendChild(thS);
    lines.forEach(function(line) {
      const td = document.createElement("td"), zId = line.id + "_" + shift.id;
      td.innerHTML = '<div id="' + zId + '" class="card-list drop-zone" data-zone="' + zId + '"></div>';
      tr.appendChild(td);
    });
    matrixBody.appendChild(tr);
  });

  renderEmployees(); initDragAndDrop(); updateRoleDropdown(); updateTeamDropdowns(); renderTeamFilterCheckboxes(); renderRoleFilterCheckboxes(); applyTeamStyles(); renderLineCheckboxes(); updateInboxBadge();
}

function renderEmployees() {
  document.querySelectorAll(".drop-zone").forEach(function(el) { el.innerHTML = ""; });
  const today = getTodayIso();
  const displayList = employees.slice();
  if (isPlanner && poolSearchQuery) {
    displayList.sort(function(a, b) {
      if (a.zone !== "pool" || b.zone !== "pool") return 0;
      const aM = (a.mainLines && a.mainLines.some(function(id) { const l = lines.find(function(x){return x.id===id;}); return l && l.name.toLowerCase().indexOf(poolSearchQuery) !== -1; })) ? 2 : ((a.secLines && a.secLines.some(function(id) { const l = lines.find(function(x){return x.id===id;}); return l && l.name.toLowerCase().indexOf(poolSearchQuery) !== -1; })) ? 1 : 0);
      const bM = (b.mainLines && b.mainLines.some(function(id) { const l = lines.find(function(x){return x.id===id;}); return l && l.name.toLowerCase().indexOf(poolSearchQuery) !== -1; })) ? 2 : ((b.secLines && b.secLines.some(function(id) { const l = lines.find(function(x){return x.id===id;}); return l && l.name.toLowerCase().indexOf(poolSearchQuery) !== -1; })) ? 1 : 0);
      return bM - aM;
    });
  }

  displayList.forEach(function(emp) {
    const fName = fullName(emp);
    if (isPlanner && emp.zone === "pool") {
      if (activeTeamFilters[emp.team] === false || activeRoleFilters[emp.role] === false) return;
      if (poolSearchQuery) {
        const nMatch = fName.toLowerCase().indexOf(poolSearchQuery) !== -1;
        const pMatch = emp.mainLines && emp.mainLines.some(function(id) { const l = lines.find(function(x){return x.id===id;}); return l && l.name.toLowerCase().indexOf(poolSearchQuery) !== -1; });
        const sMatch = emp.secLines && emp.secLines.some(function(id) { const l = lines.find(function(x){return x.id===id;}); return l && l.name.toLowerCase().indexOf(poolSearchQuery) !== -1; });
        if (!nMatch && !pMatch && !sMatch) return;
      }
    }

    const card = document.createElement("div");
    card.className = "employee-card " + emp.team; card.setAttribute("data-id", emp.id);
    let parts = [];
    if (emp.lastLineId) {
      const lastL = lines.find(function(x) { return x.id === emp.lastLineId; });
      if (lastL) {
        const delBtn = emp.zone === "pool" ? '<span onclick="event.stopPropagation(); deletePin(\'' + emp.id + '\')" style="cursor:pointer; color:#ef4444; font-size:0.75rem; padding:0 3px;">✖</span>' : "";
        parts.push('<span style="color:#0284c7; font-weight:700;">📌 ' + lastL.name.replace(/Linie\s*/i, '') + ' ' + delBtn + '</span>');
      }
    }
    if (emp.mainLines && emp.mainLines.length) {
      parts.push("<b>Prio:</b> " + emp.mainLines.map(function(id) { const l = lines.find(function(x){return x.id===id;}); return l ? l.name.replace(/Linie\s*/i, '') : null; }).filter(Boolean).join(", "));
    }
    if (emp.secLines && emp.secLines.length) {
      parts.push('<span style="color:#94a3b8;">Sek:</span> ' + emp.secLines.map(function(id) { const l = lines.find(function(x){return x.id===id;}); return l ? l.name.replace(/Linie\s*/i, '') : null; }).filter(Boolean).join(", "));
    }

    const fixHtml = emp.noRotation ? '<span class="card-fix-tag" title="Fixiert (rotiert nicht)">⚓ Fix</span>' : '';
    const activeSl = sickLeaves.find(function(sl) { return sl.empId === emp.id && sl.startDate <= today && sl.endDate >= today; });
    const sickHtml = activeSl ? '<span class="card-sick-tag">' + (activeSl.category && activeSl.category.indexOf('Urlaub') !== -1 ? '🌴' : '🏥') + ' Bis ' + formatDateDe(activeSl.endDate) + '</span>' : '';
    const activeEs = extraShifts.find(function(es) { return es.empId === emp.id && es.status === "approved" && es.date >= today; });
    const extraHtml = activeEs ? '<span class="card-extra-tag">➕ ' + formatDateDe(activeEs.date) + ' (' + (shiftsLabel[activeEs.shift] || activeEs.shift) + ' | ' + (activeEs.note || 'BS') + ')</span>' : '';

    card.innerHTML =
      '<div class="card-name">' + fName + '</div>' +
      '<div style="display:flex; justify-content:space-between; align-items:center; gap:4px;">' +
        '<div style="display:flex; gap:4px; align-items:center; flex-wrap:wrap;">' +
          '<span class="card-role">' + emp.role + '</span>' +
          fixHtml +
        '</div>' +
        '<div style="display:flex; align-items:center; gap:3px;">' +
          '<button class="quick-sick-btn" onclick="openInboxModal(\'' + emp.id + '\', true)" title="Abwesenheit eintragen">🏥</button>' +
          (emp.ersthelfer ? '<span style="color:#dc2626; font-size:1.2rem; font-weight:900; line-height:0.5;" title="Ersthelfer">+</span>' : '') +
        '</div>' +
      '</div>' +
      (parts.length ? '<div class="card-lines-info">' + parts.join(" | ") + '</div>' : '') +
      extraHtml + sickHtml;

    const targetZone = document.getElementById(emp.zone) || document.getElementById("pool");
    if (targetZone) targetZone.appendChild(card);
  });

  const pEl = document.getElementById("pool"), eEl = document.getElementById("extra"), aEl = document.getElementById("absent");
  if (document.getElementById("poolCount")) document.getElementById("poolCount").textContent = "(" + (pEl ? pEl.children.length : 0) + ")";
  if (document.getElementById("extraCount")) document.getElementById("extraCount").textContent = "(" + (eEl ? eEl.children.length : 0) + ")";
  if (document.getElementById("absentCount")) document.getElementById("absentCount").textContent = "(" + (aEl ? aEl.children.length : 0) + ")";

  const extraListEl = document.getElementById("approvedExtraList");
  if (extraListEl) {
    const appr = extraShifts.filter(function(es) {
      if (es.status !== "approved" || es.date < today) return false;
      const isSickOnThatDay = sickLeaves.some(function(sl) { return sl.empId === es.empId && sl.startDate <= es.date && sl.endDate >= es.date; });
      return !isSickOnThatDay;
    }).sort(function(a,b) { return a.date.localeCompare(b.date); });

    extraListEl.innerHTML = appr.map(function(es) {
      return '<div style="display:flex; justify-content:space-between; align-items:center; background:#dcfce7; padding:3px 6px; border-radius:4px; margin-top:3px; color:#166534;">' +
        '<span><b>' + es.empName + '</b>: ' + formatDateDe(es.date) + ' (' + shiftsLabel[es.shift] + ')</span>' +
        '<div style="display:flex; gap:4px;">' +
          '<button onclick="pullExtraShiftToBox(\'' + es.id + '\')" style="border:none; background:#16a34a; color:#fff; border-radius:3px; padding:1px 5px; cursor:pointer; font-size:0.68rem;" title="Karte vorab in dieses Zusatz-Fenster holen">📥</button>' +
          '<button onclick="deleteExtraShift(\'' + es.id + '\')" style="border:none; background:none; color:#b91c1c; cursor:pointer; font-size:0.72rem;" title="Bringschicht entfernen">✖</button>' +
        '</div>' +
      '</div>';
    }).join("");
  }
}

function initDragAndDrop() {
  sortableInstances.forEach(function(s) { s.destroy(); }); sortableInstances = [];
  document.querySelectorAll(".drop-zone").forEach(function(zone) {
    sortableInstances.push(new Sortable(zone, {
      group: "shared-shifts", animation: 150, disabled: !isPlanner,
      onEnd: function (evt) {
        const empId = evt.item.getAttribute("data-id"), newZone = evt.to.getAttribute("data-zone");
        const emp = employees.find(function(e) { return e.id === empId; });
        if (emp) {
          emp.zone = newZone;
          const nL = extractLineIdFromZone(newZone), nS = extractShiftIdFromZone(newZone);
          if (nL && nS) emp.lastShiftId = nS;
          if (nL && (!emp.lastLineId || (nS && shiftRotation[nS] === emp.team) || isEmpProtectedFromRotation(emp))) emp.lastLineId = nL;
          saveToFirebase(); renderEmployees();
        }
      }
    }));
  });
}

function openChangePinModal(isMandatory) {
  if (!isPlanner && !pendingPinChangeEmpId) return;
  const err = document.getElementById("changePinError");
  if (isMandatory) {
    err.style.background = "#fef3c7"; err.style.color = "#b45309";
    err.textContent = "🔒 Erst-Anmeldung mit Start-PIN 1234: Bitte vergib jetzt deine eigene Planer-PIN!";
    err.style.display = "block";
  } else {
    err.style.display = "none";
  }
  document.getElementById("newPlannerPinInput").value = "";
  document.getElementById("newPlannerPinConfirm").value = "";
  document.getElementById("changePinModal").style.display = "flex";
}

function saveNewPlannerPin() {
  const p1 = document.getElementById("newPlannerPinInput").value.trim();
  const p2 = document.getElementById("newPlannerPinConfirm").value.trim();
  const err = document.getElementById("changePinError");
  err.style.background = "#fee2e2"; err.style.color = "#b91c1c";
  err.style.display = "none";

  if (p1.length < 4) { err.textContent = "Mindestens 4 Zeichen erforderlich!"; err.style.display = "block"; return; }
  if (p1 === "1234") { err.textContent = "Bitte nicht die Standard-PIN 1234 verwenden!"; err.style.display = "block"; return; }
  if (p1 !== p2) { err.textContent = "Passwörter stimmen nicht überein!"; err.style.display = "block"; return; }

  const targetId = pendingPinChangeEmpId || currentPlannerEmpId;
  const emp = employees.find(function(e) { return e.id === targetId; });
  if (!emp) {
    alert("Du bist als allgemeiner Admin angemeldet. Bitte melde dich mit deinem eigenen Namen an, um deine persönliche PIN zu ändern.");
    closeModal("changePinModal"); return;
  }

  emp.password = p1;
  emp.mustChangePw = false;
  pendingPinChangeEmpId = null;
  saveToFirebase();
  closeModal("changePinModal");

  if (!isPlanner) {
    applyPlannerLoginState(fullName(emp), Number(emp.accessLevel) || 2, emp.id);
    initBoard();
  }
  showToast("✅ Planer-PIN erfolgreich gespeichert!");
}

window.addEventListener("DOMContentLoaded", function() {
  Object.keys(teamsConfig).forEach(function(k) { activeTeamFilters[k] = true; });
  roles.forEach(function(r) { activeRoleFilters[r] = true; });
  updateHeaderDateKw();

  const noRotChk = document.getElementById("newEmpNoRotation");
  if (noRotChk && !document.getElementById("newEmpFirstAider") && noRotChk.parentElement && noRotChk.parentElement.parentElement) {
    const lbl = document.createElement("label");
    lbl.style.cssText = "display:flex; align-items:center; gap:6px; cursor:pointer;";
    lbl.innerHTML = '<input type="checkbox" id="newEmpFirstAider"> Ersthelfer <span style="color:#dc2626; font-weight:900;">+</span>';
    noRotChk.parentElement.parentElement.insertBefore(lbl, noRotChk.parentElement);
  }

  const savedName = sessionStorage.getItem("planner_name");
  const savedLvl = Number(sessionStorage.getItem("planner_level") || 0);
  const savedEmpId = sessionStorage.getItem("planner_emp_id");
  const lastAct = Number(sessionStorage.getItem("planner_last_active") || Date.now());

  if (savedName && savedLvl >= 2 && (Date.now() - lastAct <= PLANER_INACTIVITY_MS)) {
    applyPlannerLoginState(savedName, savedLvl, savedEmpId);
  } else {
    sessionStorage.removeItem("planner_name"); sessionStorage.removeItem("planner_level"); sessionStorage.removeItem("planner_emp_id"); sessionStorage.removeItem("planner_last_active");
  }

  // Sofortiger erzwungener Ladevorgang von der Cloud beim Start gegen leere Listen
  boardRef.get().then(function(doc) {
    if (doc.exists) {
      applyIncomingDocData(doc.data());
    }
  }).catch(function(err) {
    console.error("Initialer Ladefehler:", err);
  });

  initBoard();

  ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"].forEach(function(evt) {
    document.addEventListener(evt, resetPlanerActivity, { passive: true });
  });

  document.addEventListener("click", function(e) {
    const g1 = document.getElementById("manualSickSearchGroup");
    if (g1 && !g1.contains(e.target)) document.getElementById("manualSickSuggestions").style.display = "none";
    const g2 = document.getElementById("plannerLoginSearchGroup");
    if (g2 && !g2.contains(e.target)) document.getElementById("plannerLoginSuggestions").style.display = "none";
  });
});

function handleLogoClick() {
  if (!isPlanner) {
    document.getElementById("pinModal").style.display = "flex";
    document.getElementById("loginModalError").style.display = "none";
    document.getElementById("loginPlannerName").value = "";
    document.getElementById("pinInput").value = "";
    selectedLoginPlannerId = null;
    document.getElementById("loginPlannerName").focus();
  }
}

function onPlannerLoginInput(val) {
  selectedLoginPlannerId = null;
  const box = document.getElementById("plannerLoginSuggestions"), q = val.trim().toLowerCase();
  if (!q) { box.style.display = "none"; return; }
  const matches = employees.filter(function(e) {
    return fullName(e).toLowerCase().indexOf(q) !== -1 || ((e.lastName || "") + " " + (e.firstName || "")).toLowerCase().indexOf(q) !== -1;
  });
  if (!matches.length) { box.style.display = "none"; return; }
  box.innerHTML = matches.map(function(e) {
    return '<div class="suggestion-item" onclick="selectPlannerLogin(\'' + e.id + '\')"><span><b>' + fullName(e) + '</b></span><small style="color:#64748b;">Stufe ' + (e.accessLevel || 1) + '</small></div>';
  }).join("");
  box.style.display = "block";
}

function selectPlannerLogin(id) {
  const e = employees.find(function(x) { return x.id === id; });
  if (e) {
    selectedLoginPlannerId = e.id;
    document.getElementById("loginPlannerName").value = fullName(e);
    document.getElementById("plannerLoginSuggestions").style.display = "none";
    document.getElementById("pinInput").focus();
  }
}

function verifyPin() {
  const nameVal = document.getElementById("loginPlannerName").value.trim().toLowerCase();
  const pinVal = document.getElementById("pinInput").value.trim();
  const errBox = document.getElementById("loginModalError");
  errBox.style.display = "none";

  if ((nameVal === "admin" || nameVal === "planer") && pinVal === "1234") {
    applyPlannerLoginState("Admin", 3, null); closeModal("pinModal"); initBoard(); return;
  }

  let emp = selectedLoginPlannerId ? employees.find(function(e) { return e.id === selectedLoginPlannerId; }) : employees.find(function(e) { return fullName(e).toLowerCase() === nameVal; });
  if (!emp && nameVal) {
    const p = employees.filter(function(e) { return fullName(e).toLowerCase().indexOf(nameVal) !== -1; });
    if (p.length === 1) emp = p[0];
  }

  if (!emp || (emp.password || "1234") !== pinVal) {
    errBox.textContent = "❌ Name oder PIN nicht korrekt!"; errBox.style.display = "block"; return;
  }

  const lvl = Number(emp.accessLevel) || 1;
  if (lvl <= 1) {
    errBox.textContent = "⛔ Bitte kontaktiere deinen Vorgesetzten für Administrationsrechte (Aktuell: Stufe 1)."; errBox.style.display = "block"; return;
  }

  if (emp.password === "1234" || emp.mustChangePw) {
    closeModal("pinModal");
    pendingPinChangeEmpId = emp.id;
    openChangePinModal(true);
    return;
  }

  applyPlannerLoginState(fullName(emp), lvl, emp.id); closeModal("pinModal"); initBoard();
}

function applyPlannerLoginState(name, lvl, empId) {
  isPlanner = true; plannerLevel = lvl; currentPlannerName = name; currentPlannerEmpId = empId || null;
  sessionStorage.setItem("planner_name", name);
  sessionStorage.setItem("planner_level", lvl);
  if (empId) sessionStorage.setItem("planner_emp_id", empId);
  document.body.classList.add("planner-active");
  document.body.classList.toggle("planner-lvl-3", lvl === 3);
  document.getElementById("plannerStatusBadge").textContent = "👤 " + name + " (Stufe " + lvl + ")";
  resetPlanerActivity();
}

function logoutPlanner() {
  isPlanner = false; plannerLevel = 0; currentPlannerName = ""; currentPlannerEmpId = null; pendingPinChangeEmpId = null;
  sessionStorage.removeItem("planner_name"); sessionStorage.removeItem("planner_level"); sessionStorage.removeItem("planner_emp_id"); sessionStorage.removeItem("planner_last_active");
  document.body.classList.remove("planner-active", "planner-lvl-3");
  closeModal("pinModal"); closeModal("inboxModal"); closeModal("settingsModal"); closeModal("lineEditModal"); closeModal("changePinModal");
  initBoard();
}

function applyIncomingDocData(d) {
  if (!d) return;
  try {
    if (Array.isArray(d.lines) && d.lines.length > 0) lines = d.lines;
    if (Array.isArray(d.roles) && d.roles.length > 0) roles = d.roles;
    sickLeaves = Array.isArray(d.sickLeaves) ? d.sickLeaves : [];
    leaveRequests = Array.isArray(d.leaveRequests) ? d.leaveRequests : [];
    extraShifts = Array.isArray(d.extraShifts) ? d.extraShifts : [];
    if (d.shiftRotation && typeof d.shiftRotation === "object") shiftRotation = d.shiftRotation;
    
    if (d.teamsConfig && typeof d.teamsConfig === "object" && Object.keys(d.teamsConfig).length > 0) {
      const cleanTeams = {};
      Object.keys(d.teamsConfig).forEach(function(k) {
        const t = d.teamsConfig[k];
        if (t && typeof t === "object") {
          cleanTeams[k] = {
            name: t.name || k,
            color: t.color || "#0091df",
            rotates: t.rotates !== undefined ? !!t.rotates : true
          };
        }
      });
      if (Object.keys(cleanTeams).length > 0) teamsConfig = cleanTeams;
    }

    let memoryUpdated = false;
    if (Array.isArray(d.employees) && d.employees.length > 0) {
      employees = d.employees.filter(Boolean).map(function(e) {
        if (!e.firstName && e.name) { const p = String(e.name).split(" "); e.firstName = p[0] || ""; e.lastName = p.slice(1).join(" ") || ""; }
        if (!Array.isArray(e.mainLines)) e.mainLines = [];
        if (!Array.isArray(e.secLines)) e.secLines = [];
        if (!e.password) e.password = "1234";
        if (e.mustChangePw === undefined) e.mustChangePw = (e.password === "1234");
        if (e.noRotation === undefined) e.noRotation = false;
        if (!e.accessLevel) e.accessLevel = 1;
        if (e.zone && e.zone.slice(-5) === "_frei") { const lId = extractLineIdFromZone(e.zone); if (lId) e.lastLineId = lId; e.zone = "pool"; memoryUpdated = true; }
        const cLine = extractLineIdFromZone(e.zone), cShift = extractShiftIdFromZone(e.zone);
        if (["pool","absent","extra"].indexOf(e.zone) === -1 && cShift) e.lastShiftId = cShift;
        if (cLine && (!e.lastLineId || (cShift && shiftRotation[cShift] === e.team))) { if (e.lastLineId !== cLine) { e.lastLineId = cLine; memoryUpdated = true; } }
        return e;
      });
    }

    Object.keys(teamsConfig).forEach(function(k) { if (activeTeamFilters[k] === undefined) activeTeamFilters[k] = true; });
    roles.forEach(function(r) { if (activeRoleFilters[r] === undefined) activeRoleFilters[r] = true; });

    const autoChanged = processSickLeavesAutomation();
    if (memoryUpdated || autoChanged) saveToFirebase();

    applyTeamStyles(); updateTeamDropdowns(); renderTeamFilterCheckboxes(); renderRoleFilterCheckboxes(); updateInboxBadge();
    if (document.getElementById("inboxModal").style.display === "flex") renderInboxModal();
    if (document.getElementById("settingsModal").style.display === "flex") renderSettingsLists();
    if (!backupDoneToday && employees.length > 0) createDailyBackup(d);
  } catch (err) {
    console.error("Fehler beim Verarbeiten der Daten:", err);
  }
  initBoard();
}

boardRef.onSnapshot(function(doc) {
  if (doc.exists) applyIncomingDocData(doc.data());
}, function(err) {
  console.error("Firebase Snapshot-Fehler:", err);
});

window.forceRefreshFromServer = function() {
  const info = document.getElementById("serverSyncInfo");
  if (info) info.firstElementChild.textContent = "⏳ Lade frisch vom Server...";
  boardRef.get({ source: "server" }).then(function(doc) {
    if (doc.exists) applyIncomingDocData(doc.data());
  }).catch(function() {
    boardRef.get().then(function(doc) { if (doc.exists) applyIncomingDocData(doc.data()); });
  });
};

function saveToFirebase() {
  boardRef.set({ lines: lines, roles: roles, employees: employees, teamsConfig: teamsConfig, sickLeaves: sickLeaves, leaveRequests: leaveRequests, extraShifts: extraShifts, shiftRotation: shiftRotation }, { merge: true });
}

function rotateAllShifts() {
  const slotOrder = ["frueh", "spaet", "nacht", "frei"];
  const slotLabel = { frueh: "Früh", spaet: "Spät", nacht: "Nacht", frei: "Frei (Pool)" };
  const activeSlots = slotOrder.filter(function(s) { return shiftRotation[s] && isTeamRotating(shiftRotation[s]); });

  if (activeSlots.length < 2) {
    alert("Für die Rotation müssen mindestens 2 Schichten mit rotierenden Teams (Haken 'Rotiert' in den Einstellungen) besetzt sein.");
    return;
  }

  const nextShiftRotation = Object.assign({}, shiftRotation);
  const summaryLines = [];
  activeSlots.forEach(function(fromSlot, idx) {
    const toSlot = activeSlots[(idx + 1) % activeSlots.length];
    const tKey = shiftRotation[fromSlot];
    nextShiftRotation[toSlot] = tKey;
    const tName = (teamsConfig[tKey] && teamsConfig[tKey].name) ? teamsConfig[tKey].name : tKey;
    summaryLines.push("• " + tName + ": " + slotLabel[fromSlot] + " ➔ " + slotLabel[toSlot]);
  });

  if (!confirm("Rotierende Teams weiterschalten?\n\n" + summaryLines.join("\n") + "\n\n(Teams ohne Rotations-Haken sowie Mitarbeiter mit ⚓ Fix bleiben unverändert)")) return;

  const today = getTodayIso();
  employees.forEach(function(emp) {
    if (isEmpProtectedFromRotation(emp)) return;
    const cL = extractLineIdFromZone(emp.zone), cS = extractShiftIdFromZone(emp.zone);
    if (cL && (!emp.lastLineId || (cS && shiftRotation[cS] === emp.team))) emp.lastLineId = cL;
  });

  shiftRotation = nextShiftRotation;

  employees.forEach(function(emp) {
    if (isEmpProtectedFromRotation(emp)) return;
    const isSick = sickLeaves.some(function(sl) { return sl.empId === emp.id && sl.startDate <= today && sl.endDate >= today; });
    if (emp.zone === "absent" || emp.zone === "extra" || isSick) return;
    if (emp.team === shiftRotation.frueh) { const l = getPredeterminedLineForEmp(emp); emp.zone = l ? (l + "_frueh") : "pool"; }
    else if (emp.team === shiftRotation.spaet) { const l = getPredeterminedLineForEmp(emp); emp.zone = l ? (l + "_spaet") : "pool"; }
    else if (emp.team === shiftRotation.nacht) { const l = getPredeterminedLineForEmp(emp); emp.zone = l ? (l + "_nacht") : "pool"; }
    else if (emp.team === shiftRotation.frei) emp.zone = "pool";
  });
  saveToFirebase(); initBoard();
}

window.loadTeamToShift = function(slotKey) {
  const sel = document.getElementById("teamSelect_" + slotKey);
  if (sel) assignTeamToShift(slotKey, sel.value);
};

function assignTeamToShift(slotKey, newTeamKey) {
  if (!newTeamKey) return;
  const oldTeamInSlot = shiftRotation[slotKey];
  let swappedSlot = null;
  if (newTeamKey !== oldTeamInSlot) {
    ["frueh", "spaet", "nacht", "frei"].forEach(function(k) {
      if (k !== slotKey && shiftRotation[k] === newTeamKey) { shiftRotation[k] = oldTeamInSlot; swappedSlot = k; }
    });
  }
  shiftRotation[slotKey] = newTeamKey;
  const today = getTodayIso();
  employees.forEach(function(emp) {
    if (emp.noRotation) return;
    const isSick = sickLeaves.some(function(sl) { return sl.empId === emp.id && sl.startDate <= today && sl.endDate >= today; });
    if (emp.zone === "absent" || emp.zone === "extra" || isSick) return;
    if (emp.team === newTeamKey) {
      if (slotKey === "frei") { const l = extractLineIdFromZone(emp.zone); if (l) emp.lastLineId = l; emp.zone = "pool"; }
      else { const l = getPredeterminedLineForEmp(emp); emp.zone = l ? (l + "_" + slotKey) : "pool"; }
    } else if (newTeamKey !== oldTeamInSlot && emp.team === oldTeamInSlot && isTeamRotating(oldTeamInSlot)) {
      if (swappedSlot === "frei") { const l = extractLineIdFromZone(emp.zone); if (l) emp.lastLineId = l; emp.zone = "pool"; }
      else if (swappedSlot) { const l = getPredeterminedLineForEmp(emp); emp.zone = l ? (l + "_" + swappedSlot) : "pool"; }
    }
  });
  saveToFirebase(); initBoard();
}

function clearShiftRow(shiftId, shiftName) {
  const suffix = "_" + shiftId;
  const inShift = employees.filter(function(e) { return e.zone && e.zone.slice(-suffix.length) === suffix && !isEmpProtectedFromRotation(e); });
  if (!inShift.length) { alert("Keine rotierenden Mitarbeiter in der " + shiftName + "-Schicht."); return; }
  if (!confirm(shiftName + "-Schicht (" + inShift.length + " rotierende Mitarbeiter) in den Pool leeren?\n(Mitarbeiter mit ⚓ Fix und nicht-rotierende Teams bleiben erhalten)")) return;
  inShift.forEach(function(emp) { const l = extractLineIdFromZone(emp.zone); if (l && (!emp.lastLineId || shiftRotation[shiftId] === emp.team)) emp.lastLineId = l; emp.zone = "pool"; });
  saveToFirebase(); initBoard();
}

function clearEntireBoard() {
  const onBoard = employees.filter(function(e) { return e.zone && ["pool","absent","extra"].indexOf(e.zone) === -1 && !isEmpProtectedFromRotation(e); });
  if (!onBoard.length) { alert("Keine rotierenden Mitarbeiter auf dem Board."); return; }
  if (!confirm("Alle " + onBoard.length + " rotierenden Mitarbeiter in den Pool leeren?\n(Mitarbeiter mit ⚓ Fix und nicht-rotierende Teams bleiben stehen)")) return;
  onBoard.forEach(function(emp) { const l = extractLineIdFromZone(emp.zone), s = extractShiftIdFromZone(emp.zone); if (l && (!emp.lastLineId || (s && shiftRotation[s] === emp.team))) emp.lastLineId = l; emp.zone = "pool"; });
  saveToFirebase(); initBoard();
}

function processSickLeavesAutomation() {
  const today = getTodayIso();
  let changed = false;
  if (sickLeaves.length > 1) {
    const merged = [];
    sickLeaves.slice().sort(function(a, b) { return a.startDate.localeCompare(b.startDate); }).forEach(function(item) {
      const ex = merged.find(function(m) { return m.empId === item.empId && (m.category || "Krank") === (item.category || "Krank") && canMergeDateRanges(m.startDate, m.endDate, item.startDate, item.endDate); });
      if (ex) {
        if (item.startDate < ex.startDate) ex.startDate = item.startDate;
        if (item.endDate > ex.endDate) ex.endDate = item.endDate;
        ex.reason = mergeReasonsText(ex.reason, item.reason);
        if (!item.readByPlanner) ex.readByPlanner = false;
        if (item.returnRequestPending) { ex.returnRequestPending = true; ex.returnRequestDate = item.returnRequestDate; ex.returnRequestCreatedAt = item.returnRequestCreatedAt; }
        changed = true;
      } else merged.push(Object.assign({}, item));
    });
    if (changed) sickLeaves = merged;
  }

  const expired = sickLeaves.filter(function(sl) { return sl.endDate < today; });
  if (expired.length > 0) {
    expired.forEach(function(exp) {
      db.collection("shiftplan_history").doc(exp.id).set(Object.assign({}, exp, { archivedAt: new Date().toISOString() })).catch(function(){});
      const emp = employees.find(function(e) { return e.id === exp.empId; });
      const hasOther = sickLeaves.some(function(sl) { return sl.id !== exp.id && sl.empId === exp.empId && sl.startDate <= today && sl.endDate >= today; });
      if (emp && emp.zone === "absent" && !hasOther) returnEmpFromAbsentOrExtra(emp);
    });
    sickLeaves = sickLeaves.filter(function(sl) { return sl.endDate >= today; });
    changed = true;
  }

  sickLeaves.forEach(function(sl) {
    if (sl.startDate <= today && sl.endDate >= today) {
      const emp = employees.find(function(e) { return e.id === sl.empId; });
      if (emp && emp.zone !== "absent") {
        const cL = extractLineIdFromZone(emp.zone), cS = extractShiftIdFromZone(emp.zone);
        if (cL) emp.lastLineId = cL;
        if (cS) emp.lastShiftId = cS;
        emp.zone = "absent"; changed = true;
      }
    }
  });

  const expiredEs = extraShifts.filter(function(es) { return es.date < today && es.status === "approved"; });
  if (expiredEs.length > 0) {
    expiredEs.forEach(function(exp) {
      db.collection("shiftplan_history").doc(exp.id).set({
        id: exp.id, empId: exp.empId, empName: exp.empName,
        category: "Bringschicht (" + (shiftsLabel[exp.shift] || exp.shift) + ")",
        startDate: exp.date, endDate: exp.date, reason: exp.note || "BS",
        createdAt: exp.createdAt, approvedBy: exp.approvedBy, approvedAt: exp.approvedAt,
        archivedAt: new Date().toISOString()
      }).catch(function(){});
      const emp = employees.find(function(e) { return e.id === exp.empId; });
      const hasOtherEs = extraShifts.some(function(x) { return x.id !== exp.id && x.empId === exp.empId && x.status === "approved" && x.date === today; });
      if (emp && emp.zone === "extra" && !hasOtherEs) returnEmpFromAbsentOrExtra(emp);
    });
    extraShifts = extraShifts.filter(function(es) { return !(es.date < today && es.status === "approved"); });
    changed = true;
  }

  extraShifts.forEach(function(es) {
    if (es.status === "approved" && es.date === today && !es.placedOnBoard) {
      const emp = employees.find(function(e) { return e.id === es.empId; });
      if (emp && emp.zone === "pool") {
        const hasActiveAbsence = sickLeaves.some(function(sl) { return sl.empId === emp.id && sl.startDate <= today && sl.endDate >= today; });
        if (!hasActiveAbsence) { emp.zone = "extra"; es.placedOnBoard = true; changed = true; }
      }
    }
  });
  return changed;
}

function updateInboxBadge() {
  const badge = document.getElementById("inboxBadge");
  if (!badge) return;
  const c1 = sickLeaves.filter(function(sl) { return !sl.readByPlanner || sl.returnRequestPending; }).length;
  const c2 = leaveRequests.filter(function(lr) { return (!lr.status || lr.status === "pending") || lr.cancelUnreadByPlanner || lr.counterResponseUnread; }).length;
  const c3 = extraShifts.filter(function(es) { return (!es.status || es.status === "pending") || es.cancelUnreadByPlanner; }).length;
  const total = c1 + c2 + c3;
  badge.textContent = total;
  badge.style.display = total > 0 ? "inline-flex" : "none";
}

window.approveLeaveRequest = function(reqId) {
  const req = leaveRequests.find(function(r) { return r.id === reqId; });
  if (!req) return;
  const nowStr = new Date().toLocaleString("de-DE");
  const slId = "sl_" + Date.now();
  req.status = "approved"; req.approvedBy = currentPlannerName; req.approvedAt = nowStr; req.linkedSickLeaveId = slId;
  sickLeaves.push({
    id: slId, requestId: req.id, empId: req.empId, empName: req.empName,
    category: req.type || "Urlaub - bezahlt", startDate: req.startDate, endDate: req.endDate,
    reason: req.reason || req.type, createdAt: req.createdAt, readByPlanner: true,
    approvedBy: currentPlannerName, approvedAt: nowStr
  });
  processSickLeavesAutomation(); saveToFirebase(); renderInboxModal(); updateInboxBadge(); renderEmployees();
};

window.rejectLeaveRequest = function(reqId) {
  const req = leaveRequests.find(function(r) { return r.id === reqId; });
  if (!req) return;
  req.status = "rejected"; req.approvedBy = currentPlannerName; req.approvedAt = new Date().toLocaleString("de-DE");
  saveToFirebase(); renderInboxModal(); updateInboxBadge();
};

window.acknowledgeLeaveCancel = function(reqId) {
  const req = leaveRequests.find(function(r) { return r.id === reqId; });
  if (req) { req.cancelUnreadByPlanner = false; req.counterResponseUnread = false; saveToFirebase(); renderInboxModal(); updateInboxBadge(); }
};

window.acknowledgeExtraCancel = function(esId) {
  const es = extraShifts.find(function(x) { return x.id === esId; });
  if (es) { es.cancelUnreadByPlanner = false; saveToFirebase(); renderInboxModal(); updateInboxBadge(); }
};

window.togglePartialLeaveBox = function(reqId) {
  const el = document.getElementById("partialBox_" + reqId);
  if (el) el.style.display = el.style.display === "none" ? "block" : "none";
};

window.addPartialRangeRow = function(reqId, minD, maxD) {
  const container = document.getElementById("partialRanges_" + reqId);
  const div = document.createElement("div");
  div.style.cssText = "display:flex; gap:6px; align-items:center; margin-top:6px;";
  div.innerHTML = '<span style="font-size:0.75rem;">Von:</span><input type="date" class="form-control partial-start" value="' + minD + '" style="padding:4px; font-size:0.78rem;"><span style="font-size:0.75rem;">Bis:</span><input type="date" class="form-control partial-end" value="' + maxD + '" style="padding:4px; font-size:0.78rem;"><button class="btn btn-outline" style="padding:2px 6px; color:#ef4444;" onclick="this.parentElement.remove()">✖</button>';
  container.appendChild(div);
};

window.sendPartialCounterOffer = function(reqId) {
  const req = leaveRequests.find(function(r) { return r.id === reqId; });
  if (!req) return;
  const container = document.getElementById("partialRanges_" + reqId);
  const starts = container.querySelectorAll(".partial-start"), ends = container.querySelectorAll(".partial-end");
  const ranges = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i].value, e = ends[i].value;
    if (!s || !e || e < s) { alert("Bitte gültige Zeiträume (Von - Bis) beim Gegenvorschlag eingeben!"); return; }
    ranges.push({ startDate: s, endDate: e });
  }
  if (!ranges.length) return;
  const note = document.getElementById("partialNote_" + reqId).value.trim();
  req.status = "counter_offered"; req.proposedRanges = ranges; req.plannerNote = note;
  req.approvedBy = currentPlannerName; req.approvedAt = new Date().toLocaleString("de-DE");
  saveToFirebase(); renderInboxModal(); updateInboxBadge();
};

window.approveExtraShift = function(esId) {
  const es = extraShifts.find(function(x) { return x.id === esId; });
  if (!es) return;
  const today = getTodayIso();
  es.status = "approved"; es.approvedBy = currentPlannerName; es.approvedAt = new Date().toLocaleString("de-DE");
  const emp = employees.find(function(e) { return e.id === es.empId; });
  if (emp) {
    const hasActiveAbsence = sickLeaves.some(function(sl) { return sl.empId === emp.id && sl.startDate <= today && sl.endDate >= today; });
    if (emp.zone === "pool" && es.date === today && !hasActiveAbsence) { emp.zone = "extra"; es.placedOnBoard = true; }
  }
  saveToFirebase(); renderInboxModal(); updateInboxBadge(); renderEmployees();
};

window.rejectExtraShift = function(esId) {
  const es = extraShifts.find(function(x) { return x.id === esId; });
  if (!es) return;
  es.status = "rejected"; es.approvedBy = currentPlannerName; es.approvedAt = new Date().toLocaleString("de-DE");
  saveToFirebase(); renderInboxModal(); updateInboxBadge();
};

window.pullExtraShiftToBox = function(esId) {
  const es = extraShifts.find(function(x) { return x.id === esId; });
  if (!es) return;
  const emp = employees.find(function(e) { return e.id === es.empId; });
  if (emp) {
    const today = getTodayIso();
    const isAbsentToday = sickLeaves.some(function(sl) { return sl.empId === emp.id && sl.startDate <= today && sl.endDate >= today; });
    if (isAbsentToday || emp.zone === "absent") {
      alert("⚠️ Dieser Mitarbeiter ist heute als abwesend (Krank/Urlaub) gemeldet und kann nicht ins Bringschicht-Fenster gezogen werden!");
      return;
    }
    emp.zone = "extra"; es.placedOnBoard = true; saveToFirebase(); renderEmployees();
  }
};

window.deleteExtraShift = function(esId) {
  const es = extraShifts.find(function(x) { return x.id === esId; });
  if (es) {
    const emp = employees.find(function(e) { return e.id === es.empId; });
    if (emp && emp.zone === "extra") returnEmpFromAbsentOrExtra(emp);
  }
  extraShifts = extraShifts.filter(function(x) { return x.id !== esId; });
  saveToFirebase(); renderEmployees();
};

window.acceptReturnRequest = function(id) {
  const sl = sickLeaves.find(function(x) { return x.id === id; });
  if (sl && sl.returnRequestDate) {
    const parts = sl.returnRequestDate.split("-");
    const d = new Date(parts[0], parts[1] - 1, parts[2]); d.setDate(d.getDate() - 1);
    sl.endDate = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    sl.returnRequestPending = false; sl.readByPlanner = true;
    sl.approvedBy = currentPlannerName; sl.approvedAt = new Date().toLocaleString("de-DE");
    processSickLeavesAutomation(); saveToFirebase(); renderInboxModal(); updateInboxBadge(); renderEmployees();
  }
};

window.rejectReturnRequest = function(id) {
  const sl = sickLeaves.find(function(x) { return x.id === id; });
  if (sl) { sl.returnRequestPending = false; sl.readByPlanner = true; sl.approvedBy = currentPlannerName; saveToFirebase(); renderInboxModal(); updateInboxBadge(); }
};

window.toggleEditSickDate = function(id) {
  const box = document.getElementById("editDateBox_" + id);
  if (box) box.style.display = (box.style.display === "none") ? "flex" : "none";
};

window.saveSickLeaveDates = function(id) {
  const startInp = document.getElementById("newStartDate_" + id);
  const endInp = document.getElementById("newEndDate_" + id);
  if (!startInp || !endInp || !startInp.value || !endInp.value) return;
  if (endInp.value < startInp.value) { alert("Das Enddatum darf nicht vor dem Startdatum liegen!"); return; }

  const sl = sickLeaves.find(function(x) { return x.id === id; });
  if (!sl) return;

  const oldStart = sl.startDate, oldEnd = sl.endDate;
  sl.startDate = startInp.value;
  sl.endDate = endInp.value;
  sl.approvedBy = currentPlannerName;
  sl.approvedAt = new Date().toLocaleString("de-DE");

  const linkedReq = leaveRequests.find(function(r) { return r.id === sl.requestId || r.linkedSickLeaveId === sl.id || (r.empId === sl.empId && r.startDate === oldStart && r.endDate === oldEnd && r.status === "approved"); });
  if (linkedReq && linkedReq.status === "approved") {
    linkedReq.startDate = sl.startDate;
    linkedReq.endDate = sl.endDate;
    linkedReq.approvedBy = currentPlannerName;
    linkedReq.approvedAt = sl.approvedAt;
  }

  const today = getTodayIso();
  const emp = employees.find(function(e) { return e.id === sl.empId; });
  if (emp) {
    const stillAbsentToday = sickLeaves.some(function(x) { return x.empId === emp.id && x.startDate <= today && x.endDate >= today; });
    if (!stillAbsentToday && emp.zone === "absent") returnEmpFromAbsentOrExtra(emp);
  }

  processSickLeavesAutomation(); saveToFirebase(); renderInboxModal(); renderEmployees();
};

function onManualSickNameInput(val) {
  selectedManualSickEmpId = null;
  const box = document.getElementById("manualSickSuggestions"), q = val.trim().toLowerCase();
  if (!q) { box.style.display = "none"; return; }
  const matches = employees.filter(function(e) { return fullName(e).toLowerCase().indexOf(q) !== -1 || ((e.lastName || "") + " " + (e.firstName || "")).toLowerCase().indexOf(q) !== -1; });
  if (!matches.length) { box.style.display = "none"; return; }
  box.innerHTML = matches.map(function(e) {
    return '<div class="suggestion-item" onclick="selectManualSickEmp(\'' + e.id + '\')"><span><b>' + fullName(e) + '</b></span><small style="color:#64748b;">' + e.role + '</small></div>';
  }).join("");
  box.style.display = "block";
}
function selectManualSickEmp(id) {
  const e = employees.find(function(x) { return x.id === id; });
  if (e) { selectedManualSickEmpId = e.id; document.getElementById("manualSickEmpInput").value = fullName(e); document.getElementById("manualSickSuggestions").style.display = "none"; }
}

window.toggleManualEntryBox = function(forceState) {
  const content = document.getElementById("manualEntryContent");
  const arrow = document.getElementById("manualEntryArrow");
  if (!content || !arrow) return;
  const isOpen = forceState !== undefined ? forceState : (content.style.display === "none");
  content.style.display = isOpen ? "block" : "none";
  arrow.textContent = isOpen ? "▲ Formular schließen" : "▼ Formular öffnen";
};

window.updateInboxSearch = function(val) {
  inboxSearchQuery = val.trim().toLowerCase();
  const inp = document.getElementById("inboxSearchInput");
  if (inp && inp.value !== val) inp.value = val;
  const clr = document.getElementById("clearInboxSearchBtn");
  if (clr) clr.style.display = inboxSearchQuery.length > 0 ? "block" : "none";
  renderInboxModal();
};

window.setInboxUnreadFilter = function(f) { inboxUnreadFilter = f; renderInboxModal(); };
window.setInboxActiveFilter = function(f) { inboxActiveFilter = f; renderInboxModal(); };

function matchesInboxSearch(fields) {
  if (!inboxSearchQuery) return true;
  for (let i = 0; i < fields.length; i++) {
    if (fields[i] && String(fields[i]).toLowerCase().indexOf(inboxSearchQuery) !== -1) return true;
  }
  return false;
}

function openInboxModal(preselectEmpId, forceOpenManual) {
  if (plannerLevel < 3) return;
  document.getElementById("inboxModal").style.display = "flex";
  const input = document.getElementById("manualSickEmpInput");
  if (preselectEmpId) {
    const emp = employees.find(function(e) { return e.id === preselectEmpId; });
    if (emp) { selectedManualSickEmpId = emp.id; input.value = fullName(emp); }
    toggleManualEntryBox(true);
  } else {
    selectedManualSickEmpId = null; input.value = "";
    toggleManualEntryBox(!!forceOpenManual);
  }
  const today = getTodayIso();
  document.getElementById("manualSickStart").value = today;
  document.getElementById("manualSickEnd").value = today;
  forceRefreshFromServer();
  renderInboxModal();
}

function addManualSickLeave() {
  const typed = document.getElementById("manualSickEmpInput").value.trim().toLowerCase();
  const cat = document.getElementById("manualSickCategory").value;
  const sD = document.getElementById("manualSickStart").value, eD = document.getElementById("manualSickEnd").value;
  const r = document.getElementById("manualSickReason").value.trim();
  let emp = selectedManualSickEmpId ? employees.find(function(e) { return e.id === selectedManualSickEmpId; }) : employees.find(function(e) { return fullName(e).toLowerCase() === typed; });
  if (!emp || !sD || !eD || eD < sD) { alert("Bitte gültigen Mitarbeiter und Zeitraum wählen!"); return; }
  const nowStr = new Date().toLocaleString("de-DE"), today = getTodayIso();
  const ex = sickLeaves.find(function(sl) { return sl.empId === emp.id && (sl.category || "Krank") === cat && canMergeDateRanges(sl.startDate, sl.endDate, sD, eD); });
  if (ex) {
    if (sD < ex.startDate) ex.startDate = sD;
    if (eD > ex.endDate) ex.endDate = eD;
    ex.reason = mergeReasonsText(ex.reason, r || cat);
    ex.approvedBy = currentPlannerName; ex.approvedAt = nowStr;
  } else {
    sickLeaves.push({ id: "sl_" + Date.now(), empId: emp.id, empName: fullName(emp), category: cat, startDate: sD, endDate: eD, reason: r || cat, createdAt: nowStr, readByPlanner: true, approvedBy: currentPlannerName, approvedAt: nowStr });
  }
  if (sD <= today && eD >= today && emp.zone !== "absent") {
    const cL = extractLineIdFromZone(emp.zone), cS = extractShiftIdFromZone(emp.zone);
    if (cL) emp.lastLineId = cL; if (cS) emp.lastShiftId = cS; emp.zone = "absent";
  }
  selectedManualSickEmpId = null; document.getElementById("manualSickEmpInput").value = ""; document.getElementById("manualSickReason").value = "";
  toggleManualEntryBox(false);
  saveToFirebase(); renderInboxModal(); renderEmployees(); showToast("✅ Zeitraum eingetragen!");
}

function renderInboxModal() {
  const unreadC = document.getElementById("unreadSickList"), activeC = document.getElementById("activeSickList"), btnMark = document.getElementById("btnMarkAllRead"), today = getTodayIso();
  const unreadSlAll = sickLeaves.filter(function(sl) { return !sl.readByPlanner || sl.returnRequestPending; });
  const pendingLrAll = leaveRequests.filter(function(lr) { return !lr.status || lr.status === "pending" || lr.status === "counter_offered"; });
  const cancelledLrAll = leaveRequests.filter(function(lr) { return lr.cancelUnreadByPlanner || lr.counterResponseUnread; });
  const pendingEsAll = extraShifts.filter(function(es) { return !es.status || es.status === "pending"; });
  const cancelledEsAll = extraShifts.filter(function(es) { return es.cancelUnreadByPlanner; });

  btnMark.style.display = unreadSlAll.length > 0 ? "inline-block" : "none";

  const syncInfo = document.getElementById("serverSyncInfo");
  if (syncInfo) {
    syncInfo.firstElementChild.innerHTML = "✅ Live-Stand: <b>" + pendingLrAll.length + "</b> offene Urlaubsanträge | <b>" + pendingEsAll.length + "</b> Bringschichten | <b>" + unreadSlAll.length + "</b> Krankmeldungen";
  }

  const totalCancelCount = cancelledLrAll.length + cancelledEsAll.length;
  const totalOpenCount = pendingLrAll.length + pendingEsAll.length + unreadSlAll.length + totalCancelCount;

  const unreadBar = document.getElementById("inboxUnreadFilterBar");
  if (unreadBar) {
    const uChips = [
      { id: "all", label: "Alle (" + totalOpenCount + ")" },
      { id: "leave", label: "🌴 Anträge (" + pendingLrAll.length + ")" },
      { id: "extra", label: "➕ Bringschichten (" + pendingEsAll.length + ")" },
      { id: "sick", label: "🏥 Krank & Gesund (" + unreadSlAll.length + ")" },
      { id: "cancel", label: "🚫 Stornos & Antworten (" + totalCancelCount + ")" }
    ];
    unreadBar.innerHTML = uChips.map(function(c) {
      return '<button type="button" class="filter-chip ' + (inboxUnreadFilter === c.id ? 'active' : '') + '" onclick="setInboxUnreadFilter(\'' + c.id + '\')">' + c.label + '</button>';
    }).join("");
  }

  const showCancel = (inboxUnreadFilter === "all" || inboxUnreadFilter === "cancel");
  const showLeave = (inboxUnreadFilter === "all" || inboxUnreadFilter === "leave");
  const showExtra = (inboxUnreadFilter === "all" || inboxUnreadFilter === "extra");
  const showSick = (inboxUnreadFilter === "all" || inboxUnreadFilter === "sick");

  let html = "";

  if (showCancel) {
    cancelledLrAll.forEach(function(lr) {
      if (!matchesInboxSearch([lr.empName, lr.type, lr.reason, formatDateDe(lr.startDate), formatDateDe(lr.endDate), lr.startDate, lr.endDate, "storno", "antwort"])) return;
      let titleText = '🚫 Stornierung durch Mitarbeiter: ' + lr.empName;
      let bodyText = 'Der Mitarbeiter hat seinen <b>' + lr.type + ' (' + formatDateDe(lr.startDate) + ' – ' + formatDateDe(lr.endDate) + ')</b> storniert.';
      let cardStyle = 'border-left-color:#dc2626;';
      if (lr.counterResponseUnread) {
        if (lr.status === "accepted_counter") {
          titleText = '✅ Gegenvorschlag angenommen: ' + lr.empName;
          bodyText = 'Der Mitarbeiter hat deinen Gegenvorschlag für <b>' + lr.type + '</b> angenommen (bereits im Plan aktiv).';
          cardStyle = 'background:#f0fdf4; border-color:#bbf7d0; border-left-color:#16a34a;';
        } else if (lr.status === "declined_counter") {
          titleText = '❌ Gegenvorschlag abgelehnt: ' + lr.empName;
          bodyText = 'Der Mitarbeiter hat deinen Gegenvorschlag für <b>' + lr.type + '</b> abgelehnt.';
        }
      }
      html += '<div class="sick-card unread" style="' + cardStyle + '">' +
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">' +
          '<div>' +
            '<div style="font-weight:700; color:#0f172a;">' + titleText + '</div>' +
            '<div style="font-size:0.8rem; margin-top:3px;">' + bodyText + '</div>' +
            '<div style="font-size:0.65rem; color:#64748b; margin-top:2px;">🕒 Gemeldet am: ' + (lr.cancelledAt || lr.counterRespondedAt || lr.createdAt || '-') + '</div>' +
          '</div>' +
          '<button class="btn btn-primary" style="padding:5px 10px; font-size:0.75rem;" onclick="acknowledgeLeaveCancel(\'' + lr.id + '\')">✓ Gelesen</button>' +
        '</div>' +
      '</div>';
    });

    cancelledEsAll.forEach(function(es) {
      if (!matchesInboxSearch([es.empName, es.note, formatDateDe(es.date), es.date, shiftsLabel[es.shift], "storno", "bringschicht"])) return;
      html += '<div class="sick-card unread" style="border-left-color:#dc2626;">' +
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">' +
          '<div>' +
            '<div style="font-weight:700; color:#9f1239;">🚫 Bringschicht abgesagt: ' + es.empName + '</div>' +
            '<div style="font-size:0.8rem; margin-top:3px;">Bringschicht am <b>' + formatDateDe(es.date) + ' (' + (shiftsLabel[es.shift] || es.shift) + ')</b> wurde vom Mitarbeiter storniert.</div>' +
            '<div style="font-size:0.65rem; color:#64748b; margin-top:2px;">🕒 Storniert am: ' + (es.cancelledAt || '-') + '</div>' +
          '</div>' +
          '<button class="btn btn-primary" style="padding:5px 10px; font-size:0.75rem;" onclick="acknowledgeExtraCancel(\'' + es.id + '\')">✓ Gelesen</button>' +
        '</div>' +
      '</div>';
    });
  }

  if (showLeave) {
    pendingLrAll.forEach(function(lr) {
      if (!matchesInboxSearch([lr.empName, lr.type, lr.reason, formatDateDe(lr.startDate), formatDateDe(lr.endDate), lr.startDate, lr.endDate, "urlaub", "antrag"])) return;
      const days = calcSickDays(lr.startDate, lr.endDate);
      html += '<div class="sick-card" style="background:#f0f9ff; border-left-color:#0284c7; border-color:#bae6fd;">' +
        '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">' +
          '<div style="flex:1;">' +
            '<div style="font-weight:700; color:#0369a1;">🌴 Antrag (' + lr.type + '): ' + lr.empName + (lr.status === "counter_offered" ? ' <span style="background:#fef08a; color:#854d0e; font-size:0.68rem; padding:1px 6px; border-radius:4px;">⏳ Wartet auf MA-Antwort</span>' : '') + '</div>' +
            '<div style="font-size:0.65rem; color:#0284c7; margin-top:2px;">🕒 Eingereicht am: ' + (lr.createdAt || '-') + '</div>' +
            '<div style="font-size:0.84rem; font-weight:700; margin-top:4px;">📅 Gewünscht: ' + formatDateDe(lr.startDate) + ' bis ' + formatDateDe(lr.endDate) + ' (' + days + ' ' + (days === 1 ? 'Tag' : 'Tage') + ')</div>' +
            (lr.reason ? '<div style="font-size:0.8rem; margin-top:4px; color:#334155;">💬 "' + lr.reason + '"</div>' : '') +
            '<div id="partialBox_' + lr.id + '" style="display:none; background:#fff; padding:10px; border-radius:6px; border:1px solid #93c5fd; margin-top:8px;">' +
              '<div style="font-size:0.78rem; font-weight:700; color:#1e3a8a; margin-bottom:6px;">⚖️ Gegenvorschlag (Genehmigte Teil-Zeiträume angeben):</div>' +
              '<div id="partialRanges_' + lr.id + '">' +
                '<div style="display:flex; gap:6px; align-items:center;">' +
                  '<span style="font-size:0.75rem;">Von:</span><input type="date" class="form-control partial-start" value="' + lr.startDate + '" style="padding:4px; font-size:0.78rem;">' +
                  '<span style="font-size:0.75rem;">Bis:</span><input type="date" class="form-control partial-end" value="' + lr.endDate + '" style="padding:4px; font-size:0.78rem;">' +
                '</div>' +
              '</div>' +
              '<button class="btn btn-outline" style="padding:3px 8px; font-size:0.72rem; margin-top:6px;" onclick="addPartialRangeRow(\'' + lr.id + '\',\'' + lr.startDate + '\',\'' + lr.endDate + '\')">+ Weiterer Zeitraum (z.B. Woche 3)</button>' +
              '<input type="text" id="partialNote_' + lr.id + '" class="form-control" placeholder="Kurze Info an Mitarbeiter (optional)..." style="margin-top:6px; padding:5px 8px; font-size:0.78rem;">' +
              '<button class="btn btn-primary" style="width:100%; margin-top:6px; padding:6px; font-size:0.78rem;" onclick="sendPartialCounterOffer(\'' + lr.id + '\')">📤 Vorschlag an Mitarbeiter senden</button>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex; flex-direction:column; gap:5px;">' +
            '<button class="btn btn-primary" style="background:#16a34a; padding:5px 10px; font-size:0.75rem;" onclick="approveLeaveRequest(\'' + lr.id + '\')">✓ Bestätigen</button>' +
            '<button class="btn btn-outline" style="padding:5px 10px; font-size:0.75rem; color:#0284c7; border-color:#7dd3fc;" onclick="togglePartialLeaveBox(\'' + lr.id + '\')">⚖️ Teilweise</button>' +
            '<button class="btn btn-outline" style="padding:5px 10px; font-size:0.75rem; color:#ef4444;" onclick="rejectLeaveRequest(\'' + lr.id + '\')">✖ Ablehnen</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    });
  }

  if (showExtra) {
    pendingEsAll.forEach(function(es) {
      if (!matchesInboxSearch([es.empName, es.note, formatDateDe(es.date), es.date, shiftsLabel[es.shift], "bringschicht", "zusatzschicht"])) return;
      html += '<div class="sick-card" style="background:#f0fdf4; border-left-color:#16a34a; border-color:#bbf7d0;">' +
        '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">' +
          '<div>' +
            '<div style="font-weight:700; color:#166534;">➕ Bringschicht-Anfrage: ' + es.empName + '</div>' +
            '<div style="font-size:0.65rem; color:#15803d; margin-top:2px;">🕒 Eingereicht am: ' + (es.createdAt || '-') + '</div>' +
            '<div style="font-size:0.84rem; font-weight:700; margin-top:4px;">📅 Datum: ' + formatDateDe(es.date) + ' | Schicht: ' + (shiftsLabel[es.shift] || es.shift) + '</div>' +
            '<div style="font-size:0.8rem; color:#334155; margin-top:2px;">Bemerkung: <b>' + (es.note || 'BS/ZS') + '</b></div>' +
          '</div>' +
          '<div style="display:flex; flex-direction:column; gap:5px;">' +
            '<button class="btn btn-primary" style="background:#16a34a; padding:5px 10px; font-size:0.75rem;" onclick="approveExtraShift(\'' + es.id + '\')">✓ Bestätigen</button>' +
            '<button class="btn btn-outline" style="padding:5px 10px; font-size:0.75rem; color:#ef4444;" onclick="rejectExtraShift(\'' + es.id + '\')">✖ Ablehnen</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    });
  }

  if (showSick) {
    unreadSlAll.forEach(function(sl) {
      if (!matchesInboxSearch([sl.empName, sl.category, sl.reason, formatDateDe(sl.startDate), formatDateDe(sl.endDate), sl.startDate, sl.endDate, "krank", "gesund"])) return;
      if (sl.returnRequestPending) {
        html += '<div class="sick-card" style="background:#fffbeb; border-left-color:#f59e0b; border-color:#fde68a;">' +
          '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">' +
            '<div>' +
              '<div style="font-weight:700; color:#b45309;">⚠️ Gesundmeldung: ' + sl.empName + '</div>' +
              '<div style="font-size:0.65rem; color:#92400e; margin-top:2px;">🕒 Angefragt am: ' + (sl.returnRequestCreatedAt || sl.createdAt || '-') + '</div>' +
              '<div style="font-size:0.82rem; background:#fff; padding:6px; border-radius:4px; margin-top:6px; border:1px solid #fde68a;">' +
                'War gemeldet bis: <span style="text-decoration:line-through; color:#94a3b8;">' + formatDateDe(sl.endDate) + '</span><br>' +
                'Wieder einsatzbereit am: <b style="color:#16a34a;">' + formatDateDe(sl.returnRequestDate) + '</b>' +
              '</div>' +
            '</div>' +
            '<div style="display:flex; flex-direction:column; gap:6px;">' +
              '<button class="btn btn-primary" style="background:#16a34a; padding:6px 10px; font-size:0.75rem;" onclick="acceptReturnRequest(\'' + sl.id + '\')">✓ Bestätigen</button>' +
              '<button class="btn btn-outline" style="padding:6px 10px; font-size:0.75rem; color:#ef4444;" onclick="rejectReturnRequest(\'' + sl.id + '\')">✖ Ablehnen</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      } else {
        const days = calcSickDays(sl.startDate, sl.endDate);
        html += '<div class="sick-card unread">' +
          '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">' +
            '<div>' +
              '<div style="font-weight:700; color:#9f1239;">🏥 Krankmeldung: ' + sl.empName + '</div>' +
              '<div style="font-size:0.65rem; color:#9f1239; margin-top:2px;">🕒 Eingereicht am: ' + (sl.createdAt || '-') + '</div>' +
              '<div style="font-size:0.82rem; font-weight:600; margin-top:2px;">📅 Zeitraum: ' + formatDateDe(sl.startDate) + ' bis ' + formatDateDe(sl.endDate) + ' (' + days + ' ' + (days === 1 ? 'Tag' : 'Tage') + ')</div>' +
              '<div style="font-size:0.8rem; margin-top:4px; background:#fff; padding:5px 8px; border-radius:4px; border:1px solid #fecdd3;"><b>Notiz:</b> ' + (sl.reason || '<i>Keine Angabe</i>') + '</div>' +
            '</div>' +
            '<button class="btn btn-primary" style="padding:5px 10px; font-size:0.78rem;" onclick="markSickLeaveRead(\'' + sl.id + '\')">✓ Bestätigen</button>' +
          '</div>' +
        '</div>';
      }
    });
  }

  unreadC.innerHTML = html || '<div style="color:#64748b; font-size:0.83rem; padding:8px; background:#f8fafc; border-radius:6px;">Keine passenden Anträge oder Meldungen für diesen Filter.</div>';

  const isSickCat = function(sl) { return !sl.category || sl.category.indexOf("Krank") !== -1; };
  const countToday = sickLeaves.filter(function(sl) { return sl.startDate <= today && sl.endDate >= today; }).length;
  const countFuture = sickLeaves.filter(function(sl) { return sl.startDate > today; }).length;
  const countSickOnly = sickLeaves.filter(isSickCat).length;
  const countLeaveOnly = sickLeaves.filter(function(sl) { return !isSickCat(sl); }).length;

  const activeBar = document.getElementById("inboxActiveFilterBar");
  if (activeBar) {
    const aChips = [
      { id: "all", label: "Alle (" + sickLeaves.length + ")" },
      { id: "today", label: "🔴 Heute abwesend (" + countToday + ")" },
      { id: "future", label: "📅 Zukünftig (" + countFuture + ")" },
      { id: "sick", label: "🏥 Nur Krank (" + countSickOnly + ")" },
      { id: "leave", label: "🌴 Nur Urlaub/Frei (" + countLeaveOnly + ")" }
    ];
    activeBar.innerHTML = aChips.map(function(c) {
      return '<button type="button" class="filter-chip ' + (inboxActiveFilter === c.id ? 'active' : '') + '" onclick="setInboxActiveFilter(\'' + c.id + '\')">' + c.label + '</button>';
    }).join("");
  }

  const filteredActive = sickLeaves.slice().sort(function(a, b) { return a.startDate.localeCompare(b.startDate); }).filter(function(sl) {
    if (inboxActiveFilter === "today" && !(sl.startDate <= today && sl.endDate >= today)) return false;
    if (inboxActiveFilter === "future" && !(sl.startDate > today)) return false;
    if (inboxActiveFilter === "sick" && !isSickCat(sl)) return false;
    if (inboxActiveFilter === "leave" && isSickCat(sl)) return false;
    return matchesInboxSearch([sl.empName, sl.category || "Krank", sl.reason, sl.approvedBy, formatDateDe(sl.startDate), formatDateDe(sl.endDate), sl.startDate, sl.endDate]);
  });

  if (!filteredActive.length) {
    activeC.innerHTML = '<div style="color:#64748b; font-size:0.83rem; padding:8px; background:#f8fafc; border-radius:6px;">Keine aktiven Zeiträume für diesen Filter gefunden.</div>';
  } else {
    activeC.innerHTML = filteredActive.map(function(sl) {
      const isCurr = sl.startDate <= today && sl.endDate >= today;
      const badge = isCurr ? '<span style="background:#fee2e2; color:#b91c1c; font-size:0.68rem; padding:2px 6px; border-radius:4px; font-weight:700;">AKTUELL ABWESEND</span>' : '<span style="background:#fef3c7; color:#b45309; font-size:0.68rem; padding:2px 6px; border-radius:4px; font-weight:700;">AB ' + formatDateDe(sl.startDate) + '</span>';
      const catBadge = '<span style="background:#e0f2fe; color:#0369a1; font-size:0.68rem; padding:2px 6px; border-radius:4px; font-weight:700;">' + (sl.category || 'Krank') + '</span>';
      const days = calcSickDays(sl.startDate, sl.endDate);
      return '<div class="sick-card">' +
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">' +
          '<div style="flex:1;">' +
            '<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;"><span style="font-weight:700; color:#0f172a;">' + sl.empName + '</span>' + catBadge + badge + '</div>' +
            '<div style="font-size:0.65rem; color:#64748b; margin-top:2px;">🕒 Eingereicht: ' + (sl.createdAt || '-') + ' ' + (sl.approvedBy ? '| ✍️ <b>Bestätigt durch: ' + sl.approvedBy + '</b>' : '') + '</div>' +
            '<div style="font-size:0.8rem; margin-top:2px;">' +
              'Zeitraum: <b>' + formatDateDe(sl.startDate) + '</b> bis <b>' + formatDateDe(sl.endDate) + '</b> (' + days + ' ' + (days === 1 ? 'Tag' : 'Tage') + ')' +
              '<button class="btn btn-outline" style="padding:1px 6px; font-size:0.7rem; margin-left:6px; color:var(--bayer-blue);" onclick="toggleEditSickDate(\'' + sl.id + '\')">✏️ Zeitraum ändern</button>' +
            '</div>' +
            '<div id="editDateBox_' + sl.id + '" style="display:none; align-items:center; flex-wrap:wrap; gap:6px; margin-top:6px; background:#fff; padding:6px; border-radius:6px; border:1px solid #cbd5e1;">' +
              '<span style="font-size:0.75rem; font-weight:600;">Von:</span>' +
              '<input type="date" id="newStartDate_' + sl.id + '" value="' + sl.startDate + '" class="form-control" style="width:auto; padding:3px 6px; font-size:0.78rem;">' +
              '<span style="font-size:0.75rem; font-weight:600;">Bis:</span>' +
              '<input type="date" id="newEndDate_' + sl.id + '" value="' + sl.endDate + '" class="form-control" style="width:auto; padding:3px 6px; font-size:0.78rem;">' +
              '<button class="btn btn-primary" style="padding:4px 10px; font-size:0.75rem;" onclick="saveSickLeaveDates(\'' + sl.id + '\')">Speichern</button>' +
            '</div>' +
            (sl.reason ? '<div style="font-size:0.78rem; color:#475569; margin-top:3px;">💬 "' + sl.reason + '"</div>' : '') +
          '</div>' +
          '<button class="btn btn-outline" style="padding:4px 8px; font-size:0.75rem; color:#ef4444;" onclick="deleteSickLeave(\'' + sl.id + '\')">Beenden / Löschen</button>' +
        '</div>' +
      '</div>';
    }).join("");
  }
}

function markSickLeaveRead(id) {
  const sl = sickLeaves.find(function(x) { return x.id === id; });
  if (sl) { sl.readByPlanner = true; sl.approvedBy = currentPlannerName; sl.approvedAt = new Date().toLocaleString("de-DE"); saveToFirebase(); renderInboxModal(); updateInboxBadge(); }
}

function markAllSickLeavesRead() {
  const nowStr = new Date().toLocaleString("de-DE");
  sickLeaves.forEach(function(sl) { if (!sl.returnRequestPending && !sl.readByPlanner) { sl.readByPlanner = true; sl.approvedBy = currentPlannerName; sl.approvedAt = nowStr; } });
  saveToFirebase(); renderInboxModal(); updateInboxBadge();
}

function deleteSickLeave(id) {
  if (!confirm("Abwesenheit beenden / löschen?")) return;
  const sl = sickLeaves.find(function(x) { return x.id === id; }), today = getTodayIso(), nowStr = new Date().toLocaleString("de-DE");
  sickLeaves = sickLeaves.filter(function(x) { return x.id !== id; });

  if (sl) {
    leaveRequests.forEach(function(r) {
      const isLinked = (r.id === sl.requestId || r.linkedSickLeaveId === sl.id || (r.empId === sl.empId && r.startDate === sl.startDate && r.endDate === sl.endDate && (r.status === "approved" || r.status === "accepted_counter")));
      if (isLinked) {
        const hasRemainingLinkedSlices = sickLeaves.some(function(otherSl) { return otherSl.requestId === r.id; });
        if (!hasRemainingLinkedSlices) {
          r.status = "cancelled_by_planner";
          r.approvedBy = currentPlannerName;
          r.approvedAt = nowStr;
        }
      }
    });

    const emp = employees.find(function(e) { return e.id === sl.empId; });
    const hasOtherActive = sickLeaves.some(function(x) { return x.id !== sl.empId && x.empId === sl.empId && x.startDate <= today && x.endDate >= today; });
    if (emp && emp.zone === "absent" && !hasOtherActive) returnEmpFromAbsentOrExtra(emp);
  }
  saveToFirebase(); renderInboxModal(); updateInboxBadge(); renderEmployees();
}

function renderHistory() {
  const list = document.getElementById("historyList");
  list.innerHTML = "Lade Historie...";
  db.collection("shiftplan_history").orderBy("endDate", "desc").limit(200).get().then(function(snap) {
    const rawDocs = []; snap.forEach(function(doc) { rawDocs.push(Object.assign({ docId: doc.id }, doc.data())); });
    rawDocs.sort(function(a, b) { return (a.startDate || "").localeCompare(b.startDate || ""); });
    const mergedList = [], toDel = [], toUpd = [];
    rawDocs.forEach(function(item) {
      const key = item.empId || item.empName;
      const match = mergedList.find(function(m) { return (m.empId || m.empName) === key && (m.category || "Krank") === (item.category || "Krank") && canMergeDateRanges(m.startDate, m.endDate, item.startDate, item.endDate); });
      if (match) {
        if (item.startDate < match.startDate) match.startDate = item.startDate;
        if (item.endDate > match.endDate) match.endDate = item.endDate;
        match.reason = mergeReasonsText(match.reason, item.reason);
        toDel.push(item.docId); if (toUpd.indexOf(match) === -1) toUpd.push(match);
      } else mergedList.push(Object.assign({}, item));
    });
    toUpd.forEach(function(m) { const c = Object.assign({}, m); delete c.docId; db.collection("shiftplan_history").doc(m.docId).set(c).catch(function(){}); });
    toDel.forEach(function(id) { db.collection("shiftplan_history").doc(id).delete().catch(function(){}); });
    mergedList.sort(function(a, b) { return (b.endDate || "").localeCompare(a.endDate || ""); });
    cachedHistoryData = mergedList; displayFilteredHistory(cachedHistoryData);
  }).catch(function() { list.innerHTML = "<div style='color:#b91c1c;'>Fehler beim Laden.</div>"; });
}

window.deleteHistoryEntry = function(docId) {
  if (!confirm("Diesen Eintrag dauerhaft aus der Historie löschen?")) return;
  db.collection("shiftplan_history").doc(docId).delete().then(function() { cachedHistoryData = cachedHistoryData.filter(function(h) { return h.docId !== docId; }); filterHistoryUnified(); });
};

function displayFilteredHistory(data) {
  const list = document.getElementById("historyList");
  if (!data.length) { list.innerHTML = "<div style='color:#64748b;'>Keine Einträge gefunden.</div>"; return; }
  list.innerHTML = data.map(function(h) {
    const days = calcSickDays(h.startDate, h.endDate);
    return '<div class="item-row" style="align-items:flex-start; flex-direction:column; gap:2px; background:#f8fafc; padding:10px; border-radius:6px; margin-bottom:6px; border:1px solid #e2e8f0;">' +
      '<div style="display:flex; justify-content:space-between; align-items:center; width:100%;">' +
        '<b>' + h.empName + ' <span style="font-size:0.72rem; color:#0369a1;">(' + (h.category || 'Krank') + ')</span></b>' +
        '<div style="display:flex; align-items:center; gap:8px;">' +
          '<span style="font-size:0.75rem; font-weight:600;">📅 ' + formatDateDe(h.startDate) + ' – ' + formatDateDe(h.endDate) + ' <span style="color:var(--bayer-blue);">(' + days + ' ' + (days === 1 ? 'Tag' : 'Tage') + ')</span></span>' +
          '<button onclick="deleteHistoryEntry(\'' + (h.docId || h.id) + '\')" style="border:none; background:none; cursor:pointer; font-size:0.8rem;" title="Löschen">🗑️</button>' +
        '</div>' +
      '</div>' +
      '<div style="font-size:0.78rem; color:#475569;">Notiz: ' + (h.reason || 'Keine Angabe') + '</div>' +
      '<div style="font-size:0.68rem; color:#94a3b8;">Eingereicht: ' + (h.createdAt || '-') + ' ' + (h.approvedBy ? '| ✍️ Bestätigt durch: <b>' + h.approvedBy + '</b>' : '') + '</div>' +
    '</div>';
  }).join("");
}

function filterHistoryUnified() {
  const q = document.getElementById("historyUnifiedInput").value.trim().toLowerCase();
  if (!q) { displayFilteredHistory(cachedHistoryData); return; }
  displayFilteredHistory(cachedHistoryData.filter(function(h) {
    return h.empName.toLowerCase().indexOf(q) !== -1 || (h.reason && h.reason.toLowerCase().indexOf(q) !== -1) || formatDateDe(h.startDate).indexOf(q) !== -1 || formatDateDe(h.endDate).indexOf(q) !== -1 || h.startDate.indexOf(q) !== -1 || h.endDate.indexOf(q) !== -1;
  }));
}

function applyTeamStyles() {
  let st = document.getElementById("dynamicTeamStyles");
  if (!st) { st = document.createElement("style"); st.id = "dynamicTeamStyles"; document.head.appendChild(st); }
  st.textContent = Object.keys(teamsConfig).sort().map(function(k) {
    return ".employee-card." + k + " { border-left-color: " + teamsConfig[k].color + " !important; }" +
           ".team-dot-" + k + " { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background-color: " + teamsConfig[k].color + "; margin-right: 4px; vertical-align: middle; }";
  }).join("\n");
}

function updateTeamDropdowns() {
  const keys = Object.keys(teamsConfig).sort();
  const newEmpTeam = document.getElementById("newEmpTeam");
  if (newEmpTeam) {
    const prevVal = newEmpTeam.value;
    newEmpTeam.innerHTML = keys.map(function(k) {
      return '<option value="' + k + '" style="color:' + teamsConfig[k].color + '; font-weight:700;">■ ' + teamsConfig[k].name + (isTeamRotating(k) ? ' 🔄' : '') + '</option>';
    }).join("");
    if (prevVal && teamsConfig[prevVal]) newEmpTeam.value = prevVal;
    onEmpTeamChange(newEmpTeam.value || keys[0]);
  }
  const freiSel = document.getElementById("teamSelect_frei");
  if (freiSel) {
    const curFreiKey = shiftRotation.frei || keys[0];
    freiSel.innerHTML = keys.map(function(k) {
      return '<option value="' + k + '" style="color:' + teamsConfig[k].color + '; font-weight:700;" ' + (curFreiKey === k ? 'selected' : '') + '>🏖️ Frei: ' + teamsConfig[k].name + (isTeamRotating(k) ? ' 🔄' : '') + '</option>';
    }).join("");
    freiSel.onchange = function() { styleShiftDropdown(this, this.value); };
    styleShiftDropdown(freiSel, curFreiKey);
  }
}

function onEmpTeamChange(teamKey) {
  const sel = document.getElementById("newEmpTeam");
  styleShiftDropdown(sel, teamKey);
}

function updatePoolSearch(val) {
  poolSearchQuery = val.trim().toLowerCase();
  const inp = document.getElementById("poolSearchInput"); if (inp && inp.value !== val) inp.value = val;
  document.getElementById("clearSearchBtn").style.display = poolSearchQuery.length > 0 ? "block" : "none";
  renderEmployees();
}

function renderTeamFilterCheckboxes() {
  const c = document.getElementById("teamFilterContainer"); if (!c) return;
  c.innerHTML = Object.keys(teamsConfig).sort().map(function(k) {
    const rotIcon = isTeamRotating(k) ? '<span style="font-size:0.65rem; opacity:0.65;" title="Rotiert automatisch">🔄</span>' : '';
    return '<label style="display:flex; align-items:center; gap:4px; cursor:pointer; font-size:0.75rem;"><input type="checkbox" ' + (activeTeamFilters[k] ? 'checked' : '') + ' onchange="activeTeamFilters[\'' + k + '\']=this.checked; renderEmployees();"><span style="color:' + teamsConfig[k].color + '; font-weight:700;">■</span> ' + teamsConfig[k].name + rotIcon + '</label>';
  }).join("");
}
function toggleAllTeamFilters(s) { Object.keys(teamsConfig).forEach(function(k) { activeTeamFilters[k] = s; }); renderTeamFilterCheckboxes(); renderEmployees(); }

function renderRoleFilterCheckboxes() {
  const c = document.getElementById("roleFilterContainer"); if (!c) return;
  c.innerHTML = roles.map(function(r, i) { return '<label style="display:flex; align-items:center; gap:4px; cursor:pointer; font-size:0.75rem;"><input type="checkbox" ' + (activeRoleFilters[r] ? 'checked' : '') + ' onchange="activeRoleFilters[roles[' + i + ']]=this.checked; renderEmployees();">' + r + '</label>'; }).join("");
}
function toggleAllRoleFilters(s) { roles.forEach(function(r) { activeRoleFilters[r] = s; }); renderRoleFilterCheckboxes(); renderEmployees(); }

function renderLineCheckboxes(selMain, selSec) {
  selMain = selMain || []; selSec = selSec || [];
  const mC = document.getElementById("mainLinesCheckboxes"), sC = document.getElementById("secLinesCheckboxes"); if (!mC || !sC) return;
  const build = function(cls, sel) {
    return lines.map(function(l) {
      return '<label style="font-size:0.78rem; display:flex; align-items:center; gap:4px; cursor:pointer; background:#f1f5f9; padding:3px 6px; border-radius:4px;"><input type="checkbox" value="' + l.id + '" class="' + cls + '" ' + (sel.indexOf(l.id) !== -1 ? 'checked' : '') + '> ' + l.name.replace(/Linie\s*/i, '') + '</label>';
    }).join("");
  };
  mC.innerHTML = build("main-line-chk", selMain); sC.innerHTML = build("sec-line-chk", selSec);
}

function createDailyBackup(data) {
  const todayIso = getTodayIso(), todayDe = new Date().toLocaleDateString("de-DE");
  db.collection("shiftplan_backups").doc(todayIso).get().then(function(snap) {
    if (!snap.exists) {
      db.collection("shiftplan_backups").doc(todayIso).set({
        date: todayIso, displayDate: todayDe, lines: data.lines || lines, roles: data.roles || roles,
        employees: data.employees || employees, teamsConfig: data.teamsConfig || teamsConfig,
        sickLeaves: data.sickLeaves || [], leaveRequests: data.leaveRequests || [],
        extraShifts: data.extraShifts || [], shiftRotation: data.shiftRotation || shiftRotation
      }).then(function() {
        db.collection("shiftplan_backups").orderBy("date", "desc").get().then(function(sn) { let c = 0; sn.forEach(function(d) { if (++c > 7) d.ref.delete(); }); });
      });
    }
    backupDoneToday = true;
  }).catch(function(){});
}

function renderBackups() {
  const list = document.getElementById("backupList"); list.innerHTML = "Lade Backups...";
  db.collection("shiftplan_backups").orderBy("date", "desc").get().then(function(snap) {
    if (snap.empty) { list.innerHTML = "Noch keine Backups vorhanden."; return; }
    list.innerHTML = ""; snap.forEach(function(doc) { const b = doc.data(); list.innerHTML += '<div class="item-row"><span>Stand vom <b>' + b.displayDate + '</b> (' + (b.employees || []).length + ' Mitarbeiter)</span><button class="btn btn-outline" style="padding:4px 10px; color:var(--bayer-blue);" onclick="restoreBackup(\'' + doc.id + '\')">Wiederherstellen</button></div>'; });
  });
}

function restoreBackup(docId) {
  if (!confirm("Diesen Stand wirklich laden?")) return;
  db.collection("shiftplan_backups").doc(docId).get().then(function(snap) {
    if (snap.exists) {
      const b = snap.data();
      boardRef.set({
        lines: (b.lines && b.lines.length) ? b.lines : defaultLines,
        roles: (b.roles && b.roles.length) ? b.roles : roles,
        employees: b.employees || [],
        teamsConfig: b.teamsConfig || teamsConfig,
        sickLeaves: b.sickLeaves || [],
        leaveRequests: b.leaveRequests || [],
        extraShifts: b.extraShifts || [],
        shiftRotation: b.shiftRotation || shiftRotation
      }, { merge: true });
      closeModal("settingsModal");
    }
  });
}

function openLineEditModal(lineId) {
  const l = lines.find(function(x) { return x.id === lineId; }); if (!l) return;
  document.getElementById("editLineId").value = l.id;
  document.getElementById("lineEditTitle").textContent = l.name + " bearbeiten";
  document.getElementById("editLinePrio").value = l.prio || "";
  document.getElementById("editLineTag").value = l.tag || "";
  document.getElementById("editLineNote").value = l.note || "";
  document.getElementById("lineEditModal").style.display = "flex";
}

function saveLineDetails() {
  const l = lines.find(function(x) { return x.id === document.getElementById("editLineId").value; }); if (!l) return;
  l.prio = document.getElementById("editLinePrio").value;
  l.tag = document.getElementById("editLineTag").value.trim();
  l.note = document.getElementById("editLineNote").value.trim();
  saveToFirebase(); initBoard(); closeModal("lineEditModal");
}

function openSettingsModal() {
  if (plannerLevel < 3) return;
  document.getElementById("settingsModal").style.display = "flex";
  renderSettingsLists();
}

function switchTab(t, idx) {
  document.querySelectorAll(".tab-btn").forEach(function(b, i) { b.classList.toggle("active", i === idx); });
  document.querySelectorAll(".tab-content").forEach(function(c) { c.classList.remove("active"); });
  document.getElementById(t).classList.add("active");
  if (t === "tabBackups") renderBackups();
  if (t === "tabHistory") renderHistory();
}

function updateRoleDropdown() {
  const sel = document.getElementById("newEmpRole"); if (!sel) return;
  sel.innerHTML = roles.map(function(r) { return '<option value="' + r + '">' + r + '</option>'; }).join("");
}

function addTeam() {
  const name = document.getElementById("newTeamName").value.trim();
  const color = document.getElementById("newTeamColor").value;
  const rotates = document.getElementById("newTeamRotates").checked;
  if (!name) return;
  const k = "team_" + Date.now();
  teamsConfig[k] = { name: name, color: color, rotates: rotates };
  activeTeamFilters[k] = true;
  document.getElementById("newTeamName").value = "";
  document.getElementById("newTeamRotates").checked = true;
  saveToFirebase(); renderSettingsLists(); initBoard(); showToast("✅ Team hinzugefügt!");
}

window.toggleTeamRotation = function(k, isChecked) {
  if (!teamsConfig[k]) return;
  teamsConfig[k].rotates = !!isChecked;
  saveToFirebase();
  initBoard();
};

function updateTeam(k) {
  const nameEl = document.getElementById("teamNameInput_" + k);
  const colorEl = document.getElementById("teamColorInput_" + k);
  const rotEl = document.getElementById("teamRotatesInput_" + k);
  const name = nameEl ? nameEl.value.trim() : "";
  const color = colorEl ? colorEl.value : "#0091df";
  const rotates = rotEl ? rotEl.checked : true;
  if (name && teamsConfig[k]) {
    teamsConfig[k] = { name: name, color: color, rotates: rotates };
    saveToFirebase(); renderSettingsLists(); initBoard(); showToast("✅ Team aktualisiert!");
  }
}

function deleteTeam(k) {
  if (Object.keys(teamsConfig).length <= 1 || !confirm("Team wirklich löschen?")) return;
  delete teamsConfig[k]; delete activeTeamFilters[k];
  const fb = Object.keys(teamsConfig).sort()[0];
  employees.forEach(function(e) { if (e.team === k) e.team = fb; });
  saveToFirebase(); renderSettingsLists(); initBoard(); showToast("🗑️ Team gelöscht!");
}

function filterSettingsEmployees(query) {
  renderSettingsLists(query.trim().toLowerCase());
}

function renderSettingsLists(searchFilter) {
  const searchInp = document.getElementById("settingsEmpSearchInput");
  const activeQuery = searchFilter !== undefined ? searchFilter : (searchInp ? searchInp.value.trim().toLowerCase() : "");

  document.getElementById("roleList").innerHTML = roles.map(function(r, i) { return '<div class="item-row"><span>' + r + '</span><button class="btn btn-outline" style="padding:4px 10px; color:#ef4444;" onclick="deleteRole(' + i + ')">Löschen</button></div>'; }).join("");
  
  let sortedEmps = employees.slice().sort(function(a, b) { return fullName(a).localeCompare(fullName(b)); });
  if (activeQuery) {
    sortedEmps = sortedEmps.filter(function(e) {
      const tName = (teamsConfig[e.team] && teamsConfig[e.team].name) ? teamsConfig[e.team].name.toLowerCase() : "";
      return fullName(e).toLowerCase().indexOf(activeQuery) !== -1 || e.role.toLowerCase().indexOf(activeQuery) !== -1 || tName.indexOf(activeQuery) !== -1;
    });
  }

  document.getElementById("employeeList").innerHTML = sortedEmps.map(function(e) {
    const fName = fullName(e), lvl = Number(e.accessLevel) || 1;
    const tObj = teamsConfig[e.team] || { name: e.team, color: "#94a3b8" };
    const teamBadge = '<span class="team-dot-' + e.team + '"></span><span style="font-size:0.74rem; font-weight:700; color:' + tObj.color + ';">' + tObj.name + '</span>';
    const lvlBadge = '<span style="background:#f1f5f9; color:#475569; font-size:0.68rem; padding:1px 5px; border-radius:4px; font-weight:700;">Stufe ' + lvl + '</span>';
    const pwBadge = (e.mustChangePw || !e.password || e.password === "1234") ? '<span style="font-size:0.7rem; color:#d97706;">⏳ PIN: 1234</span>' : '<span style="font-size:0.7rem; color:#15803d;">🔒 Eigenes PW</span>';
    const fixBadge = e.noRotation ? '<span style="background:#fef08a; color:#854d0e; font-size:0.68rem; padding:1px 5px; border-radius:4px; font-weight:700;">⚓ Fix</span>' : '';
    const faBadge = e.ersthelfer ? '<span style="color:#dc2626; font-weight:900;" title="Ersthelfer">+</span>' : '';
    return '<div class="item-row"><div style="flex:1;"><b>' + fName + '</b> ' + faBadge + ' · ' + teamBadge + ' <small>(' + e.role + ')</small> ' + fixBadge + ' ' + lvlBadge + ' ' + pwBadge + '</div><div style="display:flex; gap:5px;"><button class="btn btn-outline" style="padding:4px 8px; font-size:0.75rem; color:#0284c7;" onclick="resetEmpPassword(\'' + e.id + '\')">🔄 PIN</button><button class="btn btn-outline" style="padding:4px 8px; font-size:0.75rem;" onclick="editEmployee(\'' + e.id + '\')">Bearbeiten</button><button class="btn btn-outline" style="padding:4px 8px; font-size:0.75rem; color:#ef4444;" onclick="deleteEmployee(\'' + e.id + '\')">Löschen</button></div></div>';
  }).join("");

  document.getElementById("lineSettingsList").innerHTML = lines.map(function(l, i) { return '<div class="item-row"><span><b>' + l.name + '</b></span><div style="display:flex; gap:6px;"><button class="btn btn-outline" style="padding:2px 8px;" ' + (i === 0 ? 'disabled' : '') + ' onclick="moveLine(' + i + ',-1)">▲</button><button class="btn btn-outline" style="padding:2px 8px;" ' + (i === lines.length - 1 ? 'disabled' : '') + ' onclick="moveLine(' + i + ',1)">▼</button><button class="btn btn-outline" style="padding:4px 10px; color:#ef4444;" onclick="deleteLine(\'' + l.id + '\')">Löschen</button></div></div>'; }).join("");
  document.getElementById("teamSettingsList").innerHTML = Object.keys(teamsConfig).sort().map(function(k) {
    const rotChecked = isTeamRotating(k) ? "checked" : "";
    return '<div class="item-row" style="flex-wrap:wrap;">' +
      '<input type="color" id="teamColorInput_' + k + '" value="' + teamsConfig[k].color + '" style="width:36px; height:32px; border:none; cursor:pointer;">' +
      '<input type="text" id="teamNameInput_' + k + '" class="form-control" value="' + teamsConfig[k].name + '" style="flex:1; min-width:120px; padding:6px;">' +
      '<label style="display:flex; align-items:center; gap:5px; font-size:0.8rem; font-weight:600; cursor:pointer; background:#f8fafc; padding:5px 8px; border-radius:6px; border:1px solid #cbd5e1;" title="Haken gesetzt = Team rotiert automatisch mit">' +
        '<input type="checkbox" id="teamRotatesInput_' + k + '" ' + rotChecked + ' onchange="toggleTeamRotation(\'' + k + '\', this.checked)"> 🔄 Rotiert' +
      '</label>' +
      '<button class="btn btn-outline" style="padding:6px 10px; color:var(--bayer-blue);" onclick="updateTeam(\'' + k + '\')">Speichern</button>' +
      '<button class="btn btn-outline" style="padding:6px 10px; color:#ef4444;" onclick="deleteTeam(\'' + k + '\')">Löschen</button>' +
    '</div>';
  }).join("");
}

function resetEmpPassword(id) {
  const emp = employees.find(function(e) { return e.id === id; }); if (!emp || !confirm('PIN von "' + fullName(emp) + '" auf 1234 zurücksetzen?')) return;
  emp.password = "1234"; emp.mustChangePw = true; saveToFirebase(); renderSettingsLists(); showToast("🔄 PIN auf 1234 zurückgesetzt!");
}

function addLine() {
  const name = document.getElementById("newLineName").value.trim(); if (!name) return;
  lines.push({ id: "L_" + Date.now(), name: name, prio: "", tag: "", note: "" }); document.getElementById("newLineName").value = ""; saveToFirebase(); initBoard(); renderSettingsLists(); showToast("✅ Linie hinzugefügt!");
}
function moveLine(i, dir) { const item = lines.splice(i, 1)[0]; lines.splice(i + dir, 0, item); saveToFirebase(); initBoard(); renderSettingsLists(); }
function deleteLine(id) {
  if (!confirm("Linie wirklich löschen?")) return;
  lines = lines.filter(function(l) { return l.id !== id; });
  employees.forEach(function(e) { if (e.zone && e.zone.indexOf(id + "_") === 0) e.zone = "pool"; if (e.lastLineId === id) delete e.lastLineId; });
  saveToFirebase(); initBoard(); renderSettingsLists(); showToast("🗑️ Linie gelöscht!");
}
function addRole() {
  const val = document.getElementById("newRoleName").value.trim(); if (!val || roles.indexOf(val) !== -1) return;
  roles.push(val); activeRoleFilters[val] = true; document.getElementById("newRoleName").value = ""; saveToFirebase(); updateRoleDropdown(); renderRoleFilterCheckboxes(); renderSettingsLists(); showToast("✅ Rolle hinzugefügt!");
}
function deleteRole(i) {
  const rem = roles.splice(i, 1)[0]; delete activeRoleFilters[rem]; saveToFirebase(); updateRoleDropdown(); renderRoleFilterCheckboxes(); renderSettingsLists(); showToast("🗑️ Rolle gelöscht!");
}

function saveEmployee() {
  const idInp = document.getElementById("editEmpId").value;
  const fName = document.getElementById("newEmpFirstName").value.trim(), lName = document.getElementById("newEmpLastName").value.trim();
  const team = document.getElementById("newEmpTeam").value, role = document.getElementById("newEmpRole").value;
  const lvl = Number(document.getElementById("newEmpAccessLevel").value) || 1;
  const isFix = document.getElementById("newEmpNoRotation").checked;
  const faChk = document.getElementById("newEmpFirstAider");
  const mLines = Array.from(document.querySelectorAll(".main-line-chk:checked")).map(function(c) { return c.value; });
  const sLines = Array.from(document.querySelectorAll(".sec-line-chk:checked")).map(function(c) { return c.value; });
  if (!fName && !lName) { alert("Bitte Namen eingeben!"); return; }

  const newFullName = (fName + " " + lName).trim();

  if (idInp) {
    const emp = employees.find(function(e) { return e.id === idInp; });
    if (emp) {
      const oldFullName = fullName(emp);
      emp.firstName = fName; emp.lastName = lName; emp.team = team; emp.role = role; emp.accessLevel = lvl; emp.noRotation = isFix;
      if (faChk) emp.ersthelfer = faChk.checked;
      emp.mainLines = mLines; emp.secLines = sLines; if (!emp.lastLineId && mLines.length) emp.lastLineId = mLines[0];
      
      if (oldFullName !== newFullName) {
        sickLeaves.forEach(function(sl) { if (sl.empId === emp.id) sl.empName = newFullName; });
        leaveRequests.forEach(function(lr) { if (lr.empId === emp.id) lr.empName = newFullName; });
        extraShifts.forEach(function(es) { if (es.empId === emp.id) es.empName = newFullName; });
      }
    }
  } else {
    employees.push({
      id: "e_" + Date.now(), firstName: fName, lastName: lName, team: team, role: role, accessLevel: lvl,
      password: "1234", mustChangePw: true, ersthelfer: faChk ? faChk.checked : false, noRotation: isFix,
      mainLines: mLines, secLines: sLines, lastLineId: mLines[0] || null, zone: "pool"
    });
  }
  resetEmpForm(); saveToFirebase(); renderEmployees(); renderSettingsLists(); showToast("✅ Mitarbeiter gespeichert!");
}

function editEmployee(id) {
  const emp = employees.find(function(e) { return e.id === id; }); if (!emp) return;
  document.getElementById("editEmpId").value = emp.id;
  document.getElementById("newEmpFirstName").value = emp.firstName || "";
  document.getElementById("newEmpLastName").value = emp.lastName || "";
  document.getElementById("newEmpTeam").value = emp.team || Object.keys(teamsConfig).sort()[0];
  onEmpTeamChange(document.getElementById("newEmpTeam").value);
  document.getElementById("newEmpRole").value = emp.role || roles[0];
  document.getElementById("newEmpAccessLevel").value = String(emp.accessLevel || 1);
  document.getElementById("newEmpNoRotation").checked = !!emp.noRotation;
  const faChk = document.getElementById("newEmpFirstAider");
  if (faChk) faChk.checked = !!emp.ersthelfer;
  renderLineCheckboxes(emp.mainLines || [], emp.secLines || []);
  document.getElementById("btnSaveEmp").textContent = "Aktualisieren";
  document.getElementById("btnCancelEditEmp").style.display = "inline-block";
}

function resetEmpForm() {
  document.getElementById("editEmpId").value = ""; document.getElementById("newEmpFirstName").value = ""; document.getElementById("newEmpLastName").value = "";
  document.getElementById("newEmpAccessLevel").value = "1"; document.getElementById("newEmpNoRotation").checked = false;
  const faChk = document.getElementById("newEmpFirstAider");
  if (faChk) faChk.checked = false;
  renderLineCheckboxes([], []); document.getElementById("btnSaveEmp").textContent = "Hinzufügen / Speichern"; document.getElementById("btnCancelEditEmp").style.display = "none";
  const tSel = document.getElementById("newEmpTeam"); if (tSel && tSel.value) onEmpTeamChange(tSel.value);
}

function deleteEmployee(id) {
  if (!confirm("Mitarbeiter inklusive aller Anträge wirklich löschen?")) return;
  employees = employees.filter(function(e) { return e.id !== id; });
  sickLeaves = sickLeaves.filter(function(sl) { return sl.empId !== id; });
  leaveRequests = leaveRequests.filter(function(lr) { return lr.empId !== id; });
  extraShifts = extraShifts.filter(function(es) { return es.empId !== id; });
  saveToFirebase(); renderEmployees(); renderSettingsLists(); showToast("🗑️ Mitarbeiter gelöscht!");
}
