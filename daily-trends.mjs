// Once a day: cross-references CoinGecko's free "trending search" list
// (top ~15 coins by search interest in the last 24h, no API key needed)
// against the coins supported on ChangeHero (a static snapshot in
// changehero-currencies.json -- this list changes rarely, so there's no
// need to hit ChangeHero's live API on every run; re-generate it by hand
// occasionally with `node scripts/refresh-changehero-currencies.mjs` when
// new coins get listed), and sends the top 3 matches to Telegram with a
// one-line "why it's trending" explanation each -- meant to help the
// content team pick which coin to cover today instead of guessing.
//
// Deliberately cheap: one free CoinGecko call, zero ChangeHero API calls,
// and ONE small Claude call per day covering all 3 coins at once (not one
// call per coin). No state file, no per-coin API calls, no twitterapi.io
// involved at all.

import { readFile } from "node:fs/promises";

const CURRENCIES_FILE = new URL("./changehero-currencies.json", import.meta.url);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_NEWSJACK_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_NEWSJACK_CHAT_ID;
const DRY_RUN = process.env.DRY_RUN === "1";

if (!DRY_RUN) {
  const missing = [];
  if (!ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_NEWSJACK_BOT_TOKEN");
  if (!TELEGRAM_CHAT_ID) missing.push("TELEGRAM_NEWSJACK_CHAT_ID");
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function getChangeHeroTickers() {
  const tickers = JSON.parse(await readFile(CURRENCIES_FILE, "utf8"));
  return new Set(tickers.map((t) => t.toUpperCase()));
}

async function getTrendingCoins() {
  const res = await fetch("https://api.coingecko.com/api/v3/search/trending", {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return (body.coins ?? []).map((c) => c.item);
}

async function draftWhyTrending(matches) {
  const lines = matches
    .map((m, i) => {
      const chg = m.priceChange24h != null ? `${m.priceChange24h.toFixed(1)}%` : "unknown";
      return `${i + 1}. ${m.name} (${m.symbol}) -- 24h price change: ${chg}, market cap: ${m.marketCap || "unknown"}, 24h volume: ${m.volume24h || "unknown"}`;
    })
    .join("\n");

  const prompt = `You're writing a short internal briefing for ChangeHero's content team, to help them pick which coin to write about today. These coins are currently trending (top search interest on CoinGecko in the last 24h) and are also supported on ChangeHero:

${lines}

For each coin, write ONE short sentence (under 25 words) explaining concretely why it's trending right now, based only on the numbers given -- don't invent news you don't have. If price is flat/down but it's still trending, say so plainly (a pure search-interest spike is itself worth noting, don't force a bullish spin). Plain, factual, no hype, no emoji.

Respond with ONLY a JSON array of strings, one per coin, in the same order, no other text.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 400,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = body.content?.[0]?.text ?? "[]";
  const match = text.match(/\[[\s\S]*\]/);
  try {
    return JSON.parse(match ? match[0] : text);
  } catch {
    return matches.map(() => "(model reply wasn't valid JSON)");
  }
}

async function sendTelegramMessage(text) {
  if (DRY_RUN) {
    console.log("--- DRY RUN, would send ---\n" + text + "\n---------------------------");
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const [changeHeroTickers, trending] = await Promise.all([getChangeHeroTickers(), getTrendingCoins()]);

  const matches = trending
    .filter((item) => changeHeroTickers.has((item.symbol || "").toUpperCase()))
    .slice(0, 3)
    .map((item) => ({
      name: item.name,
      symbol: item.symbol,
      priceChange24h: item.data?.price_change_percentage_24h?.usd,
      marketCap: item.data?.market_cap,
      volume24h: item.data?.total_volume,
    }));

  console.log(`${trending.length} trending on CoinGecko, ${matches.length} also supported on ChangeHero.`);

  if (!matches.length) {
    await sendTelegramMessage(
      "📊 *Daily trending check*: none of today's top trending coins on CoinGecko are currently supported on ChangeHero. No suggestions today."
    );
    return;
  }

  const explanations = await draftWhyTrending(matches);

  let text = `📊 *Daily trending coins on ChangeHero* (${matches.length}/3 matched today's CoinGecko trending list)\n\n`;
  matches.forEach((m, i) => {
    const chg = m.priceChange24h != null ? `${m.priceChange24h >= 0 ? "+" : ""}${m.priceChange24h.toFixed(1)}%` : "n/a";
    text += `*${i + 1}. ${m.name} (${m.symbol.toUpperCase()})* — 24h: ${chg}\n`;
    text += `${explanations[i] ?? ""}\n\n`;
  });

  await sendTelegramMessage(text.trim());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
