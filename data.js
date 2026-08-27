/*
 * SmartSplitwise — data layer.
 * Holds the app state, a few small shared helpers, and the storage plumbing that
 * pulls the scanned receipt / saved people into the page. Loaded first, so the
 * things here are available to render.js and logic.js.
 */

const $ = (id) => document.getElementById(id);
const SCAN_KEY = "ss_scan";
const PEOPLE_KEY = "ss_people";

const PALETTE = [
  "#34d399", "#60a5fa", "#f472b6", "#fbbf24",
  "#a78bfa", "#fb923c", "#22d3ee", "#f87171",
  "#4ade80", "#c084fc",
];

let state = {
  currency: "$",
  source: null,
  items: [], // {id, name, price, qty, mode, units, assigned}
  tax: 0,
  fees: 0,
  discount: 0,
  people: [], // {id, name, isMe, color}
  payerId: null,
};

let idc = 1;
const uid = (p) => p + "_" + idc++ + "_" + Math.random().toString(36).slice(2, 6);

/* ---------------- small shared helpers ---------------- */
const cur = () => state.currency || "$";
function money(v) {
  if (v === null || v === undefined || isNaN(v)) v = 0;
  const s = v < 0 ? "-" : "";
  return s + cur() + Math.abs(v).toFixed(2);
}
function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}
// format a quantity for display: allow fractions (0.25, 1.5) but drop float noise
// and trailing zeros, so 2 shows as "2" and 0.25 as "0.25".
function fmtQty(v) {
  return String(Math.round(num(v) * 10000) / 10000);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
function initials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ---------------- storage: bringing data into the page ---------------- */
async function loadPeople() {
  const { [PEOPLE_KEY]: saved } = await chrome.storage.local.get(PEOPLE_KEY);
  // No hardcoded "You" — the user adds themselves (with their real name) and taps
  // "set me". Their real name is what shows up in the Splitwise summary.
  state.people = saved && saved.length ? saved : [];
  normalizePayer();
}
function normalizePayer() {
  if (state.payerId && state.people.some((p) => p.id === state.payerId)) return;
  const me = state.people.find((p) => p.isMe);
  state.payerId = me ? me.id : state.people[0] ? state.people[0].id : null;
}
function savePeople() {
  chrome.storage.local.set({ [PEOPLE_KEY]: state.people });
}

async function loadScan() {
  const { [SCAN_KEY]: scan } = await chrome.storage.local.get(SCAN_KEY);
  if (scan && scan.items) {
    state.currency = scan.currency || "$";
    state.source = {
      site: scan.site,
      url: scan.url,
      confidence: scan.confidence,
      title: scan.title,
    };
    state.items = scan.items.map((it) => makeItem(it.name, it.price, it.qty));
    state.tax = num(scan.tax);
    state.fees = num(scan.fees);
    state.discount = num(scan.discount);
    state._scrapedTotal = scan.total != null ? num(scan.total) : null;
    state._scrapedSubtotal = scan.subtotal != null ? num(scan.subtotal) : null;
    state._itemsSource = scan.itemsSource || (scan.items.length ? "dom" : "none");
    // one-time consume so a refresh doesn't reload stale data
    chrome.storage.local.remove(SCAN_KEY);
  }
}
