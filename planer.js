/* ==========================================================================
   PLANER-BOARD LOGIK (planer.js) - Vollständige & Stabile Version
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
let employees = [], sickLeaves = [], leaveRequests = [], extraShifts = [], historyLogs = [];
let teamsConfig = {
  "team-1": { name: "Team 1", color: "#0091df", rotates: true },
  "team-2": { name: "Team 2", color: "#f59e0b", rotates: true },
  "team-3": { name: "Team 3", color: "#10b981", rotates: true },
  "team-4": { name: "Team 4", color: "#f43f5e", rotates: true }
};
let securityConfig = { boardPwEnabled: false, boardPw: "0110", plannerTimeoutMin: 180 };

let hasLoadedFromCloud = false;
let activeTeamFilters = {}, activeRoleFilters = {}, poolSearchQuery = "";
let inboxSearchQuery = "", inboxUnreadFilter = "all", inboxActiveFilter = "all";
let selectedManualSickEmpId = null, selectedLoginPlannerId = null;
let isPlanner = false, plannerLevel = 0, currentPlannerName = "", currentPlannerEmpId = null;
let sortableInstances = [];
let toastTimer = null;

function getCurrentActiveShiftId() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 13) return "frueh";
  if (hour >= 13 && hour < 21) return "spaet";
  return "nacht";
}

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
  const activeShift = getCurrentActiveShiftId();
  el.textContent = dateStr + " · KW " + getCalendarWeek(now) + " (" + shiftsLabel[activeShift] + " aktiv)";
}

function showToast(msg) {
  const t = document.getElementById("toastBanner");
  if (!t) return;
  if (toastTimer) clearTimeout(toastTimer);
  t.textContent = msg;
  t.style.display = "block";
  toastTimer = setTimeout(function() { t.style.display = "none"; }, 4000);
}

function showTimedBoxMsg(elId, text, isSuccess) {
  const box = document.getElementById(elId);
  if (!box) return;
  box.style.background = isSuccess ? "#dcfce7" : "#fee2e2";
  box.style.color = isSuccess ? "#166534" : "#b91c1c";
  box.textContent = text;
  box.style.display = "block";
  setTimeout(function() { box.style.display = "none"; }, 5000);
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = "none";
  if (id === "settingsModal") resetEmpForm();
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

window.openPlannerLoginFromLock = function() {
  handleLogoClick();
};

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

  renderEmployees(); initDragAndDrop(); updateRoleDropdown(); updateTeamDropdowns(); renderTeamFilterCheckboxes(); renderRoleFilterCheckboxes(); applyTeamStyles(); renderLineCheckboxes(); updateInboxBadge(); checkBoardLockState();
}

function renderEmployees() {
  document.querySelectorAll(".drop-zone").forEach(function(el) { el.innerHTML = ""; });
  const today = getTodayIso();
  const displayList = employees.slice();

  displayList.forEach(function(emp) {
    const fName = fullName(emp);
    if (isPlanner && emp.zone === "pool") {
      if (activeTeamFilters[emp.team] === false || activeRoleFilters[emp.role] === false) return;
      if (poolSearchQuery) {
        const nMatch = fName.toLowerCase().indexOf(poolSearchQuery) !== -1;
        const pMatch = emp.mainLines && emp.mainLines.some(function(id) { const l = lines.find(function(x){return x.id===id;}); return l && l.name.toLowerCase().indexOf(poolSearchQuery) !== -1; });
        if (!nMatch && !pMatch) return;
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

    const fixHtml = emp.noRotation ? '<span class="card-fix-tag">⚓ Fix</span>' : '';
    const activeSl = sickLeaves.find(function(sl) { return sl.empId === emp.id && sl.startDate <= today && sl.endDate >= today; });
    const sickHtml = activeSl ? '<span class="card-sick-tag">Bis ' + formatDateDe(activeSl.endDate) + '</span>' : '';

    card.innerHTML =
      '<div class="card-name">' + fName + '</div>' +
      '<div style="display:flex; justify-content:space-between; align-items:center;">' +
        '<span class="card-role">' + emp.role + '</span>' +
        fixHtml +
      '</div>' +
      (parts.length ? '<div class="card-lines-info">' + parts.join(" | ") + '</div>' : '') +
      sickHtml;

    const targetZone = document.getElementById(emp.zone) || document.getElementById("pool");
    if (targetZone) targetZone.appendChild(card);
  });

  if (document.getElementById("poolCount")) document.getElementById("poolCount").textContent = "(" + (document.getElementById("pool").children.length || 0) + ")";
  if (document.getElementById("extraCount")) document.getElementById("extraCount").textContent = "(" + (document.getElementById("extra").children.length || 0) + ")";
  if (document.getElementById("absentCount")) document.getElementById("absentCount").textContent = "(" + (document.getElementById("absent").children.length || 0) + ")";
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

window.addEventListener("DOMContentLoaded", function() {
  Object.keys(teamsConfig).forEach(function(k) { activeTeamFilters[k] = true; });
  roles.forEach(function(r) { activeRoleFilters[r] = true; });
  updateHeaderDateKw();

  const savedName = sessionStorage.getItem("planner_name");
  const savedLvl = Number(sessionStorage.getItem("planner_level") || 0);
  const savedEmpId = sessionStorage.getItem("planner_emp_id");

  if (savedName && savedLvl >= 2) {
    applyPlannerLoginState(savedName, savedLvl, savedEmpId);
  }

  initBoard();
});

function handleLogoClick() {
  if (!isPlanner) {
    document.getElementById("pinModal").style.display = "flex";
    document.getElementById("loginModalError").style.display = "none";
    document.getElementById("loginPlannerName").value = "";
    document.getElementById("pinInput").value = "";
    document.getElementById("loginPlannerName").focus();
  }
}

function onPlannerLoginInput(val) {
  selectedLoginPlannerId = null;
  const box = document.getElementById("plannerLoginSuggestions"), q = (val || "").trim().toLowerCase();
  if (!employees.length) { box.style.display = "none"; return; }
  const matches = q ? employees.filter(function(e) { return fullName(e).toLowerCase().indexOf(q) !== -1; }) : employees.slice(0, 15);
  if (!matches.length) { box.style.display = "none"; return; }
  box.innerHTML = matches.map(function(e) {
    return '<div class="suggestion-item" onclick="selectPlannerLogin(\'' + e.id + '\')"><span><b>' + fullName(e) + '</b></span></div>';
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
  document.getElementById("plannerStatusBadge").textContent = "👤 " + name;
  checkBoardLockState();
}

function logoutPlanner() {
  isPlanner = false; plannerLevel = 0; currentPlannerName = ""; currentPlannerEmpId = null;
  sessionStorage.removeItem("planner_name"); sessionStorage.removeItem("planner_level"); sessionStorage.removeItem("planner_emp_id");
  document.body.classList.remove("planner-active", "planner-lvl-3");
  closeModal("pinModal"); closeModal("inboxModal"); closeModal("settingsModal");
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
    if (d.shiftRotation && typeof d.shiftRotation === "object") shiftRotation = d.shiftRotation;
    if (d.teamsConfig && typeof d.teamsConfig === "object") teamsConfig = d.teamsConfig;
    if (Array.isArray(d.employees)) employees = d.employees;
    initBoard();
  } catch (err) { console.error(err); }
}

boardRef.onSnapshot(function(doc) {
  if (doc.exists) applyIncomingDocData(doc.data());
});

function saveToFirebase() {
  if (!hasLoadedFromCloud) return;
  boardRef.set({
    lines: lines, roles: roles, employees: employees, teamsConfig: teamsConfig,
    sickLeaves: sickLeaves, leaveRequests: leaveRequests, extraShifts: extraShifts,
    shiftRotation: shiftRotation, securityConfig: securityConfig
  }, { merge: true }).catch(function(err){ console.error(err); });
}

function rotateAllShifts() {
  const slotOrder = ["frueh", "spaet", "nacht", "frei"];
  const activeSlots = slotOrder.filter(function(s) { return shiftRotation[s] && isTeamRotating(shiftRotation[s]); });
  if (activeSlots.length < 2) return;
  const nextShiftRotation = Object.assign({}, shiftRotation);
  activeSlots.forEach(function(fromSlot, idx) {
    const toSlot = activeSlots[(idx + 1) % activeSlots.length];
    nextShiftRotation[toSlot] = shiftRotation[fromSlot];
  });
  shiftRotation = nextShiftRotation;
  saveToFirebase(); initBoard();
}

window.loadTeamToShift = function(slotKey) {
  const sel = document.getElementById("teamSelect_" + slotKey);
  if (sel) { shiftRotation[slotKey] = sel.value; saveToFirebase(); initBoard(); }
};

window.addPortalLeaveRequest = function(empId, start, end, cat, reason) {
  sickLeaves.push({ id: "sl_" + Date.now(), empId: empId, startDate: start, endDate: end, category: cat, reason: reason || "Vom Mitarbeiter beantragt", readByPlanner: false });
  saveToFirebase(); renderEmployees();
};

function updateInboxBadge() {
  const badge = document.getElementById("inboxBadge");
  if (!badge) return;
  const total = sickLeaves.filter(function(sl) { return !sl.readByPlanner; }).length;
  badge.textContent = total;
  badge.style.display = total > 0 ? "inline-flex" : "none";
}

function openInboxModal() {
  document.getElementById("inboxModal").style.display = "flex";
  renderInboxLists();
}

function renderInboxLists() {
  const unreadEl = document.getElementById("unreadSickList");
  const activeEl = document.getElementById("activeSickList");
  if (!unreadEl || !activeEl) return;

  const today = getTodayIso();
  const unread = sickLeaves.filter(function(sl) { return !sl.readByPlanner; });
  const active = sickLeaves.filter(function(sl) { return sl.endDate >= today; });

  unreadEl.innerHTML = unread.length ? unread.map(function(sl) {
    const emp = employees.find(function(e) { return e.id === sl.empId; });
    const name = emp ? fullName(emp) : "Unbekannt";
    return '<div class="sick-card unread"><b>' + name + '</b> (' + (sl.category || 'Abwesend') + ')<br><small>Von ' + formatDateDe(sl.startDate) + ' bis ' + formatDateDe(sl.endDate) + '</small><br><em>' + (sl.reason || '') + '</em><div style="margin-top:6px;"><button class="btn btn-outline" style="padding:2px 8px; font-size:0.7rem;" onclick="markSickRead(\'' + sl.id + '\')">Gelesen</button></div></div>';
  }).join("") : '<p style="font-size:0.82rem; color:#64748b;">Keine offenen Anträge.</p>';

  activeEl.innerHTML = active.length ? active.map(function(sl) {
    const emp = employees.find(function(e) { return e.id === sl.empId; });
    const name = emp ? fullName(emp) : "Unbekannt";
    return '<div class="sick-card"><b>' + name + '</b> (' + (sl.category || 'Abwesend') + ')<br><small>Von ' + formatDateDe(sl.startDate) + ' bis ' + formatDateDe(sl.endDate) + '</small></div>';
  }).join("") : '<p style="font-size:0.82rem; color:#64748b;">Keine aktiven Abwesenheiten.</p>';
}

window.markSickRead = function(id) {
  const sl = sickLeaves.find(function(x) { return x.id === id; });
  if (sl) { sl.readByPlanner = true; saveToFirebase(); renderInboxLists(); updateInboxBadge(); }
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
}

function updatePoolSearch(val) {
  poolSearchQuery = val.trim().toLowerCase();
  renderEmployees();
}

function renderTeamFilterCheckboxes() {
  const c = document.getElementById("teamFilterContainer"); if (!c) return;
  c.innerHTML = Object.keys(teamsConfig).sort().map(function(k) {
    return '<label><input type="checkbox" ' + (activeTeamFilters[k] ? 'checked' : '') + ' onchange="activeTeamFilters[\'' + k + '\']=this.checked; renderEmployees();"> ' + teamsConfig[k].name + '</label>';
  }).join("");
}

function renderRoleFilterCheckboxes() {
  const c = document.getElementById("roleFilterContainer"); if (!c) return;
  c.innerHTML = roles.map(function(r, i) { return '<label><input type="checkbox" ' + (activeRoleFilters[r] ? 'checked' : '') + ' onchange="activeRoleFilters[roles[' + i + ']]=this.checked; renderEmployees();">' + r + '</label>'; }).join("");
}

function updateRoleDropdown() {
  const sel = document.getElementById("newEmpRole"); if (!sel) return;
  sel.innerHTML = roles.map(function(r) { return '<option value="' + r + '">' + r + '</option>'; }).join("");
}

function renderLineCheckboxes(selMain, selSec) {
  selMain = selMain || []; selSec = selSec || [];
  const mC = document.getElementById("mainLinesCheckboxes"), sC = document.getElementById("secLinesCheckboxes"); if (!mC || !sC) return;
  const build = function(cls, sel) {
    return lines.map(function(l) {
      return '<label><input type="checkbox" value="' + l.id + '" class="' + cls + '" ' + (sel.indexOf(l.id) !== -1 ? 'checked' : '') + '> ' + l.name + '</label>';
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

window.saveLineDetails = function() {
  const l = lines.find(function(x) { return x.id === document.getElementById("editLineId").value; }); if (!l) return;
  l.prio = document.getElementById("editLinePrio").value;
  l.tag = document.getElementById("editLineTag").value.trim();
  l.note = document.getElementById("editLineNote").value.trim();
  saveToFirebase(); initBoard(); closeModal("lineEditModal");
};

function openSettingsModal() {
  if (plannerLevel < 2) return;
  document.getElementById("settingsModal").style.display = "flex";
}

function switchTab(t, btnEl) {
  document.querySelectorAll(".tab-btn").forEach(function(b) { b.classList.remove("active"); });
  if (btnEl) btnEl.classList.add("active");
  document.querySelectorAll(".tab-content").forEach(function(c) { c.classList.remove("active"); });
  const target = document.getElementById(t);
  if (target) target.classList.add("active");
}

function autoSaveSecurityConfig() {
  const chk = document.getElementById("secBoardPwEnabled");
  const pwInp = document.getElementById("secBoardPwValue");
  securityConfig.boardPwEnabled = chk ? chk.checked : false;
  securityConfig.boardPw = pwInp ? pwInp.value.trim() : "0110";
  saveToFirebase();
}

function resetEmpForm() {
  document.getElementById("editEmpId").value = "";
  document.getElementById("newEmpFirstName").value = "";
  document.getElementById("newEmpLastName").value = "";
}
