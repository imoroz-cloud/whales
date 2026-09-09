// One-off maintenance script, NOT run on a schedule -- re-run by hand
// (locally, with CHANGEHERO_API_KEY set) whenever ChangeHero lists/delists
// coins and the daily-trends bot's static snapshot needs updating.
//
//   CHANGEHERO_API_KEY=xxx node scripts/refresh-changehero-currencies.mjs
//
// Then commit the updated changehero-currencies.json.

import { writeFile } from "node:fs/promises";

const CHANGEHERO_API_KEY = process.env.CHANGEHERO_API_KEY;
if (!CHANGEHERO_API_KEY) {
  console.error("Missing CHANGEHERO_API_KEY env var.");
  process.exit(1);
}

const OUT_FILE = new URL("../changehero-currencies.json", import.meta.url);

const res = await fetch("https://api.changehero.io/v2", {
  method: "POST",
  headers: { "Content-Type": "application/json", "api-key": CHANGEHERO_API_KEY },
  body: JSON.stringify({ jsonrpc: "2.0", id: "refresh", method: "getCurrenciesFull", params: {} }),
});
if (!res.ok) throw new Error(`ChangeHero API ${res.status}: ${await res.text()}`);
const body = await res.json();
if (body.error) throw new Error(`ChangeHero API error: ${JSON.stringify(body.error)}`);

const tickers = [...new Set(body.result.filter((c) => c.enabled).map((c) => c.publicTicker.toUpperCase()))].sort();

await writeFile(OUT_FILE, JSON.stringify(tickers, null, 2) + "\n");
console.log(`Wrote ${tickers.length} enabled tickers to changehero-currencies.json`);
