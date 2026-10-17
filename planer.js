/* ==========================================================================
   PLANER-BOARD LOGIK (planer.js) - Inkl. korrigierter Nadel- & Memory-Funktion
   ========================================================================== */

firebase.initializeApp({
  apiKey: "AIzaSyBPOYRYyUm5gA-j7YSAZl7EJoxedFhDTl4", authDomain: "schichtplan-bayer.firebaseapp.com",
  projectId: "schichtplan-bayer", storageBucket: "schichtplan-bayer.firebasestorage.app",
  messagingSenderId: "152929285194", appId: "1:152929285194:web:00b73aa6058a70aed3a2b3"
});
const db = firebase.firestore();
const boardRef = db.collection("shiftplan").doc("live_board");
const shifts = [{ id: "frueh", name: "Früh" }, { id: "spaet", name: "Spät" }, { id: "nacht", name: "Nacht" }];
const shiftsLabel = { frueh: "Frühschicht", spaet: "Spätschicht", nacht: "Nachtschicht" };
const shiftsShortLabel = { frueh: "Früh", spaet: "Spät", nacht: "Nacht" };
const defaultLines = ["32","33","34","09","22","39","36","37","38","54"].map(function(n) { return { id: "L" + n, name: "Linie " + n, prio: "", tag: "", note: "" }; });

let shiftRotation = { frueh: "team-1", spaet: "team-2", nacht: "team-3", frei: "team-4" };
let lines = defaultLines.slice();
let roles = ["Bediener", "LOP", "TL", "Schichtexperte", "Waschraumoperator"];
let employees = [], sickLeaves = [], leaveRequests = [], extraShifts = [], historyLogs = [], backups = [];
let teamsConfig = {
  "team-1": { name: "Team 1", color: "#0091df", rotates: true },
  "team-2": { name: "Team 2", color: "#f59e0b", rotates: true },
  "team-3": { name: "Team 3", color: "#10b981", rotates: true },
  "team-4": { name: "Team 4", color: "#f43f5e", rotates: true }
};
let securityConfig = { boardPwEnabled: false, boardPw: "0110", plannerTimeoutMin: 180 };

let shiftModelConfig = {
  model: "vollkonti_sonntag_frei",
  autoRotate: true,
  startDate: "",
  lastRotatedWeekKey: ""
};

let approvedShiftKey = "";
let hasLoadedFromCloud = false;
let activeTeamFilters = {}, activeRoleFilters = {}, poolSearchQuery = "", settingsEmpSearchQuery = "";
let inboxSearchQuery = "";
let selectedManualSickEmpId = null, selectedLoginPlannerId = null;
let isPlanner = false, plannerLevel = 0, currentPlannerName = "", currentPlannerEmpId = null;
let sortableInstances = [];
let msgTimers = {};

function getShiftModelLabel(modelKey) {
  if (modelKey === "dreierschicht") return "Dreierschicht";
  if (modelKey === "vollkonti") return "Vollkonti";
  return "Vollkonti (Sonntags frei)";
}

function getLogicalDateObj(baseDate) {
  const now = baseDate || new Date();
  return new Date(now.getTime() + 3 * 60 * 60 * 1000);
}

function getLogicalDateIso(baseDate) {
  const ld = getLogicalDateObj(baseDate);
  return ld.getFullYear() + "-" + String(ld.getMonth() + 1).padStart(2, "0") + "-" + String(ld.getDate()).padStart(2, "0");
}

function getTodayIso() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function getCurrentActiveShiftId() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 13) return "frueh";
  if (hour >= 13 && hour < 21) return "spaet";
  return "nacht";
}

function isSundayOffWindow() {
  const m = shiftModelConfig ? shiftModelConfig.model : "vollkonti_sonntag_frei";
  if (m !== "vollkonti_sonntag_frei" && m !== "dreierschicht") return false;
  const ld = getLogicalDateObj();
  return ld.getDay() === 0;
}

function getCurrentShiftApprovalKey() {
  return getLogicalDateIso() + "_" + getCurrentActiveShiftId();
}

function isCurrentShiftApproved() {
  return approvedShiftKey === getCurrentShiftApprovalKey();
}

function getCalendarWeek(d) {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) target.setMonth(0, 1 + ((4 - target.getDay() + 7) % 7));
  return Math.ceil((firstThursday - target) / (7 * 86400000) + 1);
}

function checkAndRunAutoRotation() {
  if (!hasLoadedFromCloud || !shiftModelConfig || !shiftModelConfig.autoRotate) return;
  const ld = getLogicalDateObj();
  const logicalIso = getLogicalDateIso();

  if (shiftModelConfig.startDate && logicalIso < shiftModelConfig.startDate) return;
  if (ld.getDay() === 0) return;

  const kw = getCalendarWeek(ld);
  const weekKey = ld.getFullYear() + "-KW" + kw;

  if (!shiftModelConfig.lastRotatedWeekKey) {
    shiftModelConfig.lastRotatedWeekKey = weekKey;
    saveToFirebase();
    return;
  }

  if (shiftModelConfig.lastRotatedWeekKey !== weekKey) {
    shiftModelConfig.lastRotatedWeekKey = weekKey;
    logHistory("Auto-Rotation", "Wochenwechsel auf KW " + kw + " (" + getShiftModelLabel(shiftModelConfig.model) + ")");
    performShiftRotationLogic(true);
  }
}

function updateAutoRotationUI() {
  const modelName = getShiftModelLabel(shiftModelConfig.model);
  const isAuto = shiftModelConfig.autoRotate !== false;
  const startStr = shiftModelConfig.startDate ? formatDateDe(shiftModelConfig.startDate) : "";

  const badge = document.getElementById("autoRotationBadge");
  const badgeDot = document.getElementById("autoRotationDot");
  const badgeText = document.getElementById("autoRotationText");
  if (badge && badgeDot && badgeText) {
    if (isAuto) {
      badge.className = "auto-rotation-badge active";
      badgeDot.style.background = "#0091df";
      badgeText.textContent = "Auto: " + modelName + (startStr ? " (ab " + startStr + ")" : "");
    } else {
      badge.className = "auto-rotation-badge";
      badgeDot.style.background = "#94a3b8";
      badgeText.textContent = "Manuell: " + modelName;
    }
  }

  const portalModelBadge = document.getElementById("portalModelBadge");
  if (portalModelBadge) {
    portalModelBadge.textContent = "Modell: " + modelName + (isAuto ? " · Auto-Rotation aktiv" : "");
  }

  const selModel = document.getElementById("cfgShiftModel");
  const inpStart = document.getElementById("cfgRotationStartDate");
  const chkAuto = document.getElementById("cfgAutoRotate");
  const hintEl = document.getElementById("cfgRotationStatusHint");
  if (selModel) selModel.value = shiftModelConfig.model || "vollkonti_sonntag_frei";
  if (inpStart) inpStart.value = shiftModelConfig.startDate || "";
  if (chkAuto) chkAuto.checked = isAuto;
  if (hintEl) {
    if (!isAuto) {
      hintEl.textContent = "Automatik pausiert";
      hintEl.style.color = "#64748b";
    } else if (shiftModelConfig.startDate && getLogicalDateIso() < shiftModelConfig.startDate) {
      hintEl.textContent = "Startet am Vorabend zum " + formatDateDe(shiftModelConfig.startDate) + " um 21:00 Uhr";
      hintEl.style.color = "#0369a1";
    } else {
      hintEl.textContent = "Aktiv (Wechsel So. 21:00 Uhr)";
      hintEl.style.color = "#166534";
    }
  }

  const freiWrap = document.getElementById("poolFreiControlWrap");
  if (freiWrap) {
    freiWrap.style.display = shiftModelConfig.model === "dreierschicht" ? "none" : "flex";
  }
}

function updateShiftApprovalUI() {
  const approved = isCurrentShiftApproved();
  const activeShift = getCurrentActiveShiftId();
  const shiftName = shiftsLabel[activeShift] || "Schicht";
  const sundayOff = isSundayOffWindow();

  const bar = document.getElementById("brandGradientBar");
  if (bar) bar.className = approved ? "brand-gradient approved" : "brand-gradient pending";

  const dot = document.getElementById("indicatorDot");
  const text = document.getElementById("indicatorText");
  const btn = document.getElementById("plannerApprovalIndicator");
  if (dot && text && btn) {
    if (approved) {
      dot.style.background = "#16a34a";
      text.textContent = "Freigegeben";
      btn.style.borderColor = "#86efac";
      btn.style.background = "#f0fdf4";
      btn.style.color = "#166534";
    } else {
      dot.style.background = "#dc2626";
      text.textContent = "Freigeben";
      btn.style.borderColor = "#fecaca";
      btn.style.background = "#fef2f2";
      btn.style.color = "#b91c1c";
    }
  }

  const portalBadge = document.getElementById("portalShiftStatusBadge");
  const portalDot = document.getElementById("portalStatusDot");
  const portalText = document.getElementById("portalStatusText");
  if (portalBadge && portalDot && portalText) {
    if (sundayOff && !approved) {
      portalBadge.className = "portal-shift-status sunday";
      portalDot.style.background = "#0284c7";
      portalText.textContent = "Sonntag – Schichtfrei (Nachtschicht ab 22:00 Uhr)";
    } else if (approved) {
      portalBadge.className = "portal-shift-status approved";
      portalDot.style.background = "#16a34a";
      portalText.textContent = shiftName + " ist bestätigt & freigegeben";
    } else {
      portalBadge.className = "portal-shift-status pending";
      portalDot.style.background = "#dc2626";
      portalText.textContent = shiftName + " ist noch nicht bestätigt";
    }
  }
}

window.toggleShiftApprovalState = function() {
  if (!isPlanner) return;
  const currentKey = getCurrentShiftApprovalKey();
  if (approvedShiftKey === currentKey) {
    approvedShiftKey = "";
    logHistory("Freigabe", "Schichtfreigabe zurückgezogen");
  } else {
    approvedShiftKey = currentKey;
    logHistory("Freigabe", "Schicht freigegeben");
  }
  updateShiftApprovalUI();
  saveToFirebase();
};

let lastWatchedShiftKey = getCurrentShiftApprovalKey();
setInterval(function() {
  const currentKey = getCurrentShiftApprovalKey();
  if (currentKey !== lastWatchedShiftKey) {
    lastWatchedShiftKey = currentKey;
    updateHeaderDateKw();
    updateShiftApprovalUI();
    updateAutoRotationUI();
  }
  checkAndRunAutoRotation();
}, 20000);

let planerLastActivityTime = Date.now();
function resetPlanerActivity() {
  planerLastActivityTime = Date.now();
  if (isPlanner) sessionStorage.setItem("planner_last_active", String(planerLastActivityTime));
}
setInterval(function() {
  const timeoutMin = Number(securityConfig.plannerTimeoutMin);
  if (isPlanner && timeoutMin > 0) {
    if (Date.now() - planerLastActivityTime > timeoutMin * 60 * 1000) logoutPlanner();
  }
}, 15000);

function formatDateDe(s) { return (s && s.indexOf("-") !== -1) ? s.split("-").reverse().join(".") : (s || ""); }
function fullName(e) { return ((e.firstName || "") + " " + (e.lastName || "")).trim(); }
function extractLineIdFromZone(z) { return (!z || ["pool","absent","extra"].indexOf(z) !== -1 || z.indexOf("_") === -1) ? null : z.split("_").slice(0, -1).join("_"); }
function extractShiftIdFromZone(z) { return (!z || ["pool","absent","extra"].indexOf(z) !== -1 || z.indexOf("_") === -1) ? null : z.split("_").pop(); }
function isTeamRotating(teamKey) { return teamsConfig[teamKey] ? (teamsConfig[teamKey].rotates !== false) : true; }
function isEmpProtectedFromRotation(emp) { return !!(emp.noRotation || !isTeamRotating(emp.team)); }

// Nadel-Memory-Funktion: Nadel direkt per Klick löschen
window.deletePin = function(id) {
  const emp = employees.find(function(e) { return e.id === id; });
  if (emp) {
    delete emp.lastLineId;
    logHistory("Nadel", "Stammlinie für " + fullName(emp) + " gelöscht");
    saveToFirebase();
    renderEmployees();
  }
};

function updateHeaderDateKw() {
  const el = document.getElementById("headerDateKw");
  if (!el) return;
  const now = new Date();
  const ld = getLogicalDateObj(now);
  const dateStr = now.toLocaleDateString("de-DE", { weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" });
  const activeShift = getCurrentActiveShiftId();
  const sundayOff = isSundayOffWindow();
  const shiftInfo = sundayOff ? "Sonntag · Schichtfrei" : (shiftsShortLabel[activeShift] + " aktiv");
  el.textContent = dateStr + " · KW " + getCalendarWeek(ld) + " (" + shiftInfo + ")";
}

function showTimedBoxMsg(elId, text, isSuccess) {
  const box = document.getElementById(elId);
  if (!box) return;
  if (msgTimers[elId]) clearTimeout(msgTimers[elId]);
  box.style.background = isSuccess ? "#dcfce7" : "#fee2e2";
  box.style.color = isSuccess ? "#166534" : "#b91c1c";
  box.textContent = text;
  box.style.display = "block";
  msgTimers[elId] = setTimeout(function() { box.style.display = "none"; }, 5000);
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

function checkBoardLockState() {
  const modal = document.getElementById("boardLockModal");
  if (!modal) return;
  if (securityConfig && securityConfig.boardPwEnabled && !isPlanner) {
    const unlocked = sessionStorage.getItem("board_unlocked") === "true";
    modal.style.display = unlocked ? "none" : "flex";
  } else {
    modal.style.display = "none";
  }
}

window.unlockBoardView = function() {
  const inp = document.getElementById("boardLockInput");
  const val = inp ? inp.value.trim() : "";
  const targetPw = (securityConfig && securityConfig.boardPw) ? String(securityConfig.boardPw).trim() : "0110";
  if (val === targetPw) {
    sessionStorage.setItem("board_unlocked", "true");
    if (inp) inp.value = "";
    document.getElementById("boardLockError").style.display = "none";
    checkBoardLockState();
  } else {
    showTimedBoxMsg("boardLockError", "❌ Falsches Zugangs-Passwort!", false);
  }
};

window.openPlannerLoginFromLock = function() { handleLogoClick(); };

function logHistory(action, details) {
  const entry = {
    id: "h_" + Date.now(),
    time: new Date().toLocaleString("de-DE"),
    user: currentPlannerName || "System",
    action: action,
    details: details || ""
  };
  historyLogs.unshift(entry);
  if (historyLogs.length > 150) historyLogs = historyLogs.slice(0, 150);
}

function initBoard() {
  updateHeaderDateKw();
  updateShiftApprovalUI();
  updateAutoRotationUI();
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

  renderEmployees(); initDragAndDrop(); updateRoleDropdown(); updateTeamDropdowns(); renderTeamFilterCheckboxes(); renderRoleFilterCheckboxes(); applyTeamStyles(); renderLineCheckboxes(); renderSettingsLists(); updateInboxBadge(); checkBoardLockState();
}

function renderEmployees() {
  const dropZones = document.querySelectorAll(".drop-zone");
  if (!dropZones.length) return;
  dropZones.forEach(function(el) { el.innerHTML = ""; });
  const today = getTodayIso();
  const displayList = employees.slice();

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
        const delBtn = '<span onclick="event.stopPropagation(); deletePin(\'' + emp.id + '\')" style="cursor:pointer; color:#ef4444; font-size:0.75rem; padding:0 3px;" title="Nadel entfernen">✖</span>';
        parts.push('<span style="color:#0284c7; font-weight:700;" title="Gemerkte Stammlinie (Memory-Effekt)">📌 ' + lastL.name.replace(/Linie\s*/i, '') + ' ' + delBtn + '</span>');
      }
    }
    if (emp.mainLines && emp.mainLines.length) {
      parts.push("<b>Prio:</b> " + emp.mainLines.map(function(id) { const l = lines.find(function(x){return x.id===id;}); return l ? l.name.replace(/Linie\s*/i, '') : null; }).filter(Boolean).join(", "));
    }

    const fixHtml = emp.noRotation ? '<span class="card-fix-tag" title="Fixiert">⚓ Fix</span>' : '';
    const activeSl = sickLeaves.find(function(sl) { return sl.empId === emp.id && sl.startDate <= today && sl.endDate >= today; });
    const sickHtml = activeSl ? '<span class="card-sick-tag">' + (activeSl.category || 'Abwesend') + ' bis ' + formatDateDe(activeSl.endDate) + '</span>' : '';
    const activeEs = extraShifts.find(function(es) { return es.empId === emp.id && es.status === "approved" && es.date >= today; });
    const extraHtml = activeEs ? '<span class="card-extra-tag">➕ ' + formatDateDe(activeEs.date) + ' (' + (shiftsShortLabel[activeEs.shift] || activeEs.shift) + ')</span>' : '';

    card.innerHTML =
      '<div class="card-name">' + fName + '</div>' +
      '<div style="display:flex; justify-content:space-between; align-items:center; gap:4px;">' +
        '<div style="display:flex; gap:4px; align-items:center; flex-wrap:wrap;">' +
          '<span class="card-role">' + emp.role + '</span>' +
          fixHtml +
        '</div>' +
        '<div style="display:flex; align-items:center; gap:3px;">' +
          (emp.ersthelfer ? '<span style="color:#dc2626; font-size:1.15rem; font-weight:900; line-height:0.5;" title="Ersthelfer">+</span>' : '') +
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
}

// DRAG-AND-DROP MIT ROBUSTER NADEL-LOGIK (MEMORY-EFFEKT)
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
          
          // Sobald der Mitarbeiter auf eine Linie gezogen wird, merkt sich das System diese Linie als seine Stamm-Nadel
          if (nL) {
            emp.lastLineId = nL;
          }
          saveToFirebase();
          renderEmployees();
        }
      }
    }));
  });
}

window.addEventListener("DOMContentLoaded", function() {
  Object.keys(teamsConfig).forEach(function(k) { activeTeamFilters[k] = true; });
  roles.forEach(function(r) { activeRoleFilters[r] = true; });
  updateHeaderDateKw();
  updateShiftApprovalUI();
  updateAutoRotationUI();

  const savedName = sessionStorage.getItem("planner_name");
  const savedLvl = Number(sessionStorage.getItem("planner_level") || 0);
  const savedEmpId = sessionStorage.getItem("planner_emp_id");
  const lastAct = Number(sessionStorage.getItem("planner_last_active") || Date.now());
  const maxMs = (Number(securityConfig.plannerTimeoutMin) || 180) * 60 * 1000;

  if (savedName && savedLvl >= 2 && (Date.now() - lastAct <= maxMs)) {
    applyPlannerLoginState(savedName, savedLvl, savedEmpId);
  }

  initBoard();

  ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"].forEach(function(evt) {
    document.addEventListener(evt, resetPlanerActivity, { passive: true });
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
  const box = document.getElementById("plannerLoginSuggestions"), q = (val || "").trim().toLowerCase();
  if (!employees.length) { box.style.display = "none"; return; }
  const sorted = employees.slice().sort(function(a, b) { return fullName(a).localeCompare(fullName(b)); });
  const matches = q ? sorted.filter(function(e) {
    return fullName(e).toLowerCase().indexOf(q) !== -1 || ((e.lastName || "") + " " + (e.firstName || "")).toLowerCase().indexOf(q) !== -1;
  }) : sorted.slice(0, 15);

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

  if ((nameVal === "admin" || nameVal === "planer") && pinVal === "1234") {
    sessionStorage.setItem("board_unlocked", "true");
    applyPlannerLoginState("Admin", 3, null); closeModal("pinModal"); initBoard(); return;
  }

  let emp = selectedLoginPlannerId ? employees.find(function(e) { return e.id === selectedLoginPlannerId; }) : employees.find(function(e) { return fullName(e).toLowerCase() === nameVal; });
  if (!emp && nameVal) {
    const p = employees.filter(function(e) { return fullName(e).toLowerCase().indexOf(nameVal) !== -1; });
    if (p.length === 1) emp = p[0];
  }

  if (!emp || (emp.password || "1234") !== pinVal) {
    showTimedBoxMsg("loginModalError", "❌ Name oder PIN nicht korrekt!", false); return;
  }

  sessionStorage.setItem("board_unlocked", "true");
  applyPlannerLoginState(fullName(emp), Number(emp.accessLevel) || 2, emp.id); closeModal("pinModal"); initBoard();
}

function applyPlannerLoginState(name, lvl, empId) {
  isPlanner = true; plannerLevel = lvl; currentPlannerName = name; currentPlannerEmpId = empId || null;
  sessionStorage.setItem("planner_name", name);
  sessionStorage.setItem("planner_level", lvl);
  if (empId) sessionStorage.setItem("planner_emp_id", empId);
  document.body.classList.add("planner-active");
  document.body.classList.toggle("planner-lvl-3", lvl === 3);
  const badge = document.getElementById("plannerStatusBadge");
  if (badge) badge.textContent = "👤 " + name + " (Stufe " + lvl + ")";
  resetPlanerActivity();
  checkBoardLockState();
}

function logoutPlanner() {
  isPlanner = false; plannerLevel = 0; currentPlannerName = ""; currentPlannerEmpId = null;
  sessionStorage.removeItem("planner_name"); sessionStorage.removeItem("planner_level"); sessionStorage.removeItem("planner_emp_id"); sessionStorage.removeItem("planner_last_active");
  document.body.classList.remove("planner-active", "planner-lvl-3");
  closeModal("pinModal"); closeModal("inboxModal"); closeModal("settingsModal"); closeModal("lineEditModal");
  initBoard();
}

function applyIncomingDocData(d) {
  if (!d) return;
  hasLoadedFromCloud = true;
  try {
    if (Array.isArray(d.lines) && d.lines.length > 0) lines = d.lines;
    if (Array.isArray(d.roles) && d.roles.length > 0) roles = d.roles;
    sickLeaves = Array.isArray(d.sickLeaves) ? d.sickLeaves : [];
    leaveRequests = Array.isArray(d.leaveRequests) ? d.leaveRequests : [];
    extraShifts = Array.isArray(d.extraShifts) ? d.extraShifts : [];
    historyLogs = Array.isArray(d.historyLogs) ? d.historyLogs : [];
    backups = Array.isArray(d.backups) ? d.backups : [];
    if (d.shiftRotation && typeof d.shiftRotation === "object") shiftRotation = d.shiftRotation;
    if (d.teamsConfig && typeof d.teamsConfig === "object") {
      teamsConfig = d.teamsConfig;
      Object.keys(teamsConfig).forEach(function(k) {
        if (typeof activeTeamFilters[k] === "undefined") activeTeamFilters[k] = true;
      });
    }
    if (d.securityConfig && typeof d.securityConfig === "object") securityConfig = Object.assign(securityConfig, d.securityConfig);
    if (d.shiftModelConfig && typeof d.shiftModelConfig === "object") shiftModelConfig = Object.assign(shiftModelConfig, d.shiftModelConfig);
    if (typeof d.approvedShiftKey === "string") approvedShiftKey = d.approvedShiftKey;
    if (Array.isArray(d.employees)) employees = d.employees;

    checkAndRunAutoRotation();
    updateShiftApprovalUI();
    updateAutoRotationUI();
    initBoard();
  } catch (err) {
    console.error("Fehler beim Laden:", err);
  }
}

boardRef.onSnapshot(function(doc) {
  if (doc.exists) applyIncomingDocData(doc.data());
});

function saveToFirebase() {
  if (!hasLoadedFromCloud) return;
  boardRef.set({
    lines: lines, roles: roles, employees: employees, teamsConfig: teamsConfig,
    sickLeaves: sickLeaves, leaveRequests: leaveRequests, extraShifts: extraShifts,
    historyLogs: historyLogs, backups: backups,
    shiftRotation: shiftRotation, securityConfig: securityConfig,
    shiftModelConfig: shiftModelConfig,
    approvedShiftKey: approvedShiftKey
  }, { merge: true }).catch(function(err){ console.error(err); });
}

// Rotations-Logik unter Berücksichtigung der gemerkten Nadel (lastLineId)
function performShiftRotationLogic(autoPlaceEmployees) {
  const isDreier = shiftModelConfig && shiftModelConfig.model === "dreierschicht";
  const slotOrder = isDreier ? ["frueh", "spaet", "nacht"] : ["frueh", "spaet", "nacht", "frei"];
  const activeSlots = slotOrder.filter(function(s) { return shiftRotation[s] && isTeamRotating(shiftRotation[s]); });
  if (activeSlots.length < 2) return;

  const nextShiftRotation = Object.assign({}, shiftRotation);
  activeSlots.forEach(function(fromSlot, idx) {
    const toSlot = activeSlots[(idx + 1) % activeSlots.length];
    nextShiftRotation[toSlot] = shiftRotation[fromSlot];
  });
  shiftRotation = nextShiftRotation;

  if (autoPlaceEmployees) {
    const activeShiftKeys = ["frueh", "spaet", "nacht"];
    employees.forEach(function(emp) {
      if (emp.zone === "absent" || emp.zone === "extra" || isEmpProtectedFromRotation(emp)) return;
      let targetShift = null;
      activeShiftKeys.forEach(function(sKey) {
        if (shiftRotation[sKey] === emp.team) targetShift = sKey;
      });

      if (targetShift) {
        // Beim Rotieren greift exakt der Memory-Effekt (lastLineId)
        const targetLine = (emp.lastLineId && lines.some(function(l){ return l.id === emp.lastLineId; }))
          ? emp.lastLineId
          : (emp.mainLines && emp.mainLines[0] ? emp.mainLines[0] : null);
        emp.zone = targetLine ? (targetLine + "_" + targetShift) : "pool";
      } else {
        emp.zone = "pool";
      }
    });
  }

  saveToFirebase();
  initBoard();
}

function rotateAllShifts() {
  logHistory("Rotation", "Schichtrotation ausgelöst (" + getShiftModelLabel(shiftModelConfig.model) + ")");
  performShiftRotationLogic(true);
}

window.saveShiftModelSettings = function() {
  const selModel = document.getElementById("cfgShiftModel");
  const inpStart = document.getElementById("cfgRotationStartDate");
  const chkAuto = document.getElementById("cfgAutoRotate");

  if (selModel) shiftModelConfig.model = selModel.value;
  if (inpStart) shiftModelConfig.startDate = inpStart.value;
  if (chkAuto) shiftModelConfig.autoRotate = chkAuto.checked;

  logHistory("Schichtmodell", "Modell: " + getShiftModelLabel(shiftModelConfig.model));
  updateAutoRotationUI();
  updateHeaderDateKw();
  updateShiftApprovalUI();
  saveToFirebase();
  initBoard();
};

window.openShiftModelSettingsQuick = function() {
  if (!isPlanner || plannerLevel < 2) return;
  openSettingsModal();
  const teamTabBtn = document.getElementById("tabBtnTeams");
  switchTab("tabTeams", teamTabBtn);
};

window.loadTeamToShift = function(slotKey) {
  const sel = document.getElementById("teamSelect_" + slotKey);
  if (!sel) return;
  const teamKey = sel.value;
  shiftRotation[slotKey] = teamKey;

  if (slotKey === "frei") {
    employees.forEach(function(emp) {
      if (emp.team === teamKey && emp.zone !== "absent" && emp.zone !== "extra" && !emp.noRotation) {
        emp.zone = "pool";
      }
    });
  } else {
    employees.forEach(function(emp) {
      if (emp.team === teamKey && emp.zone !== "absent" && emp.zone !== "extra" && !emp.noRotation) {
        const targetLine = (emp.lastLineId && lines.some(function(l){ return l.id === emp.lastLineId; }))
          ? emp.lastLineId
          : (emp.mainLines && emp.mainLines[0] ? emp.mainLines[0] : null);
        emp.zone = targetLine ? (targetLine + "_" + slotKey) : "pool";
      }
    });
  }
  saveToFirebase(); initBoard();
};

window.clearShiftRow = function(shiftId) {
  if (!isPlanner) return;
  employees.forEach(function(emp) {
    if (extractShiftIdFromZone(emp.zone) === shiftId && !emp.noRotation) {
      emp.zone = "pool";
    }
  });
  saveToFirebase(); renderEmployees();
};

window.clearEntireBoard = function() {
  if (!isPlanner) return;
  employees.forEach(function(emp) {
    if (emp.zone && emp.zone !== "pool" && emp.zone !== "absent" && emp.zone !== "extra" && !emp.noRotation) {
      emp.zone = "pool";
    }
  });
  saveToFirebase(); renderEmployees();
};

window.addPortalLeaveRequest = function(empId, start, end, cat, reason) {
  sickLeaves.push({
    id: "sl_" + Date.now(), empId: empId, startDate: start, endDate: end,
    category: cat, reason: reason || "Vom Mitarbeiter gemeldet", readByPlanner: false
  });
  saveToFirebase(); renderEmployees();
};

function updateInboxBadge() {
  const badge = document.getElementById("inboxBadge");
  if (!badge) return;
  const total = sickLeaves.filter(function(sl) { return !sl.readByPlanner; }).length;
  badge.textContent = total;
  badge.style.display = total > 0 ? "inline-flex" : "none";
}

window.openInboxModal = function(empId, openForm) {
  document.getElementById("inboxModal").style.display = "flex";
  if (openForm) {
    const content = document.getElementById("manualEntryContent");
    if (content) content.style.display = "block";
  }
  renderInboxLists();
};

window.updateInboxSearch = function(val) {
  inboxSearchQuery = (val || "").trim().toLowerCase();
  const clearBtn = document.getElementById("clearInboxSearchBtn");
  if (clearBtn) clearBtn.style.display = inboxSearchQuery ? "block" : "none";
  renderInboxLists();
};

window.toggleManualEntryBox = function() {
  const content = document.getElementById("manualEntryContent");
  if (!content) return;
  content.style.display = content.style.display === "none" ? "block" : "none";
};

window.onManualSickNameInput = function(val) {
  selectedManualSickEmpId = null;
  const box = document.getElementById("manualSickSuggestions"), q = (val || "").trim().toLowerCase();
  if (!box || !employees.length) return;
  const matches = q ? employees.filter(function(e) { return fullName(e).toLowerCase().indexOf(q) !== -1; }) : employees.slice(0, 12);
  if (!matches.length) { box.style.display = "none"; return; }
  box.innerHTML = matches.map(function(e) {
    return '<div class="suggestion-item" onclick="selectManualSickEmp(\'' + e.id + '\')"><b>' + fullName(e) + '</b></div>';
  }).join("");
  box.style.display = "block";
};

window.selectManualSickEmp = function(id) {
  const e = employees.find(function(x) { return x.id === id; });
  if (e) {
    selectedManualSickEmpId = e.id;
    document.getElementById("manualSickEmpInput").value = fullName(e);
    document.getElementById("manualSickSuggestions").style.display = "none";
  }
};

window.addManualSickLeave = function() {
  const start = document.getElementById("manualSickStart").value;
  const end = document.getElementById("manualSickEnd").value;
  const cat = document.getElementById("manualSickCategory").value;
  const reason = document.getElementById("manualSickReason").value.trim();
  if (!selectedManualSickEmpId || !start || !end) return;

  sickLeaves.push({
    id: "sl_" + Date.now(), empId: selectedManualSickEmpId, startDate: start, endDate: end,
    category: cat, reason: reason || "Vom Planer eingetragen", readByPlanner: true
  });
  const emp = employees.find(function(e) { return e.id === selectedManualSickEmpId; });
  const today = getTodayIso();
  if (emp && start <= today && end >= today) emp.zone = "absent";

  logHistory("Abwesenheit", (emp ? fullName(emp) : "") + ": " + cat);
  saveToFirebase(); renderEmployees(); renderInboxLists(); updateInboxBadge();
};

function renderInboxLists() {
  const unreadEl = document.getElementById("unreadSickList");
  const activeEl = document.getElementById("activeSickList");
  if (!unreadEl || !activeEl) return;

  const today = getTodayIso();
  const matchQuery = function(sl) {
    if (!inboxSearchQuery) return true;
    const emp = employees.find(function(e) { return e.id === sl.empId; });
    const name = emp ? fullName(emp).toLowerCase() : "";
    const cat = (sl.category || "").toLowerCase();
    return name.indexOf(inboxSearchQuery) !== -1 || cat.indexOf(inboxSearchQuery) !== -1;
  };

  const unread = sickLeaves.filter(function(sl) { return !sl.readByPlanner && matchQuery(sl); });
  const active = sickLeaves.filter(function(sl) { return sl.endDate >= today && matchQuery(sl); });

  unreadEl.innerHTML = unread.length ? unread.map(function(sl) {
    const emp = employees.find(function(e) { return e.id === sl.empId; });
    const name = emp ? fullName(emp) : "Unbekannt";
    return '<div class="sick-card unread"><div style="display:flex; justify-content:space-between;"><b>' + name + '</b><span style="font-size:0.75rem; font-weight:700; color:#dc2626;">' + (sl.category || 'Abwesend') + '</span></div><small>Von ' + formatDateDe(sl.startDate) + ' bis ' + formatDateDe(sl.endDate) + '</small><br><em>' + (sl.reason || '') + '</em><div style="margin-top:6px; display:flex; gap:6px;"><button class="btn btn-primary" style="padding:3px 10px; font-size:0.72rem;" onclick="markSickRead(\'' + sl.id + '\')">Bestätigen</button><button class="btn btn-outline" style="padding:3px 10px; font-size:0.72rem; color:#dc2626;" onclick="deleteSickLeave(\'' + sl.id + '\')">Löschen</button></div></div>';
  }).join("") : '<p style="font-size:0.82rem; color:#64748b;">Keine offenen Anträge.</p>';

  activeEl.innerHTML = active.length ? active.map(function(sl) {
    const emp = employees.find(function(e) { return e.id === sl.empId; });
    const name = emp ? fullName(emp) : "Unbekannt";
    return '<div class="sick-card" style="display:flex; justify-content:space-between; align-items:center;"><div><b>' + name + '</b> (' + (sl.category || 'Abwesend') + ')<br><small>Von ' + formatDateDe(sl.startDate) + ' bis ' + formatDateDe(sl.endDate) + '</small></div><button class="btn btn-outline" style="padding:3px 8px; font-size:0.72rem; color:#dc2626;" onclick="deleteSickLeave(\'' + sl.id + '\')">🗑️</button></div>';
  }).join("") : '<p style="font-size:0.82rem; color:#64748b;">Keine aktiven Abwesenheiten.</p>';
}

window.markSickRead = function(id) {
  const sl = sickLeaves.find(function(x) { return x.id === id; });
  if (sl) {
    sl.readByPlanner = true;
    const today = getTodayIso();
    const emp = employees.find(function(e) { return e.id === sl.empId; });
    if (emp && sl.startDate <= today && sl.endDate >= today) emp.zone = "absent";
    saveToFirebase(); renderEmployees(); renderInboxLists(); updateInboxBadge();
  }
};

window.deleteSickLeave = function(id) {
  sickLeaves = sickLeaves.filter(function(x) { return x.id !== id; });
  saveToFirebase(); renderEmployees(); renderInboxLists(); updateInboxBadge();
};

window.markAllSickLeavesRead = function() {
  sickLeaves.forEach(function(sl) { sl.readByPlanner = true; });
  saveToFirebase(); renderInboxLists(); updateInboxBadge();
};

window.forceRefreshFromServer = function() {
  boardRef.get().then(function(doc) { if (doc.exists) applyIncomingDocData(doc.data()); });
};

function applyTeamStyles() {
  let st = document.getElementById("dynamicTeamStyles");
  if (!st) { st = document.createElement("style"); st.id = "dynamicTeamStyles"; document.head.appendChild(st); }
  st.textContent = Object.keys(teamsConfig).sort().map(function(k) {
    return ".employee-card." + k + " { border-left-color: " + teamsConfig[k].color + " !important; }";
  }).join("\n");
}

function updateTeamDropdowns() {
  const keys = Object.keys(teamsConfig).sort();
  const freiSel = document.getElementById("teamSelect_frei");
  if (freiSel) {
    const curFreiKey = shiftRotation.frei || keys[0];
    freiSel.innerHTML = keys.map(function(k) {
      return '<option value="' + k + '" ' + (curFreiKey === k ? 'selected' : '') + '>Frei: ' + teamsConfig[k].name + '</option>';
    }).join("");
  }
  const empTeamSel = document.getElementById("newEmpTeam");
  if (empTeamSel) {
    empTeamSel.innerHTML = keys.map(function(k) {
      return '<option value="' + k + '">' + teamsConfig[k].name + '</option>';
    }).join("");
  }
}

function updatePoolSearch(val) {
  poolSearchQuery = (val || "").trim().toLowerCase();
  const clearBtn = document.getElementById("clearSearchBtn");
  if (clearBtn) clearBtn.style.display = poolSearchQuery ? "block" : "none";
  renderEmployees();
}

function renderTeamFilterCheckboxes() {
  const c = document.getElementById("teamFilterContainer"); if (!c) return;
  c.innerHTML = Object.keys(teamsConfig).sort().map(function(k) {
    return '<label style="display:inline-flex; align-items:center; gap:3px;"><input type="checkbox" ' + (activeTeamFilters[k] !== false ? 'checked' : '') + ' onchange="activeTeamFilters[\'' + k + '\']=this.checked; renderEmployees();"> ' + teamsConfig[k].name + '</label>';
  }).join("");
}
function toggleAllTeamFilters(s) { Object.keys(teamsConfig).forEach(function(k) { activeTeamFilters[k] = s; }); renderTeamFilterCheckboxes(); renderEmployees(); }

function renderRoleFilterCheckboxes() {
  const c = document.getElementById("roleFilterContainer"); if (!c) return;
  c.innerHTML = roles.map(function(r, i) { return '<label style="display:inline-flex; align-items:center; gap:3px;"><input type="checkbox" ' + (activeRoleFilters[r] !== false ? 'checked' : '') + ' onchange="activeRoleFilters[roles[' + i + ']]=this.checked; renderEmployees();"> ' + r + '</label>'; }).join("");
}
function toggleAllRoleFilters(s) { roles.forEach(function(r) { activeRoleFilters[r] = s; }); renderRoleFilterCheckboxes(); renderEmployees(); }

function renderLineCheckboxes(selMain, selSec) {
  selMain = selMain || []; selSec = selSec || [];
  const mC = document.getElementById("mainLinesCheckboxes"), sC = document.getElementById("secLinesCheckboxes"); if (!mC || !sC) return;
  const build = function(cls, sel) {
    return lines.map(function(l) {
      return '<label style="font-size:0.78rem; display:inline-flex; align-items:center; gap:3px;"><input type="checkbox" value="' + l.id + '" class="' + cls + '" ' + (sel.indexOf(l.id) !== -1 ? 'checked' : '') + '> ' + l.name + '</label>';
    }).join("");
  };
  mC.innerHTML = build("main-line-chk", selMain); sC.innerHTML = build("sec-line-chk", selSec);
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

window.saveLineDetails = function(keepOpen) {
  const l = lines.find(function(x) { return x.id === document.getElementById("editLineId").value; }); if (!l) return;
  l.prio = document.getElementById("editLinePrio").value;
  l.tag = document.getElementById("editLineTag").value.trim();
  l.note = document.getElementById("editLineNote").value.trim();
  saveToFirebase(); initBoard();
  if (!keepOpen) closeModal("lineEditModal");
};

function openSettingsModal() {
  if (plannerLevel < 2) return;
  renderSettingsLists();
  updateAutoRotationUI();
  const secChk = document.getElementById("secBoardPwEnabled");
  const secVal = document.getElementById("secBoardPwValue");
  if (secChk) secChk.checked = !!(securityConfig && securityConfig.boardPwEnabled);
  if (secVal) secVal.value = (securityConfig && securityConfig.boardPw) ? securityConfig.boardPw : "0110";
  document.getElementById("settingsModal").style.display = "flex";
}

function switchTab(t, btnEl) {
  document.querySelectorAll(".tab-btn").forEach(function(b) { b.classList.remove("active"); });
  if (btnEl) btnEl.classList.add("active");
  document.querySelectorAll(".tab-content").forEach(function(c) { c.classList.remove("active"); });
  const target = document.getElementById(t);
  if (target) target.classList.add("active");
  renderSettingsLists();
}

function updateRoleDropdown() {
  const sel = document.getElementById("newEmpRole"); if (!sel) return;
  sel.innerHTML = roles.map(function(r) { return '<option value="' + r + '">' + r + '</option>'; }).join("");
}

function renderSettingsLists() {
  const empListEl = document.getElementById("employeeList");
  if (empListEl) {
    const filtered = employees.filter(function(e) {
      return !settingsEmpSearchQuery || fullName(e).toLowerCase().indexOf(settingsEmpSearchQuery) !== -1;
    });
    empListEl.innerHTML = filtered.map(function(e) {
      return '<div class="item-row">' +
        '<span><b>' + fullName(e) + '</b> <small style="color:#64748b;">(' + (teamsConfig[e.team] ? teamsConfig[e.team].name : e.team) + ' · ' + e.role + ')</small></span>' +
        '<div style="display:flex; gap:6px;">' +
          '<button class="btn btn-outline" style="padding:2px 8px; font-size:0.75rem;" onclick="editEmployee(\'' + e.id + '\')">✏️</button>' +
          '<button class="btn btn-outline" style="padding:2px 8px; font-size:0.75rem; color:#dc2626;" onclick="deleteEmployee(\'' + e.id + '\')">🗑️</button>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  const roleListEl = document.getElementById("roleList");
  if (roleListEl) {
    roleListEl.innerHTML = roles.map(function(r, idx) {
      return '<div class="item-row">' +
        '<span><b>' + r + '</b></span>' +
        '<div style="display:flex; gap:4px;">' +
          '<button class="btn btn-outline" style="padding:2px 7px; font-size:0.72rem;" onclick="moveRole(' + idx + ', -1)">⬆️</button>' +
          '<button class="btn btn-outline" style="padding:2px 7px; font-size:0.72rem;" onclick="moveRole(' + idx + ', 1)">⬇️</button>' +
          '<button class="btn btn-outline" style="padding:2px 7px; font-size:0.72rem; color:#dc2626;" onclick="deleteRole(' + idx + ')">🗑️</button>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  const lineListEl = document.getElementById("lineSettingsList");
  if (lineListEl) {
    lineListEl.innerHTML = lines.map(function(l, idx) {
      return '<div class="item-row">' +
        '<span><b>' + l.name + '</b> ' + (l.prio ? '<small style="color:#dc2626; font-weight:700;">[' + l.prio + ']</small>' : '') + '</span>' +
        '<div style="display:flex; gap:4px;">' +
          '<button class="btn btn-outline" style="padding:2px 7px; font-size:0.72rem;" onclick="moveLine(' + idx + ', -1)">⬆️</button>' +
          '<button class="btn btn-outline" style="padding:2px 7px; font-size:0.72rem;" onclick="moveLine(' + idx + ', 1)">⬇️</button>' +
          '<button class="btn btn-outline" style="padding:2px 7px; font-size:0.72rem; color:#dc2626;" onclick="deleteLine(\'' + l.id + '\')">🗑️</button>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  const teamListEl = document.getElementById("teamSettingsList");
  if (teamListEl) {
    const keys = Object.keys(teamsConfig).sort();
    teamListEl.innerHTML = keys.map(function(k) {
      const t = teamsConfig[k];
      const rotChk = t.rotates !== false ? "checked" : "";
      return '<div class="item-row">' +
        '<div style="display:flex; align-items:center; gap:8px;">' +
          '<input type="color" value="' + (t.color || '#0091df') + '" style="width:26px; height:26px; border:none; cursor:pointer; background:none;" onchange="updateTeamColor(\'' + k + '\', this.value)">' +
          '<b>' + t.name + '</b>' +
        '</div>' +
        '<div style="display:flex; align-items:center; gap:10px;">' +
          '<label style="font-size:0.8rem; display:flex; align-items:center; gap:4px; cursor:pointer;">' +
            '<input type="checkbox" ' + rotChk + ' onchange="toggleTeamRotateSetting(\'' + k + '\', this.checked)"> Rotiert mit' +
          '</label>' +
          '<button class="btn btn-outline" style="padding:2px 7px; font-size:0.72rem; color:#dc2626;" onclick="deleteTeam(\'' + k + '\')" title="Team löschen">🗑️</button>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  filterHistoryUnified();

  const backupListEl = document.getElementById("backupList");
  if (backupListEl) {
    backupListEl.innerHTML = backups.length ? backups.map(function(b) {
      return '<div class="item-row">' +
        '<div><b>' + b.label + '</b><br><small style="color:#64748b;">' + b.time + ' · ' + (b.empCount || 0) + ' Mitarbeiter</small></div>' +
        '<div style="display:flex; gap:6px;">' +
          '<button class="btn btn-outline" style="padding:3px 8px; font-size:0.74rem; color:var(--bayer-blue);" onclick="restoreBackup(\'' + b.id + '\')">Wiederherstellen</button>' +
          '<button class="btn btn-outline" style="padding:3px 8px; font-size:0.74rem; color:#dc2626;" onclick="deleteBackup(\'' + b.id + '\')">🗑️</button>' +
        '</div>' +
      '</div>';
    }).join("") : '<p style="font-size:0.82rem; color:#64748b;">Noch keine Backups vorhanden.</p>';
  }

  const profBox = document.getElementById("profileInfoBox");
  if (profBox) {
    profBox.innerHTML = '<b>Angemeldet als:</b> ' + (currentPlannerName || "Admin") + ' <span style="color:#64748b;">(Stufe ' + (plannerLevel || 3) + ')</span>';
  }
}

window.moveRole = function(idx, dir) {
  const target = idx + dir;
  if (target < 0 || target >= roles.length) return;
  const temp = roles[idx]; roles[idx] = roles[target]; roles[target] = temp;
  saveToFirebase(); initBoard();
};

window.deleteRole = function(idx) {
  if (roles.length <= 1) return;
  roles.splice(idx, 1);
  saveToFirebase(); initBoard();
};

window.moveLine = function(idx, dir) {
  const target = idx + dir;
  if (target < 0 || target >= lines.length) return;
  const temp = lines[idx]; lines[idx] = lines[target]; lines[target] = temp;
  saveToFirebase(); initBoard();
};

window.deleteLine = function(id) {
  if (lines.length <= 1) return;
  lines = lines.filter(function(l) { return l.id !== id; });
  saveToFirebase(); initBoard();
};

window.updateTeamColor = function(teamKey, newColor) {
  if (teamsConfig[teamKey]) {
    teamsConfig[teamKey].color = newColor;
    saveToFirebase(); initBoard();
  }
};

window.toggleTeamRotateSetting = function(teamKey, rotates) {
  if (teamsConfig[teamKey]) {
    teamsConfig[teamKey].rotates = rotates;
    saveToFirebase(); initBoard();
  }
};

window.deleteTeam = function(teamKey) {
  if (Object.keys(teamsConfig).length <= 1) return;
  delete teamsConfig[teamKey];
  delete activeTeamFilters[teamKey];
  saveToFirebase(); initBoard();
};

window.filterHistoryUnified = function() {
  const listEl = document.getElementById("historyList");
  if (!listEl) return;
  const qEl = document.getElementById("historyUnifiedInput");
  const q = qEl ? qEl.value.trim().toLowerCase() : "";
  const filtered = historyLogs.filter(function(h) {
    if (!q) return true;
    return (h.action || "").toLowerCase().indexOf(q) !== -1 || (h.details || "").toLowerCase().indexOf(q) !== -1 || (h.user || "").toLowerCase().indexOf(q) !== -1;
  });
  listEl.innerHTML = filtered.length ? filtered.map(function(h) {
    return '<div class="item-row" style="flex-direction:column; align-items:flex-start; gap:2px;">' +
      '<div style="display:flex; justify-content:space-between; width:100%; font-size:0.75rem; color:#64748b;"><span><b>' + h.user + '</b> · ' + h.action + '</span><span>' + h.time + '</span></div>' +
      '<div style="font-size:0.82rem; color:#1e293b;">' + h.details + '</div>' +
    '</div>';
  }).join("") : '<p style="font-size:0.82rem; color:#64748b;">Keine Einträge gefunden.</p>';
};

window.createManualBackup = function() {
  const b = {
    id: "bk_" + Date.now(),
    time: new Date().toLocaleString("de-DE"),
    label: "Backup (" + (currentPlannerName || "Admin") + ")",
    empCount: employees.length,
    snapshot: JSON.stringify({ lines: lines, roles: roles, teamsConfig: teamsConfig, employees: employees, shiftRotation: shiftRotation })
  };
  backups.unshift(b);
  if (backups.length > 15) backups = backups.slice(0, 15);
  logHistory("Backup", "Manuelles Backup erstellt");
  saveToFirebase(); renderSettingsLists();
};

window.restoreBackup = function(id) {
  const b = backups.find(function(x) { return x.id === id; });
  if (!b || !b.snapshot) return;
  try {
    const data = JSON.parse(b.snapshot);
    if (data.lines) lines = data.lines;
    if (data.roles) roles = data.roles;
    if (data.teamsConfig) teamsConfig = data.teamsConfig;
    if (data.employees) employees = data.employees;
    if (data.shiftRotation) shiftRotation = data.shiftRotation;
    logHistory("Backup", "Backup wiederhergestellt");
    saveToFirebase(); initBoard();
  } catch (e) { console.error(e); }
};

window.deleteBackup = function(id) {
  backups = backups.filter(function(x) { return x.id !== id; });
  saveToFirebase(); renderSettingsLists();
};

window.saveProfilePinChange = function() {
  const oldP = document.getElementById("profOldPin").value.trim();
  const newP = document.getElementById("newNewPin").value.trim();
  const confP = document.getElementById("profNewPinConfirm").value.trim();
  if (!newP || newP.length < 4 || newP !== confP) {
    showTimedBoxMsg("profPinMsg", "❌ Neue PIN muss mind. 4 Zeichen haben und übereinstimmen!", false); return;
  }
  const emp = employees.find(function(e) { return e.id === currentPlannerEmpId; });
  if (!emp) {
    showTimedBoxMsg("profPinMsg", "ℹ️ Als System-Admin bitte einen persönlichen Planer-Account nutzen.", false); return;
  }
  if ((emp.password || "1234") !== oldP) {
    showTimedBoxMsg("profPinMsg", "❌ Aktuelle PIN ist falsch!", false); return;
  }
  emp.password = newP; emp.mustChangePw = false;
  document.getElementById("profOldPin").value = "";
  document.getElementById("newNewPin").value = "";
  document.getElementById("profNewPinConfirm").value = "";
  saveToFirebase();
  showTimedBoxMsg("profPinMsg", "✅ PIN erfolgreich geändert!", true);
};

window.filterSettingsEmployees = function(val) {
  settingsEmpSearchQuery = (val || "").trim().toLowerCase();
  renderSettingsLists();
};

window.editEmployee = function(id) {
  const emp = employees.find(function(e) { return e.id === id; }); if (!emp) return;
  document.getElementById("editEmpId").value = emp.id;
  document.getElementById("newEmpFirstName").value = emp.firstName || "";
  document.getElementById("newEmpLastName").value = emp.lastName || "";
  document.getElementById("newEmpTeam").value = emp.team || "team-1";
  document.getElementById("newEmpRole").value = emp.role || roles[0];
  document.getElementById("newEmpAccessLevel").value = String(emp.accessLevel || 1);
  if (document.getElementById("newEmpFirstAider")) document.getElementById("newEmpFirstAider").checked = !!emp.ersthelfer;
  document.getElementById("newEmpNoRotation").checked = !!emp.noRotation;
  renderLineCheckboxes(emp.mainLines || [], emp.secLines || []);
  const cancelBtn = document.getElementById("btnCancelEditEmp");
  if (cancelBtn) cancelBtn.style.display = "inline-block";
};

window.deleteEmployee = function(id) {
  employees = employees.filter(function(e) { return e.id !== id; });
  saveToFirebase(); initBoard();
};

function addTeam() {
  const name = document.getElementById("newTeamName").value.trim();
  const color = document.getElementById("newTeamColor").value;
  const rotates = document.getElementById("newTeamRotates").checked;
  if (!name) return;
  const k = "team_" + Date.now();
  teamsConfig[k] = { name: name, color: color, rotates: rotates };
  activeTeamFilters[k] = true;
  document.getElementById("newTeamName").value = "";
  saveToFirebase(); initBoard();
}

function addLine() {
  const inp = document.getElementById("newLineName");
  const name = inp ? inp.value.trim() : ""; if (!name) return;
  lines.push({ id: "L_" + Date.now(), name: name, prio: "", tag: "", note: "" });
  inp.value = "";
  saveToFirebase(); initBoard();
}

function addRole() {
  const inp = document.getElementById("newRoleName");
  const val = inp ? inp.value.trim() : ""; if (!val || roles.indexOf(val) !== -1) return;
  roles.push(val); activeRoleFilters[val] = true; inp.value = "";
  saveToFirebase(); initBoard();
}

function saveEmployee() {
  const idInp = document.getElementById("editEmpId").value;
  const fName = document.getElementById("newEmpFirstName").value.trim(), lName = document.getElementById("newEmpLastName").value.trim();
  const team = document.getElementById("newEmpTeam").value, role = document.getElementById("newEmpRole").value;
  const lvl = Number(document.getElementById("newEmpAccessLevel").value) || 1;
  const isFirstAider = document.getElementById("newEmpFirstAider") ? document.getElementById("newEmpFirstAider").checked : false;
  const isFix = document.getElementById("newEmpNoRotation").checked;
  const mLines = Array.from(document.querySelectorAll(".main-line-chk:checked")).map(function(c) { return c.value; });
  const sLines = Array.from(document.querySelectorAll(".sec-line-chk:checked")).map(function(c) { return c.value; });
  if (!fName && !lName) return;

  if (idInp) {
    const emp = employees.find(function(e) { return e.id === idInp; });
    if (emp) {
      emp.firstName = fName; emp.lastName = lName; emp.team = team; emp.role = role;
      emp.accessLevel = lvl; emp.ersthelfer = isFirstAider; emp.noRotation = isFix;
      emp.mainLines = mLines; emp.secLines = sLines;
    }
  } else {
    employees.push({
      id: "e_" + Date.now(), firstName: fName, lastName: lName, team: team, role: role, accessLevel: lvl,
      password: "1234", mustChangePw: true, ersthelfer: isFirstAider, noRotation: isFix,
      mainLines: mLines, secLines: sLines, zone: "pool"
    });
  }
  resetEmpForm(); saveToFirebase(); initBoard();
}

function resetEmpForm() {
  if (document.getElementById("editEmpId")) document.getElementById("editEmpId").value = "";
  if (document.getElementById("newEmpFirstName")) document.getElementById("newEmpFirstName").value = "";
  if (document.getElementById("newEmpLastName")) document.getElementById("newEmpLastName").value = "";
  if (document.getElementById("newEmpFirstAider")) document.getElementById("newEmpFirstAider").checked = false;
  if (document.getElementById("newEmpNoRotation")) document.getElementById("newEmpNoRotation").checked = false;
  const cancelBtn = document.getElementById("btnCancelEditEmp");
  if (cancelBtn) cancelBtn.style.display = "none";
  renderLineCheckboxes([], []);
}

function autoSaveSecurityConfig() {
  const chk = document.getElementById("secBoardPwEnabled");
  const pwInp = document.getElementById("secBoardPwValue");
  securityConfig.boardPwEnabled = chk ? chk.checked : false;
  securityConfig.boardPw = pwInp ? pwInp.value.trim() : "0110";
  saveToFirebase();
}
