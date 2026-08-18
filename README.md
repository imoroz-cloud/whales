# Whale Alerts Bot

Watches for large on-chain trades ("whale trades") in a list of coins and
posts them to a Telegram channel — [@changeherowhalealerts](https://t.me/changeherowhalealerts) —
via [@WhaleAlertsCH_bot](https://t.me/WhaleAlertsCH_bot).

It's free to run: it uses [GeckoTerminal's public API](https://apiguide.geckoterminal.com/)
(no API key, no cost) to watch each coin's main trading pool, and runs on a
schedule for free using GitHub Actions.

## How it works, in plain terms

Every 5 minutes, a script wakes up, checks each coin's trading pool for any
trade bigger than that coin's threshold since the last check, and posts a
message to the Telegram channel for each one it finds. It remembers what
it already posted (in `state.json`) so it never posts the same trade twice.

## What's covered right now

These 13 coins trade on public decentralized exchanges (Uniswap, PancakeSwap,
Raydium, etc.), so GeckoTerminal can see individual trades for them:

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

Thresholds were picked from each coin's actual recent trading volume on its
pool (so alerts fire at a meaningful "big trade for this coin" size, not
never and not constantly). Edit `coins.json` any time to change them.

**Important limitation:** this only sees trades that happen directly on a
decentralized exchange. It does **not** see trades on centralized exchanges
(Binance, Coinbase, etc.) or plain wallet-to-wallet transfers. For coins like
SHIB, PEPE, and BONK, a lot of real volume happens on centralized exchanges
that this can't watch for free — so treat this as "on-chain whale activity,"
not "every whale move."

### Not covered yet

**KAS, DASH, DIGIBYTE, FLUX, QUAI, VET, ICP, FIRO** — these mostly trade on
centralized exchanges / their own native chains, not on the DEXs GeckoTerminal
tracks. There's no single free API that covers all of them; each would need
its own blockchain explorer hooked up individually (e.g. a Kaspa explorer for
KAS, a VeChain explorer for VET). Doable later, coin by coin, if you want it.

**SNEK** — trades on Cardano, which GeckoTerminal's free API doesn't support
at all.

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

### A note on GitHub's schedule

GitHub Actions' `cron` schedules are "best effort" — under load, a run every
5 minutes might actually happen every 10–15 minutes. That's normal and out of
our control on the free tier; there's no paid tier that fixes it either
(it's a GitHub platform-wide behavior). Also, GitHub auto-disables scheduled
workflows on repos with no activity for 60 days — but this bot commits
`state.json` on nearly every run, which counts as activity, so that shouldn't
happen here.

## Running it locally (optional, for testing)

```bash
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=@changeherowhalealerts node whale-check.mjs
```

Add `DRY_RUN=1` before that to print what it *would* send instead of actually
posting to Telegram — useful for checking formatting without spamming the
channel.
