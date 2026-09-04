# Whale Alerts Bot

Watches for large on-chain trades ("whale trades") in a list of coins and
posts them to a Telegram channel — [@changeherowhalealerts](https://t.me/changeherowhalealerts) —
via [@WhaleAlertsCH_bot](https://t.me/WhaleAlertsCH_bot).

It's free to run: it uses [GeckoTerminal's public API](https://apiguide.geckoterminal.com/)
(no API key, no cost) to watch each coin's main trading pool, and runs on a
schedule for free using GitHub Actions.

## How it works, in plain terms

Every 5 minutes, a script wakes up, checks each coin's trading pool
for any **buy** bigger than that coin's threshold since the last check, and
posts a message to the Telegram channel for each one it finds. It remembers
what it already posted (in `state.json`) so it never posts the same trade
twice.

**Only buys are posted.** Sells are still detected and recorded internally
(so they're never mistakenly alerted later), but nothing gets sent to
Telegram for them — this was a deliberate choice after finding sell alerts
were more noise than signal for this use case.

## What's covered right now

These 25 coins trade on public decentralized exchanges (Uniswap, PancakeSwap,
Raydium, STON.fi, etc.), so GeckoTerminal can see individual trades for them:

| Coin | Chain | Alert threshold |
|---|---|---|
| TURBO | Ethereum | $1,000 |
| TOSHI | Base | $3,000 |
| PONKE | Solana | $3,000 |
| SHIB | Ethereum | $5,000 |
| BONK | Solana | $10,000 |
| VITA INU | BNB Chain | $500 |
| PENGU | Solana | $20,000 |
| APU | Ethereum | $2,000 |
| BABYDOGE | BNB Chain | $15,000 |
| ZBCN | Solana | $15,000 |
| FLOKI | BNB Chain | $8,000 |
| BRETT | Base | $15,000 |
| PEPE | Ethereum | $30,000 |
| ELON (Dogelon Mars) | Ethereum | $15,000 |
| WIF (dogwifhat) | Solana | $100,000 |
| MOG (Mog Coin) | Ethereum | $40,000 |
| ADI | Ethereum | $50,000 |
| TON (Toncoin) | TON | $150,000 |
| MON (Monad) | Monad | $500,000 |
| GEOD (Geodnet) | Solana | $200,000 |
| COTI | Ethereum | $5,000 |
| AURORA | Ethereum | $1,500 |
| JASMY (JasmyCoin) | Ethereum | $800 |
| LUMIA | Ethereum | $150 |
| KAS (Kaspa) | Kasplex | $15,000 |

Thresholds were picked from each coin's actual recent trading volume on its
pool (so alerts fire at a meaningful "big trade for this coin" size, not
never and not constantly). Edit `coins.json` any time to change them.

**LUMIA is a special case:** its on-chain trading is nearly dead right now
(only a few hundred dollars a day across its pools). The $150 threshold means
it'll alert on almost any trade at all, not really "whale" activity — kept in
at your call, but don't expect much signal from it unless its liquidity picks
up.

**KAS is tracked indirectly.** Kaspa's own layer-1 has no smart contracts, so
there's no direct DEX to watch. What's tracked instead is **WKAS** (Wrapped
Kaspa) trading on **Kasplex**, a newer Kaspa-linked EVM chain — specifically
its one actively-traded pool (~$107K/day). This is a reasonable proxy for
real KAS whale activity but isn't literally native KAS moving; other
wrapped-KAS pools on Ethereum/BSC/Polygon exist but see only a few dollars of
volume a day, so weren't worth using.

Transaction links (the "View transaction" line) aren't available yet for TON,
MON, or KAS — those chains use explorer setups that aren't wired up yet.
Alerts for them still fire, just without the clickable link.

**Important limitation:** this only sees trades that happen directly on a
decentralized exchange. It does **not** see trades on centralized exchanges
(Binance, Coinbase, etc.) or plain wallet-to-wallet transfers. For coins like
SHIB, PEPE, and BONK, a lot of real volume happens on centralized exchanges
that this can't watch for free — so treat this as "on-chain whale activity,"
not "every whale move."

### Not covered yet

**DASH, DIGIBYTE, FLUX, VET, FIRO, PIVX, XEC, DOGE, ZANO, CSPR** — these
mostly trade on centralized exchanges / their own native chains, not on the
DEXs GeckoTerminal tracks. There's no single free API that covers all of
them; each would need its own blockchain explorer hooked up individually.
Note: GeckoTerminal has recently added network support for Cardano and
Internet Computer and Quai Network — meaning SNEK, ICP, and QUAI may be
addable now after all (KAS already added above); worth revisiting.

**IOTA** — GeckoTerminal has an IOTA network slug now, but zero trading pools
are indexed on it yet, so there's nothing to watch even though the door is
technically open.

**VOLT INU, SHIRO, MOMO** — these tickers are used by multiple unrelated
tokens and I couldn't confidently identify which specific contract you mean
(some very similar-looking tokens are unrelated projects or scam clones).
Tell me the exact contract address/chain for the one you mean, and I'll add
it.

### Adding more coins later

Open `coins.json` and add an entry like:

```json
{ "symbol": "MYCOIN", "network": "eth", "pool": "0xthepooladdress", "thresholdUsd": 5000 }
```

- `network` is the chain slug GeckoTerminal uses (`eth`, `bsc`, `base`, `solana`, etc.)
- `pool` is the address of the coin's main trading pool on that chain — find it
  by searching the coin on [geckoterminal.com](https://www.geckoterminal.com/),
  opening its main pool, and copying the address from the URL.
- `thresholdUsd` is the minimum trade size (in USD) that triggers an alert.

Commit and push the change — the next scheduled run picks it up automatically.

## One-time setup

### 1. Create the GitHub repository

1. Go to [github.com/new](https://github.com/new) (log in first if needed).
2. **Repository name**: anything, e.g. `whale-alerts-bot`.
3. Leave it **empty** — don't check "Add a README", don't add a `.gitignore`
   or license. This project already has those.
4. Choose **Private** (recommended, since the workflow will contain your bot
   token as a secret — though secrets are hidden either way) or Public, then
   click **Create repository**.
5. GitHub will show you a page with a URL like
   `https://github.com/YOUR-USERNAME/whale-alerts-bot.git`. Copy it.

### 2. Push this code to it

Tell me you've created the repo and paste me that URL — I'll run the git
commands to push everything for you. Or, if you'd rather do it yourself, from
inside this project folder:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/whale-alerts-bot.git
git push -u origin main
```

### 3. Add your Telegram bot token as a secret

Secrets are how you give the bot its password without it being visible in
your code (anyone who could see your repo's files would otherwise see the
token).

1. On your repo's GitHub page, click **Settings** (top tab).
2. In the left sidebar: **Secrets and variables** → **Actions**.
3. Click **New repository secret**.
4. Name: `TELEGRAM_BOT_TOKEN`, Value: your bot token (the
   `8611956120:AAG...` string). Click **Add secret**.
5. Click **New repository secret** again.
6. Name: `TELEGRAM_CHAT_ID`, Value: `@changeherowhalealerts`. Click **Add secret**.

### 4. Make sure the bot is an admin on the channel

You mentioned a bot is already admin on `@changeherowhalealerts` — just double
check it's specifically **@WhaleAlertsCH_bot** (Settings → Administrators in
the Telegram channel), since that's the bot whose token is wired up here.

### 5. Turn it on

Scheduled workflows are enabled automatically once the workflow file is on
the `main` branch. To confirm it works right away instead of waiting up to 5
minutes:

1. Go to the **Actions** tab on your repo.
2. Click **Whale Alerts** in the left list.
3. Click **Run workflow** → **Run workflow**.
4. After ~30 seconds, click into the run to see its logs.

**Heads up on the very first run:** it won't post anything to Telegram. It
first needs to learn what trades already exist so it doesn't dump a backlog
of old trades on you — think of it as it taking attendance before it starts
watching for new arrivals. From the second run onward, genuinely new whale
trades will get posted.

### A note on the schedule

GitHub Actions' own `cron` schedule turned out to be unreliable in practice
(runs every 1–2 hours instead of every 5 minutes, regardless of what the cron
expression said — a platform-wide free-tier behavior, not something fixable
from this repo). So the workflow now only listens for `workflow_dispatch`,
and an external free service, [cron-job.org](https://cron-job.org), calls it
every 5 minutes instead. If alerts seem to stop arriving, check that the
cron-job.org job is still active before assuming the bot itself broke.

## Running it locally (optional, for testing)

```bash
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=@changeherowhalealerts node whale-check.mjs
```

Add `DRY_RUN=1` before that to print what it *would* send instead of actually
posting to Telegram — useful for checking formatting without spamming the
channel.

---

## Newsjack Alerts Bot

A second, separate bot (`newsjack-check.mjs`) watches a curated list of ~50
high-reach crypto X (Twitter) accounts — see `twitter-watchlist.json` — for
posts that are outperforming that account's own normal engagement. The idea
isn't to scan all of X, it's to catch the moment a big-reach account's post
is popping off harder than usual, so we can be one of the first genuinely
useful comments on it instead of getting lost in a wall of replies later.
When one pops, Claude scores the opportunity and drafts a suggested comment
*and* a standalone post idea in ChangeHero's voice, then both get sent to a
Telegram chat for a human to review.

**It never posts to X itself.** Someone on the team reads the Telegram
message and decides whether/how to reply manually. This is by design:
automated mass-replying gets flagged as spam behavior by X and risks getting
the account shadow-limited, and a human is better placed to judge tone and
timing anyway.

### How "trending" is detected

This is a two-stage filter, so most posts never reach Telegram at all.

**Stage 1 — cheap pre-filter (no Claude call).** Each account has a rolling
average engagement score (likes + 2×retweets + 3×replies + 2×quotes),
updated on every new post seen. A post only becomes a *candidate* when it's:
- posted within the last `NEWSJACK_LOOKBACK_HOURS` (default 12h — no point
  suggesting a comment on a two-day-old tweet),
- above `NEWSJACK_MIN_ENGAGEMENT` (default 20 — a floor so a 3x pop on an
  account that normally gets nothing doesn't alert), and
- at least `NEWSJACK_MULTIPLIER`× (default 3x) that account's own rolling
  average — i.e. it's a genuine outlier for *them*, not just a popular
  account posting as usual.

**Stage 2 — opportunity score (one Claude call per candidate).** For each
candidate, Claude scores it 0–10 on: relevance to a crypto-exchange audience,
how crowded the replies already are (a wall of replies means we'd get
buried), and whether there's room to say something non-generic — and drafts
the angle + comment in the same call. Only scores ≥ `NEWSJACK_MIN_SCORE`
(default 7) actually get sent to Telegram; lower-scoring candidates are
logged to the workflow run's console output only, so you can see what got
filtered out without it becoming noise in the chat.

Tune any of those via env vars (set them as repo variables, or edit the
workflow file), or per-account by adding `"minEngagement": N` to an entry in
`twitter-watchlist.json`.

### Data source: twitterapi.io, not the official X API

This bot reads tweets via [twitterapi.io](https://twitterapi.io), a
third-party pay-per-use API (~$0.15 per 1,000 tweets read, no subscription,
no minimum spend) — roughly 30x cheaper than X's own official API
($0.005/read, and X killed its cheap legacy tiers for new developers in
Feb 2026). It's a real, apparently well-regarded service, but it's still an
*unofficial* way to access X's data (not a partnership with X), so two
things follow: it can theoretically get cut off if X clamps down on this
kind of access, and since we only ever *read* through it (never post), the
worst case is the feed going quiet until we switch providers — no risk to
ChangeHero's own X account either way.

### About cost — read this before turning it on

**First version of this bot used the per-account timeline endpoint**
(`user/last_tweets`), checked on a schedule. That endpoint has no "give me
only what's new since X" option — every check re-fetches an account's latest
~20 tweets and bills for all of them, whether or not anything actually
changed. With 40 watched accounts checked hourly (briefly 2x/hour, from an
unrelated scheduling bug), that burned through a $20 credit balance in about
two weeks for roughly ten real alerts — bad value, and the root cause was
architectural, not the watchlist or the scoring thresholds.

**Current version uses the search endpoint instead**
(`tweet/advanced_search`), which supports combining many accounts into one
query (`from:a OR from:b OR ...`) filtered by `since_time`. So a single
request per ~15 accounts returns *only* tweets actually posted since the
last check — cost now tracks real posting activity instead of watchlist
size × check frequency. Expect this to be very roughly **20-50x cheaper**
than the old approach for the same watchlist and schedule, though the exact
number depends on how active the watched accounts actually are. New accounts
still cost one one-time `user/last_tweets` call each to establish a
baseline — cheap and a one-off, not recurring.

**Check the twitterapi.io dashboard after a day or two** regardless, to see
the real number rather than trust this estimate blindly, and adjust the
cron schedule in `.github/workflows/newsjack-alerts.yml` or the watchlist
size if needed. Claude API calls only happen for candidates that clear the
engagement pre-filter, so that cost stays small and roughly proportional to
actual activity either way.

### Editing the watchlist

`twitter-watchlist.json` is a starting list — mix of general crypto-Twitter
voices and the official accounts for coins already tracked by the whale
bot (so a whale buy and a newsjack opportunity for the same coin can line
up). Add or remove entries any time:

```json
{ "handle": "someaccount", "note": "why they're on the list", "minEngagement": 50 }
```

`minEngagement` is optional (falls back to `NEWSJACK_MIN_ENGAGEMENT`).
Handles are best-effort picks — sanity-check a new one still exists and is
active before relying on it.

### One-time setup

1. **twitterapi.io account**: sign up at [twitterapi.io](https://twitterapi.io),
   load some credits, and grab your API key from the dashboard.
2. **Anthropic API key**: get one at
   [console.anthropic.com](https://console.anthropic.com) — used to score
   candidates and draft the comment/post ideas.
3. **Telegram chat**: reuse an existing bot/channel, or create a new one the
   same way as the whale bot (see above), so newsjack drafts land somewhere
   separate from whale alerts.
4. Add these repo secrets (**Settings → Secrets and variables → Actions**):
   - `TWITTERAPI_IO_KEY`
   - `ANTHROPIC_API_KEY`
   - `TELEGRAM_NEWSJACK_BOT_TOKEN` — deliberately a **separate bot** from the
     whale bot's `TELEGRAM_BOT_TOKEN`, so the two workflows never fight over
     the same secret
   - `TELEGRAM_NEWSJACK_CHAT_ID` — the channel/chat this bot posts to (e.g.
     `@yourchannelname`); the bot must be an admin there, same as the whale
     bot setup above
5. The **Newsjack Alerts** workflow runs automatically once it's on `main`
   (hourly by default). Trigger it manually first via **Actions → Newsjack
   Alerts → Run workflow** to confirm it works.

Like the whale bot, the very first run per account only baselines that
account's average engagement — no alerts fire until the second run sees a
genuinely new, outperforming post.

### Running it locally (optional, for testing)

```bash
TWITTERAPI_IO_KEY=xxx ANTHROPIC_API_KEY=xxx TELEGRAM_NEWSJACK_BOT_TOKEN=xxx TELEGRAM_NEWSJACK_CHAT_ID=xxx node newsjack-check.mjs
```

Add `DRY_RUN=1` to print what it *would* send instead of posting to
Telegram.
