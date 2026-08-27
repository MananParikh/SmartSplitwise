# SmartSplitwise

A small Chrome extension I built to stop doing roommate grocery math by hand.

You open a receipt or an order page, it reads the items and totals, you say who got
what, and it figures out who owes whom — with tax and fees split by what each person
actually bought instead of just divided evenly. Then it hands you a clean breakdown
to drop into Splitwise.

Everything runs locally. No accounts, no API keys, nothing leaves your browser.

## Why

Splitting a grocery order four ways every week gets old. Some things are shared,
some are one person's, and tax should really follow whatever each person bought.
Doing that in your head is a pain, so I let the computer do it.

## How it works

Two ways to get a receipt in:

- **Paste it.** Copy your itemized receipt — the email confirmation, a "view
  receipt" page, whatever — and paste it in. This is the reliable one; it works on
  any store.
- **Scan the page.** Click the toolbar icon on an order page and it tries to read
  the items straight from the page's data.

### Where "Scan this page" works right now

Scanning depends entirely on whether a site actually puts the item data on the
page, and every store does it differently. Where it stands today:

- ✅ **Weee** (`weee.com/en`) — works well.
- ✅ **Instacart receipt page** — the printed/emailed receipt (the one titled
  "Instacart Receipt for Order #…") works well. There's a dedicated parser for it.
- ✅ **Walmart order-details page** (`walmart.com/orders/…`) — works. One catch:
  **reload the page first.** Walmart only embeds the order data when you load the
  URL fresh; if you clicked through from another Walmart page it won't be there.
- ❌ **Instacart's live in-app order page** — **not supported** (that's the
  single-page app, different from the receipt page above). Open the receipt, or
  paste it.

For anything not listed, scanning may or may not catch it — and paste always
works. This is an ongoing list; more sites will get dedicated parsers over time.

Once the items are in:

1. Add the people you're splitting with. Add yourself too, and tap **set me** so the
   summary knows which one is you.
2. For each item, tap whoever shared it. If you bought several of something and
   people took different amounts, switch that item to **by quantity** and give each
   person their share as `x` out of `y`. `x` can be a fraction (0.25, 1.5, …), so
   you can split a single thing unevenly too.
3. Anything you haven't fully assigned shows up in the results panel with the
   leftover amount and a link that jumps you straight to the item.
4. Tax and fees get split in proportion to what each person actually bought.
5. Hit **Copy summary for Splitwise** and paste the breakdown into the expense notes,
   so everyone can see how it was worked out.

## The split, briefly

- Each person starts with the items assigned to them (shared items divided among the
  sharers, or by quantity if you set it up that way).
- Tax, fees, delivery, and tip are handed out in proportion to each person's own
  subtotal.
- Amounts are rounded to the cent in a way that still adds back up to the exact total.

## Installing it

It's an unpacked extension:

1. Open `chrome://extensions`.
2. Turn on Developer mode (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the icon so it's easy to reach.

## Trying it without a real receipt

Open `demo.html` in your browser — it loads the whole thing with a sample order
already filled in. Good for a quick look or a screen recording.

## What's in here

- `manifest.json` — the extension manifest
- `popup.*` — the toolbar popup that scans the current page and hands the data off
- `scraper.js` — reads the order data off the page
- `app.html` / `app.css` — the main window's markup and styling
- `data.js` — app state and the storage that loads the scan/people into the page
- `parser.js` — turns pasted receipt text into structured data and loads it into state
- `render.js` — draws the page from that state
- `logic.js` — the split math, Splitwise summary, and the interactions
- `demo.html` — standalone demo with sample data
- `icons/` — the icon

## Still on my list

- Push straight to the Splitwise API instead of copy/paste
- Monthly spending by category (groceries vs. eating out vs. gas)
- Per-item custom percentages
