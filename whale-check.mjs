// Polls GeckoTerminal for large DEX trades on each configured coin's pool
// and posts new ones to Telegram. Designed to run on a schedule (see
// .github/workflows/whale-alerts.yml) where each run is a fresh process,
// so "have we already alerted on this trade" is tracked in state.json.

import { readFile, writeFile } from "node:fs/promises";

const COINS_FILE = new URL("./coins.json", import.meta.url);
const STATE_FILE = new URL("./state.json", import.meta.url);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DRY_RUN = process.env.DRY_RUN === "1";

if (!DRY_RUN && (!BOT_TOKEN || !CHAT_ID)) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars.");
  process.exit(1);
}

const EXPLORERS = {
  eth: (tx) => `https://etherscan.io/tx/${tx}`,
  bsc: (tx) => `https://bscscan.com/tx/${tx}`,
  base: (tx) => `https://basescan.org/tx/${tx}`,
  solana: (tx) => `https://solscan.io/tx/${tx}`,
};

const MAX_SEEN_HASHES_PER_COIN = 300;
const SLEEP_BETWEEN_COINS_MS = 2500; // stay well under GeckoTerminal's 30 req/min

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtUsd(n) {
  const num = Number(n);
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}

function fmtTokenAmount(n) {
  const num = Number(n);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toFixed(2);
}

async function loadJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function fetchTrades(network, pool, thresholdUsd, retrying = false) {
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/trades?trade_volume_in_usd_greater_than=${thresholdUsd}`;
  const res = await fetch(url, { headers: { Accept: "application/json;version=20230302" } });
  if (res.status === 429 && !retrying) {
    await sleep(15000);
    return fetchTrades(network, pool, thresholdUsd, true);
  }
  if (!res.ok) {
    throw new Error(`GeckoTerminal ${res.status} for ${network}/${pool}`);
  }
  const body = await res.json();
  return body.data ?? [];
}

async function sendTelegramMessage(text) {
  if (DRY_RUN) {
    console.log("--- DRY RUN, would send ---\n" + text + "\n---------------------------");
    return;
  }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram send failed: ${res.status} ${body}`);
  }
}

function formatAlert(coin, trade) {
  const a = trade.attributes;
  const isBuy = a.kind === "buy";
  const emoji = isBuy ? "🟢🐋" : "🔴🐋";
  const action = isBuy ? "BUY" : "SELL";
  const usd = fmtUsd(a.volume_in_usd);
  const tokenAmount = isBuy ? a.to_token_amount : a.from_token_amount;
  const explorer = EXPLORERS[coin.network];
  const link = explorer ? explorer(a.tx_hash) : null;

  let text = `${emoji} *Whale ${action}: ${coin.symbol}*\n`;
  text += `Amount: ${fmtTokenAmount(tokenAmount)} ${coin.symbol} (${usd})\n`;
  text += `Network: ${coin.network}\n`;
  if (link) text += `[View transaction](${link})`;
  return text;
}

async function processCoin(coin, state) {
  const key = coin.symbol;
  let coinState = state[key];
  if (!coinState) {
    coinState = { initialized: false, seenHashes: [] };
    state[key] = coinState;
  }

  let trades;
  try {
    trades = await fetchTrades(coin.network, coin.pool, coin.thresholdUsd);
  } catch (err) {
    console.error(`[${key}] fetch error:`, err.message);
    return;
  }

  const seen = new Set(coinState.seenHashes);

  if (!coinState.initialized) {
    // First run for this coin: just baseline the currently visible trades,
    // don't blast out alerts for trade history that predates the bot.
    for (const t of trades) seen.add(t.attributes.tx_hash);
    coinState.initialized = true;
    coinState.seenHashes = [...seen].slice(-MAX_SEEN_HASHES_PER_COIN);
    console.log(`[${key}] initialized with ${trades.length} baseline trades, no alerts sent`);
    return;
  }

  // API returns newest first; reverse so alerts post in chronological order.
  const newTrades = trades.filter((t) => !seen.has(t.attributes.tx_hash)).reverse();

  for (const trade of newTrades) {
    try {
      await sendTelegramMessage(formatAlert(coin, trade));
      console.log(`[${key}] alerted ${trade.attributes.tx_hash}`);
    } catch (err) {
      console.error(`[${key}] telegram error:`, err.message);
      continue; // don't mark as seen if we failed to send; retry next run
    }
    seen.add(trade.attributes.tx_hash);
  }

  coinState.seenHashes = [...seen].slice(-MAX_SEEN_HASHES_PER_COIN);
}

async function main() {
  const coins = await loadJson(COINS_FILE, []);
  const state = await loadJson(STATE_FILE, {});

  for (const coin of coins) {
    await processCoin(coin, state);
    await sleep(SLEEP_BETWEEN_COINS_MS);
  }

  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
