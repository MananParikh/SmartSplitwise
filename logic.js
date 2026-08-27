/*
 * SmartSplitwise — the actual features.
 * The split math (equal and by-quantity), the paste-a-receipt parser, the
 * Splitwise summary, the button/interaction handlers, and startup. Loaded last,
 * after data.js and render.js, so it can wire everything up and boot.
 */

/* ---------------- item model helpers ---------------- */
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

/* ---------------- split math ---------------- */
function itemsSum() {
  return state.items.reduce((a, it) => a + num(it.price), 0);
}
function extras() {
  return num(state.tax) + num(state.fees) - num(state.discount);
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

  const shares = ids.map((id, i) => ({ id, base: base[id], total: rounded[i] }));
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

/* ---------------- item + people actions ---------------- */
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
