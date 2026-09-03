// Polls twitterapi.io (a pay-per-use third-party X/Twitter data API, much
// cheaper than X's own official API) for recent posts from a curated
// watchlist, flags ones that are outperforming that account's own normal
// engagement, and asks Claude to score the opportunity and draft a comment
// idea + a standalone post idea. Only strong opportunities get posted to
// Telegram for a human to act on manually — this never posts or comments on
// X itself, to stay clear of anti-spam/ban risk.
//
// Designed to run on a schedule where each run is a fresh process, so
// per-account state (last seen tweet id, rolling average engagement) is
// tracked in newsjack-state.json.

import { readFile, writeFile } from "node:fs/promises";

const WATCHLIST_FILE = new URL("./twitter-watchlist.json", import.meta.url);
const STATE_FILE = new URL("./newsjack-state.json", import.meta.url);

const TWITTERAPI_IO_KEY = process.env.TWITTERAPI_IO_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Deliberately a separate bot/token from the whale-alerts bot, so the two
// workflows never fight over the same secret.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_NEWSJACK_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_NEWSJACK_CHAT_ID;
const DRY_RUN = process.env.DRY_RUN === "1";

// How fresh a tweet has to be to still be worth newsjacking.
const LOOKBACK_HOURS = Number(process.env.NEWSJACK_LOOKBACK_HOURS || 12);
// How far above an account's own rolling-average engagement a tweet must be.
const ENGAGEMENT_MULTIPLIER = Number(process.env.NEWSJACK_MULTIPLIER || 2);
// Floor so a pop on an account that normally gets ~nothing doesn't alert.
const DEFAULT_MIN_ENGAGEMENT = Number(process.env.NEWSJACK_MIN_ENGAGEMENT || 15);
// Claude-judged opportunity score (0-10) a candidate must clear to reach Telegram.
const MIN_SCORE = Number(process.env.NEWSJACK_MIN_SCORE || 6);
const SLEEP_BETWEEN_ACCOUNTS_MS = 1500;
const EMA_ALPHA = 0.3;

const BRAND_VOICE = `ChangeHero is a non-custodial crypto exchange/swap platform. Voice: helpful, concise, no hype, no price predictions or financial advice, friendly but professional, occasional light humor. Never shill, never sound spammy or salesy.`;

if (!DRY_RUN) {
  const missing = [];
  if (!TWITTERAPI_IO_KEY) missing.push("TWITTERAPI_IO_KEY");
  if (!ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_NEWSJACK_BOT_TOKEN");
  if (!TELEGRAM_CHAT_ID) missing.push("TELEGRAM_NEWSJACK_CHAT_ID");
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function fetchRecentTweets(handle, retrying = false) {
  const url = `https://api.twitterapi.io/twitter/user/last_tweets?userName=${encodeURIComponent(handle)}`;
  const res = await fetch(url, { headers: { "X-API-Key": TWITTERAPI_IO_KEY } });
  if (res.status === 429 && !retrying) {
    await sleep(15000);
    return fetchRecentTweets(handle, true);
  }
  if (!res.ok) {
    throw new Error(`twitterapi.io ${res.status} for @${handle}: ${await res.text()}`);
  }
  const body = await res.json();
  if (body.status && body.status !== "success") {
    throw new Error(`twitterapi.io error for @${handle}: ${body.msg || body.status}`);
  }
  // Newest first. Drop replies — we only care about the account's own posts.
  return (body.data?.tweets ?? []).filter((t) => !t.isReply);
}

// twitterapi.io's documented shape and its actual raw responses disagree on
// where media lives (tweet.media[] per their docs vs tweet.extendedEntities
// per what we've observed live) -- check both rather than trust either alone.
function extractPhotoUrls(tweet) {
  const fromFlat = Array.isArray(tweet.media) ? tweet.media : [];
  const fromExtended = Array.isArray(tweet.extendedEntities?.media) ? tweet.extendedEntities.media : [];
  const fromEntities = Array.isArray(tweet.entities?.media) ? tweet.entities.media : [];
  const all = [...fromFlat, ...fromExtended, ...fromEntities];
  const urls = all
    .filter((m) => (m.type ?? "photo") === "photo")
    .map((m) => m.media_url_https || m.mediaUrl || m.url || m.preview_image_url)
    .filter(Boolean);
  return [...new Set(urls)];
}

function engagementScore(tweet) {
  return tweet.likeCount + tweet.retweetCount * 2 + tweet.replyCount * 3 + (tweet.quoteCount || 0) * 2;
}

async function draftIdeas(account, tweet, engagement, avgEngagement) {
  const prompt = `${BRAND_VOICE}

A tweet from @${account.handle} (${account.note || "watchlist account"}) is outperforming that account's normal engagement (score ${engagement} vs their rolling average ~${Math.round(avgEngagement)}). It already has ${tweet.replyCount} replies.

Tweet: "${tweet.text}"

Score this as a newsjack opportunity, 0-10. This tweet already cleared an engagement-velocity filter, so treat "is it trending" as a given — your job is to judge whether it's worth OUR reacting to it, not how viral it is. Weigh:
- relevance to a crypto-exchange/swap audience (a tweet about an unrelated topic scores low even if viral)
- how crowded the replies already are: under ~50 replies is low competition (don't penalize), ~50-300 is moderate (a good, specific comment can still stand out), 300+ is genuinely crowded (penalize more here)
- whether there's room to say something genuinely non-generic, not just "gm" or a compliment

Calibrate like this: a relevant, on-topic tweet with room for a genuinely specific reply is a 7-9, even if it's not a perfect fit — don't reserve high scores only for perfect scenarios. Score low (0-4) mainly when the topic is off-brand/irrelevant, or replies are already in the thousands.

Respond with ONLY a JSON object, no other text: {"score": 0-10, "reasoning": "one short clause on what drove the score", "angle": "one sentence on why this is worth engaging with", "comment": "a suggested reply in our voice, under 200 characters, written as literal post-ready text (not a note about the reply)", "postIdea": "a standalone post idea for our own account riffing on this topic, under 200 characters, also literal post-ready text"}`;

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
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = body.content?.[0]?.text ?? "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    return { score: 0, angle: "(model reply wasn't valid JSON)", comment: text.slice(0, 200), postIdea: "" };
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

async function sendTelegramPhoto(photoUrl) {
  if (DRY_RUN) {
    console.log(`--- DRY RUN, would send photo --- ${photoUrl}`);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, photo: photoUrl }),
  });
  if (!res.ok) throw new Error(`Telegram photo send failed: ${res.status} ${await res.text()}`);
}

function formatAlert(account, tweet, ideas, engagement, avgEngagement) {
  const link = tweet.url || `https://x.com/${account.handle}/status/${tweet.id}`;
  let text = `🔥 *Newsjack opportunity (${ideas.score}/10): @${account.handle}*\n\n`;
  text += `"${tweet.text}"\n\n`;
  text += `Engagement: ${engagement} (avg for this account: ~${Math.round(avgEngagement)})\n`;
  text += `Why: ${ideas.angle}\n\n`;
  text += `💬 *Suggested comment:*\n${ideas.comment}\n\n`;
  if (ideas.postIdea) text += `📝 *Or a standalone post:*\n${ideas.postIdea}\n\n`;
  text += `[Open tweet](${link})`;
  return text;
}

async function processAccount(account, state) {
  const key = account.handle.toLowerCase();
  let acctState = state[key];
  if (!acctState) {
    acctState = { initialized: false, lastSeenId: null, avgEngagement: 0 };
    state[key] = acctState;
  }

  try {
    const tweets = await fetchRecentTweets(account.handle); // newest first

    if (!acctState.initialized) {
      // First run for this account: baseline its rolling average engagement,
      // don't blast out alerts for tweet history that predates the bot.
      if (tweets.length) {
        acctState.avgEngagement = tweets.reduce((sum, t) => sum + engagementScore(t), 0) / tweets.length;
        acctState.lastSeenId = tweets[0].id;
      }
      acctState.initialized = true;
      console.log(`[${key}] initialized, baseline avg engagement ${Math.round(acctState.avgEngagement)}`);
      return;
    }

    const lastSeen = acctState.lastSeenId ? BigInt(acctState.lastSeenId) : 0n;
    const newTweets = tweets.filter((t) => BigInt(t.id) > lastSeen);
    if (tweets.length) acctState.lastSeenId = tweets[0].id;

    if (!newTweets.length) {
      console.log(`[${key}] no new tweets since last check`);
      return;
    }

    let anyTrending = false;
    // Process oldest to newest.
    for (const tweet of [...newTweets].reverse()) {
      const engagement = engagementScore(tweet);
      const ageHours = (Date.now() - new Date(tweet.createdAt).getTime()) / 36e5;
      const minEngagement = account.minEngagement ?? DEFAULT_MIN_ENGAGEMENT;
      const isTrending =
        ageHours <= LOOKBACK_HOURS &&
        engagement >= minEngagement &&
        engagement >= acctState.avgEngagement * ENGAGEMENT_MULTIPLIER;

      if (isTrending) {
        anyTrending = true;
        try {
          const ideas = await draftIdeas(account, tweet, engagement, acctState.avgEngagement);
          if (ideas.score >= MIN_SCORE) {
            await sendTelegramMessage(formatAlert(account, tweet, ideas, engagement, acctState.avgEngagement));
            for (const photoUrl of extractPhotoUrls(tweet)) {
              try {
                await sendTelegramPhoto(photoUrl);
              } catch (err) {
                console.error(`[${key}] failed to send photo for ${tweet.id}:`, err.message);
              }
            }
            console.log(`[${key}] sent ${tweet.id} (score ${ideas.score}, engagement ${engagement} vs avg ${Math.round(acctState.avgEngagement)})`);
          } else {
            console.log(`[${key}] skipped ${tweet.id}, score ${ideas.score} below ${MIN_SCORE} (${ideas.reasoning ?? "no reasoning"})`);
          }
        } catch (err) {
          console.error(`[${key}] failed to draft/send for ${tweet.id}:`, err.message);
        }
      }

      // Update the rolling baseline with every tweet seen, flagged or not,
      // so the "normal" bar keeps up with the account's actual activity.
      acctState.avgEngagement = acctState.avgEngagement
        ? acctState.avgEngagement * (1 - EMA_ALPHA) + engagement * EMA_ALPHA
        : engagement;
    }

    if (!anyTrending) {
      console.log(`[${key}] checked ${newTweets.length} new tweet(s), none above the trending bar (avg now ~${Math.round(acctState.avgEngagement)})`);
    }
    return true;
  } catch (err) {
    console.error(`[${key}] error:`, err.message);
    return false;
  }
}

async function main() {
  const watchlist = await loadJson(WATCHLIST_FILE, []);
  const state = await loadJson(STATE_FILE, {});

  let failures = 0;
  for (const account of watchlist) {
    const ok = await processAccount(account, state);
    if (!ok) failures++;
    await sleep(SLEEP_BETWEEN_ACCOUNTS_MS);
  }

  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

  // Every account failing usually means something systemic (API key dead,
  // credits exhausted, provider outage) rather than 30 coincidental
  // one-offs. Per-account errors are swallowed above so a single flaky
  // account never blocks the run -- but total failure should NOT be
  // swallowed, or it silently stops producing alerts forever with no signal
  // (this happened: twitterapi.io ran out of credits and nothing surfaced
  // it until someone noticed zero alerts days later).
  if (watchlist.length > 0 && failures === watchlist.length) {
    console.error(`All ${failures} accounts failed this run -- likely a systemic issue (dead API key, exhausted credits, provider outage), not per-account noise.`);
    try {
      await sendTelegramMessage(`⚠️ *Newsjack bot: every account failed this run.*\nLikely cause: twitterapi.io credits exhausted, an API key is dead, or a provider outage. Check the Actions log.`);
    } catch (err) {
      console.error("Also failed to send the Telegram warning:", err.message);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
