/*
 * SmartSplitwise — Splitwise posting (extension only).
 * Posts the computed split straight to the user's Splitwise account via their
 * personal API key. The key lives in chrome.storage.local and is only ever sent
 * to secure.splitwise.com. Extension pages can call the API directly because the
 * manifest lists it under host_permissions (so CORS doesn't block it).
 */
(function () {
  const SW_KEY = "ss_sw_key";
  const BASE = "https://secure.splitwise.com/api/v3.0/";
  const SW = { key: null, user: null, groups: null, friends: null };

  const modal = $("swModal");
  const bodyEl = $("swBody");

  /* ---------------- API ---------------- */
  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ Authorization: "Bearer " + SW.key }, opts.headers || {});
    let res;
    try {
      res = await fetch(BASE + path, Object.assign({}, opts, { headers }));
    } catch (e) {
      throw new Error("Couldn't reach Splitwise (network/permission). " + (e.message || ""));
    }
    if (res.status === 401) throw new Error("That API key was rejected (401). Double-check it.");
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error("Splitwise error " + res.status + (data && data.error ? ": " + data.error : ""));
    return data;
  }
  const getCurrentUser = () => api("get_current_user").then((d) => d.user);
  const getGroups = () => api("get_groups").then((d) => d.groups || []);
  const getFriends = () => api("get_friends").then((d) => d.friends || []);
  function createExpense(params) {
    return api("create_expense", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  }

  /* ---------------- storage ---------------- */
  async function loadKey() {
    const { [SW_KEY]: k } = await chrome.storage.local.get(SW_KEY);
    SW.key = k || null;
    return SW.key;
  }
  function saveKey(k) { SW.key = k; chrome.storage.local.set({ [SW_KEY]: k }); }
  function clearKey() {
    SW.key = null; SW.user = null; SW.groups = null; SW.friends = null;
    chrome.storage.local.remove(SW_KEY);
  }

  /* ---------------- helpers ---------------- */
  function curCode() {
    return { "$": "USD", "€": "EUR", "£": "GBP", "₹": "INR" }[cur()] || "USD";
  }
  function setStatus(msg, kind) {
    const el = $("swStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "sw-status" + (kind === "err" ? " sw-status--err" : kind === "ok" ? " sw-status--ok" : "");
  }
  function flattenErrors(errors) {
    const out = [];
    (function walk(o) {
      if (!o) return;
      if (Array.isArray(o)) o.forEach(walk);
      else if (typeof o === "object") Object.values(o).forEach(walk);
      else out.push(String(o));
    })(errors);
    return out.join("; ");
  }

  /* ---------------- modal open/close ---------------- */
  function open() {
    modal.hidden = false;
    render();
  }
  function close() {
    modal.hidden = true;
  }

  async function render() {
    if (!SW.key) return renderConnect();
    bodyEl.innerHTML = `<div class="sw-status">Connecting…</div>`;
    try {
      if (!SW.user) SW.user = await getCurrentUser();
      renderPush();
    } catch (e) {
      renderConnect(e.message);
    }
  }

  /* ---------------- connect view ---------------- */
  function renderConnect(err) {
    bodyEl.innerHTML = `
      <p class="sw-help">
        Optional — posting straight to Splitwise needs a personal <b>API key</b>.
        <b>Splitwise requires an active Splitwise Pro subscription</b> to register an
        app and get one. No Pro? Just use <b>Copy summary</b> instead — it's free and
        drops the same breakdown into the expense's notes.
        <ol>
          <li>Open <a href="https://secure.splitwise.com/apps" target="_blank" rel="noopener noreferrer">secure.splitwise.com/apps</a> and register an app (any name and URL work).</li>
          <li>Copy the <b>API key</b> it shows.</li>
          <li>Paste it below — it's stored only in this extension, on your computer.</li>
        </ol>
      </p>
      <div class="sw-field">
        <label for="swKeyInput">Splitwise API key</label>
        <input class="sw-input" id="swKeyInput" type="password" placeholder="paste your API key" autocomplete="off" />
      </div>
      <div class="sw-status ${err ? "sw-status--err" : ""}" id="swStatus">${err ? escapeHtml(err) : ""}</div>
      <div class="sw-actions">
        <button class="btn btn--ghost" id="swCancel">Cancel</button>
        <button class="btn btn--go" id="swConnect">Connect</button>
      </div>`;
    $("swCancel").addEventListener("click", close);
    $("swConnect").addEventListener("click", async () => {
      const k = $("swKeyInput").value.trim();
      if (!k) return setStatus("Paste your API key first.", "err");
      const btn = $("swConnect");
      btn.disabled = true;
      setStatus("Connecting…");
      SW.key = k;
      try {
        SW.user = await getCurrentUser();
        saveKey(k);
        renderPush();
      } catch (e) {
        SW.key = null;
        btn.disabled = false;
        setStatus(e.message || "Couldn't connect.", "err");
      }
    });
    const inp = $("swKeyInput");
    if (inp) inp.focus();
  }

  /* ---------------- push view ---------------- */
  async function renderPush() {
    bodyEl.innerHTML = `<div class="sw-status">Loading your groups…</div>`;
    try {
      SW.groups = await getGroups();
    } catch (e) {
      return renderConnect(e.message);
    }
    const where = state.source && state.source.site ? state.source.site : "Receipt";
    const desc = where + " — " + new Date().toLocaleDateString();
    const groupOpts =
      `<option value="0">No group (between friends)</option>` +
      SW.groups
        .filter((g) => g.id !== 0)
        .map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`)
        .join("");

    bodyEl.innerHTML = `
      <div class="sw-badge">
        ✓ Connected as ${escapeHtml((SW.user && SW.user.first_name) || "you")}
        <button id="swDisconnect" style="background:none;border:0;color:var(--muted);text-decoration:underline;cursor:pointer;font-size:11px">disconnect</button>
      </div>
      <div class="sw-field">
        <label for="swGroup">Group</label>
        <select class="sw-select" id="swGroup">${groupOpts}</select>
      </div>
      <div class="sw-field">
        <label for="swDesc">Description</label>
        <input class="sw-input" id="swDesc" value="${escapeAttr(desc)}" maxlength="120" />
      </div>
      <div class="sw-field">
        <label>Match each person to a Splitwise member</label>
        <div id="swMap"></div>
      </div>
      <div class="sw-preview" id="swPreview"></div>
      <p class="sw-help">The full item-by-item breakdown is attached to the expense's notes.</p>
      <div class="sw-status" id="swStatus"></div>
      <div class="sw-actions">
        <button class="btn btn--ghost" id="swCancel">Cancel</button>
        <button class="btn btn--go" id="swCreate">Create expense</button>
      </div>`;

    $("swDisconnect").addEventListener("click", () => { clearKey(); renderConnect(); });
    $("swCancel").addEventListener("click", close);
    $("swGroup").addEventListener("change", renderMap);
    $("swCreate").addEventListener("click", doCreate);
    renderMap();
  }

  async function candidates() {
    const gid = $("swGroup").value;
    if (gid && gid !== "0") {
      const g = SW.groups.find((x) => String(x.id) === String(gid));
      return (g && g.members) || [];
    }
    if (!SW.friends) {
      try { SW.friends = await getFriends(); } catch (e) { SW.friends = []; }
    }
    return [SW.user].concat(SW.friends);
  }

  async function renderMap() {
    const box = $("swMap");
    box.innerHTML = `<div class="sw-status">Loading members…</div>`;
    const cands = await candidates();
    const opts = (selId) =>
      `<option value="">— not on Splitwise —</option>` +
      cands
        .map((m) => {
          const nm = ((m.first_name || "") + " " + (m.last_name || "")).trim() || ("User " + m.id);
          return `<option value="${m.id}" ${String(m.id) === String(selId) ? "selected" : ""}>${escapeHtml(nm)}</option>`;
        })
        .join("");
    box.innerHTML = state.people
      .map((p) => {
        let sel = "";
        if (p.isMe && SW.user) sel = SW.user.id;
        else {
          const m = cands.find((c) => (c.first_name || "").trim().toLowerCase() === p.name.trim().toLowerCase());
          if (m) sel = m.id;
        }
        return `<div class="sw-map">
          <span class="sw-map__name">${escapeHtml(p.name)}${p.isMe ? " (you)" : ""}</span>
          <select class="sw-select sw-map__sel" data-pid="${p.id}">${opts(sel)}</select>
        </div>`;
      })
      .join("");
    box.querySelectorAll("select").forEach((s) => s.addEventListener("change", renderPreview));
    renderPreview();
  }

  function mapping() {
    const map = {};
    $("swMap")
      .querySelectorAll("select")
      .forEach((s) => (map[s.getAttribute("data-pid")] = s.value));
    return map;
  }

  function renderPreview() {
    const { shares, allocatedTotal, unallocated } = compute();
    const payer = state.people.find((p) => p.id === state.payerId) || state.people[0];
    const map = mapping();
    const rows = shares
      .filter((s) => s.total > 0.004)
      .map((s) => {
        const p = state.people.find((x) => x.id === s.id);
        const unmapped = !map[s.id];
        return `<div class="sw-preview__row"><span>${escapeHtml(p.name)}${
          unmapped ? " ⚠" : ""
        }</span><b>${money(s.total)}</b></div>`;
      })
      .join("");
    $("swPreview").innerHTML =
      `<div class="sw-preview__row"><span>Total — paid by ${escapeHtml(payer ? payer.name : "—")}</span><b>${money(allocatedTotal)}</b></div>` +
      rows +
      (unallocated > 0.004
        ? `<div class="sw-preview__row"><span>⚠ Unassigned (not posted)</span><b>${money(unallocated)}</b></div>`
        : "");
  }

  async function doCreate() {
    const payer = state.people.find((p) => p.id === state.payerId) || state.people[0];
    if (!payer) return setStatus("Add people first.", "err");
    const { shares } = compute();
    const parts = shares.filter((s) => s.total > 0.004);
    if (!parts.length) return setStatus("Nothing to post — assign some items first.", "err");

    const map = mapping();
    if (!map[payer.id]) return setStatus(`Match the payer (${payer.name}) to a Splitwise member.`, "err");
    for (const s of parts) {
      if (!map[s.id]) {
        const p = state.people.find((x) => x.id === s.id);
        return setStatus(`Match ${p ? p.name : "everyone"} to a Splitwise member (or clear their items).`, "err");
      }
    }

    // combine by Splitwise user id (two local people could map to the same member)
    const cost = parts.reduce((a, s) => a + s.total, 0); // already cent-rounded, sums exactly
    const byUser = {};
    const add = (uid, paid, owed) => {
      byUser[uid] = byUser[uid] || { paid: 0, owed: 0 };
      byUser[uid].paid += paid;
      byUser[uid].owed += owed;
    };
    add(String(map[payer.id]), cost, 0);
    parts.forEach((s) => add(String(map[s.id]), 0, s.total));

    const params = {
      cost: cost.toFixed(2),
      description: ($("swDesc").value || "SmartSplitwise").trim().slice(0, 120),
      currency_code: curCode(),
      details: buildSummary(), // the same breakdown as "Copy summary" → expense notes
    };
    const gid = $("swGroup").value;
    params.group_id = gid && gid !== "0" ? gid : "0"; // 0 = non-group expense
    Object.keys(byUser).forEach((uid, i) => {
      params["users__" + i + "__user_id"] = uid;
      params["users__" + i + "__paid_share"] = byUser[uid].paid.toFixed(2);
      params["users__" + i + "__owed_share"] = byUser[uid].owed.toFixed(2);
    });

    const btn = $("swCreate");
    btn.disabled = true;
    setStatus("Posting…");
    try {
      const res = await createExpense(params);
      if (res && res.errors && Object.keys(res.errors).length) {
        btn.disabled = false;
        return setStatus("Splitwise rejected it: " + flattenErrors(res.errors), "err");
      }
      const exp = res && res.expenses && res.expenses[0];
      setStatus("✓ Posted to Splitwise" + (exp ? ` (expense #${exp.id})` : "") + ". You can close this.", "ok");
      btn.textContent = "Done";
      btn.disabled = false;
      btn.onclick = close;
    } catch (e) {
      btn.disabled = false;
      setStatus(e.message || "Couldn't post the expense.", "err");
    }
  }

  /* ---------------- wiring ---------------- */
  $("pushBtn").addEventListener("click", open);
  $("swClose").addEventListener("click", close);
  $("swBackdrop").addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) close();
  });

  loadKey();
})();
