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

// Buys below a coin's threshold but still worth noticing (e.g. several $10K
// buys that never individually cross a $20K bar) accumulate here. Once their
// combined value crosses the threshold, they go out as one "combined" alert
// instead of each getting ignored individually. Trades below this floor
// aren't tracked at all -- pure dust, not worth accumulating.
const TRACK_FRACTION_OF_THRESHOLD = 0.2;
// Pending buys older than this are dropped uncounted rather than surfacing
// in a combined alert long after the fact.
const PENDING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

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

async function fetchTrades(network, pool, minVolumeUsd, retrying = false) {
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/trades?trade_volume_in_usd_greater_than=${minVolumeUsd}`;
  const res = await fetch(url, { headers: { Accept: "application/json;version=20230302" } });
  if (res.status === 429 && !retrying) {
    await sleep(15000);
    return fetchTrades(network, pool, minVolumeUsd, true);
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

function formatCombinedAlert(coin, items) {
  const totalUsd = items.reduce((sum, it) => sum + it.usd, 0);
  const totalTokens = items.reduce((sum, it) => sum + it.tokenAmount, 0);
  const explorer = EXPLORERS[coin.network];

  let text = `🟢🐋 *Whale BUY (combined): ${coin.symbol}*\n`;
  text += `${items.length} buys totaling ${fmtTokenAmount(totalTokens)} ${coin.symbol} (${fmtUsd(totalUsd)})\n`;
  text += `Network: ${coin.network}\n\n`;
  for (const it of items) {
    const link = explorer ? explorer(it.txHash) : null;
    const amount = `${fmtTokenAmount(it.tokenAmount)} ${coin.symbol} (${fmtUsd(it.usd)})`;
    text += link ? `• ${amount} — [tx](${link})\n` : `• ${amount}\n`;
  }
  return text.trimEnd();
}

async function processCoin(coin, state) {
  const key = coin.symbol;
  let coinState = state[key];
  if (!coinState) {
    coinState = { initialized: false, seenHashes: [], pending: [] };
    state[key] = coinState;
  }
  if (!coinState.pending) coinState.pending = []; // upgrade older state entries

  const trackFloorUsd = Math.round(coin.thresholdUsd * TRACK_FRACTION_OF_THRESHOLD);

  let trades;
  try {
    trades = await fetchTrades(coin.network, coin.pool, trackFloorUsd);
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
    const a = trade.attributes;
    seen.add(a.tx_hash); // every new trade is "seen" once inspected, alerted or not

    if (a.kind !== "buy") continue; // sells are tracked for dedup only, never posted

    if (Number(a.volume_in_usd) >= coin.thresholdUsd) {
      try {
        await sendTelegramMessage(formatAlert(coin, trade));
        console.log(`[${key}] alerted ${a.tx_hash}`);
      } catch (err) {
        console.error(`[${key}] telegram error:`, err.message);
        seen.delete(a.tx_hash); // let it retry next run since the alert never went out
      }
      continue;
    }

    // Below the single-trade bar, but still real activity -- bank it
    // towards a combined alert instead of ignoring it outright.
    coinState.pending.push({
      usd: Number(a.volume_in_usd),
      tokenAmount: Number(a.to_token_amount),
      txHash: a.tx_hash,
      timestamp: a.block_timestamp,
    });
  }

  const cutoff = Date.now() - PENDING_MAX_AGE_MS;
  coinState.pending = coinState.pending.filter((it) => new Date(it.timestamp).getTime() >= cutoff);

  const pendingTotal = coinState.pending.reduce((sum, it) => sum + it.usd, 0);
  if (pendingTotal >= coin.thresholdUsd) {
    try {
      await sendTelegramMessage(formatCombinedAlert(coin, coinState.pending));
      console.log(`[${key}] combined alert for ${coinState.pending.length} buys ($${pendingTotal.toFixed(0)})`);
      coinState.pending = [];
    } catch (err) {
      console.error(`[${key}] telegram error (combined):`, err.message);
      // leave pending as-is; retry next run
    }
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
