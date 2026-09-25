import "dotenv/config";
import { createServer } from "node:http";

const cfg = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,

  pollMs: Number(process.env.POLL_INTERVAL_MS || 60000),

  // Minimum liquidity: $10,000
  minLiquidity: Number(process.env.MIN_LIQUIDITY_USD || 10000),

  // Minimum 5m volume
  minVolume5m: Number(process.env.MIN_VOLUME_5M_USD || 0),

  // Maximum pair age: 30 minutes
  maxAgeMin: Number(process.env.MAX_PAIR_AGE_MINUTES || 30),

  // Minimum Buy + Sell transactions in 5 minutes
  minTotalTransactions5m: 1000,

  pages: Number(process.env.NEW_POOL_PAGES || 1),

  networks: (process.env.NETWORKS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
};

if (!cfg.botToken || !cfg.chatId) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  process.exit(1);
}

const seen = new Set();
const MAX_SEEN = 20000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function money(v) {
  const n = num(v);

  if (!n) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;

  return `$${n.toFixed(2)}`;
}

function ageMinutes(createdAt) {
  const t = Date.parse(createdAt || "");

  return t
    ? Math.max(0, (Date.now() - t) / 60000)
    : Infinity;
}

function short(s, n = 8) {
  if (!s) return "N/A";

  return s.length > n * 2
    ? `${s.slice(0, n)}…${s.slice(-n)}`
    : s;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function explorerUrl(network, address) {
  const map = {
    ethereum: "https://etherscan.io/address/",
    bsc: "https://bscscan.com/address/",
    base: "https://basescan.org/address/",
    arbitrum: "https://arbiscan.io/address/",
    polygon_pos: "https://polygonscan.com/address/",
    avalanche: "https://snowtrace.io/address/",
    solana: "https://solscan.io/token/"
  };

  return map[network]
    ? map[network] + address
    : null;
}

function dexScreenerUrl(network, address) {
  const map = {
    ethereum: "ethereum",
    bsc: "bsc",
    base: "base",
    arbitrum: "arbitrum",
    polygon_pos: "polygon",
    avalanche: "avalanche",
    solana: "solana"
  };

  return map[network]
    ? `https://dexscreener.com/${map[network]}/${address}`
    : null;
}

async function getJson(url) {
  const r = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "all-chain-dex-telegram-alert-bot/1.0"
    }
  });

  if (!r.ok) {
    throw new Error(`${r.status} ${r.statusText}`);
  }

  return r.json();
}

async function getNewPools() {
  const out = [];

  if (cfg.networks.length) {
    for (const network of cfg.networks) {
      for (let page = 1; page <= cfg.pages; page++) {
        const url =
          `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(network)}/new_pools?page=${page}`;

        const data = await getJson(url);

        out.push(...(data?.data || []));
      }
    }
  } else {
    for (let page = 1; page <= cfg.pages; page++) {
      const url =
        `https://api.geckoterminal.com/api/v2/networks/new_pools?page=${page}`;

      const data = await getJson(url);

      out.push(...(data?.data || []));
    }
  }

  return out;
}

function normalize(pool) {
  const a = pool?.attributes || {};
  const rel = pool?.relationships || {};
  const id = pool?.id || "";

  const network = id.includes("_")
    ? id.split("_")[0]
    : "unknown";

  const address = id.includes("_")
    ? id.slice(id.indexOf("_") + 1)
    : id;

  return {
    id,
    network,
    address,

    name: a.name || "Unknown pair",

    addressBase:
      rel?.base_token?.data?.id
        ?.split("_")
        .slice(1)
        .join("_") || "",

    priceUsd: num(a.base_token_price_usd),

    liquidity: num(a.reserve_in_usd),

    volume5m: num(a.volume_usd?.m5),

    buys5m: num(a.transactions?.m5?.buys),

    sells5m: num(a.transactions?.m5?.sells),

    createdAt: a.pool_created_at,

    dex:
      a.dex_name ||
      rel?.dex?.data?.id ||
      "DEX",

    url:
      `https://www.geckoterminal.com/${network}/pools/${address}`
  };
}

function passes(p) {
  const age = ageMinutes(p.createdAt);

  const totalTransactions =
    p.buys5m + p.sells5m;

  return (
    p.liquidity >= cfg.minLiquidity &&
    p.volume5m >= cfg.minVolume5m &&
    age <= cfg.maxAgeMin &&
    totalTransactions >= cfg.minTotalTransactions5m
  );
}

function message(p) {
  const age = ageMinutes(p.createdAt);

  const totalTransactions =
    p.buys5m + p.sells5m;

  const baseAddr = p.addressBase;

  const exp =
    explorerUrl(
      p.network,
      baseAddr
    );

  const dex =
    dexScreenerUrl(
      p.network,
      p.address
    );

  return [
    "🚨 <b>NEW DEX PAIR</b>",
    "",

    `⛓ <b>Chain:</b> ${escapeHtml(p.network)}`,

    `🪙 <b>Pair:</b> ${escapeHtml(p.name)}`,

    `🏦 <b>DEX:</b> ${escapeHtml(p.dex)}`,

    `💧 <b>Liquidity:</b> ${money(p.liquidity)}`,

    `📊 <b>Volume 5m:</b> ${money(p.volume5m)}`,

    `🟢 <b>Buys 5m:</b> ${p.buys5m}`,

    `🔴 <b>Sells 5m:</b> ${p.sells5m}`,

    `🔥 <b>Total Tx 5m:</b> ${totalTransactions}`,

    `⏱ <b>Pair age:</b> ${age.toFixed(1)} min`,

    "",

    `📍 <b>Base token:</b> <code>${escapeHtml(
      short(baseAddr || p.address)
    )}</code>`,

    `🔎 ${
      dex
        ? `<a href="${dex}">DEX Screener</a> • `
        : ""
    }<a href="${p.url}">GeckoTerminal</a>${
      exp
        ? ` • <a href="${exp}">Explorer</a>`
        : ""
    }`,

    "",

    "⚠️ <i>Verify the contract, liquidity, permissions and trading conditions before trading.</i>"
  ].join("\n");
}

async function telegram(text) {
  const url =
    `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;

  const r = await fetch(url, {
    method: "POST",

    headers: {
      "content-type": "application/json"
    },

    body: JSON.stringify({
      chat_id: cfg.chatId,

      text,

      parse_mode: "HTML",

      disable_web_page_preview: false
    })
  });

  if (!r.ok) {
    throw new Error(
      `Telegram ${r.status}: ${await r.text()}`
    );
  }
}

async function scan() {
  try {
    const raw = await getNewPools();

    const pools = raw.map(normalize);

    pools.sort(
      (a, b) =>
        Date.parse(a.createdAt || 0) -
        Date.parse(b.createdAt || 0)
    );

    for (const p of pools) {

      // Already alerted
      if (!p.id || seen.has(p.id)) {
        continue;
      }

      // IMPORTANT:
      // Do NOT mark the pool as seen before it qualifies.
      // It will be checked again on the next scan.
      if (passes(p)) {

        await telegram(
          message(p)
        );

        // Mark as seen ONLY after successful Telegram alert.
        seen.add(p.id);

        await sleep(300);
      }
    }

    while (seen.size > MAX_SEEN) {
      seen.delete(
        seen.values().next().value
      );
    }

    console.log(
      new Date().toISOString(),
      `scanned=${pools.length} seen=${seen.size}`
    );

  } catch (e) {

    console.error(
      new Date().toISOString(),
      e.message
    );
  }
}

const port =
  Number(process.env.PORT || 10000);

const server = createServer(
  (req, res) => {

    res.writeHead(200, {
      "content-type":
        "text/plain; charset=utf-8"
    });

    res.end(
      "All-chain DEX Telegram bot is running.\n"
    );
  }
);

server.listen(
  port,
  "0.0.0.0",
  async () => {

    console.log(
      `HTTP server listening on 0.0.0.0:${port}`
    );

    console.log(
      "All-chain DEX Telegram alert bot started."
    );

    console.log({
      pollMs: cfg.pollMs,

      minLiquidity:
        cfg.minLiquidity,

      minVolume5m:
        cfg.minVolume5m,

      maxAgeMin:
        cfg.maxAgeMin,

      minTotalTransactions5m:
        cfg.minTotalTransactions5m,

      networks:
        cfg.networks.length
          ? cfg.networks
          : "aggregate"
    });

    await scan();

    setInterval(
      scan,
      cfg.pollMs
    );
  }
);