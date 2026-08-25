const http = require("http");
const fs = require("fs");
const path = require("path");
const { createClient } = require("genlayer-js");
const { privateKeyToAccount } = require("viem/accounts");
const { studionet, resolveRpc, assertStudionet } = require("./chain");

// Manually parse .env to avoid dotenv v17 corruption
function loadEnv() {
  try {
    const envPath = path.join(__dirname, "..", ".env");
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      process.env[key] = val;
    }
  } catch (e) { console.warn("Could not load .env:", e.message); }
}
loadEnv();

const { PredictKeeper } = require("./predict-keeper");

const PORT = process.env.PORT || 3005;
// Throws at startup if pointed anywhere but Studionet — the contracts live there,
// and a keeper aimed at another network would transact against whatever happens to
// sit at the same address.
const RPC_URL = resolveRpc();
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "";
const PREDICT_ADDRESS = process.env.PREDICT_CONTRACT_ADDRESS || "";
const PREDICT_KEEPER_INTERVAL_MS = parseInt(process.env.PREDICT_KEEPER_INTERVAL_MS || "60000", 10);
// Each sweep sends one touch_price transaction per market (plus any liquidations),
// so this interval is a direct gas cost. 60s keeps mark prices fresh enough for
// liquidation detection without burning gas on a 3-market loop.
const KEEPER_INTERVAL_MS = parseInt(process.env.KEEPER_INTERVAL_MS || "60000", 10);

const rawPk = process.env.PRIVATE_KEY || "";
const privateKey = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`;
const account = privateKeyToAccount(privateKey);

// ─── RPC meter ──────────────────────────────────────────────────────
//
// The node enforces 500 requests/hour and 5000/day, and exceeding either takes the
// whole app down until the window rolls. Guessing at consumption was how we blew it
// twice, so count the real thing: every JSON-RPC round trip, whatever makes it.
const rpcMeter = { total: 0, byMethod: {}, windowStart: Date.now() };
const _fetch = global.fetch;
global.fetch = async (url, opts) => {
  if (typeof url === "string" && url === RPC_URL && opts?.body) {
    try {
      const body = JSON.parse(opts.body);
      for (const m of Array.isArray(body) ? body : [body]) {
        rpcMeter.total++;
        rpcMeter.byMethod[m.method] = (rpcMeter.byMethod[m.method] || 0) + 1;
      }
    } catch (e) { rpcMeter.total++; }
  }
  return _fetch(url, opts);
};
setInterval(() => {
  const mins = (Date.now() - rpcMeter.windowStart) / 60000;
  const perHour = Math.round((rpcMeter.total / Math.max(mins, 0.1)) * 60);
  const top = Object.entries(rpcMeter.byMethod).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([m, n]) => `${m}=${n}`).join(" ");
  console.log(`[RPC] ${rpcMeter.total} calls in ${mins.toFixed(1)}min → ~${perHour}/hour of 500  ${top}`);
  if (perHour > 450) console.warn(`[RPC] ⚠ approaching the hourly cap`);
}, 300000);

const studioChain = studionet;
const client = createClient({ chain: studioChain, endpoint: RPC_URL, account });

// Writes exposed through the public HTTP API are keeper-only actions — they are
// designed to be permissionless on-chain (anyone calling them is fine/expected),
// so letting the backend's key execute them for convenience is safe. Trading
// actions (open_position/close_position/fund_vault/withdraw_vault/add_market/...)
// spend or move the CALLER's funds and must always be signed by the user's own
// wallet directly in the browser (see frontend/app.js writeContract()) — never
// routed through this backend, which would otherwise spend the admin's GEN.
const KEEPER_WRITE_ALLOWLIST = new Set(["touch_price", "liquidate_position", "settle_funding"]);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms`)), ms)),
  ]);
}

// Read cache. Two jobs: absorb repeat reads inside a short window, and keep serving
// the last-known value when the RPC is unavailable.
//
// The GenLayer Studio RPC caps requests per hour (500) as well as per day (5000).
// Every browser tab polls
// several views on a loop and the keeper sweeps every market, so without this the
// limit is blown within seconds and reads start failing. Contract state only changes
// when a transaction is accepted (~1 min), so a short TTL costs no real freshness.
const readCache = {};
const READ_TTL_MS = parseInt(process.env.READ_TTL_MS || "10000", 10);
// Market configs change only on an admin call — cache them far longer.
const LONG_TTL_METHODS = new Set(["get_all_markets", "get_market", "get_owner"]);
const LONG_TTL_MS = 120000;

async function handleRead(method, args, { allowStale = true, address = CONTRACT_ADDRESS } = {}) {
  const cacheKey = address + ":" + method + JSON.stringify(args || []);
  const ttl = LONG_TTL_METHODS.has(method) ? LONG_TTL_MS : READ_TTL_MS;
  const hit = readCache[cacheKey];
  if (hit && Date.now() - hit.ts < ttl) return hit.value;

  try {
    const result = await withTimeout(
      client.readContract({ address, functionName: method, args: args || [] }),
      25000
    );
    readCache[cacheKey] = { value: result, ts: Date.now() };
    return result;
  } catch (e) {
    if (allowStale && hit !== undefined) {
      console.warn(`[RPC] ${method} failed (${e.message}), serving stale cache`);
      return hit.value;
    }
    throw e;
  }
}

// Prediction rounds change on a timer, so a long TTL would show a stale countdown
// or a stale pool. But the node allows only 5000 requests a day in total, and the
// keeper already needs most of that, so this is as short as the budget allows.
// Countdowns tick locally in the browser anyway — only pools and prices need the
// round trip, and those move slowly enough that 15s is imperceptible.
const PREDICT_TTL_MS = parseInt(process.env.PREDICT_TTL_MS || "30000", 10);

async function handlePredictRead(method, args, { fresh = false } = {}) {
  if (!PREDICT_ADDRESS) throw new Error("PREDICT_CONTRACT_ADDRESS is not configured");
  const cacheKey = "predict:" + method + JSON.stringify(args || []);
  const hit = readCache[cacheKey];
  const ttl = method === "get_all_markets" ? LONG_TTL_MS : PREDICT_TTL_MS;
  // A caller that just moved money needs to see the result, not a value cached
  // moments before the transaction landed. Everything else takes the cache.
  if (!fresh && hit && Date.now() - hit.ts < ttl) return hit.value;
  try {
    const result = await withTimeout(
      client.readContract({ address: PREDICT_ADDRESS, functionName: method, args: args || [] }),
      25000
    );
    readCache[cacheKey] = { value: result, ts: Date.now() };
    return result;
  } catch (e) {
    if (hit !== undefined) {
      console.warn(`[RPC] predict.${method} failed (${e.message}), serving stale cache`);
      return hit.value;
    }
    throw e;
  }
}

// Drop cached reads for a symbol after we mutate its state, so the next poll is fresh.
function invalidateCache() {
  for (const k of Object.keys(readCache)) {
    if (!LONG_TTL_METHODS.has(k.split("[")[0])) delete readCache[k];
  }
}

async function handleWrite(method, args) {
  if (!KEEPER_WRITE_ALLOWLIST.has(method)) {
    throw new Error(`Method '${method}' cannot be executed by the backend — sign it with your own wallet`);
  }
  const hash = await client.writeContract({ address: CONTRACT_ADDRESS, functionName: method, args: args || [] });
  return { txHash: hash };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/config") {
    json(res, { contractAddress: CONTRACT_ADDRESS, predictAddress: PREDICT_ADDRESS });
    return;
  }

  // Prediction market reads. Writes are deliberately absent: bets and claims move
  // the user's own funds and must be signed by their wallet, never by this key.
  if (req.method === "POST" && url.pathname === "/api/predict/call") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { method, args, type, fresh } = JSON.parse(body);
        if (type === "write") {
          throw new Error(`Predict writes must be signed by your own wallet, not the backend`);
        }
        json(res, await handlePredictRead(method, args, { fresh: fresh === true }));
      } catch (e) {
        json(res, { error: e.message }, 500);
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/account") {
    json(res, { address: account.address });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/call") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { method, args, type } = JSON.parse(body);
        const result = type === "write" ? await handleWrite(method, args) : await handleRead(method, args);
        json(res, result);
      } catch (e) {
        json(res, { error: e.message }, 500);
      }
    });
    return;
  }

  json(res, { error: "Not found" }, 404);
});

// ─── Keeper loop: refresh prices, liquidate at-risk positions, settle funding ──
function priceChangePct(entry, current, direction) {
  if (entry === 0) return 0;
  return direction === "LONG" ? (current - entry) / entry : (entry - current) / entry;
}

async function sweepMarket(symbol, market) {
  if (!market.enabled) return;

  // Check for open positions FIRST. With none, there is nothing to liquidate and no
  // reason to spend gas refreshing the mark price — an idle market should cost one
  // cheap read per sweep, not a transaction.
  let positions = [];
  try {
    const raw = await handleRead("get_open_positions_for_symbol", [symbol]);
    positions = JSON.parse(raw || "[]");
  } catch (e) {
    console.error(`[KEEPER] reading ${symbol} positions failed: ${e.message}`);
    return;
  }
  if (positions.length === 0) return;

  let markPrice = 0;
  try {
    const tx = await handleWrite("touch_price", [symbol]);
    invalidateCache();
    const cached = await handleRead("get_mark_price", [symbol]);
    markPrice = parseFloat(cached.price || "0");
    console.log(`[KEEPER] ${symbol} touch_price TX ${tx.txHash.slice(0, 10)}... mark≈$${markPrice}`);
  } catch (e) {
    console.error(`[KEEPER] touch_price(${symbol}) failed: ${e.message}`);
    return;
  }
  if (!(markPrice > 0)) return;

  try {
    for (const p of positions) {
      const entry = parseFloat(p.entry_price);
      const margin = Number(BigInt(p.margin));
      const notional = Number(BigInt(p.notional));
      const pct = priceChangePct(entry, markPrice, p.direction);
      const pnl = notional * pct;
      const equity = margin + pnl;
      const maintenance = margin * (Number(market.maintenance_margin_bps) / 10000);
      if (equity <= maintenance) {
        try {
          const tx = await handleWrite("liquidate_position", [p.id]);
          console.log(`[KEEPER] liquidated #${p.id} (${symbol} ${p.direction}) TX ${tx.txHash}`);
        } catch (e) {
          console.log(`[KEEPER] liquidate_position(${p.id}) skipped: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.error(`[KEEPER] scanning ${symbol} failed: ${e.message}`);
  }

  try {
    const finfo = await handleRead("get_funding_info", [symbol]);
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - Number(finfo.last_ts || 0);
    if (elapsed >= Number(market.funding_interval_seconds)) {
      const tx = await handleWrite("settle_funding", [symbol]);
      console.log(`[KEEPER] settle_funding(${symbol}) TX ${tx.txHash}`);
    }
  } catch (e) {
    console.log(`[KEEPER] settle_funding(${symbol}) skipped: ${e.message}`);
  }
}

async function startKeeper() {
  if (!CONTRACT_ADDRESS) {
    console.warn("[KEEPER] CONTRACT_ADDRESS not set — keeper disabled, serving reads only");
    return;
  }
  let inFlight = false;
  setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      // One cheap read decides whether to look at anything else. Scanning every
      // market unconditionally cost one read per market per sweep, which with the
      // full listing was ~480 reads an hour — the node allows 500, so the perp
      // keeper alone starved everything else. With no margin locked there is
      // nothing to liquidate and nothing worth reading.
      const vault = await handleRead("get_vault_status", []);
      if (BigInt(vault.total_margin_locked || "0") === 0n) return;

      const marketsRaw = await handleRead("get_all_markets", []);
      const markets = JSON.parse(marketsRaw);
      for (const [symbol, market] of Object.entries(markets)) {
        await sweepMarket(symbol, market);
      }
    } catch (e) {
      console.error(`[KEEPER] loop error: ${e.message}`);
    } finally {
      inFlight = false;
    }
  }, KEEPER_INTERVAL_MS);
}

server.listen(PORT, async () => {
  console.log(`🔌 GenPredict backend running at http://localhost:${PORT}`);
  const onStudio = await assertStudionet(RPC_URL);
  console.log(`   Chain:    Studionet (61999)${onStudio === false ? " ⚠ NODE REPORTS A DIFFERENT CHAIN" : ""}`);
  console.log(`   Account:  ${account.address}`);
  console.log(`   Predict:  ${PREDICT_ADDRESS || "(not set)"}`);
  console.log(`   Perp:     ${CONTRACT_ADDRESS || "(not set)"}`);
  startKeeper();

  if (PREDICT_ADDRESS) {
    const predictKeeper = new PredictKeeper({
      rpcUrl: RPC_URL,
      privateKey: rawPk,
      contractAddress: PREDICT_ADDRESS,
    });
    predictKeeper.start(PREDICT_KEEPER_INTERVAL_MS);
  } else {
    console.warn("[PREDICT] PREDICT_CONTRACT_ADDRESS not set — prediction rounds will not advance");
  }
});
