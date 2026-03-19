// ─── Trip Expense Notepad — app.js ───
// Paste your deployed Google Apps Script URL below
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxO0ZjMlAWEcjgOLGqQZZetGQMteeDruR8xIiNjFjoKJUqC6XIL06337uSqX68S24qFlA/exec";

// ─── State ───
let trips = [];
let activeId = null;
let currentTab = "notes";
let pushTimer = null;

const $ = (s) => document.querySelector(s);
const $app = () => $("#app");

// ═══════════════════════════════════════════
//  CURRENCIES
// ═══════════════════════════════════════════
const CURRENCIES = [
  { code: "INR", symbol: "₹" },
  { code: "THB", symbol: "฿" },
  { code: "USD", symbol: "$" },
  { code: "EUR", symbol: "€" },
  { code: "GBP", symbol: "£" },
  { code: "JPY", symbol: "¥" },
  { code: "SGD", symbol: "S$" },
  { code: "MYR", symbol: "RM" },
  { code: "AED", symbol: "AED " },
  { code: "AUD", symbol: "A$" },
  { code: "IDR", symbol: "Rp" },
  { code: "VND", symbol: "₫" },
  { code: "KRW", symbol: "₩" },
  { code: "PHP", symbol: "₱" },
  { code: "LKR", symbol: "LKR " },
];
const BIG_CURRENCIES = new Set(["VND", "IDR", "KRW"]);

function getCurrSymbol(code) {
  const c = CURRENCIES.find(c => c.code === code);
  return c ? c.symbol : code + " ";
}

function fmt(n) {
  if (n === 0) return "0";
  return n % 1 === 0 ? n.toLocaleString() : n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

function fmtC(n, code) {
  if (n === 0) return getCurrSymbol(code) + "0";
  const sym = getCurrSymbol(code);
  const isBig = BIG_CURRENCIES.has(code);
  if (isBig && n >= 1000000) {
    const m = n / 1000000;
    if (m === Math.floor(m)) return sym + m.toString() + "M";
    if (m >= 10) return sym + m.toFixed(1) + "M";
    return sym + m.toFixed(2).replace(/\.?0+$/, "") + "M";
  }
  if (isBig && n >= 100000) {
    const k = n / 1000;
    if (k === Math.floor(k)) return sym + k.toString() + "K";
    return sym + k.toFixed(1).replace(/\.?0+$/, "") + "K";
  }
  return sym + fmt(n);
}

const INR_STYLE = new Set(["INR", "LKR"]);

function fmtBox(n, code) {
  if (n === 0) return getCurrSymbol(code) + "0";
  const sym = getCurrSymbol(code);
  const v = Math.round(n);
  if (INR_STYLE.has(code)) {
    if (v >= 10000000) {
      const cr = v / 10000000;
      return sym + (cr === Math.floor(cr) ? cr.toString() : cr.toFixed(2).replace(/\.?0+$/, "")) + " Cr";
    }
    if (v >= 100000) {
      const lac = v / 100000;
      return sym + (lac === Math.floor(lac) ? lac.toString() : lac.toFixed(2).replace(/\.?0+$/, "")) + " L";
    }
    return sym + v.toLocaleString("en-IN");
  }
  if (v >= 1000000) {
    const m = v / 1000000;
    return sym + (m === Math.floor(m) ? m.toString() : m.toFixed(2).replace(/\.?0+$/, "")) + "M";
  }
  if (v >= 10000) {
    const k = v / 1000;
    return sym + (k === Math.floor(k) ? k.toString() : k.toFixed(1).replace(/\.?0+$/, "")) + "K";
  }
  return sym + v.toLocaleString();
}

// ═══════════════════════════════════════════
//  PARSING ENGINE
// ═══════════════════════════════════════════
function isDateLine(line) {
  const t = line.trim().toLowerCase();
  if (!t) return false;
  if (/^\d{1,2}\s*[-\/]?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/i.test(t)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*[-\/]?\s*\d{1,2}/i.test(t)) return true;
  return false;
}

function safeMathEval(expr) {
  const clean = expr.replace(/\s/g, "");
  if (!/^[\d+\-*/().]+$/.test(clean)) return null;
  if (!/[+\-*/()]/.test(clean)) return null;
  if (/[+\-*/]{2,}/.test(clean.replace(/[()]/g, ""))) return null;
  try {
    const result = new Function("return (" + clean + ")")();
    if (typeof result === "number" && isFinite(result) && result >= 0) return Math.round(result * 100) / 100;
    return null;
  } catch { return null; }
}

function parseLine(raw) {
  let line = raw.trim();
  if (!line) return null;
  if (isDateLine(line)) return null;

  let method = "cash";
  if (/\bcc\b/i.test(line)) { method = "cc"; line = line.replace(/\bcc\b/gi, "").trim(); }

  let type = "expense";
  if (/\bwithdr[a]?w[a]?l?\b/i.test(line) || /\batm\b/i.test(line)) {
    type = "withdrawal";
    line = line.replace(/\bwithdr[a]?w[a]?l?\b/gi, "").replace(/\batm\b/gi, "").trim();
  } else if (/\bdeposit\b/i.test(line)) {
    type = "deposit";
  }

  // Strip commas from numbers: 10,00,000 → 1000000, 1,000,000 → 1000000
  line = line.replace(/(\d),(\d)/g, "$1$2").replace(/(\d),(\d)/g, "$1$2");

  const mathExprPattern = /[\d]+(?:\.\d+)?[\s]*[+\-*/()][\s\d+\-*/().]*[\d)]/g;
  let mathMatch = null, mathTotal = 0, mathStart = -1, mathEnd = -1, m;
  while ((m = mathExprPattern.exec(line)) !== null) {
    const result = safeMathEval(m[0]);
    if (result !== null) { mathTotal = result; mathStart = m.index; mathEnd = m.index + m[0].length; mathMatch = true; }
  }
  if (mathMatch) {
    let item = (line.slice(0, mathStart) + " " + line.slice(mathEnd)).replace(/\s+/g, " ").trim();
    if (!item && type === "withdrawal") item = "ATM withdrawal";
    else if (!item && type === "deposit") item = "Deposit";
    else if (!item) item = "—";
    return { item, amount: mathTotal, method, type, raw: raw.trim() };
  }

  const stripped = line;
  const bareNum = stripped.match(/^(\d+(?:\.\d+)?)\s*$/);
  if (bareNum) {
    const item = type === "withdrawal" ? "ATM withdrawal" : type === "deposit" ? "Deposit" : "—";
    return { item, amount: parseFloat(bareNum[1]), method, type, raw: raw.trim() };
  }

  const startMatch = stripped.match(/^(\d+(?:\.\d+)?)\s+(.+)/);
  if (startMatch) {
    const amt = parseFloat(startMatch[1]); const rest = startMatch[2].trim();
    if (rest && !/^\d+$/.test(rest)) return { item: rest, amount: amt, method, type, raw: raw.trim() };
  }

  const endMatch = stripped.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*$/);
  if (endMatch) return { item: endMatch[1].trim(), amount: parseFloat(endMatch[2]), method, type, raw: raw.trim() };

  if (startMatch) {
    const item = type === "withdrawal" ? "ATM withdrawal" : type === "deposit" ? "Deposit" : "—";
    return { item, amount: parseFloat(startMatch[1]), method, type, raw: raw.trim() };
  }

  let fallbackItem = stripped || raw.trim();
  if (!fallbackItem && type === "withdrawal") fallbackItem = "ATM withdrawal";
  else if (!fallbackItem && type === "deposit") fallbackItem = "Deposit";
  return { item: fallbackItem || "—", amount: 0, method, type, raw: raw.trim() };
}

function parseNotes(text) {
  const lines = text.split("\n");
  let currentDate = "", days = [], currentEntries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isDateLine(trimmed)) {
      if (currentDate || currentEntries.length > 0) days.push({ date: currentDate || "No date", entries: currentEntries });
      currentDate = trimmed; currentEntries = [];
    } else {
      const parsed = parseLine(trimmed);
      if (parsed) currentEntries.push(parsed);
    }
  }
  if (currentDate || currentEntries.length > 0) days.push({ date: currentDate || "No date", entries: currentEntries });
  return days;
}

// ═══════════════════════════════════════════
//  LOCAL STORAGE
// ═══════════════════════════════════════════
function loadTrips() {
  try { return JSON.parse(localStorage.getItem("trip-notepad-v2") || "[]"); } catch { return []; }
}
function saveTrips() { localStorage.setItem("trip-notepad-v2", JSON.stringify(trips)); }

// ═══════════════════════════════════════════
//  GOOGLE SHEETS SYNC
// ═══════════════════════════════════════════
function pushTrip(trip) {
  if (!SCRIPT_URL) return;
  const days = parseNotes(trip.text);
  const rows = [];
  days.forEach(d => d.entries.forEach(e => {
    rows.push({ date: d.date, item: e.item, amount: e.amount, currency: trip.currency || "INR",
      method: e.method === "cc" ? "CC" : "Cash", type: e.type === "withdrawal" ? "Withdrawal" : e.type === "deposit" ? "Deposit" : "Expense" });
  }));
  fetch(SCRIPT_URL, {
    method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ trip: trip.name, currency: trip.currency || "INR", rows, rawText: trip.text }),
  }).catch(() => {});
}

function pushTripDebounced(trip) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushTrip(trip), 2000);
}

async function fullSync() {
  const btn = $(".sync-btn");
  if (btn) btn.classList.add("spinning");
  if (!SCRIPT_URL) {
    setTimeout(() => { if (btn) btn.classList.remove("spinning"); }, 600);
    return;
  }
  try {
    // Push only the most recent / current trip
    const toPush = trips[0];
    if (toPush) {
      const days = parseNotes(toPush.text);
      const r = [];
      days.forEach(d => d.entries.forEach(e => {
        r.push({ date: d.date, item: e.item, amount: e.amount, currency: toPush.currency || "INR",
          method: e.method === "cc" ? "CC" : "Cash", type: e.type === "withdrawal" ? "Withdrawal" : e.type === "deposit" ? "Deposit" : "Expense" });
      }));
      await fetch(SCRIPT_URL, {
        method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ trip: toPush.name, currency: toPush.currency || "INR", rows: r, rawText: toPush.text }),
      }).catch(() => {});
    }
    // Pull current + 1 previous (limit=2)
    const res = await fetch(SCRIPT_URL + "?limit=2&t=" + Date.now());
    const data = await res.json();
    if (data.success && data.trips) {
      for (const rt of data.trips) {
        const local = trips.find(t => t.name === rt.name);
        if (local) {
          if (!local.text && rt.text) local.text = rt.text;
          if (rt.currency && !local.currency) local.currency = rt.currency;
        } else {
          trips.unshift({ id: Date.now().toString() + Math.random().toString(36).slice(2,6),
            name: rt.name, currency: rt.currency || "INR", text: rt.text || "", created: new Date().toISOString() });
        }
      }
      saveTrips();
    }
  } catch (e) { console.error("Sync error:", e); }
  if (btn) btn.classList.remove("spinning");
  render();
}

// ═══════════════════════════════════════════
//  RENDERING
// ═══════════════════════════════════════════
function render() {
  if (activeId) {
    const trip = trips.find(t => t.id === activeId);
    if (trip) { renderTrip(trip); return; }
    activeId = null;
  }
  renderList();
}

function renderList() {
  const currOpts = CURRENCIES.map(c => `<option value="${c.code}">${c.symbol}${c.code}</option>`).join("");
  let html = `
    <div style="display:flex;align-items:center;justify-content:center;margin-bottom:1rem;position:relative">
      <h1 style="font-size:19px;font-weight:500;text-align:center;flex:1;color:#4f46e5">Trip expenses</h1>
      <button class="sync-btn" onclick="fullSync()" title="Sync">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21.5 2v6h-6"/><path d="M2.5 22v-6h6"/>
          <path d="M2.5 11.5a10 10 0 0 1 18.4-4.5L21.5 8"/>
          <path d="M21.5 12.5a10 10 0 0 1-18.4 4.5L2.5 16"/>
        </svg>
      </button>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:1.25rem">
      <input type="text" id="newTrip" placeholder="Create new trip" style="flex:1;padding:8px 12px"/>
      <select id="newCurr" style="width:68px;font-size:12px;padding:6px 4px;border:0.5px solid rgba(255,255,255,0.6);border-radius:8px;background:rgba(255,255,255,0.5)">${currOpts}</select>
      <button class="btn btn-blue" style="padding:8px 18px;font-size:13px" onclick="createTrip()">Add</button>
    </div>`;

  if (trips.length === 0) {
    html += `<div style="text-align:center;padding:3rem 1rem;color:#94a3b8;font-size:13px">No trips yet. Create one and start noting expenses.</div>`;
  } else {
    trips.forEach(trip => {
      const cc = trip.currency || "INR";
      const days = parseNotes(trip.text);
      let cashT = 0, ccT = 0;
      days.forEach(d => d.entries.forEach(e => {
        if (e.type === "expense") { if (e.method === "cc") ccT += e.amount; else cashT += e.amount; }
      }));
      const count = days.reduce((s, d) => s + d.entries.length, 0);
      html += `<div class="trip-card" onclick="openTrip('${trip.id}')">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <span style="font-size:15px;font-weight:500">${esc(trip.name)}</span>
          <span style="font-size:11px;color:#94a3b8">${cc} · ${count} entries</span>
        </div>
        ${(cashT > 0 || ccT > 0) ? `<div style="display:flex;gap:14px;margin-top:6px;font-size:13px;color:#64748b">
          ${cashT > 0 ? `<span>Cash ${fmtC(cashT, cc)}</span>` : ""}
          ${ccT > 0 ? `<span>CC ${fmtC(ccT, cc)}</span>` : ""}
          <span style="font-weight:500;color:#1a1a1a">Total ${fmtC(cashT + ccT, cc)}</span>
        </div>` : ""}
      </div>`;
    });
  }
  $app().innerHTML = html;
  const inp = $("#newTrip");
  if (inp) inp.addEventListener("keydown", e => { if (e.key === "Enter") createTrip(); });
}

function renderTrip(trip) {
  const days = parseNotes(trip.text);
  let html = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:.75rem">
      <button class="btn" style="padding:6px 12px;font-size:12px" onclick="goBack()">←</button>
      <h2 style="font-size:16px;font-weight:500;flex:1;color:#4f46e5">${esc(trip.name)}</h2>
    </div>
    <div class="tabs">
      <div class="tab ${currentTab === 'notes' ? 'active' : ''}" onclick="switchTab('notes')">Notes</div>
      <div class="tab ${currentTab === 'summary' ? 'active' : ''}" onclick="switchTab('summary')">Summary</div>
    </div>`;

  if (currentTab === "notes") {
    html += `<div>
      <textarea class="notepad" id="notepad" spellcheck="false" autocorrect="off" autocapitalize="off">${esc(trip.text)}</textarea>
      <div class="hint">Just type naturally. Dates as headers, amount before or after item, "cc" for credit card, "+", "*" for math.</div>
    </div>`;
  } else {
    html += renderSummary(days, trip.currency || "INR");
  }

  $app().innerHTML = html;

  if (currentTab === "notes") {
    const ta = $("#notepad");
    if (ta) {
      autoResize(ta);
      ta.addEventListener("input", () => {
        trip.text = ta.value; saveTrips(); pushTripDebounced(trip); autoResize(ta);
      });
      ta.addEventListener("focus", () => ta.style.borderColor = "#888780");
      ta.addEventListener("blur", () => ta.style.borderColor = "#D3D1C7");
    }
  }
}

function autoResize(ta) { ta.style.height = "auto"; ta.style.height = Math.max(300, ta.scrollHeight) + "px"; }

function renderSummary(days, currency) {
  const cc = currency || "INR";
  let totalCash = 0, totalCC = 0;
  const noAmt = [];

  days.forEach(d => d.entries.forEach(e => {
    if (e.type === "expense") {
      if (e.method === "cc") totalCC += e.amount;
      else totalCash += e.amount;
    }
    if (e.amount === 0 && e.type === "expense") noAmt.push(e.item);
  }));

  const grandTotal = totalCash + totalCC;

  if (days.length === 0) return `<div style="text-align:center;padding:3rem 1rem;color:#94a3b8;font-size:13px">Start typing in the notes tab.</div>`;

  const boxes = [
    { label: "Cash", value: totalCash, bg: "rgba(234,243,222,0.7)", bc: "rgba(59,109,17,0.15)", lc: "#3B6D11", vc: "#27500A" },
    { label: "Card", value: totalCC, bg: "rgba(230,241,251,0.7)", bc: "rgba(24,95,165,0.15)", lc: "#185FA5", vc: "#0C447C" },
    { label: "Total", value: grandTotal, bg: "rgba(238,237,254,0.7)", bc: "rgba(83,74,183,0.15)", lc: "#534AB7", vc: "#3C3489", bold: true },
  ];

  let html = `<div style="display:flex;gap:6px;margin-bottom:14px">`;
  boxes.forEach(b => {
    html += `<div class="stat-box" style="background:${b.bg};border:0.5px solid ${b.bc}">
      <div class="stat-label" style="color:${b.lc}">${b.label}</div>
      <div class="stat-val" style="color:${b.vc};font-size:${b.bold ? 16 : 14}px">${fmtBox(b.value, cc)}</div>
    </div>`;
  });
  html += `</div>`;

  html += `<div style="border:1px solid rgba(0,0,0,0.08);border-radius:10px;overflow:hidden">`;

  html += `<div style="display:flex;padding:6px 10px;border-bottom:1px solid rgba(0,0,0,0.08)">
    <div style="flex:1;font-size:10px;font-weight:500;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px">Details</div>
    <div style="width:100px;text-align:right;font-size:10px;font-weight:500;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px">Amount</div>
  </div>`;

  days.forEach((day, di) => {
    const dayTotal = day.entries.filter(e => e.type === "expense").reduce((a, e) => a + e.amount, 0);
    if (di > 0) html += `<hr class="separator"/>`;
    html += `<div class="date-row">
      <div style="flex:1;font-weight:500;font-size:13px;color:#3C3489;text-transform:capitalize">${esc(day.date)}</div>
      <div style="width:100px;text-align:right;font-weight:500;font-size:12px;color:#534AB7">${dayTotal > 0 ? fmtC(dayTotal, cc) : ""}</div>
    </div>`;

    day.entries.forEach(e => {
      const ccBadge = (e.method === "cc" && e.type === "expense") ? `<span class="cc-tag">cc</span>` : "";
      const atmBadge = e.type === "withdrawal" ? `<span class="atm-tag">atm</span>` : "";
      const depBadge = e.type === "deposit" ? `<span class="dep-tag">dep</span>` : "";
      const amtStr = e.amount === 0 ? `<span style="color:#94a3b8">—</span>` : fmt(e.amount);
      html += `<div class="entry-row">
        <div style="flex:1;color:#1a1a1a;text-transform:capitalize">${esc(e.item)}</div>
        <div style="width:100px;text-align:right;font-weight:500;color:#1a1a1a">${ccBadge}${atmBadge}${depBadge}${amtStr}</div>
      </div>`;
    });
  });

  html += `</div>`;

  if (noAmt.length > 0) {
    html += `<div class="no-amount-warn">${noAmt.length} ${noAmt.length === 1 ? "entry" : "entries"} without amounts: ${noAmt.join(", ")}</div>`;
  }
  return html;
}

// ═══════════════════════════════════════════
//  ACTIONS
// ═══════════════════════════════════════════
function createTrip() {
  const inp = $("#newTrip");
  const currSel = $("#newCurr");
  const name = inp ? inp.value.trim() : "";
  if (!name) return;
  const curr = currSel ? currSel.value : "INR";
  const trip = { id: Date.now().toString(), name, currency: curr, text: "", created: new Date().toISOString() };
  trips.unshift(trip); saveTrips();
  activeId = trip.id; currentTab = "notes"; render();
}

function openTrip(id) { activeId = id; currentTab = "notes"; render(); }
function goBack() { activeId = null; currentTab = "notes"; render(); }
function switchTab(t) { currentTab = t; const trip = trips.find(tr => tr.id === activeId); if (trip) renderTrip(trip); }

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════
trips = loadTrips();
render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
