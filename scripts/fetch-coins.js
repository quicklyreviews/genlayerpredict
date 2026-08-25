/**
 * Snapshot the top N coins from CoinGecko into frontend/coins.json.
 *
 * The list is baked into the frontend as a static file rather than fetched at
 * runtime, for three reasons: CoinGecko's free endpoint drops its CORS headers
 * the moment it rate-limits (so a browser fetch fails exactly when the app is
 * busiest), a thousand-row list never changes fast enough to be worth a request
 * per page load, and search has to stay instant while typing.
 *
 * Re-run it whenever you want new listings picked up:
 *   npm run coins            # top 1000
 *   npm run coins -- 250     # smaller/faster
 *
 * Every entry records whether the asset is tradeable on the venues the contract
 * prices against — a coin CoinGecko knows but Binance and Coinbase do not cannot
 * be settled, so the UI must not offer a market for it.
 */
const fs = require("fs");
const path = require("path");

const WANTED = parseInt(process.argv[2] || "1000", 10);
const PER_PAGE = 250; // CoinGecko's maximum
const OUT = path.join(__dirname, "..", "frontend", "coins.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, attempt = 1) {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 5) throw new Error(`${url} → ${res.status} after ${attempt} attempts`);
    // The free tier throttles hard; backing off is the whole trick to getting 1000.
    const wait = attempt * 15000;
    console.log(`   rate limited (${res.status}) — waiting ${wait / 1000}s then retrying`);
    await sleep(wait);
    return getJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

/** Symbols quoted against USDT on Binance — the contract's primary price source. */
async function binanceSymbols() {
  try {
    const d = await getJson("https://api.binance.com/api/v3/exchangeInfo");
    return new Set(
      d.symbols
        .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT")
        .map((s) => s.baseAsset.toUpperCase())
    );
  } catch (e) {
    console.warn(`   could not reach Binance (${e.message}) — marking every coin unverified`);
    return null;
  }
}

async function main() {
  console.log(`Fetching the top ${WANTED} coins from CoinGecko…`);
  const pages = Math.ceil(WANTED / PER_PAGE);
  const coins = [];

  for (let page = 1; page <= pages; page++) {
    const url =
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc` +
      `&per_page=${PER_PAGE}&page=${page}&sparkline=false`;
    const rows = await getJson(url);
    if (!Array.isArray(rows) || rows.length === 0) break;
    coins.push(...rows);
    console.log(`   page ${page}/${pages} → ${coins.length} coins`);
    if (page < pages) await sleep(3000); // stay under the free tier's limit
  }

  console.log("Checking which are tradeable on Binance…");
  const tradeable = await binanceSymbols();

  const seen = new Set();
  const out = [];
  for (const c of coins.slice(0, WANTED)) {
    const symbol = String(c.symbol || "").toUpperCase();
    // Symbols are not unique on CoinGecko; the higher market cap comes first, so
    // the first one wins and later impostors are dropped.
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({
      symbol,
      id: c.id,
      name: c.name,
      rank: c.market_cap_rank ?? null,
      image: c.image || null,
      // null when Binance was unreachable — "unknown", not "unsupported".
      tradeable: tradeable ? tradeable.has(symbol) : null,
    });
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source: "coingecko /coins/markets, market_cap_desc",
    count: out.length,
    tradeable_checked: tradeable !== null,
    coins: out,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload));

  const ok = out.filter((c) => c.tradeable).length;
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`\nWrote ${out.length} coins to frontend/coins.json (${kb} KB)`);
  if (tradeable) console.log(`${ok} are tradeable on Binance and can be listed as markets`);
  console.log(`Top 10: ${out.slice(0, 10).map((c) => c.symbol).join(", ")}`);
}

main().catch((e) => {
  console.error("fetch-coins failed:", e.message ?? e);
  process.exit(1);
});
