import "dotenv/config";
import { createServer } from "node:http";

const cfg = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,

  pollMs: Number(process.env.POLL_INTERVAL_MS || 60000),

  minLiquidity: Number(
    process.env.MIN_LIQUIDITY_USD || 10000
  ),

  minVolume5m: Number(
    process.env.MIN_VOLUME_5M_USD || 0
  ),

  maxAgeMin: Number(
    process.env.MAX_PAIR_AGE_MINUTES || 30
  ),

  minTotalTransactions5m: Number(
    process.env.MIN_TOTAL_TRANSACTIONS_5M || 1000
  ),

  pages: Number(
    process.env.NEW_POOL_PAGES || 1
  ),

  networks: (process.env.NETWORKS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
};

if (!cfg.botToken || !cfg.chatId) {
  console.error(
    "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID"
  );
  process.exit(1);
}

const alerted = new Set();
const expired = new Set();

const MAX_TRACKED = 20000;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function money(v) {
  const n = num(v);

  if (!n) return "$0";

  if (n >= 1e9) {
    return `$${(n / 1e9).toFixed(2)}B`;
  }

  if (n >= 1e6) {
    return `$${(n / 1e6).toFixed(2)}M`;
  }

  if (n >= 1e3) {
    return `$${(n / 1e3).toFixed(1)}K`;
  }

  return `$${n.toFixed(2)}`;
}

function ageMinutes(createdAt) {
  const t = Date.parse(createdAt || "");

  if (!t) {
    return Infinity;
  }

  return Math.max(
    0,
    (Date.now() - t) / 60000
  );
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
    ethereum:
      "https://etherscan.io/address/",

    bsc:
      "https://bscscan.com/address/",

    base:
      "https://basescan.org/address/",

    arbitrum:
      "https://arbiscan.io/address/",

    polygon_pos:
      "https://polygonscan.com/address/",

    avalanche:
      "https://snowtrace.io/address/",

    solana:
      "https://solscan.io/token/"
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
      "user-agent":
        "all-chain-dex-telegram-alert-bot/2.0"
    }
  });

  if (!r.ok) {
    throw new Error(
      `${r.status} ${r.statusText}`
    );
  }

  return r.json();
}

async function getNewPools() {
  const out = [];

  if (cfg.networks.length) {
    for (const network of cfg.networks) {
      for (
        let page = 1;
        page <= cfg.pages;
        page++
      ) {
        const url =
          `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(
            network
          )}/new_pools?page=${page}`;

        const data = await getJson(url);

        out.push(
          ...(data?.data || [])
        );
      }
    }
  } else {
    for (
      let page = 1;
      page <= cfg.pages;
      page++
    ) {
      const url =
        `https://api.geckoterminal.com/api/v2/networks/new_pools?page=${page}`;

      const data = await getJson(url);

      out.push(
        ...(data?.data || [])
      );
    }
  }

  return out;
}

function normalize(pool) {
  const a =
    pool?.attributes || {};

  const rel =
    pool?.relationships || {};

  const id =
    pool?.id || "";

  const network =
    id.includes("_")
      ? id.split("_")[0]
      : "unknown";

  const address =
    id.includes("_")
      ? id.slice(
          id.indexOf("_") + 1
        )
      : id;

  return {
    id,
    network,
    address,

    name:
      a.name ||
      "Unknown pair",

    addressBase:
      rel?.base_token?.data?.id
        ?.split("_")
        .slice(1)
        .join("_") || "",

    priceUsd:
      num(a.base_token_price_usd),

    liquidity:
      num(a.reserve_in_usd),

    volume5m:
      num(a.volume_usd?.m5),

    buys5m:
      num(a.transactions?.m5?.buys),

    sells5m:
      num(a.transactions?.m5?.sells),

    createdAt:
      a.pool_created_at,

    dex:
      a.dex_name ||
      rel?.dex?.data?.id ||
      "DEX",

    lockedLiquidityPercentage:
      num(
        a.locked_liquidity_percentage
      ),

    url:
      `https://www.geckoterminal.com/${network}/pools/${address}`
  };
}

function totalTransactions(p) {
  return (
    p.buys5m +
    p.sells5m
  );
}

function basicPasses(p) {
  const age =
    ageMinutes(p.createdAt);

  return (
    p.liquidity >=
      cfg.minLiquidity &&

    p.volume5m >=
      cfg.minVolume5m &&

    age <=
      cfg.maxAgeMin &&

    totalTransactions(p) >=
      cfg.minTotalTransactions5m
  );
}

async function getTokenInfo(network, tokenAddress) {
  if (
    !network ||
    network === "unknown" ||
    !tokenAddress
  ) {
    return null;
  }

  const url =
    `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(
      network
    )}/tokens/${encodeURIComponent(
      tokenAddress
    )}/info`;

  try {
    const data =
      await getJson(url);

    return data?.data?.attributes || null;
  } catch (e) {
    console.error(
      "Token info error:",
      network,
      tokenAddress,
      e.message
    );

    return null;
  }
}

function securityStatus(info) {
  if (!info) {
    return {
      honeypot: "UNKNOWN",
      mint: "UNKNOWN",
      freeze: "UNKNOWN",
      risk: "UNKNOWN"
    };
  }

  const honeypot =
    info.is_honeypot === true
      ? "YES"
      : info.is_honeypot === false
      ? "NO"
      : "UNKNOWN";

  const mint =
    info.mint_authority === "yes"
      ? "YES"
      : info.mint_authority === "no"
      ? "NO"
      : "UNKNOWN";

  const freeze =
    info.freeze_authority === "yes"
      ? "YES"
      : info.freeze_authority === "no"
      ? "NO"
      : "UNKNOWN";

  let risk = "LOW/UNKNOWN";

  if (honeypot === "YES") {
    risk = "HIGH";
  } else if (
    mint === "YES" ||
    freeze === "YES"
  ) {
    risk = "CHECK";
  } else if (
    honeypot === "NO" &&
    mint === "NO" &&
    freeze === "NO"
  ) {
    risk = "LOWER";
  }

  return {
    honeypot,
    mint,
    freeze,
    risk
  };
}

function message(p, info) {
  const age =
    ageMinutes(p.createdAt);

  const baseAddr =
    p.addressBase;

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

  const totalTx =
    totalTransactions(p);

  const sec =
    securityStatus(info);

  const holders =
    info?.holders?.count;

  const top10 =
    info?.holders
      ?.distribution_percentage
      ?.top_10;

  const gtScore =
    num(info?.gt_score);

  const locked =
    num(
      p.lockedLiquidityPercentage
    );

  const lines = [
    "🚨 <b>NEW DEX PAIR</b>",
    "",

    `⛓ <b>Chain:</b> ${escapeHtml(
      p.network
    )}`,

    `🪙 <b>Pair:</b> ${escapeHtml(
      p.name
    )}`,

    `🏦 <b>DEX:</b> ${escapeHtml(
      p.dex
    )}`,

    `💧 <b>Liquidity:</b> ${money(
      p.liquidity
    )}`,

    `📊 <b>Volume 5m:</b> ${money(
      p.volume5m
    )}`,

    `📈 <b>Buys/Sells 5m:</b> ${
      p.buys5m
    }/${p.sells5m}`,

    `🔢 <b>Total transactions 5m:</b> ${totalTx}`,

    `⏱ <b>Pair age:</b> ${age.toFixed(
      1
    )} min`,

    "",

    "🔐 <b>SECURITY CHECK</b>",

    `🍯 <b>Honeypot:</b> ${sec.honeypot}`,

    `🪙 <b>Mint authority:</b> ${sec.mint}`,

    `❄️ <b>Freeze authority:</b> ${sec.freeze}`,

    `🛡 <b>Security status:</b> ${sec.risk}`,

    `👥 <b>Holders:</b> ${
      holders
        ? Number(holders).toLocaleString()
        : "N/A"
    }`,

    `🐋 <b>Top 10 distribution:</b> ${
      top10 != null
        ? `${top10}%`
        : "N/A"
    }`,

    `⭐ <b>GT Score:</b> ${
      gtScore
        ? gtScore.toFixed(1)
        : "N/A"
    }`,

    `🔒 <b>Locked liquidity:</b> ${
      locked
        ? `${locked.toFixed(2)}%`
        : "N/A"
    }`,

    "",

    `📍 <b>Base token:</b> <code>${escapeHtml(
      short(
        baseAddr ||
          p.address
      )
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

    "⚠️ <i>Security checks reduce risk but do not guarantee that a token is genuine or safe. Verify the contract before trading.</i>"
  ];

  return lines.join("\n");
}

async function telegram(text) {
  const url =
    `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;

  const r =
    await fetch(url, {
      method: "POST",

      headers: {
        "content-type":
          "application/json"
      },

      body: JSON.stringify({
        chat_id:
          cfg.chatId,

        text,

        parse_mode:
          "HTML",

        disable_web_page_preview:
          false
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
    const raw =
      await getNewPools();

    const pools =
      raw.map(normalize);

    pools.sort(
      (a, b) =>
        Date.parse(
          a.createdAt || 0
        ) -
        Date.parse(
          b.createdAt || 0
        )
    );

    let basicQualified = 0;
    let securityChecked = 0;
    let alertsSent = 0;

    for (const p of pools) {
      if (!p.id) {
        continue;
      }

      if (alerted.has(p.id)) {
        continue;
      }

      if (expired.has(p.id)) {
        continue;
      }

      const age =
        ageMinutes(
          p.createdAt
        );

      /*
       * IMPORTANT:
       * Do NOT mark a young pool as seen just because
       * it currently has less than 1000 transactions.
       *
       * This allows the same pool to be checked again
       * on the next scan as transactions increase.
       */

      if (age > cfg.maxAgeMin) {
        expired.add(p.id);
        continue;
      }

      if (!basicPasses(p)) {
        continue;
      }

      basicQualified++;

      const info =
        await getTokenInfo(
          p.network,
          p.addressBase
        );

      securityChecked++;

      /*
       * Block confirmed honeypots.
       * Unknown security data is NOT automatically blocked.
       */

      if (
        info?.is_honeypot === true
      ) {
        console.log(
          "Blocked confirmed honeypot:",
          p.network,
          p.address
        );

        alerted.add(p.id);
        continue;
      }

      await telegram(
        message(p, info)
      );

      alerted.add(p.id);
      alertsSent++;

      await sleep(700);
    }

    while (
      alerted.size >
      MAX_TRACKED
    ) {
      alerted.delete(
        alerted.values().next().value
      );
    }

    while (
      expired.size >
      MAX_TRACKED
    ) {
      expired.delete(
        expired.values().next().value
      );
    }

    console.log(
      new Date().toISOString(),
      `scanned=${pools.length}`,
      `basicQualified=${basicQualified}`,
      `securityChecked=${securityChecked}`,
      `alertsSent=${alertsSent}`,
      `alerted=${alerted.size}`,
      `expired=${expired.size}`
    );
  } catch (e) {
    console.error(
      new Date().toISOString(),
      e.message
    );
  }
}

const port =
  Number(
    process.env.PORT || 10000
  );

const server =
  createServer(
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
      pollMs:
        cfg.pollMs,

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