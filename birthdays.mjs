// Runs daily. If any ChangeHero-listed project has its launch-date
// anniversary TOMORROW (Moscow time), sends one prominent Telegram message
// listing them and pins it -- a heads-up so the content team can prepare a
// post a day ahead. The pin is removed automatically on the next run once
// it's old enough, so pins never pile up. Stateless: it finds its own old
// pin via getChat instead of storing message ids.
//
// Data comes from asset-birthdays.json, which only contains dates that were
// cross-checked across independent sources. No LLM, costs nothing to run.

import { readFile } from "node:fs/promises";

const BIRTHDAYS_FILE = process.env.BIRTHDAYS_FILE ?? new URL("./asset-birthdays.json", import.meta.url);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_NEWSJACK_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_NEWSJACK_CHAT_ID;
const DRY_RUN = process.env.DRY_RUN === "1";
// For testing: pretend "today" is this date (YYYY-MM-DD), e.g. TODAY_OVERRIDE=2026-01-02
const TODAY_OVERRIDE = process.env.TODAY_OVERRIDE;

// Our messages contain this phrase; it's how we recognize our own old pin.
const MARKER = "PROJECT BIRTHDAY";
// Old enough to unpin. The daily run is ~24h apart, so 12h is a safe cutoff.
const UNPIN_AFTER_HOURS = 12;

if (!DRY_RUN && (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)) {
  console.error("Missing TELEGRAM_NEWSJACK_BOT_TOKEN or TELEGRAM_NEWSJACK_CHAT_ID.");
  process.exit(1);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function moscowToday() {
  if (TODAY_OVERRIDE) return TODAY_OVERRIDE;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date()); // YYYY-MM-DD
}

function addDay(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`Telegram ${method} failed: ${res.status} ${JSON.stringify(body)}`);
  return body.result;
}

// Removes our own previous birthday pin once it's stale. Never touches pins
// that aren't ours (e.g. something the team pinned by hand).
async function unpinStaleBirthdayPin() {
  if (DRY_RUN) return;
  try {
    const chat = await tg("getChat", {});
    const pinned = chat.pinned_message;
    if (!pinned?.text?.includes(MARKER)) return;
    const ageHours = (Date.now() / 1000 - pinned.date) / 3600;
    if (ageHours < UNPIN_AFTER_HOURS) return;
    await tg("unpinChatMessage", { message_id: pinned.message_id });
    console.log(`Unpinned previous birthday message (${Math.round(ageHours)}h old).`);
  } catch (err) {
    console.warn("Could not check/unpin the old pin:", err.message);
  }
}

function formatMessage(due, td, tm) {
  const bar = "━━━━━━━━━━━━━━━━━━";
  let text = TODAY_OVERRIDE ? "🧪 *TEST — sample data, not a real reminder*\n\n" : "";
  text += `🎂🎂🎂 *${MARKER}* 🎂🎂🎂\n${bar}\n`;
  text += `🗓 *Tomorrow, ${td} ${MONTHS[tm - 1]}*\n\n`;
  for (const p of due) {
    const tick = p.tickers.length ? ` (${p.tickers.join(" / ")})` : "";
    text += `🎈 *${p.name.toUpperCase()}*${tick}\n`;
    text += `🎉 turns *${p.age}* ${p.age === 1 ? "year" : "years"} old${p.age % 5 === 0 ? "  ⭐ round number!" : ""}\n`;
    text += `🚀 launched ${p.date}\n\n`;
  }
  text += `${bar}\n👉 _Time to prepare a post — publish tomorrow._`;
  return text;
}

async function main() {
  await unpinStaleBirthdayPin();

  const projects = JSON.parse(await readFile(BIRTHDAYS_FILE, "utf8"));
  const tomorrow = addDay(moscowToday());
  const [ty, tm, td] = tomorrow.split("-").map(Number);

  const due = projects
    .map((p) => {
      const [by, bm, bd] = p.date.split("-").map(Number);
      // Feb 29 birthdays are celebrated on Mar 1 in non-leap years.
      const [am, ad] = bm === 2 && bd === 29 && !isLeap(ty) ? [3, 1] : [bm, bd];
      return { ...p, age: ty - by, hit: am === tm && ad === td };
    })
    .filter((p) => p.hit && p.age > 0)
    .sort((a, b) => b.age - a.age);

  console.log(`Tomorrow is ${tomorrow}: ${due.length} project birthday(s).`);
  if (!due.length) return;

  const text = formatMessage(due, td, tm);
  if (DRY_RUN) {
    console.log("--- DRY RUN, would send and pin ---\n" + text + "\n---------------------------");
    return;
  }

  const sent = await tg("sendMessage", { text, parse_mode: "Markdown", disable_web_page_preview: true });
  try {
    // Notify subscribers (disable_notification: false) -- the point is visibility.
    await tg("pinChatMessage", { message_id: sent.message_id, disable_notification: false });
    console.log("Sent and pinned.");
  } catch (err) {
    // A pin failure (e.g. bot lacks the right) must not fail the run: the message itself already went out.
    console.warn("Sent, but could not pin:", err.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
