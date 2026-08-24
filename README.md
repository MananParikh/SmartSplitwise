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

A heads-up on scanning: some sites (Walmart's grocery order page, for one) don't
actually put the individual item prices on the page — they only show the subtotal.
There's nothing to scrape in that case, so pasting the receipt is the way around it.

Once the items are in:

1. Add the people you're splitting with. Add yourself too, and tap **set me** so the
   summary knows which one is you.
2. For each item, tap whoever shared it. If you bought several of something and
   people took different amounts, switch that item to **by quantity** and give each
   person their share as `x` out of `y`.
3. Tax and fees get split in proportion to what each person actually bought.
4. Hit **Copy summary for Splitwise** and paste the breakdown into the expense notes,
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
- `popup.*` — the toolbar popup that scans the current page
- `scraper.js` — reads the order data off the page
- `app.*` — the main window where you assign items and split
- `demo.html` — standalone demo with sample data
- `icons/` — the icon

## Still on my list

- Push straight to the Splitwise API instead of copy/paste
- Monthly spending by category (groceries vs. eating out vs. gas)
- Per-item custom percentages
