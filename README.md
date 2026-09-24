# All-Chain DEX Telegram Alert Bot

Node.js bot that monitors GeckoTerminal new DEX pools and sends Telegram alerts.

## Setup

Install dependencies:

npm install

Run:

npm start

## Environment Variables

TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

POLL_INTERVAL_MS=20000
MIN_LIQUIDITY_USD=10000
MIN_VOLUME_5M_USD=2000
MAX_PAIR_AGE_MINUTES=5
NEW_POOL_PAGES=1
NETWORKS=

## Important

Do not upload your real Telegram bot token to GitHub.

The bot only sends alerts. It does not buy or sell tokens and does not require wallet private keys.
