/* SmartSplitwise app: assignment + proportional split + settlement. */

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
  items: [], // {id, name, price, assigned:[personId]}
  tax: 0,
  fees: 0,
  discount: 0,
  people: [], // {id, name, isMe, color}
  payerId: null,
};

let idc = 1;
const uid = (p) => p + "_" + idc++ + "_" + Math.random().toString(36).slice(2, 6);

/* ---------------- money helpers ---------------- */
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
// Round an array of exact dollar values to cents so their sum stays exact.
function allocateCents(values) {
  const cents = values.map((v) => v * 100);
  const floor = cents.map((c) => Math.floor(c));
  const target = Math.round(cents.reduce((a, b) => a + b, 0));
  let remainder = target - floor.reduce((a, b) => a + b, 0);
  const order = cents
    .map((c, i) => ({ i, frac: c - Math.floor(c) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder && order.length; k++) floor[order[k % order.length].i]++;
  return floor.map((c) => c / 100);
}

function isQtyMode(it) {
  return it.mode === "qty" && (num(it.qty) || 1) > 1;
}
function itemUnassigned(it) {
  const liveIds = state.people.map((p) => p.id);
  if (isQtyMode(it)) {
    return liveIds.reduce((s, id) => s + Math.max(0, num((it.units || {})[id])), 0) === 0;
  }
  return (it.assigned || []).filter((id) => liveIds.includes(id)).length === 0;
}
// distribute `qty` whole units across ids as evenly as possible (largest first)
function evenUnits(qty, ids) {
  const u = {};
  const n = ids.length;
  if (!n) return u;
  const base = Math.floor(qty / n);
  let r = qty - base * n;
  ids.forEach((id, i) => (u[id] = base + (i < r ? 1 : 0)));
  return u;
}

// build an item with mode/qty/units defaults. Nobody is assigned by default —
// qty>1 starts in "by quantity" (all units 0), qty==1 starts in "equal" (nobody
// tagged). The user explicitly assigns people per item.
function makeItem(name, price, qty) {
  const q = Math.max(1, Math.round(num(qty)) || 1);
  return {
    id: uid("i"),
    name: name || "",
    price: price === "" || price == null ? "" : num(price),
    qty: q,
    mode: q > 1 ? "qty" : "equal",
    units: {},
    assigned: [],
  };
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ---------------- persistence ---------------- */
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

/* ---------------- computation ---------------- */
function itemsSum() {
  return state.items.reduce((a, it) => a + num(it.price), 0);
}
function extras() {
  return num(state.tax) + num(state.fees) - num(state.discount);
}

function compute() {
  const base = {};
  state.people.forEach((p) => (base[p.id] = 0));
  let unallocated = 0;
  const liveIds = new Set(state.people.map((p) => p.id));

  for (const it of state.items) {
    const price = num(it.price);
    if (isQtyMode(it)) {
      const q = Math.max(1, num(it.qty) || 1);
      const u = it.units || {};
      let totalU = 0;
      state.people.forEach((p) => {
        if (liveIds.has(p.id)) totalU += Math.max(0, num(u[p.id]));
      });
      const denom = Math.max(q, totalU);
      if (denom > 0 && totalU > 0) {
        state.people.forEach((p) => {
          if (!liveIds.has(p.id)) return;
          const x = Math.max(0, num(u[p.id]));
          if (x) base[p.id] += (price * x) / denom;
        });
        unallocated += (price * (denom - totalU)) / denom;
      } else {
        unallocated += price;
      }
    } else {
      const a = (it.assigned || []).filter((id) => liveIds.has(id));
      if (a.length === 0) {
        unallocated += price;
        continue;
      }
      const share = price / a.length;
      a.forEach((id) => (base[id] += share));
    }
  }

  const baseSum = Object.values(base).reduce((a, b) => a + b, 0);
  const ex = extras();
  const ids = state.people.map((p) => p.id);

  const exact = ids.map((id) => {
    if (baseSum > 0) return base[id] + ex * (base[id] / baseSum);
    return ex / (ids.length || 1); // no items assigned: split extras evenly
  });
  const rounded = allocateCents(exact);

  const shares = ids.map((id, i) => ({
    id,
    base: base[id],
    total: rounded[i],
  }));
  const allocatedTotal = baseSum + ex;

  return { shares, baseSum, extras: ex, unallocated, allocatedTotal };
}

// who shares an item, with unit counts in qty mode
function itemSharers(it) {
  if (isQtyMode(it)) {
    return state.people
      .filter((p) => Math.max(0, num((it.units || {})[p.id])) > 0)
      .map((p) => ({ p, units: Math.max(0, num(it.units[p.id])) }));
  }
  return (it.assigned || [])
    .filter((id) => state.people.some((p) => p.id === id))
    .map((id) => ({ p: state.people.find((x) => x.id === id) }));
}
function qtyDenom(it) {
  const q = Math.max(1, num(it.qty) || 1);
  let t = 0;
  state.people.forEach((p) => (t += Math.max(0, num((it.units || {})[p.id]))));
  return Math.max(q, t);
}
// what one person pays for one item (mirrors compute())
function itemCostFor(it, pid) {
  const price = num(it.price);
  if (isQtyMode(it)) {
    const denom = qtyDenom(it);
    const u = Math.max(0, num((it.units || {})[pid]));
    return denom > 0 ? (price * u) / denom : 0;
  }
  const a = (it.assigned || []).filter((id) => state.people.some((p) => p.id === id));
  return a.includes(pid) ? price / a.length : 0;
}

/* ---------------- rendering ---------------- */
function personColor(id) {
  const p = state.people.find((x) => x.id === id);
  return p ? p.color : "#888";
}

function renderSource() {
  const el = $("source");
  if (state.source) {
    const conf = state.source.confidence || "low";
    const label =
      conf === "high"
        ? "auto-read looks accurate"
        : conf === "medium"
        ? "auto-read — double-check the numbers"
        : "auto-read — please review carefully";
    el.innerHTML = `<div class="source__inner">
      <span class="source__dot"></span>
      <span class="source__site">${escapeHtml(state.source.site || "Receipt")}</span>
      <span class="source__meta">· ${label}</span>
    </div>`;
  } else {
    el.innerHTML = `<div class="source__inner">
      <span class="source__dot"></span>
      <span class="source__site">Manual entry</span>
      <span class="source__meta">· add items below, or scan a receipt from the toolbar icon</span>
    </div>`;
  }
}

function renderPeople() {
  normalizePayer();
  const box = $("people");
  box.innerHTML = "";
  const nameInput = $("personName");
  if (nameInput)
    nameInput.placeholder = state.people.length === 0 ? "Your name" : "Add a person (e.g. Roommate A)";
  if (state.people.length === 0) {
    const fr = document.createElement("div");
    fr.className = "firstrun";
    fr.innerHTML =
      "👋 Start by adding <b>yourself</b> — type your name below and click <b>+ Add</b>, then tap <b>set me</b> on your name. Then add your roommates.";
    box.appendChild(fr);
  }
  state.people.forEach((p) => {
    const el = document.createElement("div");
    el.className = "person";
    el.innerHTML = `
      <span class="avatar" style="background:${p.color}">${escapeHtml(
      initials(p.name)
    )}</span>
      <span class="person__name">${escapeHtml(p.name)}</span>
      <button class="person__me ${p.isMe ? "" : "person__me--off"}" title="Mark as you">${
      p.isMe ? "you" : "set me"
    }</button>
      <button class="person__x" title="Remove">×</button>`;
    el.querySelector(".person__me").addEventListener("click", () => setMe(p.id));
    el.querySelector(".person__x").addEventListener("click", () => removePerson(p.id));
    box.appendChild(el);
  });

  // payer dropdown
  const sel = $("payer");
  sel.innerHTML = "";
  state.people.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name + (p.isMe ? " (you)" : "");
    if (p.id === state.payerId) o.selected = true;
    sel.appendChild(o);
  });
}

function renderItems() {
  const box = $("items");
  box.innerHTML = "";
  if (state.items.length === 0) {
    if (state.source && state._itemsSource === "none") {
      const sub =
        state._scrapedSubtotal != null
          ? ` The page's subtotal was <b>${money(state._scrapedSubtotal)}</b> — add the items that make it up.`
          : "";
      box.innerHTML = `<div class="empty">Couldn't read the individual items from this page (its receipt hides them or loads them separately).${sub} Add them below to split.</div>`;
    } else {
      box.innerHTML = `<div class="empty">No items yet. Add one below, or scan a receipt from the toolbar icon.</div>`;
    }
    return;
  }
  state.items.forEach((it) => {
    const qtyMode = isQtyMode(it);
    const el = document.createElement("div");
    el.className = "item" + (itemUnassigned(it) ? " item--unassigned" : "");

    // --- top: name / price / delete ---
    const top = document.createElement("div");
    top.className = "item__top";
    top.innerHTML = `
      <input class="item__name" value="${escapeAttr(it.name)}" placeholder="Item name" />
      <input class="item__price" type="number" step="0.01" min="0" value="${
        it.price !== "" && it.price !== null ? Number(it.price).toFixed(2) : ""
      }" />
      <button class="item__del" title="Remove item">×</button>`;
    top.querySelector(".item__name").addEventListener("input", (e) => {
      it.name = e.target.value;
    });
    top.querySelector(".item__price").addEventListener("input", (e) => {
      it.price = e.target.value;
      recalc();
    });
    top.querySelector(".item__del").addEventListener("click", () => {
      state.items = state.items.filter((x) => x.id !== it.id);
      render();
    });

    // --- mode toggle (+ qty field when in qty mode) ---
    const modeRow = document.createElement("div");
    modeRow.className = "item__mode";
    modeRow.innerHTML = `
      <div class="seg">
        <button class="seg__btn ${qtyMode ? "" : "seg__btn--on"}" data-m="equal">Equal split</button>
        <button class="seg__btn ${qtyMode ? "seg__btn--on" : ""}" data-m="qty">By quantity</button>
      </div>`;
    modeRow.querySelector('[data-m="equal"]').addEventListener("click", () => setMode(it, "equal"));
    modeRow.querySelector('[data-m="qty"]').addEventListener("click", () => setMode(it, "qty"));
    if (qtyMode) {
      const qwrap = document.createElement("label");
      qwrap.className = "qtyfield";
      qwrap.innerHTML = `Qty <input type="number" min="2" step="1" value="${Math.max(2, num(it.qty) || 2)}" />`;
      qwrap.querySelector("input").addEventListener("change", (e) => {
        it.qty = Math.max(1, Math.round(num(e.target.value)) || 1);
        render();
      });
      modeRow.appendChild(qwrap);
    }

    // --- assignment ---
    const assign = document.createElement("div");
    assign.className = "item__assign";

    if (!qtyMode) {
      const liveAssigned = (it.assigned || []).filter((id) =>
        state.people.some((p) => p.id === id)
      );
      state.people.forEach((p) => {
        const on = liveAssigned.includes(p.id);
        const tag = document.createElement("button");
        tag.className = "tag" + (on ? " tag--on" : "");
        tag.innerHTML = `<span class="tag__dot" style="background:${on ? "#0b1020" : p.color}"></span>${
          on ? "✓ " : ""
        }${escapeHtml(p.name)}`;
        if (on) {
          tag.style.background = p.color;
          tag.style.borderColor = p.color;
          tag.style.color = "#0b1020";
        }
        tag.addEventListener("click", () => toggleAssign(it, p.id));
        assign.appendChild(tag);
      });
      const split = document.createElement("span");
      split.className = "item__split";
      split.textContent =
        liveAssigned.length > 1
          ? `${money(num(it.price) / liveAssigned.length)} each`
          : liveAssigned.length === 0
          ? "unassigned"
          : "";
      assign.appendChild(split);
    } else {
      const q = Math.max(1, num(it.qty) || 1);
      const u = it.units || (it.units = {});
      let totalU = 0;
      state.people.forEach((p) => (totalU += Math.max(0, num(u[p.id]))));
      const unit = q > 0 ? num(it.price) / q : 0;
      state.people.forEach((p) => {
        const x = Math.max(0, num(u[p.id]));
        const row = document.createElement("div");
        row.className = "unitrow" + (x > 0 ? " unitrow--on" : "");
        row.innerHTML = `
          <span class="tag__dot" style="background:${p.color}"></span>
          <span class="unitrow__name">${escapeHtml(p.name)}</span>
          <span class="unitrow__frac">${x}/${q}</span>
          <span class="unitrow__cost">${x > 0 ? money(unit * x) : ""}</span>
          <span class="stepper">
            <button class="stepper__b" data-d="-1" ${x <= 0 ? "disabled" : ""}>−</button>
            <input class="stepper__i" type="number" min="0" step="1" value="${x}" />
            <button class="stepper__b" data-d="1">+</button>
          </span>`;
        row.querySelector('[data-d="-1"]').addEventListener("click", () => setUnits(it, p.id, x - 1));
        row.querySelector('[data-d="1"]').addEventListener("click", () => setUnits(it, p.id, x + 1));
        row.querySelector(".stepper__i").addEventListener("change", (e) =>
          setUnits(it, p.id, Math.round(num(e.target.value)))
        );
        assign.appendChild(row);
      });
      const hint = document.createElement("div");
      hint.className = "item__qtyhint";
      const rem = q - totalU;
      hint.innerHTML =
        `<span>${totalU}/${q} units assigned</span>` +
        (rem > 0
          ? `<span class="item__qtyhint--warn">${rem} unit${rem === 1 ? "" : "s"} (${money(unit * rem)}) unassigned</span>`
          : totalU > q
          ? `<span class="item__qtyhint--warn">over-assigned — split across ${totalU} units</span>`
          : `<span class="item__qtyhint--ok">fully assigned ✓</span>`);
      assign.appendChild(hint);
    }

    el.appendChild(top);
    el.appendChild(modeRow);
    el.appendChild(assign);
    box.appendChild(el);
  });
}

function renderResult() {
  const { shares, unallocated, allocatedTotal } = compute();
  const maxShare = Math.max(0.01, ...shares.map((s) => s.total));

  // warnings
  const warn = $("warnings");
  const msgs = [];
  const unassignedCount = state.items.filter(
    (it) =>
      (it.assigned || []).filter((id) => state.people.some((p) => p.id === id))
        .length === 0
  ).length;
  if (unassignedCount > 0) {
    msgs.push(
      `${unassignedCount} item${unassignedCount > 1 ? "s are" : " is"} unassigned — ${money(
        unallocated
      )} isn't allocated to anyone yet.`
    );
  }
  warn.innerHTML = msgs.map((m) => `<div class="warn">${m}</div>`).join("");

  // per-person shares
  const box = $("shares");
  box.innerHTML = "";
  shares.forEach((s) => {
    const p = state.people.find((x) => x.id === s.id);
    if (!p) return;
    const row = document.createElement("div");
    row.className = "share";
    const pct = Math.max(2, (s.total / maxShare) * 100);
    row.innerHTML = `
      <span class="avatar" style="background:${p.color}">${escapeHtml(
      initials(p.name)
    )}</span>
      <div class="share__mid">
        <div class="share__row">
          <span class="share__name">${escapeHtml(p.name)}${
      p.isMe ? '<span class="share__you">you</span>' : ""
    }</span>
          <span class="share__amt">${money(s.total)}</span>
        </div>
        <div class="share__bar"><span class="share__fill" style="width:${pct}%;background:${
      p.color
    }"></span></div>
      </div>`;
    box.appendChild(row);
  });

  // settlement
  const payer = state.people.find((p) => p.id === state.payerId) || state.people[0];
  const settle = $("settle");
  settle.innerHTML = "";
  if (!payer) {
    settle.innerHTML = `<div class="settle__empty">Add people to see the split.</div>`;
  } else {
    const others = shares.filter((s) => s.id !== payer.id && s.total > 0.004);
    const title = document.createElement("div");
    title.className = "settle__title";
    title.textContent = `Settle up · ${payer.name} paid ${money(allocatedTotal)}`;
    settle.appendChild(title);

    if (others.length === 0) {
      const e = document.createElement("div");
      e.className = "settle__empty";
      e.textContent = "Nobody owes anything yet — assign items to people.";
      settle.appendChild(e);
    } else {
      others.forEach((s) => {
        const p = state.people.find((x) => x.id === s.id);
        const row = document.createElement("div");
        row.className = "settle__row";
        row.innerHTML = `<span>${escapeHtml(p.name)} → ${escapeHtml(
          payer.name
        )}</span><b>${money(s.total)}</b>`;
        settle.appendChild(row);
      });
    }
    const selfShare = shares.find((s) => s.id === payer.id);
    if (selfShare) {
      const self = document.createElement("div");
      self.className = "settle__self";
      self.textContent = `${payer.name} covers own share: ${money(selfShare.total)}`;
      settle.appendChild(self);
    }
  }
}

function renderCharges() {
  $("itemsSum").textContent = money(itemsSum());
  $("tax").value = state.tax ? Number(state.tax) : "";
  $("fees").value = state.fees ? Number(state.fees) : "";
  $("discount").value = state.discount ? Number(state.discount) : "";
  $("billTotal").textContent = money(itemsSum() + extras());
  $("currency").value = state.currency;

  // note if scraped total disagrees with computed total
  const note = $("totalNote");
  if (state.source && state._scrapedTotal != null) {
    const diff = Math.abs(state._scrapedTotal - (itemsSum() + extras()));
    if (diff > 0.02) {
      note.hidden = false;
      note.textContent = `Heads up: the page showed a total of ${money(
        state._scrapedTotal
      )}. Adjust items, tax, or fees so it matches.`;
    } else note.hidden = true;
  } else note.hidden = true;
}

function render() {
  renderSource();
  renderPeople();
  renderItems();
  renderCharges();
  renderResult();
}
// lighter recalc that skips rebuilding item inputs (preserves focus)
function recalc() {
  renderCharges();
  renderResult();
}

/* ---------------- actions ---------------- */
function toggleAssign(it, personId) {
  it.assigned = it.assigned || [];
  if (it.assigned.includes(personId))
    it.assigned = it.assigned.filter((id) => id !== personId);
  else it.assigned.push(personId);
  render();
}
function setMode(it, mode) {
  if (mode === "qty") {
    // carry over only the people already tagged (never auto-add everyone)
    const sharers = (it.assigned || []).filter((id) => state.people.some((p) => p.id === id));
    if (!(num(it.qty) > 1)) it.qty = Math.max(2, sharers.length || 2);
    it.units = sharers.length ? evenUnits(Math.max(1, num(it.qty) || 1), sharers) : {};
    it.mode = "qty";
  } else {
    // only people who actually had units carry over (nobody by default)
    const u = it.units || {};
    it.assigned = state.people.map((p) => p.id).filter((id) => num(u[id]) > 0);
    it.mode = "equal";
  }
  render();
}
function setUnits(it, personId, x) {
  it.units = it.units || {};
  it.units[personId] = Math.max(0, Math.round(num(x)));
  render();
}
function setMe(id) {
  state.people.forEach((p) => (p.isMe = p.id === id));
  savePeople();
  render();
}
function removePerson(id) {
  state.people = state.people.filter((p) => p.id !== id);
  state.items.forEach((it) => {
    it.assigned = (it.assigned || []).filter((x) => x !== id);
    if (it.units) delete it.units[id];
  });
  normalizePayer();
  savePeople();
  render();
}
function addPerson(name) {
  name = (name || "").trim();
  if (!name) return;
  const used = state.people.map((p) => p.color);
  const color = PALETTE.find((c) => !used.includes(c)) || PALETTE[state.people.length % PALETTE.length];
  state.people.push({ id: uid("p"), name, isMe: false, color });
  savePeople();
  render();
}
function addItem() {
  state.items.push({ id: uid("i"), name: "", price: "", qty: 1, mode: "equal", units: {}, assigned: [] });
  render();
  const inputs = document.querySelectorAll(".item__name");
  if (inputs.length) inputs[inputs.length - 1].focus();
}

/* ---------------- paste-a-receipt parser ---------------- */
function parseReceiptText(text) {
  const empty = { items: [], subtotal: null, tax: null, total: null, fees: null, discount: null };
  if (!text || !text.trim()) return empty;
  const M = "(?:[$€£₹]\\s?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|\\d{1,3}(?:,\\d{3})*\\.\\d{2})";
  const RE = new RegExp(M);
  const REG = new RegExp(M, "g");
  const parseM = (s) => {
    const m = String(s).match(RE);
    return m ? parseFloat(m[0].replace(/[^0-9.]/g, "")) : null;
  };
  const SUMMARY = /\b(sub[\s-]?total|sales?\s*tax|tax|gst|hst|vat|grand\s*total|order\s*total|total|delivery|service|shipping|driver\s*tip|tip|gratuity|bag\s*fee|fee|savings|discount|promo|coupon|balance|amount\s*due|payment)\b/i;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);

  const detectQty = (s) => {
    let m;
    if ((m = s.match(/\bqty:?\s*(\d{1,3})\b/i))) return +m[1];
    if ((m = s.match(/^\s*(\d{1,3})\s*(?:x|×|@)\s+/i))) return +m[1];
    if ((m = s.match(/(?:x|×)\s*(\d{1,3})\b/i))) return +m[1];
    return 1;
  };
  const stripQty = (s) =>
    s
      .replace(/^\d{1,3}\s*(?:x|×|@)\s*/i, "")
      .replace(/\bqty:?\s*\d{1,3}\b/i, "")
      .replace(/(?:x|×)\s*\d{1,3}\b/i, "")
      .replace(/\s+/g, " ")
      .trim();

  const c = { subtotal: null, tax: null, total: null, fees: 0, discount: 0, tip: 0 };
  let sawFee = false, sawTip = false, sawDisc = false;
  const items = [];
  let pendingName = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prices = line.match(REG) || [];
    if (SUMMARY.test(line)) {
      pendingName = null;
      let val = prices.length ? parseM(prices[prices.length - 1]) : null;
      // "Tax" on one line, "$4.91" on the next
      if (val == null && i + 1 < lines.length && !/[a-zA-Z]/.test(lines[i + 1]) && RE.test(lines[i + 1])) {
        val = parseM(lines[i + 1]);
        i++;
      }
      if (val == null) continue;
      if (/\bsub[\s-]?total\b/i.test(line)) {
        if (c.subtotal == null || val > c.subtotal) c.subtotal = val;
      } else if (/\b(grand\s*total|order\s*total|total|amount\s*due)\b/i.test(line) && !/sub/i.test(line)) {
        if (c.total == null || val > c.total) c.total = val;
      } else if (/\b(sales?\s*tax|tax|gst|hst|vat)\b/i.test(line) && !/rate/i.test(line)) {
        if (c.tax == null) c.tax = val;
      } else if (/\b(savings|discount|promo|coupon)\b/i.test(line)) {
        c.discount += Math.abs(val); sawDisc = true;
      } else if (/\b(driver\s*tip|tip|gratuity)\b/i.test(line)) {
        c.tip += Math.abs(val); sawTip = true;
      } else if (/\b(delivery|service|shipping|bag\s*fee|fee)\b/i.test(line)) {
        c.fees += Math.abs(val); sawFee = true;
      }
      continue;
    }
    if (prices.length) {
      const price = parseM(prices[prices.length - 1]);
      const noPrice = line.replace(REG, " ").replace(/\s+/g, " ").trim();
      let qty = detectQty(noPrice);
      let name = stripQty(noPrice);
      if (!name && pendingName) {
        name = stripQty(pendingName);
        qty = Math.max(qty, detectQty(pendingName));
        pendingName = null;
      }
      if (price != null && price > 0)
        items.push({ name: name || "Item " + (items.length + 1), price, qty });
    } else {
      pendingName = line; // a name whose price is on the following line
    }
  }
  if (c.tip) c.fees += c.tip;
  return {
    items,
    subtotal: c.subtotal,
    tax: c.tax,
    total: c.total,
    fees: sawFee || c.fees ? Number(c.fees.toFixed(2)) : null,
    discount: sawDisc ? Number(c.discount.toFixed(2)) : null,
  };
}

function applyParsed(p) {
  if (!p.items.length && p.subtotal == null && p.total == null && p.tax == null) return false;
  state.items = p.items.map((it) => makeItem(it.name, it.price, it.qty));
  state.tax = num(p.tax);
  state.fees = num(p.fees);
  state.discount = num(p.discount);
  state._scrapedTotal = p.total != null ? num(p.total) : null;
  state._scrapedSubtotal = p.subtotal != null ? num(p.subtotal) : null;
  state._itemsSource = p.items.length ? "paste" : "none";
  const sum = p.items.reduce((a, b) => a + num(b.price), 0);
  const conf = p.items.length && p.subtotal != null && Math.abs(sum - p.subtotal) < 0.75
    ? "high" : p.items.length ? "medium" : "low";
  state.source = { site: "Pasted receipt", url: "", confidence: conf, title: "Pasted receipt" };
  render();
  return true;
}

/* ---------------- Splitwise summary ---------------- */
// The copy summary is meant for the Splitwise expense NOTES: it explains HOW the
// bill was split (item by item), not who owes what (the app bars + Splitwise
// itself already show the totals). Sections: shared-by-everyone → group → personal.
function buildSummary() {
  const { unallocated } = compute();
  const where = state.source && state.source.site ? state.source.site : "Receipt";
  const date = new Date().toLocaleDateString();
  const N = state.people.length;

  const everyone = [], group = [], unassigned = [];
  const personal = {}; // pid -> [{it, sh}]
  for (const it of state.items) {
    const sh = itemSharers(it);
    if (sh.length === 0) { unassigned.push(it); continue; }
    if (sh.length === 1) {
      const pid = sh[0].p.id;
      (personal[pid] = personal[pid] || []).push({ it, sh });
    } else if (sh.length === N && N > 1) {
      everyone.push({ it, sh });
    } else {
      group.push({ it, sh });
    }
  }

  const detail = (it, sh) => {
    if (isQtyMode(it)) {
      const q = Math.max(1, num(it.qty) || 1);
      return sh.map((s) => `${s.p.name} ${s.units}/${q} = ${money(itemCostFor(it, s.p.id))}`).join(", ");
    }
    return `${money(num(it.price) / sh.length)} each`;
  };

  const L = [];
  L.push(`SmartSplitwise — ${where} — ${date}`);
  L.push(`Tax & fees are split in proportion to each person's items.`);
  L.push("How this was split:");

  if (everyone.length) {
    L.push("");
    L.push("• SHARED BY EVERYONE:");
    everyone.forEach(({ it, sh }) =>
      L.push(`   - ${it.name || "Item"} (${money(num(it.price))}) → split ${sh.length} ways, ${detail(it, sh)}`)
    );
  }
  if (group.length) {
    L.push("");
    L.push("• SHARED BY SOME:");
    group.forEach(({ it, sh }) => {
      const who = sh.map((s) => s.p.name).join(", ");
      L.push(`   - ${it.name || "Item"} (${money(num(it.price))}) → ${who}: ${detail(it, sh)}`);
    });
  }
  const anyPersonal = Object.keys(personal).length > 0;
  if (anyPersonal) {
    L.push("");
    L.push("• PERSONAL ITEMS:");
    state.people.forEach((p) => {
      const arr = personal[p.id];
      if (!arr || !arr.length) return;
      const items = arr
        .map(({ it }) => {
          const q = isQtyMode(it) ? `${Math.max(0, num((it.units || {})[p.id]))}× ` : "";
          return `${q}${it.name || "Item"} (${money(itemCostFor(it, p.id))})`;
        })
        .join(", ");
      const sum = arr.reduce((a, { it }) => a + itemCostFor(it, p.id), 0);
      L.push(`   - ${p.name} — ${money(sum)}: ${items}`);
      L.push(""); // blank line after each person's personal summary
    });
  }
  if (unallocated > 0.004) {
    L.push("");
    L.push(`• NOT ASSIGNED (${money(unallocated)}): ${unassigned.map((it) => it.name || "Item").join(", ")}`);
  }
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

async function copySummary() {
  const text = buildSummary();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const toast = $("toast");
  toast.hidden = false;
  clearTimeout(copySummary._t);
  copySummary._t = setTimeout(() => (toast.hidden = true), 1800);
}

/* ---------------- misc helpers ---------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

/* ---------------- wiring ---------------- */
$("addPersonForm").addEventListener("submit", (e) => {
  e.preventDefault();
  addPerson($("personName").value);
  $("personName").value = "";
  $("personName").focus();
});
$("addItem").addEventListener("click", addItem);
$("pasteToggle").addEventListener("click", () => {
  const w = $("pasteWrap");
  w.hidden = !w.hidden;
  $("pasteToggle").textContent = w.hidden ? "show" : "hide";
});
$("parseBtn").addEventListener("click", () => {
  const parsed = parseReceiptText($("pasteBox").value);
  const ok = applyParsed(parsed);
  const hint = $("parseHint");
  hint.textContent = ok
    ? `Parsed ${parsed.items.length} item${parsed.items.length === 1 ? "" : "s"}${
        parsed.subtotal != null ? " · subtotal " + money(parsed.subtotal) : ""
      }.`
    : "Couldn't find items in that text — make sure each line has a name and a price.";
});
$("tax").addEventListener("input", (e) => {
  state.tax = num(e.target.value);
  recalc();
});
$("fees").addEventListener("input", (e) => {
  state.fees = num(e.target.value);
  recalc();
});
$("discount").addEventListener("input", (e) => {
  state.discount = num(e.target.value);
  recalc();
});
$("currency").addEventListener("change", (e) => {
  state.currency = e.target.value;
  render();
});
$("payer").addEventListener("change", (e) => {
  state.payerId = e.target.value;
  renderResult();
});
$("everyoneAll").addEventListener("click", () => {
  const ids = state.people.map((p) => p.id);
  state.items.forEach((it) => {
    if (isQtyMode(it)) it.units = evenUnits(Math.max(1, num(it.qty) || 1), ids);
    else it.assigned = ids.slice();
  });
  render();
});
$("clearAssign").addEventListener("click", () => {
  state.items.forEach((it) => {
    it.assigned = [];
    it.units = {};
  });
  render();
});
$("clearBtn").addEventListener("click", () => {
  state.items = [];
  state.tax = state.fees = state.discount = 0;
  state.source = null;
  state._scrapedTotal = null;
  render();
});
$("copyBtn").addEventListener("click", copySummary);

/* ---------------- boot ---------------- */
(async function boot() {
  await loadPeople();
  await loadScan();
  render();
})();
