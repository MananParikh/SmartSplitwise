/* SmartSplitwise popup: scans the active tab and hands the result to the app. */

const $ = (id) => document.getElementById(id);
const SCAN_KEY = "ss_scan";
const PEOPLE_KEY = "ss_people";

let lastScan = null;

function fmt(v, cur) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  const sign = v < 0 ? "-" : "";
  return sign + (cur || "$") + Math.abs(v).toFixed(2);
}

function showError(msg) {
  const e = $("error");
  e.textContent = msg;
  e.hidden = false;
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function restricted(url) {
  return (
    !url ||
    /^chrome:|^edge:|^about:|^chrome-extension:|^https:\/\/chrome\.google\.com\/webstore|^https:\/\/chromewebstore\.google\.com/.test(
      url
    )
  );
}

async function scan() {
  const btn = $("scanBtn");
  const icon = btn.querySelector(".btn__icon");
  $("error").hidden = true;
  $("preview").hidden = true;
  btn.disabled = true;
  icon.classList.add("spin");

  try {
    const tab = await currentTab();
    if (restricted(tab && tab.url)) {
      showError(
        "This page can't be scanned (browser or store page). Open a real receipt/order page and try again — or enter it manually below."
      );
      return;
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["scraper.js"],
    });
    const data = results && results[0] && results[0].result;
    if (!data || !data.ok) {
      showError(
        "Couldn't read this page automatically. You can still enter the receipt manually below."
      );
      return;
    }
    lastScan = data;
    renderPreview(data);
  } catch (err) {
    showError(
      "Scan failed: " +
        (err && err.message ? err.message : String(err)) +
        ". Try manual entry below."
    );
  } finally {
    btn.disabled = false;
    icon.classList.remove("spin");
  }
}

function renderPreview(d) {
  $("hint").hidden = true;
  $("pvSite").textContent = d.site || "receipt";
  $("pvSite").title = d.url || "";
  const badge = $("pvBadge");
  const conf = d.confidence || "low";
  badge.textContent =
    conf === "high" ? "looks good" : conf === "medium" ? "check it" : "review";
  badge.className = "badge badge--" + conf;

  $("pvItems").textContent = (d.items && d.items.length) || 0;
  $("pvSubtotal").textContent = fmt(d.subtotal, d.currency);
  $("pvTax").textContent = fmt(d.tax, d.currency);
  $("pvTotal").textContent = fmt(d.total, d.currency);
  $("preview").hidden = false;
}

async function openApp(withScan) {
  if (withScan && lastScan) {
    await chrome.storage.local.set({ [SCAN_KEY]: lastScan });
  } else {
    await chrome.storage.local.remove(SCAN_KEY);
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
  window.close();
}

async function refreshPeopleCount() {
  const { [PEOPLE_KEY]: people } = await chrome.storage.local.get(PEOPLE_KEY);
  const n = (people && people.length) || 0;
  $("peopleCount").textContent = n
    ? n + (n === 1 ? " person saved" : " people saved")
    : "no people yet";
}

async function resetPeople() {
  await chrome.storage.local.remove(PEOPLE_KEY);
  refreshPeopleCount();
}

$("scanBtn").addEventListener("click", scan);
$("openBtn").addEventListener("click", () => openApp(true));
$("manualBtn").addEventListener("click", () => openApp(false));
$("resetPeople").addEventListener("click", resetPeople);

refreshPeopleCount();
