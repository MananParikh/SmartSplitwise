/*
 * SmartSplitwise — rendering.
 * Everything that draws the page from `state`: the source strip, people, the
 * item list (with the equal / by-quantity controls), the charges, and the
 * results. No business logic lives here — it reads state and paints the DOM,
 * wiring each control back to the handlers in logic.js.
 */

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
    el.id = "item-" + it.id;
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
          <span class="unitrow__frac">${fmtQty(x)}/${q}</span>
          <span class="unitrow__cost">${x > 0 ? money(unit * x) : ""}</span>
          <span class="stepper">
            <button class="stepper__b" data-d="-1" ${x <= 0 ? "disabled" : ""}>−</button>
            <input class="stepper__i" type="number" min="0" step="any" value="${fmtQty(x)}" />
            <button class="stepper__b" data-d="1">+</button>
          </span>`;
        row.querySelector('[data-d="-1"]').addEventListener("click", () => setUnits(it, p.id, x - 1));
        row.querySelector('[data-d="1"]').addEventListener("click", () => setUnits(it, p.id, x + 1));
        // accepts fractions like 0.25 or 1.5, not just whole numbers
        row.querySelector(".stepper__i").addEventListener("change", (e) =>
          setUnits(it, p.id, num(e.target.value))
        );
        assign.appendChild(row);
      });
      const hint = document.createElement("div");
      hint.className = "item__qtyhint";
      const rem = q - totalU;
      hint.innerHTML =
        `<span>${fmtQty(totalU)}/${q} units assigned</span>` +
        (rem > 0.0001
          ? `<span class="item__qtyhint--warn">${fmtQty(rem)} unit${rem === 1 ? "" : "s"} (${money(unit * rem)}) unassigned</span>`
          : totalU > q + 0.0001
          ? `<span class="item__qtyhint--warn">over-assigned — split across ${fmtQty(totalU)} units</span>`
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

  // warnings — any item with unallocated dollars (fully unassigned, OR a
  // partially-assigned by-quantity item with leftover units) shows as a chip
  // you can click to jump to and finish.
  const warn = $("warnings");
  warn.innerHTML = "";
  const needFix = state.items.filter((it) => itemUnallocatedAmt(it) > 0.004);
  if (needFix.length) {
    const box = document.createElement("div");
    box.className = "warn";
    const head = document.createElement("div");
    head.textContent = `${money(unallocated)} isn't allocated to anyone yet — ${needFix.length} item${
      needFix.length > 1 ? "s" : ""
    }. Tap to fix:`;
    box.appendChild(head);
    const links = document.createElement("div");
    links.className = "warn__links";
    needFix.forEach((it) => {
      const b = document.createElement("button");
      b.className = "warn__link";
      const left = itemUnallocatedAmt(it);
      const nm = (it.name || "").trim() || "Unnamed item";
      b.textContent = `${nm} (${money(left)})`;
      b.addEventListener("click", () => jumpToItem(it.id));
      links.appendChild(b);
    });
    box.appendChild(links);
    warn.appendChild(box);
  }

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

// scroll an item into view and flash it — used by the "unassigned" warning chips
function jumpToItem(id) {
  const el = document.getElementById("item-" + id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("item--flash");
  setTimeout(() => el.classList.remove("item--flash"), 1300);
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
