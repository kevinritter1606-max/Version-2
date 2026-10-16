// ============================================================================
// SCHICHT UND LINIENÜBERSICHT - PLANER.JS (VERSION 2.9)
// ============================================================================

const firebaseConfig = {
    apiKey: "AIzaSyBPOYRYyUm5gA-j7YSAZl7EJoxedFhDTl4",
    authDomain: "schichtplan-bayer.firebaseapp.com",
    projectId: "schichtplan-bayer",
    storageBucket: "schichtplan-bayer.firebasestorage.app",
    messagingSenderId: "152929285194",
    appId: "1:152929285194:web:00b73aa6058a70aed3a2b3"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();
const boardDocRef = db.collection("shiftplan").doc("live_board");
const backupsColRef = db.collection("shiftplan_backups");
const historyColRef = db.collection("shiftplan_history");

// ============================================================================
// GLOBALER SYSTEM-STATUS
// ============================================================================

let isCloudDataLoaded = false;
let isRecoveringData = false;
let currentPlanner = null; // Eingeloggter Planer (Stufe 2 oder 3)
let pendingLoginEmployee = null;
let plannerInactivityTimer = null;

// Postfach-Filter & Tabs
let currentInboxTab = "todo";
let currentInboxReqFilter = "all";
let currentInboxActFilter = "all";
let cachedHistoryItems = [];

// Schichten (ohne Uhrzeiten im Namen)
const SHIFTS = [
    { id: "frueh", label: "Früh" },
    { id: "spaet", label: "Spät" },
    { id: "nacht", label: "Nacht" }
];

// Standard-Datenstruktur (wird durch Cloud-Daten überschrieben)
let state = {
    lines: [
        { id: "line_1", name: "Linie 09", prio: "", tag: "", note: "" },
        { id: "line_2", name: "Linie 22", prio: "", tag: "", note: "" },
        { id: "line_3", name: "Linie 34", prio: "", tag: "", note: "" },
        { id: "line_4", name: "Linie 36", prio: "", tag: "", note: "" },
        { id: "line_5", name: "Linie 37", prio: "", tag: "", note: "" },
        { id: "line_6", name: "Linie 39", prio: "", tag: "", note: "" }
    ],
    roles: ["Bediener", "LOP", "TL", "Schichtexperte", "Waschraumoperator"],
    teamsConfig: {
        team1: { name: "Team 1", color: "#3b82f6", rotates: true },
        team2: { name: "Team 2", color: "#f59e0b", rotates: true },
        team3: { name: "Team 3", color: "#10b981", rotates: true },
        team4: { name: "Team 4", color: "#ef4444", rotates: true },
        tagschicht: { name: "TagSchicht", color: "#8b5cf6", rotates: false }
    },
    shiftRotation: {
        frueh: "team1",
        spaet: "team2",
        nacht: "team3",
        frei: "team4"
    },
    autoShiftConfig: {
        enabled: false,
        model: "bayer_222_4team",
        startDate: "2026-01-12",
        teamOrder: ["team1", "team2", "team3", "team4"],
        cycleOffset: 0,
        lastAppliedBlockKey: ""
    },
    shiftApproval: {
        approved: false,
        windowId: "",
        shiftKey: "frueh",
        shiftLabel: "Frühschicht",
        approvedBy: "",
        approvedAt: "",
        timestamp: 0
    },
    securityConfig: {
        boardPwEnabled: false,
        boardPw: "",
        plannerTimeoutMin: 15,
        portalTimeoutMin: 10
    },
    employees: [],
    sickLeaves: [],
    leaveRequests: [],
    extraShifts: []
};

let activeTeamFilters = new Set();
let activeRoleFilters = new Set();

// ============================================================================
// HILFSFUNKTIONEN & DATUMS-/SCHICHT-MATHEMATIK
// ============================================================================

function showToast(msg, borderColor = "#0091df") {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const el = document.createElement("div");
    el.className = "toast-msg";
    el.style.borderLeftColor = borderColor;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
        el.style.opacity = "0";
        el.style.transition = "opacity 0.3s";
        setTimeout(() => el.remove(), 300);
    }, 3200);
}

function toIsoDate(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, "0");
    const d = String(dateObj.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function getTodayIso() {
    return toIsoDate(new Date());
}

function formatDateDE(isoStr) {
    if (!isoStr) return "-";
    const parts = isoStr.split("-");
    if (parts.length !== 3) return isoStr;
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function getCalendarWeek(dateObj) {
    const d = new Date(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// Effektives Schicht-Datum: Schaltet exakt um 05:00 Uhr morgens auf den neuen Tag um!
function getEffectiveShiftDate(now = new Date()) {
    const eff = new Date(now);
    if (eff.getHours() < 5) {
        eff.setDate(eff.getDate() - 1);
    }
    eff.setHours(12, 0, 0, 0);
    return eff;
}

// Aktuelles Schichtfenster (Umschaltung immer 1h vor Schichtbeginn: 05:00, 13:00, 21:00 Uhr)
function getCurrentShiftWindow(now = new Date()) {
    const h = now.getHours();
    const effDateIso = toIsoDate(getEffectiveShiftDate(now));

    if (h >= 5 && h < 13) {
        return {
            shiftKey: "frueh",
            label: "Frühschicht",
            shortLabel: "Früh",
            isPrepHour: h === 5, // 05:00 - 05:59 Uhr (1h vor Schichtbeginn)
            windowId: `${effDateIso}_frueh`
        };
    } else if (h >= 13 && h < 21) {
        return {
            shiftKey: "spaet",
            label: "Spätschicht",
            shortLabel: "Spät",
            isPrepHour: h === 13, // 13:00 - 13:59 Uhr (1h vor Schichtbeginn)
            windowId: `${effDateIso}_spaet`
        };
    } else {
        // 21:00 bis 04:59 Uhr -> Nachtschicht
        const nightStartDate = new Date(now);
        if (h < 5) {
            nightStartDate.setDate(nightStartDate.getDate() - 1);
        }
        const nightIso = toIsoDate(nightStartDate);
        return {
            shiftKey: "nacht",
            label: "Nachtschicht",
            shortLabel: "Nacht",
            isPrepHour: h === 21, // 21:00 - 21:59 Uhr (1h vor Schichtbeginn)
            windowId: `${nightIso}_nacht`
        };
    }
}

// ============================================================================
// DER GEKNACKTE 2-2-2 SCHICHT-ALGORITHMUS (JAHRESPLAN 2025 / 2026 / FF.)
// ============================================================================

function getBayer222BlockInfo(effectiveDate = getEffectiveShiftDate()) {
    // Referenz-Montag: 12.01.2026 (Woche A: Mo/Di = Früh, Mi/Do = Spät, Fr/Sa = Nacht)
    // Identisch mit 13.01.2025 und 19.10.2026
    const anchorMonday = new Date(2026, 0, 12, 12, 0, 0, 0);
    const d = new Date(effectiveDate.getFullYear(), effectiveDate.getMonth(), effectiveDate.getDate(), 12, 0, 0, 0);

    // Wochentag (Mo=0 ... So=6)
    const jsDay = d.getDay();
    const mondayBasedDay = (jsDay + 6) % 7;

    // Montag der aktuellen Woche berechnen
    const currentMonday = new Date(d);
    currentMonday.setDate(d.getDate() - mondayBasedDay);

    const diffWeeks = Math.round((currentMonday - anchorMonday) / (7 * 86400000));

    // 3 feste Blöcke pro Woche:
    // Block 0: Montag (0) & Dienstag (1)
    // Block 1: Mittwoch (2) & Donnerstag (3)
    // Block 2: Freitag (4), Samstag (5) & Sonntag (6 - Pause/Auslauf Nachtschicht)
    let blockInWeek = 0;
    let blockName = "Mo/Di-Block";
    if (mondayBasedDay === 0 || mondayBasedDay === 1) {
        blockInWeek = 0;
        blockName = "Mo/Di-Block";
    } else if (mondayBasedDay === 2 || mondayBasedDay === 3) {
        blockInWeek = 1;
        blockName = "Mi/Do-Block";
    } else {
        blockInWeek = 2;
        blockName = mondayBasedDay === 6 ? "Sonntag (Ruhetag / Auslauf Fr/Sa-Nacht)" : "Fr/Sa-Block";
    }

    const totalBlockIndex = diffWeeks * 3 + blockInWeek;
    // Positiver Modulo 4 (0 = Früh, 1 = Spät, 2 = Nacht, 3 = Frei)
    const baseStateIndex = ((totalBlockIndex % 4) + 4) % 4;
    const blockKey = `${toIsoDate(currentMonday)}_B${blockInWeek}`;

    return {
        blockKey,
        blockInWeek,
        blockName,
        isSunday: mondayBasedDay === 6,
        baseStateIndex,
        effectiveIso: toIsoDate(d)
    };
}

function calculateTargetShiftRotation(now = new Date()) {
    const cfg = state.autoShiftConfig || {};
    const rotatingTeams = Object.keys(state.teamsConfig).filter(k => state.teamsConfig[k] && state.teamsConfig[k].rotates);
    const teamOrder = (cfg.teamOrder && cfg.teamOrder.length === 4 && cfg.teamOrder.every(k => rotatingTeams.includes(k)))
        ? cfg.teamOrder
        : rotatingTeams.slice(0, 4);

    if (teamOrder.length < 4) {
        return null;
    }

    const effDate = getEffectiveShiftDate(now);

    if (cfg.model === "weekly_3shift") {
        const startStr = cfg.startDate || "2026-01-05";
        const parts = startStr.split("-").map(Number);
        const startObj = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1, 12, 0, 0, 0);
        const diffWeeks = Math.floor((effDate - startObj) / (7 * 86400000));
        const step = (((diffWeeks + (cfg.cycleOffset || 0)) % 4) + 4) % 4;

        // Bei jeder Stufe rückt jedes Team eine Position weiter (Früh -> Spät -> Nacht -> Frei)
        const states = ["frueh", "spaet", "nacht", "frei"];
        const result = {};
        teamOrder.forEach((teamKey, idx) => {
            const stateIdx = ((step - idx) % 4 + 4) % 4;
            result[states[stateIdx]] = teamKey;
        });
        return {
            rotation: result,
            blockKey: `WEEK_${diffWeeks}_OFF_${cfg.cycleOffset || 0}`,
            description: `Wochen-Rotation (Schichttag ${formatDateDE(toIsoDate(effDate))})`
        };
    }

    // Standard: Echtes Bayer 4-Gruppen 2-2-2 Modell (Mo/Di, Mi/Do, Fr/Sa)
    const info = getBayer222BlockInfo(effDate);
    const step = ((info.baseStateIndex + (cfg.cycleOffset || 0)) % 4 + 4) % 4;

    // Stationen: 0 = Früh, 1 = Spät, 2 = Nacht, 3 = Frei
    // Team 1 (Index 0) ist auf Station `step`.
    // Damit beim nächsten Block (+1) das Team aus Früh in Spät wandert, hat Team i den Zustand (step + i) % 4:
    const states = ["frueh", "spaet", "nacht", "frei"];
    const result = {};
    teamOrder.forEach((teamKey, idx) => {
        const stateIdx = (step + idx) % 4;
        result[states[stateIdx]] = teamKey;
    });

    return {
        rotation: result,
        blockKey: `${info.blockKey}_OFF_${cfg.cycleOffset || 0}`,
        description: `${info.blockName} (Schichttag ab 05:00 Uhr: ${formatDateDE(info.effectiveIso)})`
    };
}

// Prüft, ob die automatische Schicht-Rotation einen neuen Block erreicht hat (ab 05:00 Uhr)
function checkAndRunAutoShiftRotation() {
    if (!isCloudDataLoaded || !state.autoShiftConfig || !state.autoShiftConfig.enabled) {
        updateAutoShiftBadge();
        return;
    }

    const calc = calculateTargetShiftRotation(new Date());
    if (!calc) {
        updateAutoShiftBadge();
        return;
    }

    if (state.autoShiftConfig.lastAppliedBlockKey !== calc.blockKey) {
        applyRotationMappingToBoard(calc.rotation);
        state.autoShiftConfig.lastAppliedBlockKey = calc.blockKey;
        saveToFirebase(false);
        showToast(`🤖 Automatischer Schichtwechsel (${calc.description}) durchgeführt`, "#0091df");
    }
    updateAutoShiftBadge();
}

function applyRotationMappingToBoard(newRotationMap) {
    const oldRotation = { ...state.shiftRotation };
    state.shiftRotation = { ...newRotationMap };

    // Bestimme für jedes rotierende Team, von welcher Schicht in welche Schicht es gewechselt ist
    const teamToNewShift = {};
    Object.entries(newRotationMap).forEach(([shiftKey, teamKey]) => {
        if (teamKey) teamToNewShift[teamKey] = shiftKey;
    });

    state.employees.forEach(emp => {
        if (emp.noRotation) return;
        const tCfg = state.teamsConfig[emp.team];
        if (!tCfg || !tCfg.rotates) return;
        if (emp.zone === "absent" || emp.zone === "extra") return;

        const targetShift = teamToNewShift[emp.team];
        if (!targetShift) return;

        if (targetShift === "frei") {
            emp.zone = "pool";
        } else if (emp.zone && emp.zone.includes("__")) {
            const [lineId] = emp.zone.split("__");
            emp.zone = `${lineId}__${targetShift}`;
        } else if (emp.zone === "pool") {
            // Wenn das Team aus Frei in eine aktive Schicht wechselt und eine Stammlinie hat:
            if (Array.isArray(emp.mainLines) && emp.mainLines.length > 0) {
                const firstMainLine = emp.mainLines[0];
                const lineExists = state.lines.some(l => l.id === firstMainLine);
                if (lineExists) {
                    emp.zone = `${firstMainLine}__${targetShift}`;
                }
            }
        }
    });
}

// ============================================================================
// SICHERHEITS-WÄCHTER (INTEGRITÄTSSCHUTZ FÜR SCHICHT-AUTOMATIK)
// ============================================================================

function confirmAutoShiftOverride(reasonText) {
    if (!state.autoShiftConfig || !state.autoShiftConfig.enabled) {
        return true; // Automatik ist aus -> kein Problem
    }
    const proceed = confirm(
        `⚠️ ACHTUNG – Automatischer Schicht-Generator ist aktiv!\n\n` +
        `Ursache: ${reasonText}\n\n` +
        `Wenn du diese Änderung durchführst, kann das hinterlegte Schichtmodell nicht mehr automatisch weitergeführt werden und die Schicht-Automatik wird sicherheitshalber DEAKTIVIERT.\n\n` +
        `Möchtest du trotzdem fortfahren und die Automatik ausschalten?`
    );
    if (proceed) {
        state.autoShiftConfig.enabled = false;
        updateAutoShiftBadge();
        const toggleEl = document.getElementById("autoShiftEnabledToggle");
        if (toggleEl) toggleEl.checked = false;
        showToast("⚠️ Schicht-Automatik wurde wegen manueller Änderung deaktiviert.", "#f59e0b");
        return true;
    }
    return false;
}

function updateAutoShiftBadge() {
    const badge = document.getElementById("autoShiftStatusBadge");
    if (!badge) return;
    if (state.autoShiftConfig && state.autoShiftConfig.enabled) {
        badge.style.display = "inline-flex";
    } else {
        badge.style.display = "none";
    }
}

// ============================================================================
// SCHICHTPLAN-FREIGABE & 1-STUNDEN-VORHER RESET LOGIK
// ============================================================================

function checkShiftApprovalAutoReset() {
    const win = getCurrentShiftWindow(new Date());
    if (!state.shiftApproval) {
        state.shiftApproval = {
            approved: false,
            windowId: win.windowId,
            shiftKey: win.shiftKey,
            shiftLabel: win.label,
            approvedBy: "",
            approvedAt: "",
            timestamp: 0
        };
    }

    // Automatischer Reset 1h vor nächstem Schichtbeginn (sobald windowId wechselt!)
    if (state.shiftApproval.approved && state.shiftApproval.windowId !== win.windowId) {
        state.shiftApproval.approved = false;
        state.shiftApproval.windowId = win.windowId;
        state.shiftApproval.shiftKey = win.shiftKey;
        state.shiftApproval.shiftLabel = win.label;
        state.shiftApproval.approvedBy = "";
        state.shiftApproval.approvedAt = "";
        if (isCloudDataLoaded) {
            saveToFirebase(false);
        }
    }

    renderShiftStatusBannerAndButton();
}

function renderShiftStatusBannerAndButton() {
    const win = getCurrentShiftWindow(new Date());
    const banner = document.getElementById("shiftStatusBanner");
    const bannerText = document.getElementById("shiftStatusBannerText");
    const bannerMeta = document.getElementById("shiftStatusBannerMeta");
    const btn = document.getElementById("btnApproveShiftPlan");

    const isApprovedForCurrentWindow = Boolean(
        state.shiftApproval &&
        state.shiftApproval.approved &&
        state.shiftApproval.windowId === win.windowId
    );

    // Button im Header für eingeloggten Planer aktualisieren
    if (btn) {
        if (isApprovedForCurrentWindow) {
            btn.className = "btn btn-approve-active";
            btn.innerHTML = `✅ Schichtplan freigegeben (${win.shortLabel})`;
        } else {
            btn.className = "btn btn-approve-pending";
            btn.innerHTML = `☑️ Schichtplan freigeben (${win.shortLabel})`;
        }
    }

    if (!banner || !bannerText || !bannerMeta) return;

    if (isApprovedForCurrentWindow) {
        banner.className = "shift-status-banner status-approved";
        bannerText.innerHTML = `<span class="status-dot-pulse"></span> 🟢 Willkommen zur ${win.label} – Schichtplan freigegeben`;
        bannerMeta.textContent = state.shiftApproval.approvedBy
            ? `Freigegeben von ${state.shiftApproval.approvedBy} um ${state.shiftApproval.approvedAt} (automatischer Reset 1h vor nächster Schicht)`
            : `Offiziell freigegeben`;
    } else if (win.isPrepHour || currentPlanner) {
        banner.className = "shift-status-banner status-prep";
        bannerText.innerHTML = `🕒 Willkommen zur ${win.label} – Schichtplanung in Bearbeitung (noch nicht freigegeben)`;
        bannerMeta.textContent = currentPlanner
            ? `Klicke oben auf „Schichtplan freigeben (${win.shortLabel})“, sobald die Planung steht`
            : `Bitte warten, bis der Schichtplaner den Plan freigibt`;
    } else {
        banner.className = "shift-status-banner";
        banner.style.display = "none";
    }
}

function toggleShiftPlanApproval() {
    if (!currentPlanner) return;
    const win = getCurrentShiftWindow(new Date());
    const isCurrentlyApproved = Boolean(
        state.shiftApproval &&
        state.shiftApproval.approved &&
        state.shiftApproval.windowId === win.windowId
    );

    if (isCurrentlyApproved) {
        state.shiftApproval = {
            approved: false,
            windowId: win.windowId,
            shiftKey: win.shiftKey,
            shiftLabel: win.label,
            approvedBy: "",
            approvedAt: "",
            timestamp: Date.now()
        };
        showToast(`ℹ️ Freigabe für die ${win.label} wurde zurückgenommen.`, "#f59e0b");
    } else {
        const nowStr = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr";
        state.shiftApproval = {
            approved: true,
            windowId: win.windowId,
            shiftKey: win.shiftKey,
            shiftLabel: win.label,
            approvedBy: `${currentPlanner.firstName} ${currentPlanner.lastName}`,
            approvedAt: nowStr,
            timestamp: Date.now()
        };
        showToast(`🟢 Schichtplan für die ${win.label} offiziell freigegeben!`, "#16a34a");
    }

    renderShiftStatusBannerAndButton();
    saveToFirebase(false);
}

// ============================================================================
// FIREBASE SYNCHRONISATION & AUTO-RECOVERY
// ============================================================================

async function attemptAutoRecoveryFromBackups() {
    if (isRecoveringData) return false;
    isRecoveringData = true;
    try {
        const snap = await backupsColRef.orderBy("timestamp", "desc").limit(10).get();
        for (const doc of snap.docs) {
            const bData = doc.data();
            const payload = bData.payload || bData;
            if (payload && Array.isArray(payload.employees) && payload.employees.length > 0) {
                console.warn("Auto-Recovery: Stelle Mitarbeiter aus Backup wieder her:", doc.id);
                applyCloudDataToState(payload);
                isCloudDataLoaded = true;
                await saveToFirebase(false);
                showToast(`🛡️ Auto-Recovery: ${payload.employees.length} Mitarbeiter automatisch aus Backup wiederhergestellt!`, "#16a34a");
                isRecoveringData = false;
                return true;
            }
        }
    } catch (err) {
        console.error("Fehler bei Auto-Recovery:", err);
    }
    isRecoveringData = false;
    return false;
}

function applyCloudDataToState(data) {
    if (!data) return;
    if (Array.isArray(data.lines) && data.lines.length > 0) state.lines = data.lines;
    if (Array.isArray(data.roles) && data.roles.length > 0) state.roles = data.roles;
    if (data.teamsConfig && Object.keys(data.teamsConfig).length > 0) state.teamsConfig = data.teamsConfig;
    if (data.shiftRotation) state.shiftRotation = { ...state.shiftRotation, ...data.shiftRotation };
    if (data.autoShiftConfig) state.autoShiftConfig = { ...state.autoShiftConfig, ...data.autoShiftConfig };
    if (data.shiftApproval) state.shiftApproval = { ...state.shiftApproval, ...data.shiftApproval };
    if (data.securityConfig) state.securityConfig = { ...state.securityConfig, ...data.securityConfig };
    if (Array.isArray(data.employees)) state.employees = data.employees;
    if (Array.isArray(data.sickLeaves)) state.sickLeaves = data.sickLeaves;
    if (Array.isArray(data.leaveRequests)) state.leaveRequests = data.leaveRequests;
    if (Array.isArray(data.extraShifts)) state.extraShifts = data.extraShifts;

    // Standardwerte für Mitarbeiter absichern
    state.employees.forEach(emp => {
        if (!emp.accessLevel) emp.accessLevel = 1;
        if (!emp.password) emp.password = "0000";
        if (!Array.isArray(emp.mainLines)) emp.mainLines = [];
        if (!Array.isArray(emp.secLines)) emp.secLines = [];
        if (!emp.zone) emp.zone = "pool";
    });

    if (activeTeamFilters.size === 0) {
        Object.keys(state.teamsConfig).forEach(k => activeTeamFilters.add(k));
    }
    if (activeRoleFilters.size === 0) {
        state.roles.forEach(r => activeRoleFilters.add(r));
    }
}

async function saveToFirebase(showSuccessToast = false) {
    if (!isCloudDataLoaded) {
        console.warn("Schreibschutz aktiv: Cloud-Daten noch nicht vollständig geladen.");
        return;
    }
    if (!Array.isArray(state.employees) || state.employees.length === 0) {
        console.warn("Schreibschutz: Speichern einer leeren Mitarbeiterliste verhindert.");
        return;
    }

    try {
        await boardDocRef.set({
            lines: state.lines,
            roles: state.roles,
            teamsConfig: state.teamsConfig,
            shiftRotation: state.shiftRotation,
            autoShiftConfig: state.autoShiftConfig,
            shiftApproval: state.shiftApproval,
            securityConfig: state.securityConfig,
            employees: state.employees,
            sickLeaves: state.sickLeaves,
            leaveRequests: state.leaveRequests,
            extraShifts: state.extraShifts,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        if (showSuccessToast) {
            showToast("💾 Änderungen gespeichert", "#16a34a");
        }
        createDailyAutoBackupIfNeeded();
    } catch (err) {
        console.error("Fehler beim Speichern in Firebase:", err);
        showToast("❌ Fehler beim Speichern in der Cloud!", "#ef4444");
    }
}

async function createDailyAutoBackupIfNeeded() {
    if (!isCloudDataLoaded || state.employees.length === 0) return;
    const todayKey = `auto_${getTodayIso()}`;
    const lastBackupLocal = localStorage.getItem("lastAutoBackupKey");
    if (lastBackupLocal === todayKey) return;

    try {
        await backupsColRef.doc(todayKey).set({
            type: "auto_daily",
            createdAtIso: new Date().toISOString(),
            timestamp: Date.now(),
            empCount: state.employees.length,
            payload: JSON.parse(JSON.stringify(state))
        }, { merge: true });
        localStorage.setItem("lastAutoBackupKey", todayKey);
    } catch (e) {
        console.warn("Auto-Backup Hinweis:", e);
    }
}

// ============================================================================
// INITIALISIERUNG & ECHTZEIT-LISTENER
// ============================================================================

function updateHeaderDate() {
    const now = new Date();
    const days = ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."];
    const dayName = days[now.getDay()];
    const dateStr = now.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
    const kw = getCalendarWeek(now);
    const el = document.getElementById("headerDateDisplay");
    if (el) {
        // Cleaner Look ohne Kalender-Icon
        el.textContent = `${dayName}, ${dateStr} · KW ${kw}`;
    }
}

function initBoard() {
    updateHeaderDate();
    setInterval(() => {
        updateHeaderDate();
        checkShiftApprovalAutoReset();
        checkAndRunAutoShiftRotation();
    }, 30000);

    setupInactivityListeners();

    boardDocRef.onSnapshot(async (doc) => {
        if (doc.exists) {
            const data = doc.data();
            if (!data.employees || data.employees.length === 0) {
                const recovered = await attemptAutoRecoveryFromBackups();
                if (recovered) return;
            }
            applyCloudDataToState(data);
            isCloudDataLoaded = true;
        } else {
            await attemptAutoRecoveryFromBackups();
            isCloudDataLoaded = true;
        }

        checkBoardStartPasswordLock();
        syncAbsencesAndExtraShiftsWithZones();
        checkShiftApprovalAutoReset();
        checkAndRunAutoShiftRotation();
        renderFilterCheckboxes();
        renderMatrix();
        renderEmployees();
        updateInboxBadge();

        if (document.getElementById("inboxModal").style.display === "flex") {
            renderInbox();
        }
    }, (err) => {
        console.error("Live-Listener Fehler:", err);
    });
}

window.addEventListener("DOMContentLoaded", initBoard);

// ============================================================================
// START-PASSWORT FÜR DIE ÜBERSICHT & INAKTIVITÄTS-TIMER
// ============================================================================

function checkBoardStartPasswordLock() {
    const modal = document.getElementById("boardLockModal");
    if (!modal) return;
    const cfg = state.securityConfig || {};
    if (cfg.boardPwEnabled && cfg.boardPw && cfg.boardPw.trim() !== "") {
        const unlocked = sessionStorage.getItem("boardViewUnlocked") === "true";
        if (!unlocked && !currentPlanner) {
            modal.style.display = "flex";
            return;
        }
    }
    modal.style.display = "none";
}

function unlockBoardView() {
    const input = document.getElementById("boardLockInput");
    const err = document.getElementById("boardLockError");
    const cfg = state.securityConfig || {};
    if (input && input.value === cfg.boardPw) {
        sessionStorage.setItem("boardViewUnlocked", "true");
        document.getElementById("boardLockModal").style.display = "none";
        if (err) err.style.display = "none";
        input.value = "";
    } else if (err) {
        err.style.display = "block";
    }
}

function setupInactivityListeners() {
    const resetTimer = () => {
        if (!currentPlanner) return;
        if (plannerInactivityTimer) clearTimeout(plannerInactivityTimer);
        const mins = Number(state.securityConfig?.plannerTimeoutMin ?? 15);
        if (mins > 0) {
            plannerInactivityTimer = setTimeout(() => {
                logoutPlanner(true);
            }, mins * 60 * 1000);
        }
    };
    ["mousemove", "mousedown", "keydown", "touchstart", "click"].forEach(evt => {
        window.addEventListener(evt, resetTimer, { passive: true });
    });
}

// ============================================================================
// PLANER-ANMELDUNG & EIGENE PIN ÄNDERN (MIT 3-FACH PRÜFUNG)
// ============================================================================

function handleLogoClick() {
    if (currentPlanner) {
        openSettingsModal();
        return;
    }
    const sel = document.getElementById("loginEmpSelect");
    const planners = state.employees.filter(e => Number(e.accessLevel) >= 2);
    sel.innerHTML = "";
    if (planners.length === 0) {
        const opt = document.createElement("option");
        opt.value = "__admin_fallback__";
        opt.textContent = "System-Admin (Notfall-Login)";
        sel.appendChild(opt);
    } else {
        planners.sort((a, b) => (a.lastName || "").localeCompare(b.lastName || "")).forEach(emp => {
            const opt = document.createElement("option");
            opt.value = emp.id;
            opt.textContent = `${emp.firstName} ${emp.lastName} (Stufe ${emp.accessLevel})`;
            sel.appendChild(opt);
        });
    }
    document.getElementById("pinInput").value = "";
    document.getElementById("pinError").style.display = "none";
    document.getElementById("pinModal").style.display = "flex";
    setTimeout(() => document.getElementById("pinInput").focus(), 80);
}

function closePinModal() {
    document.getElementById("pinModal").style.display = "none";
}

function verifyPin() {
    const selVal = document.getElementById("loginEmpSelect").value;
    const pinVal = document.getElementById("pinInput").value;
    const errEl = document.getElementById("pinError");

    if (selVal === "__admin_fallback__") {
        if (pinVal === "0000" || pinVal === "1234") {
            completePlannerLogin({ id: "admin", firstName: "System", lastName: "Admin", accessLevel: 3 });
            closePinModal();
            return;
        }
        errEl.style.display = "block";
        return;
    }

    const emp = state.employees.find(e => e.id === selVal);
    if (!emp) return;

    if (String(emp.password || "0000") === String(pinVal)) {
        closePinModal();
        if (emp.mustChangePw || emp.password === "0000") {
            pendingLoginEmployee = emp;
            document.getElementById("newPlannerPin1").value = "";
            document.getElementById("newPlannerPin2").value = "";
            document.getElementById("changePinError").style.display = "none";
            document.getElementById("changePinModal").style.display = "flex";
        } else {
            completePlannerLogin(emp);
        }
    } else {
        errEl.style.display = "block";
    }
}

function saveNewPlannerPin() {
    if (!pendingLoginEmployee) return;
    const p1 = document.getElementById("newPlannerPin1").value.trim();
    const p2 = document.getElementById("newPlannerPin2").value.trim();
    const err = document.getElementById("changePinError");

    if (p1.length < 4) {
        err.textContent = "❌ Die neue PIN muss mindestens 4 Zeichen lang sein.";
        err.style.display = "block";
        return;
    }
    if (p1 === "0000") {
        err.textContent = "❌ Bitte wähle aus Sicherheitsgründen nicht 0000.";
        err.style.display = "block";
        return;
    }
    if (p1 !== p2) {
        err.textContent = "❌ Die beiden PIN-Eingaben stimmen nicht überein.";
        err.style.display = "block";
        return;
    }

    const target = state.employees.find(e => e.id === pendingLoginEmployee.id);
    if (target) {
        target.password = p1;
        target.mustChangePw = false;
        saveToFirebase(false);
        completePlannerLogin(target);
    }
    pendingLoginEmployee = null;
    document.getElementById("changePinModal").style.display = "none";
    showToast("🔑 Neue persönliche PIN erfolgreich gespeichert!", "#16a34a");
}

function completePlannerLogin(emp) {
    currentPlanner = emp;
    sessionStorage.setItem("boardViewUnlocked", "true");
    document.body.classList.remove("readonly-mode");

    const badge = document.getElementById("plannerStatusBadge");
    if (badge) {
        badge.style.display = "inline-flex";
        badge.textContent = `👤 ${emp.firstName} ${emp.lastName} (Stufe ${emp.accessLevel})`;
    }
    document.getElementById("headerActions").style.display = "flex";

    renderShiftStatusBannerAndButton();
    renderMatrix();
    renderEmployees();
    updateInboxBadge();
    showToast(`Willkommen, ${emp.firstName}! Planer-Modus aktiviert.`, "#16a34a");
}

function logoutPlanner(isAutoTimeout = false) {
    currentPlanner = null;
    if (plannerInactivityTimer) clearTimeout(plannerInactivityTimer);
    document.body.classList.add("readonly-mode");

    document.getElementById("plannerStatusBadge").style.display = "none";
    document.getElementById("headerActions").style.display = "none";
    closeSettingsModal();
    closeInboxModal();

    renderShiftStatusBannerAndButton();
    renderMatrix();
    renderEmployees();

    if (isAutoTimeout) {
        showToast("⏱️ Automatische Abmeldung wegen Inaktivität.", "#f59e0b");
    } else {
        showToast("Abgemeldet. Schreibschutz aktiv.", "#64748b");
    }
}

function changeOwnPlannerPin() {
    if (!currentPlanner) return;
    const oldPin = document.getElementById("profOldPin").value.trim();
    const new1 = document.getElementById("profNewPin1").value.trim();
    const new2 = document.getElementById("profNewPin2").value.trim();

    const emp = state.employees.find(e => e.id === currentPlanner.id);
    if (!emp) {
        showToast("❌ Profil nicht in Mitarbeiterliste gefunden.", "#ef4444");
        return;
    }
    if (String(emp.password || "0000") !== oldPin) {
        showToast("❌ Die eingegebene aktuelle PIN ist falsch!", "#ef4444");
        return;
    }
    if (new1.length < 4) {
        showToast("❌ Die neue PIN muss mindestens 4 Zeichen lang sein!", "#ef4444");
        return;
    }
    if (new1 !== new2) {
        showToast("❌ Die beiden neuen PINs stimmen nicht überein!", "#ef4444");
        return;
    }

    emp.password = new1;
    emp.mustChangePw = false;
    document.getElementById("profOldPin").value = "";
    document.getElementById("profNewPin1").value = "";
    document.getElementById("profNewPin2").value = "";
    saveToFirebase(false);
    showToast("✅ Deine persönliche PIN wurde erfolgreich geändert!", "#16a34a");
}

// ============================================================================
// ABWESENHEITEN & BRINGSCHICHTEN AUTOMATISCH SYNCHRONISIEREN
// ============================================================================

function getActiveAbsenceForEmployee(empId, dateIso = getTodayIso()) {
    const sick = state.sickLeaves.find(s => s.empId === empId && s.startDate <= dateIso && s.endDate >= dateIso);
    if (sick) return { type: "sick", category: sick.category || "Krank", item: sick };

    const vac = state.leaveRequests.find(l => l.empId === empId && l.status === "approved" && l.startDate <= dateIso && l.endDate >= dateIso);
    if (vac) return { type: "vacation", category: vac.category || "Urlaub", item: vac };

    return null;
}

function syncAbsencesAndExtraShiftsWithZones() {
    const today = getTodayIso();
    state.employees.forEach(emp => {
        const activeAbs = getActiveAbsenceForEmployee(emp.id, today);
        if (activeAbs) {
            emp.zone = "absent";
        } else if (emp.zone === "absent") {
            // Wenn Zeitraum abgelaufen ist, zurück in den Pool legen
            emp.zone = "pool";
        }
    });
}

// ============================================================================
// FILTER, SIDEBAR & MATRIX RENDERING
// ============================================================================

function renderFilterCheckboxes() {
    const teamContainer = document.getElementById("teamFilterContainer");
    const roleContainer = document.getElementById("roleFilterContainer");
    if (!teamContainer || !roleContainer) return;

    teamContainer.innerHTML = "";
    Object.entries(state.teamsConfig).forEach(([teamKey, cfg]) => {
        const lbl = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = activeTeamFilters.has(teamKey);
        cb.onchange = () => {
            if (cb.checked) activeTeamFilters.add(teamKey);
            else activeTeamFilters.delete(teamKey);
            renderEmployees();
        };
        const dot = document.createElement("span");
        dot.style.cssText = `width:8px;height:8px;border-radius:2px;background:${cfg.color};display:inline-block;`;
        lbl.appendChild(cb);
        lbl.appendChild(dot);
        lbl.appendChild(document.createTextNode(cfg.name));
        teamContainer.appendChild(lbl);
    });

    roleContainer.innerHTML = "";
    state.roles.forEach(role => {
        const lbl = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = activeRoleFilters.has(role);
        cb.onchange = () => {
            if (cb.checked) activeRoleFilters.add(role);
            else activeRoleFilters.delete(role);
            renderEmployees();
        };
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(role));
        roleContainer.appendChild(lbl);
    });

    // Frei-Team Dropdown im Pool-Header aktualisieren
    const selFrei = document.getElementById("selectTeamFrei");
    if (selFrei) {
        selFrei.innerHTML = `<option value="">-- Frei-Team --</option>`;
        Object.entries(state.teamsConfig).forEach(([k, t]) => {
            const opt = document.createElement("option");
            opt.value = k;
            opt.textContent = `🏖️ Frei: ${t.name}`;
            if (state.shiftRotation.frei === k) opt.selected = true;
            selFrei.appendChild(opt);
        });
    }
}

function toggleAllTeamFilters(enable) {
    activeTeamFilters.clear();
    if (enable) Object.keys(state.teamsConfig).forEach(k => activeTeamFilters.add(k));
    renderFilterCheckboxes();
    renderEmployees();
}

function toggleAllRoleFilters(enable) {
    activeRoleFilters.clear();
    if (enable) state.roles.forEach(r => activeRoleFilters.add(r));
    renderFilterCheckboxes();
    renderEmployees();
}

function renderMatrix() {
    const thead = document.getElementById("matrixHead");
    const tbody = document.getElementById("matrixBody");
    if (!thead || !tbody) return;

    const isEditable = Boolean(currentPlanner);

    // HEADER ZEILE
    let headHtml = `<tr><th class="shift-col-header">
        <div style="font-weight:800; margin-bottom:4px;">Schicht</div>
        ${isEditable ? `
            <button class="btn-mini btn-rotate" onclick="rotateShifts()">🔄 Rotieren</button>
            <button class="btn-mini" onclick="clearAllShifts()">🧹 Alle leeren</button>
        ` : ``}
    </th>`;

    state.lines.forEach(line => {
        headHtml += `<th>
            <div style="font-weight:800; color:#0f172a;">${line.name}</div>
            ${line.tag ? `<div class="line-tag-badge">${line.tag}</div>` : ``}
            ${line.prio ? `<div class="line-prio-badge">${line.prio}</div>` : ``}
            ${line.note ? `<div class="line-note-text">${line.note}</div>` : ``}
            ${isEditable ? `
                <div style="margin-top:4px;">
                    <button class="btn-mini" style="font-size:0.65rem; padding:2px 4px;" onclick="quickEditLineHeader('${line.id}')">✏️ Status/Notiz</button>
                </div>
            ` : ``}
        </th>`;
    });
    headHtml += `</tr>`;
    thead.innerHTML = headHtml;

    // SCHICHT-ZEILEN (Früh, Spät, Nacht - ohne Uhrzeiten dahinter)
    let bodyHtml = "";
    SHIFTS.forEach(shift => {
        const assignedTeamKey = state.shiftRotation[shift.id] || "";
        const teamColor = state.teamsConfig[assignedTeamKey]?.color || "#cbd5e1";

        let teamOptions = `<option value="">-- Team wählen --</option>`;
        Object.entries(state.teamsConfig).forEach(([k, t]) => {
            const sel = assignedTeamKey === k ? "selected" : "";
            teamOptions += `<option value="${k}" ${sel}>${t.name}</option>`;
        });

        bodyHtml += `<tr>
            <td class="shift-cell" style="border-left: 5px solid ${teamColor};">
                <div class="shift-name">${shift.label}</div>
                ${isEditable ? `
                    <select class="shift-team-select" onchange="onShiftTeamSelectChange('${shift.id}', this.value)">
                        ${teamOptions}
                    </select>
                    <div style="display:flex; gap:3px;">
                        <button class="btn-mini" title="Stammlinien dieses Teams in diese Schicht laden" onclick="loadTeamToShift('${shift.id}')">📥 Laden</button>
                        <button class="btn-mini" title="Schicht leeren" onclick="clearShiftRow('${shift.id}')">🧹 Leeren</button>
                    </div>
                ` : `
                    <div style="font-size:0.76rem; font-weight:700; color:${teamColor};">
                        ${state.teamsConfig[assignedTeamKey]?.name || "-"}
                    </div>
                `}
            </td>`;

        state.lines.forEach(line => {
            const zoneId = `${line.id}__${shift.id}`;
            bodyHtml += `<td>
                <div id="${zoneId}" class="drop-zone" data-zone="${zoneId}"></div>
            </td>`;
        });

        bodyHtml += `</tr>`;
    });

    tbody.innerHTML = bodyHtml;
    setupDropZones();
}

function quickEditLineHeader(lineId) {
    if (!currentPlanner) return;
    const line = state.lines.find(l => l.id === lineId);
    if (!line) return;

    const newTag = prompt(`Status-Badge für ${line.name} (z.B. Wartung, Steht, oder leer lassen):`, line.tag || "");
    if (newTag === null) return;
    const newPrio = prompt(`Priorität für ${line.name} (z.B. PRIO 1, PRIO 2, oder leer lassen):`, line.prio || "");
    if (newPrio === null) return;
    const newNote = prompt(`Kurze Info/Notiz unter ${line.name} (z.B. 10.000 bis FW):`, line.note || "");
    if (newNote === null) return;

    line.tag = newTag.trim();
    line.prio = newPrio.trim();
    line.note = newNote.trim();
    renderMatrix();
    renderEmployees();
    saveToFirebase(true);
}

function getLineShortNumber(lineId) {
    const line = state.lines.find(l => l.id === lineId);
    if (!line) return "";
    return line.name.replace("Linie", "").trim();
}

function renderEmployees() {
    document.querySelectorAll(".drop-zone").forEach(z => (z.innerHTML = ""));

    const searchVal = (document.getElementById("poolSearchInput")?.value || "").toLowerCase().trim();
    const today = getTodayIso();

    let countPool = 0;
    let countExtra = 0;
    let countAbsent = 0;

    state.employees.forEach(emp => {
        const zoneId = emp.zone || "pool";
        let container = document.getElementById(zoneId);
        if (!container) {
            emp.zone = "pool";
            container = document.getElementById("pool");
        }

        const mainNums = (emp.mainLines || []).map(getLineShortNumber).filter(Boolean);
        const secNums = (emp.secLines || []).map(getLineShortNumber).filter(Boolean);

        if (emp.zone === "pool") {
            if (!activeTeamFilters.has(emp.team)) return;
            if (!activeRoleFilters.has(emp.role)) return;
            if (searchVal) {
                const hay = `${emp.firstName} ${emp.lastName} ${emp.role} ${mainNums.join(" ")} ${secNums.join(" ")}`.toLowerCase();
                if (!hay.includes(searchVal)) return;
            }
            countPool++;
        } else if (emp.zone === "extra") {
            countExtra++;
        } else if (emp.zone === "absent") {
            countAbsent++;
        }

        const teamCfg = state.teamsConfig[emp.team] || { name: emp.team, color: "#94a3b8" };
        const card = document.createElement("div");
        card.className = "emp-card";
        card.style.borderLeftColor = teamCfg.color;
        card.dataset.empId = emp.id;

        if (currentPlanner) {
            card.draggable = true;
            card.addEventListener("dragstart", e => {
                e.dataTransfer.setData("text/plain", emp.id);
            });
        }

        const activeAbs = getActiveAbsenceForEmployee(emp.id, today);

        let linesText = "";
        if (mainNums.length > 0 || secNums.length > 0) {
            const parts = [];
            if (mainNums.length > 0) parts.push(`⭐ ${mainNums.join(", ")}`);
            if (secNums.length > 0) parts.push(`Sek: ${secNums.join(", ")}`);
            linesText = `<div class="emp-lines">${parts.join(" | ")}</div>`;
        }

        card.innerHTML = `
            <div class="emp-card-top">
                <span>${emp.firstName} ${emp.lastName}</span>
                <span style="display:flex; gap:3px; align-items:center;">
                    ${emp.noRotation ? `<span class="emp-badge-fix" title="Fixiert – rotiert nicht mit">⚓ Fix</span>` : ``}
                    ${emp.ersthelfer ? `<span class="emp-badge-eh" title="Ersthelfer">➕</span>` : ``}
                </span>
            </div>
            <div class="emp-role">${emp.role || ""} · <span style="color:${teamCfg.color};">${teamCfg.name}</span></div>
            ${linesText}
            ${activeAbs ? `<div class="emp-absent-tag">${activeAbs.category} (bis ${formatDateDE(activeAbs.item.endDate)})</div>` : ``}
        `;

        container.appendChild(card);
    });

    const cp = document.getElementById("count-pool");
    const ce = document.getElementById("count-extra");
    const ca = document.getElementById("count-absent");
    if (cp) cp.textContent = countPool;
    if (ce) ce.textContent = countExtra;
    if (ca) ca.textContent = countAbsent;
}

function setupDropZones() {
    document.querySelectorAll(".drop-zone").forEach(zone => {
        zone.ondragover = e => {
            if (!currentPlanner) return;
            e.preventDefault();
            zone.classList.add("drag-over");
        };
        zone.ondragleave = () => zone.classList.remove("drag-over");
        zone.ondrop = e => {
            if (!currentPlanner) return;
            e.preventDefault();
            zone.classList.remove("drag-over");
            const empId = e.dataTransfer.getData("text/plain");
            const targetZone = zone.dataset.zone;
            const emp = state.employees.find(x => x.id === empId);
            if (emp && targetZone) {
                emp.zone = targetZone;
                renderEmployees();
                saveToFirebase(false);
            }
        };
    });
}

// ============================================================================
// SCHICHT-ROTATION & TEAM-STEUERUNG
// ============================================================================

function onShiftTeamSelectChange(shiftKey, teamKey) {
    if (!currentPlanner) return;
    if (!confirmAutoShiftOverride(`Manuelle Änderung der Team-Zuweisung in Schicht „${shiftKey.toUpperCase()}“`)) {
        renderMatrix();
        renderFilterCheckboxes();
        return;
    }
    state.shiftRotation[shiftKey] = teamKey;
    renderMatrix();
    renderEmployees();
    saveToFirebase(false);
}

function loadTeamToShift(shiftKey) {
    if (!currentPlanner) return;
    const teamKey = state.shiftRotation[shiftKey];
    if (!teamKey) {
        showToast("⚠️ Bitte zuerst ein Team für diesen Bereich auswählen.", "#f59e0b");
        return;
    }

    state.employees.forEach(emp => {
        if (emp.team !== teamKey || emp.noRotation) return;
        if (emp.zone === "absent" || emp.zone === "extra") return;

        if (shiftKey === "frei") {
            emp.zone = "pool";
        } else if (Array.isArray(emp.mainLines) && emp.mainLines.length > 0) {
            const targetLine = emp.mainLines[0];
            if (state.lines.some(l => l.id === targetLine)) {
                emp.zone = `${targetLine}__${shiftKey}`;
            }
        }
    });

    renderEmployees();
    saveToFirebase(true);
}

function clearShiftRow(shiftKey) {
    if (!currentPlanner) return;
    state.employees.forEach(emp => {
        if (emp.noRotation) return;
        if (emp.zone && emp.zone.endsWith(`__${shiftKey}`)) {
            emp.zone = "pool";
        }
    });
    renderEmployees();
    saveToFirebase(true);
}

function clearAllShifts() {
    if (!currentPlanner) return;
    if (!confirm("Möchtest du wirklich alle Linien-Zuweisungen (außer ⚓ Fix-Mitarbeiter) in den Pool zurücksetzen?")) return;
    state.employees.forEach(emp => {
        if (emp.noRotation) return;
        if (emp.zone && emp.zone.includes("__")) {
            emp.zone = "pool";
        }
    });
    renderEmployees();
    saveToFirebase(true);
}

function rotateShifts() {
    if (!currentPlanner) return;
    if (!confirmAutoShiftOverride("Manueller Klick auf den „🔄 Rotieren“-Button")) return;

    // Zyklischer Wechsel: Früh -> Spät -> Nacht -> Frei -> Früh
    const prev = { ...state.shiftRotation };
    const nextRotation = {
        spaet: prev.frueh || "",
        nacht: prev.spaet || "",
        frei: prev.nacht || "",
        frueh: prev.frei || ""
    };

    applyRotationMappingToBoard(nextRotation);
    renderFilterCheckboxes();
    renderMatrix();
    renderEmployees();
    saveToFirebase(true);
    showToast("🔄 Schichten wurden um 1 Station weitergedreht.", "#0091df");
}

// ============================================================================
// DER NEUE POSTFACH-KOMMANDOSTAND (3 KLARE REITER)
// ============================================================================

function getInboxActionItems() {
    const pendingLeaves = state.leaveRequests.filter(r => r.status === "pending");
    const pendingExtras = state.extraShifts.filter(x => x.status === "pending");
    const pendingReturns = state.sickLeaves.filter(s => Boolean(s.returnRequestDate));
    const unreadCancels = state.leaveRequests.filter(
        r => (r.status === "cancelled_by_emp" || r.status === "counter_accepted" || r.status === "counter_declined") && !r.plannerAck
    );
    return {
        pendingLeaves,
        pendingExtras,
        pendingReturns,
        unreadCancels,
        total: pendingLeaves.length + pendingExtras.length + pendingReturns.length + unreadCancels.length
    };
}

function updateInboxBadge() {
    const counts = getInboxActionItems();
    const badge = document.getElementById("inboxBadge");
    if (badge) {
        if (counts.total > 0) {
            badge.style.display = "inline-block";
            badge.textContent = counts.total;
        } else {
            badge.style.display = "none";
        }
    }
}

function openInboxModal() {
    if (!currentPlanner) return;
    populateManualAbsenceEmployees();
    const today = getTodayIso();
    document.getElementById("manualAbsStart").value = today;
    document.getElementById("manualAbsEnd").value = today;
    switchInboxTab(currentInboxTab || "todo");
    document.getElementById("inboxModal").style.display = "flex";
}

function closeInboxModal() {
    document.getElementById("inboxModal").style.display = "none";
}

function switchInboxTab(tabName) {
    currentInboxTab = tabName;
    document.getElementById("inboxTabBtnTodo").classList.toggle("active", tabName === "todo");
    document.getElementById("inboxTabBtnCalendar").classList.toggle("active", tabName === "calendar");
    document.getElementById("inboxTabBtnManual").classList.toggle("active", tabName === "manual");

    document.getElementById("inboxTabTodo").style.display = tabName === "todo" ? "block" : "none";
    document.getElementById("inboxTabCalendar").style.display = tabName === "calendar" ? "block" : "none";
    document.getElementById("inboxTabManual").style.display = tabName === "manual" ? "block" : "none";
    document.getElementById("inboxTopSearchWrap").style.display = tabName === "manual" ? "none" : "block";

    renderInbox();
}

function setInboxRequestFilter(filter) {
    currentInboxReqFilter = filter;
    document.querySelectorAll("[data-reqfilter]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.reqfilter === filter);
    });
    renderInbox();
}

function setInboxActiveFilter(filter) {
    currentInboxActFilter = filter;
    document.querySelectorAll("[data-actfilter]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.actfilter === filter);
    });
    renderInbox();
}

function refreshInboxNow() {
    boardDocRef.get().then(doc => {
        if (doc.exists) {
            applyCloudDataToState(doc.data());
            syncAbsencesAndExtraShiftsWithZones();
            renderEmployees();
            updateInboxBadge();
            renderInbox();
            showToast("🔄 Postfach-Stand aktualisiert.", "#16a34a");
        }
    });
}

function renderInbox() {
    const counts = getInboxActionItems();
    const search = (document.getElementById("inboxSearchInput")?.value || "").toLowerCase().trim();
    const today = getTodayIso();

    // Live-Status Zeile oben
    const statusText = document.getElementById("inboxLiveStatusText");
    if (statusText) {
        statusText.innerHTML = `✅ Live-Stand: <strong>${counts.pendingLeaves.length}</strong> offene Urlaubsanträge | <strong>${counts.pendingExtras.length}</strong> Bringschichten | <strong>${counts.pendingReturns.length}</strong> Gesundmeldungen`;
    }

    // Tab-Zähler
    document.getElementById("inboxTabTodoCount").textContent = counts.total;
    document.getElementById("reqCountAll").textContent = counts.total;
    document.getElementById("reqCountVac").textContent = counts.pendingLeaves.length;
    document.getElementById("reqCountExtra").textContent = counts.pendingExtras.length;
    document.getElementById("reqCountSick").textContent = counts.pendingReturns.length;
    document.getElementById("reqCountCancel").textContent = counts.unreadCancels.length;

    // ---------------------------------------------------------
    // TAB 1: ZU ERLEDIGEN (ACTION ITEMS)
    // ---------------------------------------------------------
    const todoContainer = document.getElementById("inboxTodoList");
    let todoHtml = "";

    const matchesSearch = (str) => !search || str.toLowerCase().includes(search);

    if (currentInboxReqFilter === "all" || currentInboxReqFilter === "vacation") {
        counts.pendingLeaves.forEach(req => {
            const hay = `${req.empName} ${req.category || "Urlaub"} ${req.startDate} ${req.endDate} ${req.reason || ""}`;
            if (!matchesSearch(hay)) return;
            todoHtml += `
                <div class="inbox-item" style="border-left-color:#0284c7;">
                    <div>
                        <div style="font-weight:800; font-size:0.88rem;">🌴 ${req.empName} – ${req.category || "Urlaubsantrag"}</div>
                        <div style="font-size:0.8rem; color:#334155; margin-top:2px;">
                            Zeitraum: <strong>${formatDateDE(req.startDate)} bis ${formatDateDE(req.endDate)}</strong>
                        </div>
                        ${req.reason ? `<div style="font-size:0.76rem; color:#64748b; margin-top:2px;">💬 Notiz: ${req.reason}</div>` : ``}
                    </div>
                    <div style="display:flex; gap:6px; flex-wrap:wrap;">
                        <button class="btn btn-success" onclick="approveLeaveRequest('${req.id}')">✅ Genehmigen</button>
                        <button class="btn" onclick="proposePartialLeave('${req.id}')">📅 Teil-Vorschlag</button>
                        <button class="btn btn-danger" onclick="rejectLeaveRequest('${req.id}')">❌ Ablehnen</button>
                    </div>
                </div>
            `;
        });
    }

    if (currentInboxReqFilter === "all" || currentInboxReqFilter === "extra") {
        counts.pendingExtras.forEach(ex => {
            const hay = `${ex.empName} Bringschicht ${ex.date} ${ex.shift || ""} ${ex.note || ""}`;
            if (!matchesSearch(hay)) return;
            todoHtml += `
                <div class="inbox-item" style="border-left-color:#10b981;">
                    <div>
                        <div style="font-weight:800; font-size:0.88rem;">➕ ${ex.empName} – Bringschicht / Zusatzschicht</div>
                        <div style="font-size:0.8rem; color:#334155; margin-top:2px;">
                            Datum: <strong>${formatDateDE(ex.date)}</strong> · Schicht: <strong>${ex.shift || "Nach Bedarf"}</strong>
                        </div>
                        ${ex.note ? `<div style="font-size:0.76rem; color:#64748b; margin-top:2px;">💬 Info: ${ex.note}</div>` : ``}
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button class="btn btn-success" onclick="approveExtraShift('${ex.id}')">✅ Bestätigen</button>
                        <button class="btn btn-danger" onclick="rejectExtraShift('${ex.id}')">❌ Ablehnen</button>
                    </div>
                </div>
            `;
        });
    }

    if (currentInboxReqFilter === "all" || currentInboxReqFilter === "sick") {
        counts.pendingReturns.forEach(s => {
            const hay = `${s.empName} Gesundmeldung ${s.returnRequestDate}`;
            if (!matchesSearch(hay)) return;
            todoHtml += `
                <div class="inbox-item" style="border-left-color:#16a34a;">
                    <div>
                        <div style="font-weight:800; font-size:0.88rem;">🏥 ${s.empName} – Vorzeitige Gesundmeldung</div>
                        <div style="font-size:0.8rem; color:#334155; margin-top:2px;">
                            Möchte ab <strong>${formatDateDE(s.returnRequestDate)}</strong> wieder arbeiten (ursprünglich bis ${formatDateDE(s.endDate)})
                        </div>
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button class="btn btn-success" onclick="confirmEarlyReturn('${s.id}')">✅ Rückkehr bestätigen</button>
                    </div>
                </div>
            `;
        });
    }

    if (currentInboxReqFilter === "all" || currentInboxReqFilter === "cancel") {
        counts.unreadCancels.forEach(c => {
            const hay = `${c.empName} Storno ${c.startDate} ${c.endDate}`;
            if (!matchesSearch(hay)) return;
            const statusLabel = c.status === "cancelled_by_emp"
                ? "🚫 Vom Mitarbeiter storniert"
                : c.status === "counter_accepted"
                ? "✅ Gegenvorschlag vom Mitarbeiter angenommen"
                : "❌ Gegenvorschlag vom Mitarbeiter abgelehnt";
            todoHtml += `
                <div class="inbox-item" style="border-left-color:#f59e0b;">
                    <div>
                        <div style="font-weight:800; font-size:0.88rem;">${statusLabel}: ${c.empName}</div>
                        <div style="font-size:0.8rem; color:#334155; margin-top:2px;">
                            Zeitraum: ${formatDateDE(c.startDate)} bis ${formatDateDE(c.endDate)}
                        </div>
                    </div>
                    <button class="btn" onclick="acknowledgeInboxInfo('${c.id}')">👍 Gelesen / Ausblenden</button>
                </div>
            `;
        });
    }

    if (!todoHtml) {
        todoHtml = `<div class="empty-state-box">🎉 Alles erledigt! Für diesen Filter liegen aktuell keine offenen Anträge oder Meldungen vor.</div>`;
    }
    todoContainer.innerHTML = todoHtml;

    // ---------------------------------------------------------
    // TAB 2: AKTIVER KALENDER & GENEHMIGTE ABWESENHEITEN
    // ---------------------------------------------------------
    const activeItems = [];
    state.sickLeaves.forEach(s => {
        if (s.endDate >= today) {
            activeItems.push({
                kind: "sick",
                id: s.id,
                empId: s.empId,
                empName: s.empName,
                category: s.category || "Krank",
                startDate: s.startDate,
                endDate: s.endDate,
                note: s.note || s.reason || ""
            });
        }
    });
    state.leaveRequests.forEach(l => {
        if (l.status === "approved" && l.endDate >= today) {
            activeItems.push({
                kind: "vacation",
                id: l.id,
                empId: l.empId,
                empName: l.empName,
                category: l.category || "Urlaub",
                startDate: l.startDate,
                endDate: l.endDate,
                note: l.reason || ""
            });
        }
    });

    activeItems.sort((a, b) => a.startDate.localeCompare(b.startDate));

    const cToday = activeItems.filter(x => x.startDate <= today && x.endDate >= today).length;
    const cFuture = activeItems.filter(x => x.startDate > today).length;
    const cSick = activeItems.filter(x => x.kind === "sick").length;
    const cVac = activeItems.filter(x => x.kind === "vacation").length;

    document.getElementById("inboxTabCalCount").textContent = activeItems.length;
    document.getElementById("actCountAll").textContent = activeItems.length;
    document.getElementById("actCountToday").textContent = cToday;
    document.getElementById("actCountFuture").textContent = cFuture;
    document.getElementById("actCountSick").textContent = cSick;
    document.getElementById("actCountVac").textContent = cVac;

    const calContainer = document.getElementById("inboxCalendarList");
    let calHtml = "";

    activeItems.forEach(item => {
        const isToday = item.startDate <= today && item.endDate >= today;
        if (currentInboxActFilter === "today" && !isToday) return;
        if (currentInboxActFilter === "future" && item.startDate <= today) return;
        if (currentInboxActFilter === "sick" && item.kind !== "sick") return;
        if (currentInboxActFilter === "vacation" && item.kind !== "vacation") return;

        const hay = `${item.empName} ${item.category} ${item.startDate} ${item.endDate} ${item.note}`;
        if (!matchesSearch(hay)) return;

        const borderCol = item.kind === "sick" ? "#ef4444" : "#16a34a";
        const icon = item.kind === "sick" ? "🏥" : "🌴";

        calHtml += `
            <div class="inbox-item" style="border-left-color:${borderCol};">
                <div>
                    <div style="font-weight:800; font-size:0.88rem;">
                        ${icon} ${item.empName} – ${item.category}
                        ${isToday ? `<span style="background:#fee2e2; color:#b91c1c; font-size:0.7rem; padding:1px 6px; border-radius:999px; margin-left:6px;">🔴 Heute abwesend</span>` : `<span style="background:#e0f2fe; color:#0369a1; font-size:0.7rem; padding:1px 6px; border-radius:999px; margin-left:6px;">⏳ Geplant</span>`}
                    </div>
                    <div style="font-size:0.8rem; color:#334155; margin-top:2px;">
                        Zeitraum: <strong>${formatDateDE(item.startDate)} bis ${formatDateDE(item.endDate)}</strong>
                    </div>
                    ${item.note ? `<div style="font-size:0.75rem; color:#64748b; margin-top:2px;">💬 ${item.note}</div>` : ``}
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="btn" onclick="editActiveAbsenceDates('${item.kind}', '${item.id}')">✏️ Zeitraum ändern</button>
                    <button class="btn btn-danger" onclick="deleteAbsenceEntry('${item.kind}', '${item.id}')">🗑️ Löschen / Beenden</button>
                </div>
            </div>
        `;
    });

    if (!calHtml) {
        calHtml = `<div class="empty-state-box">Keine aktiven oder zukünftigen Zeiträume für diesen Filter gefunden.</div>`;
    }
    calContainer.innerHTML = calHtml;
}

// POSTFACH AKTIONEN
async function archiveToHistory(entry) {
    try {
        const id = entry.id || "hist_" + Date.now();
        await historyColRef.doc(id).set({
            ...entry,
            archivedAt: new Date().toISOString()
        }, { merge: true });
    } catch (e) {
        console.warn("Historie-Archivierung Hinweis:", e);
    }
}

function approveLeaveRequest(reqId) {
    const req = state.leaveRequests.find(r => r.id === reqId);
    if (!req) return;
    req.status = "approved";
    req.approvedBy = currentPlanner ? `${currentPlanner.firstName} ${currentPlanner.lastName}` : "Planer";
    req.approvedAt = new Date().toISOString();

    archiveToHistory({
        id: req.id,
        empId: req.empId,
        empName: req.empName,
        category: req.category || "Urlaub",
        startDate: req.startDate,
        endDate: req.endDate,
        reason: req.reason || "",
        approvedBy: req.approvedBy,
        approvedAt: req.approvedAt
    });

    syncAbsencesAndExtraShiftsWithZones();
    renderEmployees();
    updateInboxBadge();
    renderInbox();
    saveToFirebase(false);
    showToast(`✅ Antrag von ${req.empName} genehmigt!`, "#16a34a");
}

function proposePartialLeave(reqId) {
    const req = state.leaveRequests.find(r => r.id === reqId);
    if (!req) return;
    const newStart = prompt(`Gegenvorschlag für ${req.empName} – Startdatum (JJJJ-MM-TT):`, req.startDate);
    if (!newStart) return;
    const newEnd = prompt(`Gegenvorschlag für ${req.empName} – Enddatum (JJJJ-MM-TT):`, req.endDate);
    if (!newEnd) return;
    const note = prompt("Kurze Begründung für den Teil-Gegenvorschlag:", "Engpass in der Schichtbesetzung") || "";

    req.status = "counter_proposed";
    req.proposedStartDate = newStart.trim();
    req.proposedEndDate = newEnd.trim();
    req.plannerNote = note.trim();
    updateInboxBadge();
    renderInbox();
    saveToFirebase(false);
    showToast(`📅 Gegenvorschlag an ${req.empName} gesendet.`, "#0091df");
}

function rejectLeaveRequest(reqId) {
    const req = state.leaveRequests.find(r => r.id === reqId);
    if (!req) return;
    const note = prompt(`Grund für die Ablehnung an ${req.empName} (optional):`, "") || "";
    req.status = "rejected";
    req.plannerNote = note.trim();
    updateInboxBadge();
    renderInbox();
    saveToFirebase(false);
    showToast(`❌ Antrag von ${req.empName} abgelehnt.`, "#ef4444");
}

function approveExtraShift(exId) {
    const ex = state.extraShifts.find(x => x.id === exId);
    if (!ex) return;
    ex.status = "approved";
    if (ex.date === getTodayIso()) {
        const emp = state.employees.find(e => e.id === ex.empId);
        if (emp && emp.zone === "pool") emp.zone = "extra";
    }
    renderEmployees();
    updateInboxBadge();
    renderInbox();
    saveToFirebase(false);
    showToast(`✅ Bringschicht für ${ex.empName} bestätigt.`, "#16a34a");
}

function rejectExtraShift(exId) {
    const ex = state.extraShifts.find(x => x.id === exId);
    if (!ex) return;
    ex.status = "rejected";
    updateInboxBadge();
    renderInbox();
    saveToFirebase(false);
    showToast(`❌ Bringschicht abgelehnt.`, "#ef4444");
}

function confirmEarlyReturn(sickId) {
    const s = state.sickLeaves.find(x => x.id === sickId);
    if (!s) return;
    // Setze Enddatum auf gestern, damit Mitarbeiter ab sofort wieder einsatzbereit im Pool ist
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    s.endDate = toIsoDate(yesterday);
    delete s.returnRequestDate;

    syncAbsencesAndExtraShiftsWithZones();
    renderEmployees();
    updateInboxBadge();
    renderInbox();
    saveToFirebase(false);
    showToast(`✅ Gesundmeldung von ${s.empName} bestätigt – Mitarbeiter zurück im Pool!`, "#16a34a");
}

function acknowledgeInboxInfo(reqId) {
    const req = state.leaveRequests.find(r => r.id === reqId);
    if (!req) return;
    req.plannerAck = true;
    if (req.status === "counter_accepted" && req.proposedStartDate && req.proposedEndDate) {
        req.startDate = req.proposedStartDate;
        req.endDate = req.proposedEndDate;
        req.status = "approved";
    }
    syncAbsencesAndExtraShiftsWithZones();
    renderEmployees();
    updateInboxBadge();
    renderInbox();
    saveToFirebase(false);
}

function editActiveAbsenceDates(kind, id) {
    const list = kind === "sick" ? state.sickLeaves : state.leaveRequests;
    const item = list.find(x => x.id === id);
    if (!item) return;

    const newStart = prompt(`Neues Startdatum (JJJJ-MM-TT) für ${item.empName}:`, item.startDate);
    if (!newStart) return;
    const newEnd = prompt(`Neues Enddatum (JJJJ-MM-TT) für ${item.empName}:`, item.endDate);
    if (!newEnd) return;

    item.startDate = newStart.trim();
    item.endDate = newEnd.trim();
    syncAbsencesAndExtraShiftsWithZones();
    renderEmployees();
    renderInbox();
    saveToFirebase(true);
}

function deleteAbsenceEntry(kind, id) {
    if (!confirm("Möchtest du diesen Abwesenheits-Zeitraum wirklich beenden bzw. löschen?")) return;
    if (kind === "sick") {
        state.sickLeaves = state.sickLeaves.filter(x => x.id !== id);
    } else {
        state.leaveRequests = state.leaveRequests.filter(x => x.id !== id);
    }
    syncAbsencesAndExtraShiftsWithZones();
    renderEmployees();
    renderInbox();
    saveToFirebase(true);
}

function populateManualAbsenceEmployees() {
    const sel = document.getElementById("manualAbsEmpSelect");
    if (!sel) return;
    sel.innerHTML = "";
    [...state.employees]
        .sort((a, b) => (a.lastName || "").localeCompare(b.lastName || ""))
        .forEach(emp => {
            const opt = document.createElement("option");
            opt.value = emp.id;
            opt.textContent = `${emp.firstName} ${emp.lastName} (${state.teamsConfig[emp.team]?.name || emp.team})`;
            sel.appendChild(opt);
        });
}

function addManualAbsence() {
    const empId = document.getElementById("manualAbsEmpSelect").value;
    const category = document.getElementById("manualAbsCategory").value;
    const start = document.getElementById("manualAbsStart").value;
    const end = document.getElementById("manualAbsEnd").value;
    const note = document.getElementById("manualAbsNote").value.trim();

    const emp = state.employees.find(e => e.id === empId);
    if (!emp || !start || !end) {
        showToast("⚠️ Bitte Mitarbeiter, Start- und Enddatum auswählen.", "#f59e0b");
        return;
    }
    if (end < start) {
        showToast("⚠️ Das Enddatum darf nicht vor dem Startdatum liegen.", "#ef4444");
        return;
    }

    const entryId = "abs_" + Date.now();
    const empName = `${emp.firstName} ${emp.lastName}`;
    const approvedBy = currentPlanner ? `${currentPlanner.firstName} ${currentPlanner.lastName}` : "Planer";

    if (category.includes("Krank")) {
        state.sickLeaves.push({
            id: entryId,
            empId: emp.id,
            empName,
            category,
            startDate: start,
            endDate: end,
            note,
            createdAt: new Date().toISOString()
        });
    } else {
        state.leaveRequests.push({
            id: entryId,
            empId: emp.id,
            empName,
            category,
            startDate: start,
            endDate: end,
            reason: note,
            status: "approved",
            approvedBy,
            approvedAt: new Date().toISOString()
        });
    }

    archiveToHistory({
        id: entryId,
        empId: emp.id,
        empName,
        category,
        startDate: start,
        endDate: end,
        reason: note,
        approvedBy,
        approvedAt: new Date().toISOString()
    });

    document.getElementById("manualAbsNote").value = "";
    syncAbsencesAndExtraShiftsWithZones();
    renderEmployees();
    updateInboxBadge();
    switchInboxTab("calendar");
    saveToFirebase(false);
    showToast(`✅ ${category} für ${empName} direkt eingetragen!`, "#16a34a");
}

// ============================================================================
// EINSTELLUNGEN MODAL (ADMIN & PLANER)
// ============================================================================

function openSettingsModal() {
    if (!currentPlanner) return;
    populateEmployeeFormOptions();
    renderSettingsEmployees();
    renderSettingsTeams();
    renderSettingsRoles();
    renderSettingsLines();
    renderSecuritySettings();
    loadCloudBackupsList();
    loadHistoryFromFirestore();

    document.getElementById("settingsModal").style.display = "flex";
}

function closeSettingsModal() {
    document.getElementById("settingsModal").style.display = "none";
}

function switchTab(tabId) {
    document.querySelectorAll(".settings-tab-content").forEach(el => (el.style.display = "none"));
    const target = document.getElementById(tabId);
    if (target) target.style.display = "block";

    const map = {
        tabEmployees: "tabBtnEmployees",
        tabTeams: "tabBtnTeams",
        tabRoles: "tabBtnRoles",
        tabLines: "tabBtnLines",
        tabHistory: "tabBtnHistory",
        tabSecurity: "tabBtnSecurity",
        tabProfile: "tabBtnProfile"
    };
    Object.values(map).forEach(btnId => {
        document.getElementById(btnId)?.classList.remove("active");
    });
    if (map[tabId]) {
        document.getElementById(map[tabId])?.classList.add("active");
    }
}

// 1. MITARBEITER VERWALTEN
function populateEmployeeFormOptions() {
    const teamSel = document.getElementById("newEmpTeam");
    const roleSel = document.getElementById("newEmpRole");
    const mainBox = document.getElementById("newEmpMainLines");
    const secBox = document.getElementById("newEmpSecLines");
    if (!teamSel || !roleSel) return;

    teamSel.innerHTML = "";
    Object.entries(state.teamsConfig).forEach(([k, t]) => {
        const opt = document.createElement("option");
        opt.value = k;
        opt.textContent = t.name;
        teamSel.appendChild(opt);
    });

    roleSel.innerHTML = "";
    state.roles.forEach(r => {
        const opt = document.createElement("option");
        opt.value = r;
        opt.textContent = r;
        roleSel.appendChild(opt);
    });

    const buildLineCheckboxes = (container, cls) => {
        container.innerHTML = "";
        state.lines.forEach(l => {
            const lbl = document.createElement("label");
            lbl.innerHTML = `<input type="checkbox" class="${cls}" value="${l.id}"> ${l.name}`;
            container.appendChild(lbl);
        });
    };
    buildLineCheckboxes(mainBox, "cb-main-line");
    buildLineCheckboxes(secBox, "cb-sec-line");
}

function resetEmpForm() {
    document.getElementById("editEmpId").value = "";
    document.getElementById("newEmpFirstName").value = "";
    document.getElementById("newEmpLastName").value = "";
    document.getElementById("newEmpAccessLevel").value = "1";
    document.getElementById("newEmpPassword").value = "";
    document.getElementById("newEmpErsthelfer").checked = false;
    document.getElementById("newEmpNoRotation").checked = false;
    document.querySelectorAll(".cb-main-line, .cb-sec-line").forEach(cb => (cb.checked = false));
    document.getElementById("empFormTitle").textContent = "➕ Neuen Mitarbeiter anlegen / bearbeiten";
}

function editEmployee(empId) {
    const emp = state.employees.find(e => e.id === empId);
    if (!emp) return;
    populateEmployeeFormOptions();
    document.getElementById("editEmpId").value = emp.id;
    document.getElementById("newEmpFirstName").value = emp.firstName || "";
    document.getElementById("newEmpLastName").value = emp.lastName || "";
    document.getElementById("newEmpTeam").value = emp.team || "";
    document.getElementById("newEmpRole").value = emp.role || "";
    document.getElementById("newEmpAccessLevel").value = String(emp.accessLevel || 1);
    document.getElementById("newEmpPassword").value = emp.password || "0000";
    document.getElementById("newEmpErsthelfer").checked = Boolean(emp.ersthelfer);
    document.getElementById("newEmpNoRotation").checked = Boolean(emp.noRotation);

    document.querySelectorAll(".cb-main-line").forEach(cb => {
        cb.checked = (emp.mainLines || []).includes(cb.value);
    });
    document.querySelectorAll(".cb-sec-line").forEach(cb => {
        cb.checked = (emp.secLines || []).includes(cb.value);
    });
    document.getElementById("empFormTitle").textContent = `✏️ Mitarbeiter bearbeiten: ${emp.firstName} ${emp.lastName}`;
}

function saveEmployee() {
    const editId = document.getElementById("editEmpId").value;
    const firstName = document.getElementById("newEmpFirstName").value.trim();
    const lastName = document.getElementById("newEmpLastName").value.trim();
    const team = document.getElementById("newEmpTeam").value;
    const role = document.getElementById("newEmpRole").value;
    const accessLevel = Number(document.getElementById("newEmpAccessLevel").value || 1);
    const password = document.getElementById("newEmpPassword").value.trim() || "0000";
    const ersthelfer = document.getElementById("newEmpErsthelfer").checked;
    const noRotation = document.getElementById("newEmpNoRotation").checked;

    if (!firstName || !lastName) {
        showToast("⚠️ Bitte Vor- und Nachname eingeben.", "#f59e0b");
        return;
    }

    const mainLines = Array.from(document.querySelectorAll(".cb-main-line:checked")).map(cb => cb.value);
    const secLines = Array.from(document.querySelectorAll(".cb-sec-line:checked")).map(cb => cb.value);

    if (editId) {
        const emp = state.employees.find(e => e.id === editId);
        if (emp) {
            emp.firstName = firstName;
            emp.lastName = lastName;
            emp.team = team;
            emp.role = role;
            emp.accessLevel = accessLevel;
            emp.password = password;
            emp.ersthelfer = ersthelfer;
            emp.noRotation = noRotation;
            emp.mainLines = mainLines;
            emp.secLines = secLines;
        }
    } else {
        state.employees.push({
            id: "emp_" + Date.now(),
            firstName,
            lastName,
            team,
            role,
            accessLevel,
            password,
            mustChangePw: password === "0000",
            ersthelfer,
            noRotation,
            mainLines,
            secLines,
            zone: "pool"
        });
    }

    resetEmpForm();
    renderSettingsEmployees();
    renderEmployees();
    saveToFirebase(true);
}

function deleteEmployee(empId) {
    const emp = state.employees.find(e => e.id === empId);
    if (!emp) return;
    if (!confirm(`Möchtest du ${emp.firstName} ${emp.lastName} wirklich löschen?`)) return;
    if (state.employees.length <= 1) {
        showToast("🛡️ Der letzte Mitarbeiter kann aus Datenschutzgründen nicht gelöscht werden.", "#ef4444");
        return;
    }
    state.employees = state.employees.filter(e => e.id !== empId);
    renderSettingsEmployees();
    renderEmployees();
    saveToFirebase(true);
}

function renderSettingsEmployees() {
    const container = document.getElementById("settingsEmpList");
    if (!container) return;
    const q = (document.getElementById("empSettingsSearch")?.value || "").toLowerCase().trim();

    let html = "";
    [...state.employees]
        .sort((a, b) => (a.lastName || "").localeCompare(b.lastName || ""))
        .forEach(emp => {
            const hay = `${emp.firstName} ${emp.lastName} ${emp.role} ${emp.team}`.toLowerCase();
            if (q && !hay.includes(q)) return;
            const tCfg = state.teamsConfig[emp.team] || { name: emp.team, color: "#64748b" };
            html += `
                <div class="inbox-item" style="border-left-color:${tCfg.color}; padding:8px 12px;">
                    <div>
                        <strong>${emp.firstName} ${emp.lastName}</strong>
                        <span style="font-size:0.76rem; color:#64748b; margin-left:6px;">
                            ${tCfg.name} · ${emp.role} · Stufe ${emp.accessLevel || 1}
                            ${emp.noRotation ? ` · ⚓ Fix` : ``}
                        </span>
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button class="btn" onclick="editEmployee('${emp.id}')">✏️ Bearbeiten</button>
                        <button class="btn btn-danger" onclick="deleteEmployee('${emp.id}')">🗑️</button>
                    </div>
                </div>
            `;
        });
    container.innerHTML = html || `<div class="empty-state-box">Keine Mitarbeiter gefunden.</div>`;
}

// 2. TEAMS & AUTOMATISCHER SCHICHT-GENERATOR (MIT SICHERHEITS-WÄCHTER)
function renderSettingsTeams() {
    const toggle = document.getElementById("autoShiftEnabledToggle");
    const modelSel = document.getElementById("autoShiftModelSelect");
    const startInput = document.getElementById("autoShiftStartDate");

    if (toggle) toggle.checked = Boolean(state.autoShiftConfig?.enabled);
    if (modelSel) modelSel.value = state.autoShiftConfig?.model || "bayer_222_4team";
    if (startInput) startInput.value = state.autoShiftConfig?.startDate || "2026-01-12";

    updateAutoShiftPreviewBox();

    const listEl = document.getElementById("settingsTeamsList");
    if (!listEl) return;
    let html = "";
    Object.entries(state.teamsConfig).forEach(([teamKey, cfg]) => {
        html += `
            <div class="inbox-item" style="border-left-color:${cfg.color}; padding:8px 12px;">
                <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                    <input type="color" value="${cfg.color}" onchange="updateTeamConfig('${teamKey}', 'color', this.value)" style="width:32px; height:28px; border:none; cursor:pointer;">
                    <input type="text" class="form-control" value="${cfg.name}" onchange="updateTeamConfig('${teamKey}', 'name', this.value)" style="width:160px;">
                    <label style="display:inline-flex; align-items:center; gap:5px; font-size:0.8rem; font-weight:700; cursor:pointer;">
                        <input type="checkbox" ${cfg.rotates ? "checked" : ""} onchange="updateTeamConfig('${teamKey}', 'rotates', this.checked, this)">
                        🔄 Rotiert im Schichtmodell
                    </label>
                </div>
                <button class="btn btn-danger" onclick="deleteTeam('${teamKey}')">🗑️</button>
            </div>
        `;
    });
    listEl.innerHTML = html;
}

function updateAutoShiftPreviewBox() {
    const box = document.getElementById("autoShiftPreviewBox");
    if (!box) return;
    const calc = calculateTargetShiftRotation(new Date());
    if (!calc) {
        box.innerHTML = `<span style="color:#b91c1c; font-weight:700;">⚠️ Hinweis:</span> Für das 4-Gruppen-Schichtmodell müssen mindestens 4 Teams den Haken „🔄 Rotiert“ aktiviert haben.`;
        return;
    }
    const r = calc.rotation;
    const getName = k => state.teamsConfig[k]?.name || k;
    box.innerHTML = `
        <div style="font-weight:700; color:#0369a1; margin-bottom:4px;">📅 Berechneter Stand für ${calc.description}:</div>
        <div style="display:flex; gap:14px; flex-wrap:wrap;">
            <span><strong>Früh:</strong> ${getName(r.frueh)}</span>
            <span><strong>Spät:</strong> ${getName(r.spaet)}</span>
            <span><strong>Nacht:</strong> ${getName(r.nacht)}</span>
            <span><strong>Frei:</strong> ${getName(r.frei)}</span>
        </div>
    `;
}

function toggleAutoShiftMode(enabled) {
    if (enabled) {
        const rotatingTeams = Object.keys(state.teamsConfig).filter(k => state.teamsConfig[k]?.rotates);
        if (rotatingTeams.length < 4) {
            alert("⚠️ Um den automatischen 4-Gruppen Schicht-Generator zu aktivieren, müssen mindestens 4 Teams den Haken bei „🔄 Rotiert“ gesetzt haben!");
            document.getElementById("autoShiftEnabledToggle").checked = false;
            return;
        }
        // Synchronisiere den Offset automatisch auf die aktuell im Board eingestellte Frühschicht,
        // damit der aktuelle Plan nahtlos mit dem 2-2-2 Kalender-Rhythmus weiterläuft!
        calibrateAutoShiftOffsetToCurrentBoard();
        state.autoShiftConfig.enabled = true;
        checkAndRunAutoShiftRotation();
        showToast("🤖 Automatischer Schicht-Generator aktiviert! (Umschaltung ab 05:00 Uhr)", "#16a34a");
    } else {
        state.autoShiftConfig.enabled = false;
        showToast("ℹ️ Automatischer Schicht-Generator deaktiviert.", "#64748b");
    }
    updateAutoShiftBadge();
    updateAutoShiftPreviewBox();
    saveToFirebase(false);
}

function calibrateAutoShiftOffsetToCurrentBoard() {
    const rotatingTeams = Object.keys(state.teamsConfig).filter(k => state.teamsConfig[k]?.rotates).slice(0, 4);
    state.autoShiftConfig.teamOrder = rotatingTeams;
    const currentFruehTeam = state.shiftRotation.frueh;
    const info = getBayer222BlockInfo(getEffectiveShiftDate(new Date()));

    // Finde den Offset (0..3), bei dem calc.rotation.frueh dem aktuell gewählten Früh-Team entspricht
    for (let off = 0; off < 4; off++) {
        state.autoShiftConfig.cycleOffset = off;
        const testCalc = calculateTargetShiftRotation(new Date());
        if (testCalc && testCalc.rotation.frueh === currentFruehTeam) {
            state.autoShiftConfig.lastAppliedBlockKey = testCalc.blockKey;
            break;
        }
    }
}

function saveAutoShiftConfig() {
    state.autoShiftConfig.model = document.getElementById("autoShiftModelSelect").value;
    state.autoShiftConfig.startDate = document.getElementById("autoShiftStartDate").value || "2026-01-12";
    updateAutoShiftPreviewBox();
    if (state.autoShiftConfig.enabled) {
        checkAndRunAutoShiftRotation();
    }
    saveToFirebase(true);
}

function applyAutoShiftNow(manualClick = false) {
    const calc = calculateTargetShiftRotation(new Date());
    if (!calc) {
        showToast("⚠️ Mindestens 4 rotierende Teams erforderlich!", "#ef4444");
        return;
    }
    applyRotationMappingToBoard(calc.rotation);
    state.autoShiftConfig.lastAppliedBlockKey = calc.blockKey;
    renderFilterCheckboxes();
    renderMatrix();
    renderEmployees();
    updateAutoShiftPreviewBox();
    saveToFirebase(false);
    if (manualClick) {
        showToast(`⚡ Schichten gemäß Modell (${calc.description}) zugewiesen!`, "#16a34a");
    }
}

function updateTeamConfig(teamKey, field, value, checkboxEl = null) {
    const cfg = state.teamsConfig[teamKey];
    if (!cfg) return;

    // SICHERHEITS-WÄCHTER: Prüfen, ob Haken "Rotiert" entfernt wird, während Automatik läuft
    if (field === "rotates" && value === false && state.autoShiftConfig?.enabled) {
        const ok = confirmAutoShiftOverride(`Deaktivierung der Rotation („🔄 Rotiert“) bei „${cfg.name}“`);
        if (!ok) {
            if (checkboxEl) checkboxEl.checked = true;
            return;
        }
    }

    cfg[field] = value;
    renderFilterCheckboxes();
    renderMatrix();
    renderEmployees();
    updateAutoShiftPreviewBox();
    saveToFirebase(false);
}

function addNewTeam() {
    const input = document.getElementById("newTeamNameInput");
    const name = input.value.trim();
    if (!name) return;
    const key = "team_" + Date.now();
    state.teamsConfig[key] = { name, color: "#0ea5e9", rotates: false };
    activeTeamFilters.add(key);
    input.value = "";
    renderSettingsTeams();
    renderFilterCheckboxes();
    renderMatrix();
    saveToFirebase(true);
}

function deleteTeam(teamKey) {
    const cfg = state.teamsConfig[teamKey];
    if (!cfg) return;
    if (cfg.rotates && state.autoShiftConfig?.enabled) {
        if (!confirmAutoShiftOverride(`Löschen des rotierenden Teams „${cfg.name}“`)) return;
    }
    if (!confirm(`Team „${cfg.name}“ wirklich löschen?`)) return;
    delete state.teamsConfig[teamKey];
    renderSettingsTeams();
    renderFilterCheckboxes();
    renderMatrix();
    saveToFirebase(true);
}

// 3. ROLLEN & LINIEN (AUTO-SAVE)
function renderSettingsRoles() {
    const el = document.getElementById("settingsRolesList");
    if (!el) return;
    el.innerHTML = state.roles.map(r => `
        <div class="inbox-item" style="padding:7px 12px;">
            <strong>${r}</strong>
            <button class="btn btn-danger" onclick="deleteRole('${r}')">🗑️</button>
        </div>
    `).join("");
}

function addRole() {
    const inp = document.getElementById("newRoleInput");
    const val = inp.value.trim();
    if (!val || state.roles.includes(val)) return;
    state.roles.push(val);
    activeRoleFilters.add(val);
    inp.value = "";
    renderSettingsRoles();
    renderFilterCheckboxes();
    saveToFirebase(true);
}

function deleteRole(role) {
    if (!confirm(`Rolle „${role}“ wirklich entfernen?`)) return;
    state.roles = state.roles.filter(r => r !== role);
    renderSettingsRoles();
    renderFilterCheckboxes();
    saveToFirebase(true);
}

function renderSettingsLines() {
    const el = document.getElementById("settingsLinesList");
    if (!el) return;
    el.innerHTML = state.lines.map(l => `
        <div class="inbox-item" style="padding:8px 12px;">
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <input type="text" class="form-control" value="${l.name}" onchange="updateLineField('${l.id}', 'name', this.value)" style="width:130px; font-weight:700;">
                <input type="text" class="form-control" value="${l.tag || ""}" placeholder="Status (z.B. Wartung)" onchange="updateLineField('${l.id}', 'tag', this.value)" style="width:150px;">
                <input type="text" class="form-control" value="${l.prio || ""}" placeholder="Prio (z.B. PRIO 1)" onchange="updateLineField('${l.id}', 'prio', this.value)" style="width:130px;">
                <input type="text" class="form-control" value="${l.note || ""}" placeholder="Notiz (z.B. 10.000 bis FW)" onchange="updateLineField('${l.id}', 'note', this.value)" style="width:190px;">
            </div>
            <button class="btn btn-danger" onclick="deleteLine('${l.id}')">🗑️</button>
        </div>
    `).join("");
}

function updateLineField(lineId, field, value) {
    const l = state.lines.find(x => x.id === lineId);
    if (!l) return;
    l[field] = value.trim();
    renderMatrix();
    renderEmployees();
    saveToFirebase(false);
}

function addLine() {
    const inp = document.getElementById("newLineNameInput");
    const name = inp.value.trim();
    if (!name) return;
    state.lines.push({ id: "line_" + Date.now(), name, prio: "", tag: "", note: "" });
    inp.value = "";
    renderSettingsLines();
    renderMatrix();
    renderEmployees();
    saveToFirebase(true);
}

function deleteLine(lineId) {
    const l = state.lines.find(x => x.id === lineId);
    if (!l || !confirm(`Linie „${l.name}“ wirklich löschen?`)) return;
    state.lines = state.lines.filter(x => x.id !== lineId);
    renderSettingsLines();
    renderMatrix();
    renderEmployees();
    saveToFirebase(true);
}

// 4. URLAUBS-HISTORIE
async function loadHistoryFromFirestore() {
    try {
        const snap = await historyColRef.orderBy("startDate", "desc").limit(200).get();
        cachedHistoryItems = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderHistoryList();
    } catch (e) {
        console.warn("Historie Laden Hinweis:", e);
    }
}

function renderHistoryList() {
    const el = document.getElementById("settingsHistoryList");
    if (!el) return;
    const q = (document.getElementById("historySearchInput")?.value || "").toLowerCase().trim();
    const filtered = cachedHistoryItems.filter(item => {
        const hay = `${item.empName || ""} ${item.category || ""} ${item.startDate || ""} ${item.endDate || ""}`.toLowerCase();
        return !q || hay.includes(q);
    });

    if (filtered.length === 0) {
        el.innerHTML = `<div class="empty-state-box">Keine Historien-Einträge gefunden.</div>`;
        return;
    }

    el.innerHTML = filtered.map(item => `
        <div class="inbox-item" style="padding:8px 12px;">
            <div>
                <strong>${item.empName}</strong> – ${item.category || "Urlaub"}
                <div style="font-size:0.78rem; color:#475569;">
                    ${formatDateDE(item.startDate)} bis ${formatDateDE(item.endDate)}
                    ${item.approvedBy ? ` · Genehmigt von ${item.approvedBy}` : ``}
                </div>
            </div>
        </div>
    `).join("");
}

// 5. SICHERHEIT & CLOUD-BACKUPS
function renderSecuritySettings() {
    const cfg = state.securityConfig || {};
    document.getElementById("secBoardPwEnabled").checked = Boolean(cfg.boardPwEnabled);
    document.getElementById("secBoardPwInput").value = cfg.boardPw || "";
    document.getElementById("secPlannerTimeout").value = cfg.plannerTimeoutMin ?? 15;
    document.getElementById("secPortalTimeout").value = cfg.portalTimeoutMin ?? 10;
}

function saveSecuritySettings() {
    state.securityConfig = {
        boardPwEnabled: document.getElementById("secBoardPwEnabled").checked,
        boardPw: document.getElementById("secBoardPwInput").value.trim(),
        plannerTimeoutMin: Number(document.getElementById("secPlannerTimeout").value || 0),
        portalTimeoutMin: Number(document.getElementById("secPortalTimeout").value || 0)
    };
    saveToFirebase(true);
}

async function createManualCloudBackup() {
    if (!isCloudDataLoaded) return;
    const docId = "manual_" + Date.now();
    try {
        await backupsColRef.doc(docId).set({
            type: "manual",
            createdAtIso: new Date().toISOString(),
            timestamp: Date.now(),
            empCount: state.employees.length,
            createdBy: currentPlanner ? `${currentPlanner.firstName} ${currentPlanner.lastName}` : "Admin",
            payload: JSON.parse(JSON.stringify(state))
        });
        showToast("☁️ Cloud-Backup erfolgreich angelegt!", "#16a34a");
        loadCloudBackupsList();
    } catch (e) {
        showToast("❌ Backup konnte nicht erstellt werden.", "#ef4444");
    }
}

async function loadCloudBackupsList() {
    const el = document.getElementById("cloudBackupsList");
    if (!el) return;
    try {
        const snap = await backupsColRef.orderBy("timestamp", "desc").limit(10).get();
        if (snap.empty) {
            el.innerHTML = `<div class="empty-state-box">Noch keine Cloud-Backups vorhanden.</div>`;
            return;
        }
        el.innerHTML = snap.docs.map(doc => {
            const d = doc.data();
            const dt = d.createdAtIso ? new Date(d.createdAtIso).toLocaleString("de-DE") : doc.id;
            return `
                <div class="inbox-item" style="padding:8px 12px;">
                    <div>
                        <strong>${d.type === "manual" ? "📌 Manuelles Backup" : "🕒 Auto-Backup"}</strong> (${dt})
                        <div style="font-size:0.76rem; color:#64748b;">👥 ${d.empCount || 0} Mitarbeiter gespeichert</div>
                    </div>
                    <button class="btn" onclick="restoreFromCloudBackup('${doc.id}')">⏪ Wiederherstellen</button>
                </div>
            `;
        }).join("");
    } catch (e) {
        el.innerHTML = "";
    }
}

async function restoreFromCloudBackup(backupDocId) {
    if (!confirm("Möchtest du den gesamten Systemstand (Mitarbeiter, Linien, Teams) aus diesem Backup wiederherstellen?")) return;
    try {
        const doc = await backupsColRef.doc(backupDocId).get();
        if (!doc.exists) return;
        const data = doc.data();
        const payload = data.payload || data;
        applyCloudDataToState(payload);
        await saveToFirebase(false);
        renderSettingsEmployees();
        renderSettingsTeams();
        renderMatrix();
        renderEmployees();
        showToast("✅ Systemstand erfolgreich aus Backup wiederhergestellt!", "#16a34a");
    } catch (e) {
        showToast("❌ Fehler beim Wiederherstellen.", "#ef4444");
    }
}

function exportLocalJsonBackup() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `schichtplan_backup_${getTodayIso()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}
