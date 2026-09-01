/*
 * SmartSplitwise — PDF receipts.
 * A digital PDF has a real text layer, so we extract it exactly with PDF.js
 * (no OCR). The trick to parsing it correctly is rebuilding lines from each text
 * fragment's position — group fragments by their y (a row), sort by x (left to
 * right) — so "Item name .... 12.95" ends up on one line before it hits the
 * receipt parser. Scanned-image PDFs have no text layer and won't work here.
 */
(function () {
  // Rebuild readable lines from PDF.js text items (each has .str and a transform
  // whose [4],[5] are the x,y of the fragment).
  function linesFromItems(items) {
    const frags = [];
    for (const it of items || []) {
      const s = it.str;
      if (!s || !s.trim()) continue;
      const t = it.transform || [1, 0, 0, 1, 0, 0];
      frags.push({ s: s, x: t[4], y: t[5] });
    }
    // top-to-bottom (PDF y grows upward), then left-to-right
    frags.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    let cur = null;
    const yTol = 3; // fragments within 3 units of y are the same visual row
    for (const f of frags) {
      if (!cur || Math.abs(f.y - cur.y) > yTol) {
        cur = { y: f.y, parts: [] };
        rows.push(cur);
      }
      cur.parts.push(f);
    }
    return rows
      .map((r) => {
        r.parts.sort((a, b) => a.x - b.x);
        return r.parts.map((p) => p.s).join(" ").replace(/\s+/g, " ").trim();
      })
      .filter(Boolean)
      .join("\n");
  }

  async function extractText(file) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(linesFromItems(content.items));
    }
    return pages.join("\n");
  }

  // expose the pure function so it can be unit-tested without a browser
  try {
    if (typeof window !== "undefined") window.__pdfReceipt = { linesFromItems };
  } catch (e) {}

  // point PDF.js at the vendored worker (MV3 needs a local, same-origin worker)
  try {
    if (typeof pdfjsLib !== "undefined") {
      pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.js");
    }
  } catch (e) {}

  const input = document.getElementById("pdfFile");
  const drop = document.getElementById("pdfDrop");
  const status = document.getElementById("pdfStatus");
  if (!input) return;

  let busy = false;

  async function handle(file) {
    if (busy) return;
    const isPdf = file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name || ""));
    if (!isPdf) {
      status.textContent = "Please choose a PDF file.";
      return;
    }
    if (typeof pdfjsLib === "undefined") {
      status.textContent = "The PDF reader didn't load — try the paste option below.";
      return;
    }
    busy = true;
    status.textContent = "Reading PDF…";
    try {
      const text = await extractText(file);
      if (!text || !text.trim()) {
        status.textContent =
          "This PDF has no readable text (it's probably a scanned image). Try the paste option below.";
        return;
      }
      // drop the extracted text into the paste box so it's easy to review/fix
      const box = document.getElementById("pasteBox");
      if (box) box.value = text.trim();
      const wrap = document.getElementById("pasteWrap");
      const toggle = document.getElementById("pasteToggle");
      if (wrap) wrap.hidden = false;
      if (toggle) toggle.textContent = "hide";

      const parsed = parseReceiptText(text);
      const ok = applyParsed(parsed);
      if (ok && state.source) {
        state.source.site = "PDF receipt";
        renderSource();
      }
      status.textContent = ok
        ? `Read ${parsed.items.length} item${parsed.items.length === 1 ? "" : "s"} from the PDF. ` +
          `Check them below — the raw text is in "Paste a receipt" if you need to fix anything.`
        : "Couldn't pull items out of that PDF. The text is in \"Paste a receipt\" for you to edit.";
    } catch (e) {
      status.textContent = "Couldn't read that PDF: " + (e && e.message ? e.message : e);
    } finally {
      busy = false;
    }
  }

  input.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handle(f);
  });
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("pdfdrop--drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("pdfdrop--drag");
    })
  );
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handle(f);
  });
})();
