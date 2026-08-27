/*
 * SmartSplitwise receipt scraper.
 * Injected into the active tab via chrome.scripting.executeScript({files:['scraper.js']}).
 * The file is a single IIFE; its return value becomes InjectionResult.result.
 *
 * Strategy, in priority order:
 *   1. Embedded order JSON  — most sites ship the full order (items + totals) as
 *      a JSON blob in a <script> tag or a window state object. Reliable.
 *   2. Clean repeating DOM rows (name + one price), scoped to main content.
 *   3. Summary numbers from the DOM as a last resort.
 * Whatever it finds is always shown in an editable review panel, so partial or
 * missing results are safe — it never fabricates line items.
 */
(function () {
  "use strict";

  // ---- money ---------------------------------------------------------------
  // With a currency symbol, cents are optional ($0, $89, $4.97). Without a
  // symbol, cents are required so we don't grab random integers.
  const MONEY =
    "(?:[$€£₹]\\s?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?|\\d{1,3}(?:,\\d{3})*\\.\\d{2})";
  const MONEY_RE = new RegExp(MONEY);
  const MONEY_RE_G = new RegExp(MONEY, "g");

  function parseMoney(s) {
    if (s == null) return null;
    const m = String(s).match(MONEY_RE);
    if (!m) return null;
    const n = parseFloat(m[0].replace(/[^0-9.]/g, ""));
    return isNaN(n) ? null : n;
  }
  function coerceNum(v, depth) {
    if (typeof v === "number") return isFinite(v) && v >= 0 && v < 1e6 ? v : null;
    if (typeof v === "string") return parseMoney(v);
    if (v && typeof v === "object" && (depth || 0) < 2) {
      for (const k of ["value", "amount", "displayValue", "price", "amountDue"]) {
        if (k in v) {
          const n = coerceNum(v[k], (depth || 0) + 1);
          if (n != null) return n;
        }
      }
    }
    return null;
  }

  function detectCurrency(text) {
    if (/£/.test(text)) return "£";
    if (/€/.test(text)) return "€";
    if (/₹/.test(text)) return "₹";
    return "$";
  }

  // ==========================================================================
  // 1) JSON extraction
  // ==========================================================================
  const NAME_KEY = /(product[_ ]?name|item[_ ]?name|display[_ ]?name|producttitle|^name$|^title$|^description$)/i;
  const PRICE_KEY = /(line[_ ]?price|line[_ ]?total|item[_ ]?total|total[_ ]?price|unit[_ ]?price|^price$|^amount$|priceinfo|itemprice)/i;

  function nameFromObj(o) {
    for (const k of Object.keys(o)) {
      if (NAME_KEY.test(k)) {
        const v = o[k];
        if (typeof v === "string") {
          const s = v.trim();
          if (s.length > 1 && s.length < 180) return s;
        }
      }
    }
    return null;
  }
  // Find a numeric price up to a few levels down, preferring price-ish keys.
  function deepPrice(v, depth) {
    if (depth > 3 || v == null) return null;
    if (typeof v === "number") return isFinite(v) && v >= 0 && v < 1e6 ? v : null;
    if (typeof v === "string") return parseMoney(v);
    if (typeof v === "object") {
      const keys = Object.keys(v);
      const pref = keys.filter((k) => /price|value|amount|linetotal|total/i.test(k));
      for (const k of pref.concat(keys)) {
        const r = deepPrice(v[k], depth + 1);
        if (r != null && r > 0) return r;
      }
    }
    return null;
  }
  const UNIT_KEY = /(unit[_ ]?price|price[_ ]?each|each[_ ]?price|price[_ ]?per|per[_ ]?unit)/i;
  const LINE_KEY = /(line[_ ]?price|line[_ ]?total|item[_ ]?total|total[_ ]?price|extended[_ ]?price|sub[_ ]?total|row[_ ]?total)/i;

  // Classify an item's price as an explicit line total, a per-unit price, or
  // ambiguous. Flattens one level into nested price objects (e.g. priceInfo).
  function priceInfoFromObj(o) {
    const pairs = [];
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === "object" && !Array.isArray(v) && /price|cost|amount/i.test(k)) {
        for (const k2 of Object.keys(v)) pairs.push([k2, v[k2]]);
      } else {
        pairs.push([k, v]);
      }
    }
    let unit = null, line = null, any = null;
    for (const [k, v] of pairs) {
      if (!PRICE_KEY.test(k)) continue;
      const val = deepPrice(v, 0);
      if (val == null || val <= 0) continue;
      if (LINE_KEY.test(k)) { if (line == null) line = val; }
      else if (UNIT_KEY.test(k)) { if (unit == null) unit = val; }
      else if (any == null) any = val;
    }
    if (line != null) return { base: line, kind: "line" };
    if (unit != null) return { base: unit, kind: "unit" };
    if (any != null) return { base: any, kind: "ambiguous" };
    return null;
  }

  function qtyFromObj(o) {
    for (const k of Object.keys(o)) {
      const nk = k.replace(/[_\s]/g, "").toLowerCase();
      if (/^(quantity|qty|orderedquantity|orderquantity|purchasequantity|purchasedquantity|itemquantity|numitems|itemcount|unitcount|count)$/.test(nk)) {
        let raw = o[k];
        if (raw && typeof raw === "object") raw = raw.value != null ? raw.value : raw.amount != null ? raw.amount : raw.count;
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 1 && n < 1000) return Math.round(n);
      }
    }
    return 1;
  }

  const TOTAL_KEYS = [
    ["subtotal", /^(sub[_ ]?total)$/i],
    ["total", /^(grand[_ ]?total|order[_ ]?total|total|amount[_ ]?due|order[_ ]?amount)$/i],
    ["tax", /^(tax|tax[_ ]?total|total[_ ]?tax|sales[_ ]?tax)$/i],
    ["fees", /^(delivery[_ ]?(fee|charge|price|total)?|shipping([_ ]?(fee|charge|price))?)$/i],
    ["tip", /^(tip|driver[_ ]?tip|gratuity)$/i],
    ["discount", /^(savings|discount|discount[_ ]?total|promo[_ ]?savings)$/i],
  ];

  function scoreTotals(o) {
    let s = 0;
    for (const k of Object.keys(o)) {
      for (const [, re] of TOTAL_KEYS) {
        if (re.test(k) && coerceNum(o[k]) != null) {
          s++;
          break;
        }
      }
    }
    return s;
  }

  function scanJSON(root) {
    const seen = new WeakSet();
    let budget = 250000;
    let bestItems = [];
    let bestTotalsObj = null;
    let bestTotalsScore = 0;

    function walk(node, depth) {
      if (budget-- <= 0 || node == null || depth > 9) return;
      if (typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        if (node.length >= 1 && node.length <= 600) {
          const good = [];
          for (const el of node) {
            if (el && typeof el === "object" && !Array.isArray(el)) {
              const nm = nameFromObj(el);
              const pi = priceInfoFromObj(el);
              if (nm && pi) good.push({ name: nm, base: pi.base, kind: pi.kind, qty: qtyFromObj(el) });
            }
          }
          const need = node.length === 1 ? 1 : Math.max(2, Math.ceil(node.length * 0.4));
          if (good.length >= need && good.length > bestItems.length) bestItems = good;
        }
        for (const el of node) walk(el, depth + 1);
      } else {
        const sc = scoreTotals(node);
        if (sc > bestTotalsScore) {
          bestTotalsScore = sc;
          bestTotalsObj = node;
        }
        for (const k of Object.keys(node)) walk(node[k], depth + 1);
      }
    }

    try {
      walk(root, 0);
    } catch (e) {
      /* ignore */
    }

    let totals = null;
    if (bestTotalsObj && bestTotalsScore >= 2) {
      totals = {};
      for (const k of Object.keys(bestTotalsObj)) {
        for (const [name, re] of TOTAL_KEYS) {
          if (re.test(k)) {
            const n = coerceNum(bestTotalsObj[k]);
            if (n != null && !(name in totals)) totals[name] = Math.abs(n);
          }
        }
      }
    }
    return { items: bestItems, totals };
  }

  function jsonRoots() {
    const roots = [];
    // <script> JSON blobs
    for (const s of document.querySelectorAll("script")) {
      const t = (s.textContent || "").trim();
      if (t.length < 20 || t.length > 4000000) continue;
      const type = (s.type || "").toLowerCase();
      const looks = t[0] === "{" || t[0] === "[";
      if (type.includes("json") || s.id === "__NEXT_DATA__" || looks) {
        try {
          roots.push(JSON.parse(t));
        } catch (e) {
          /* not pure JSON */
        }
      }
    }
    // window state objects (redux/next/apollo/etc.)
    try {
      for (const k of Object.keys(window)) {
        if (!/^__|state|data|order|apollo|redux|preloaded|initial/i.test(k)) continue;
        const v = window[k];
        if (v && typeof v === "object") roots.push(v);
      }
    } catch (e) {
      /* cross-origin / restricted */
    }
    return roots;
  }

  function extractFromJSON() {
    let items = [];
    let totals = {};
    for (const root of jsonRoots()) {
      const r = scanJSON(root);
      if (r.items.length > items.length) items = r.items;
      if (r.totals) for (const k in r.totals) if (!(k in totals)) totals[k] = r.totals[k];
    }
    // Resolve each item to a LINE TOTAL. "line" prices are used as-is; "unit"
    // prices are multiplied by quantity; "ambiguous" prices (a bare "price"
    // field) are multiplied only if that makes the item sum match the order
    // subtotal better — this auto-corrects sites that list unit prices with a
    // separate quantity (e.g. Weee) without knowing their exact field names.
    const totalOf = (it, ambMult) =>
      it.kind === "line"
        ? it.base
        : it.kind === "unit"
        ? it.base * (it.qty || 1)
        : ambMult
        ? it.base * (it.qty || 1)
        : it.base;
    const sub = totals && totals.subtotal != null ? totals.subtotal : null;
    const sumMult = items.reduce((a, it) => a + totalOf(it, true), 0);
    const sumFlat = items.reduce((a, it) => a + totalOf(it, false), 0);
    let ambMult = true;
    if (sub != null && items.length) ambMult = Math.abs(sumMult - sub) <= Math.abs(sumFlat - sub);

    const seen = new Set();
    items = items
      .map((it) => ({
        name: (it.name || "").replace(/\s+/g, " ").trim(),
        price: Number(totalOf(it, ambMult).toFixed(2)),
        qty: it.qty && it.qty >= 1 ? it.qty : 1,
      }))
      .filter((it) => {
        if (it.price <= 0 || it.price > 100000) return false;
        const key = it.name.toLowerCase() + "|" + it.price.toFixed(2) + "|" + it.qty;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return { items, totals };
  }

  // ==========================================================================
  // 2) DOM fallback (scoped, denoised)
  // ==========================================================================
  const NOISE_ANCESTOR = /(^|[-_ ])(nav|navbar|header|footer|menu|sidebar|breadcrumb|account|masthead|banner|promo|advert|cookie|search)([-_ ]|$)/i;

  function inNoise(el) {
    let n = el;
    let hops = 0;
    while (n && n !== document.body && hops++ < 12) {
      const tag = n.tagName;
      if (tag === "NAV" || tag === "HEADER" || tag === "FOOTER" || tag === "ASIDE")
        return true;
      const role = n.getAttribute && n.getAttribute("role");
      if (role === "navigation" || role === "banner" || role === "search") return true;
      const cid = ((n.className && n.className.baseVal ? n.className.baseVal : n.className) || "") + " " + (n.id || "");
      if (typeof cid === "string" && NOISE_ANCESTOR.test(cid)) return true;
      n = n.parentElement;
    }
    return false;
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none") return false;
    return true;
  }

  function ownText(el) {
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  const SUMMARY_LINE = /\b(sub[\s-]?total|sales?\s*tax|tax|gst|hst|vat|grand\s*total|order\s*total|total|delivery|service|shipping|driver\s*tip|tip|gratuity|bag\s*fee|fee|savings|discount|promo|coupon|payment|balance|due)\b/i;
  const JUNK_ITEM = /\b(reorder|account|sign\s*in|hi\b|hello|member|review|subscription|wallet|address|help|track|return|refund|delivery|shipping|free|was\b|now\b|view|see all|show)\b/i;

  function domSummary() {
    const out = { subtotal: null, tax: null, total: null, fees: 0, tip: 0, discount: 0 };
    let sawFee = false, sawTip = false, sawDisc = false;
    const nodes = document.body ? document.body.querySelectorAll("*") : [];
    for (const el of nodes) {
      if (el.children.length > 3) continue;
      const txt = ownText(el);
      if (!txt || txt.length > 60 || !MONEY_RE.test(txt)) continue;
      if (!SUMMARY_LINE.test(txt)) continue;
      if (inNoise(el)) continue;
      const matches = txt.match(MONEY_RE_G) || [];
      if (!matches.length) continue;
      const eff = parseMoney(matches[matches.length - 1]); // effective (post-strike)
      if (eff == null) continue;
      if (/\bsub[\s-]?total\b/i.test(txt)) {
        if (out.subtotal == null || eff > out.subtotal) out.subtotal = eff;
      } else if (/\b(grand\s*total|order\s*total|total)\b/i.test(txt) && !/sub/i.test(txt)) {
        if (out.total == null || eff > out.total) out.total = eff;
      } else if (/\b(sales?\s*tax|tax|gst|hst|vat)\b/i.test(txt) && !/rate/i.test(txt)) {
        if (out.tax == null) out.tax = eff;
      } else if (/\b(savings|discount|promo|coupon)\b/i.test(txt)) {
        out.discount += Math.abs(eff); sawDisc = true;
      } else if (/\b(driver\s*tip|tip|gratuity)\b/i.test(txt)) {
        out.tip += Math.abs(eff); sawTip = true;
      } else if (/\b(delivery|service|shipping|bag\s*fee|fee)\b/i.test(txt)) {
        out.fees += Math.abs(eff); sawFee = true;
      }
    }
    return { out, sawFee, sawTip, sawDisc };
  }

  function domItems() {
    // group priced leaf rows by parent; a real item list = a parent with >=3
    // priced children whose labels look like products (not summary/junk).
    const byParent = new Map();
    const nodes = document.body ? document.body.querySelectorAll("*") : [];
    for (const el of nodes) {
      if (el.children.length > 3) continue;
      const txt = ownText(el);
      if (!txt || txt.length > 120 || !MONEY_RE.test(txt)) continue;
      if (SUMMARY_LINE.test(txt) || JUNK_ITEM.test(txt)) continue;
      if (inNoise(el) || !visible(el)) continue;
      const matches = txt.match(MONEY_RE_G) || [];
      if (matches.length !== 1) continue;
      const price = parseMoney(matches[0]);
      if (price == null || price <= 0) continue;
      const name = txt.replace(MONEY_RE_G, " ").replace(/\s+/g, " ").trim();
      if (name.length < 3 || /^\d+$/.test(name)) continue;
      const p = el.parentElement || el;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push({ name, price });
    }
    let best = [];
    for (const arr of byParent.values()) if (arr.length > best.length) best = arr;
    if (best.length < 3) return [];
    const seen = new Set();
    return best.filter((it) => {
      const k = it.name.toLowerCase() + "|" + it.price.toFixed(2);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ==========================================================================
  // 3) site-specific parsers (clean, stable receipt pages)
  // ==========================================================================
  // Instacart's printed/emailed receipt page is server-rendered and tidy: each
  // item is a .item-block with the name, a "N x $unit" line, and a .total line
  // total; the order totals live in ul.charges. Read it directly.
  function parseInstacart() {
    const rows = document.querySelectorAll(".item-block .item-row");
    if (!rows.length) return null;

    const items = [];
    rows.forEach((row) => {
      const nameEl = row.querySelector(".item-name");
      const priceEl = row.querySelector(".item-price");
      if (!nameEl || !priceEl) return;

      // name = the item-name text without the size / "N x $unit" / savings bits
      const clone = nameEl.cloneNode(true);
      clone.querySelectorAll("small, br, .savings-lines").forEach((n) => n.remove());
      const name = (clone.textContent || "").replace(/\s+/g, " ").trim();

      // quantity from a "2 x $2.65" line (skip weight-priced "1.12 lb x $0.49")
      let qty = 1;
      const muted = nameEl.querySelector("small.muted");
      if (muted) {
        const m = muted.textContent.replace(/\s+/g, " ").match(/^\s*(\d{1,3})\s*x\s/i);
        if (m) qty = parseInt(m[1], 10);
      }

      // line total = the last .total (the final, post-discount price)
      const totals = priceEl.querySelectorAll(".total");
      const price = totals.length ? parseMoney(totals[totals.length - 1].textContent) : null;

      if (name && price != null && price > 0) items.push({ name, price, qty });
    });
    if (!items.length) return null;

    const out = { items, subtotal: null, tax: null, fees: null, discount: null, total: null };
    let feeSum = 0, taxSum = 0, discSum = 0;
    let sawFee = false, sawTax = false, sawDisc = false;
    document.querySelectorAll("ul.charges li.charge-row").forEach((li) => {
      const typeEl = li.querySelector(".charge-type");
      const amtEl = li.querySelector(".amount");
      if (!typeEl || !amtEl) return;
      const type = (typeEl.textContent || "").replace(/\s+/g, " ").trim();
      const amt = parseMoney(amtEl.textContent);
      if (amt == null) return;
      if (/items?\s*subtotal/i.test(type)) out.subtotal = amt;
      else if (/tax/i.test(type)) { taxSum += amt; sawTax = true; }
      else if (/\b(fee|service|delivery|shipping|bag)\b/i.test(type)) { feeSum += amt; sawFee = true; }
      else if (/\b(discount|promo(?:tion)?|coupon|credit)\b/i.test(type) && !/saved|savings/i.test(type)) {
        discSum += amt; sawDisc = true;
      } else if (/^total charged$|^total$/i.test(type)) {
        if (out.total == null) out.total = amt;
      }
      // "You saved" and "$0 Delivery!" lines are informational — already priced in.
    });
    if (sawTax) out.tax = taxSum;
    if (sawFee) out.fees = feeSum;
    if (sawDisc) out.discount = discSum;
    return out;
  }

  function parseSite() {
    if (/instacart\.com/i.test(location.hostname)) return parseInstacart();
    return null;
  }

  // ==========================================================================
  // main
  // ==========================================================================
  function run() {
    const pageText = document.body
      ? (document.body.innerText || document.body.textContent || "").slice(0, 30000)
      : "";
    const currency = detectCurrency(pageText);

    // a dedicated parser wins when we have one for this site and it finds items
    const site = parseSite();
    if (site && site.items.length) {
      const sum = site.items.reduce((a, b) => a + b.price, 0);
      const conf =
        site.subtotal != null
          ? Math.abs(sum - site.subtotal) < 0.75 ? "high" : "medium"
          : site.items.length >= 3 ? "high" : "medium";
      return {
        ok: true,
        site: location.hostname.replace(/^www\./, ""),
        url: location.href,
        title: document.title || location.hostname,
        currency,
        items: site.items,
        itemsSource: "site",
        subtotal: site.subtotal != null ? Number(site.subtotal.toFixed(2)) : null,
        tax: site.tax != null ? Number(site.tax.toFixed(2)) : null,
        fees: site.fees != null ? Number(site.fees.toFixed(2)) : null,
        discount: site.discount != null ? Number(site.discount.toFixed(2)) : null,
        total: site.total != null ? Number(site.total.toFixed(2)) : null,
        confidence: conf,
        scannedAt: Date.now(),
      };
    }

    const json = extractFromJSON();
    let items = json.items;
    let itemsSource = items.length ? "json" : "none";

    if (!items.length) {
      const di = domItems();
      if (di.length) {
        items = di;
        itemsSource = "dom";
      }
    }

    const dom = domSummary();
    const t = json.totals || {};
    // prefer JSON totals, fall back to DOM summary
    const subtotal = t.subtotal != null ? t.subtotal : dom.out.subtotal;
    const tax = t.tax != null ? t.tax : dom.out.tax;
    const total = t.total != null ? t.total : dom.out.total;
    let fees = t.fees != null ? t.fees : dom.sawFee ? dom.out.fees : null;
    const tip = t.tip != null ? t.tip : dom.sawTip ? dom.out.tip : null;
    const discount = t.discount != null ? t.discount : dom.sawDisc ? dom.out.discount : null;
    // fold tip into fees for the app's single "fees" field
    if (tip) fees = (fees || 0) + tip;

    const itemsSum = items.reduce((a, b) => a + b.price, 0);
    let confidence = "low";
    if (items.length && subtotal != null) {
      const diff = Math.abs(itemsSum - subtotal);
      confidence = diff < 0.75 ? "high" : diff < Math.max(3, subtotal * 0.12) ? "medium" : "low";
    } else if (itemsSource === "json" && items.length >= 3) {
      confidence = "high";
    } else if (items.length >= 3) {
      confidence = "medium";
    }

    return {
      ok: true,
      site: location.hostname.replace(/^www\./, ""),
      url: location.href,
      title: document.title || location.hostname,
      currency,
      items,
      itemsSource,
      subtotal: subtotal != null ? Number(subtotal.toFixed(2)) : null,
      tax: tax != null ? Number(tax.toFixed(2)) : null,
      fees: fees != null ? Number(fees.toFixed(2)) : null,
      discount: discount != null ? Number(discount.toFixed(2)) : null,
      total: total != null ? Number(total.toFixed(2)) : null,
      confidence,
      scannedAt: Date.now(),
    };
  }

  try {
    return run();
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
})();
