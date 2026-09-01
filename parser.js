/*
 * SmartSplitwise — parsing.
 * The one place that deals with messy input. `parseReceiptText` turns pasted
 * receipt text into a clean { items, subtotal, tax, ... } shape, and
 * `applyParsed` drops that into state. Everything else works with data that's
 * already in the right shape, so it never has to think about parsing.
 */

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
  // receipt header/footer noise — skip so it never becomes an "item"
  const JUNK = /\b(tel|phone|fax|hours?|closed|thank\s*you|powered\s*by|r\.?\s*no|transaction\s*by|no\s*description|amt|change|cash|card|visa|mastercard|amex|discover|debit|server|cashier|table|guest\s*count|order\s*#|receipt|www\.|\.com|\.net|\.org)\b/i;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);

  const detectQty = (s) => {
    let m;
    if ((m = s.match(/\bqty:?\s*(\d{1,3})\b/i))) return +m[1];
    if ((m = s.match(/^\s*(\d{1,3})\s*(?:x|×|@)\s+/i))) return +m[1];
    if ((m = s.match(/(?:x|×)\s*(\d{1,3})\b/i))) return +m[1];
    if ((m = s.match(/^\s*(\d{1,2})\s+(?=[A-Za-z])/))) return +m[1]; // "4 Soju"
    return 1;
  };
  const stripQty = (s) =>
    s
      .replace(/^\d{1,3}\s*(?:x|×|@)\s*/i, "")
      .replace(/\bqty:?\s*\d{1,3}\b/i, "")
      .replace(/(?:x|×)\s*\d{1,3}\b/i, "")
      .replace(/^\s*\d{1,2}\s+(?=[A-Za-z])/, "") // leading "1 " / "4 " quantity
      .replace(/\s+/g, " ")
      .trim();

  const c = { subtotal: null, tax: null, total: null, fees: 0, discount: 0, tip: 0 };
  let sawFee = false, sawTip = false, sawDisc = false;
  const items = [];
  let pendingName = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prices = line.match(REG) || [];
    if (JUNK.test(line)) {
      pendingName = null;
      continue;
    }
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

// Take a parsed receipt and load it into state, then redraw.
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
