require("dotenv").config();

const http = require("http");
const { createClient } = require("genlayer-js");
const { privateKeyToAccount } = require("viem/accounts");
const { localnet } = require("genlayer-js/chains");
const { TransactionStatus } = require("genlayer-js/types");

const PORT = 3005;
const RPC_URL = "https://studio.genlayer.com/api";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
if (!CONTRACT_ADDRESS) throw new Error("❌ Missing CONTRACT_ADDRESS in .env");

let cachedRound = null;

const rawPk = process.env.PRIVATE_KEY || "";
const privateKey = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`;
const account = privateKeyToAccount(privateKey);

const studioChain = { ...localnet, id: 61999 };
const client = createClient({
  chain: studioChain,
  endpoint: RPC_URL,
  account,
});

// ─── Fetch BTC price from Binance ──────────────────────────────────
async function fetchBTCPrice() {
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
    const d = await r.json();
    const price = parseFloat(d.price).toFixed(2);
    console.log(`[PRICE] BTC = $${price}`);
    return price;
  } catch (e) {
    console.warn(`[PRICE] Binance failed, trying CoinGecko...`);
    try {
      const r2 = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
      const d2 = await r2.json();
      const price = String(d2.bitcoin.usd);
      console.log(`[PRICE] BTC = $${price} (CoinGecko)`);
      return price;
    } catch (e2) {
      console.error(`[PRICE] All price feeds failed`);
      return null;
    }
  }
}

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

async function handleRead(method, args) {
  const result = await client.readContract({
    address: CONTRACT_ADDRESS,
    functionName: method,
    args: args || [],
  });
  return result;
}

async function handleWrite(method, args) {
  const hash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    functionName: method,
    args: args || [],
    value: 0n,
  });
  return { txHash: hash };
}

// Recent TX log for system actions (start/lock/resolve)
const recentTxs = [];
function logTx(action, txHash, roundId, status = "PENDING") {
  const entry = {
    action,
    txHash,
    roundId,
    status,
    timestamp: Math.floor(Date.now() / 1000),
  };
  recentTxs.unshift(entry);
  if (recentTxs.length > 20) recentTxs.length = 20;
  return entry;
}

async function trackTxStatus(entry) {
  // ACCEPTED first (faster, ~10s), then FINALIZED in background
  try {
    await client.waitForTransactionReceipt({
      hash: entry.txHash,
      status: TransactionStatus.ACCEPTED,
      interval: 3000,
      retries: 60,
    });
    entry.status = "ACCEPTED";
    console.log(`[TX] ${entry.action} #${entry.roundId} ACCEPTED`);
  } catch (e) {
    entry.status = "FAILED";
    console.error(`[TX] ${entry.action} #${entry.roundId} FAILED: ${e.message}`);
    return;
  }
  try {
    await client.waitForTransactionReceipt({
      hash: entry.txHash,
      status: TransactionStatus.FINALIZED,
      interval: 5000,
      retries: 120,
    });
    entry.status = "FINALIZED";
    console.log(`[TX] ${entry.action} #${entry.roundId} FINALIZED`);
  } catch (e) {
    // remain ACCEPTED
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/round") {
    try {
      const data = cachedRound || await handleRead("get_round", []);
      json(res, data);
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/account") {
    json(res, { address: account.address });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/txs") {
    json(res, { txs: recentTxs });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    json(res, { contractAddress: CONTRACT_ADDRESS });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/call") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { method, args, type } = JSON.parse(body);
        let result;
        if (type === "write") {
          result = await handleWrite(method, args);
        } else {
          // Serve get_round from cache if available to prevent RPC spam
          if (method === "get_round" && cachedRound) {
            result = cachedRound;
          } else {
            result = await handleRead(method, args);
          }
        }
        json(res, result);
      } catch (e) {
        json(res, { error: e.message }, 500);
      }
    });
    return;
  }

  json(res, { error: "Not found" }, 404);
});

// ─── Verify state after TX ─────────────────────────────────────────
async function waitAndVerifyState(action, expectedRoundId) {
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const r = await handleRead("get_round", []);
      const rid = Number(r.round_id || 0);
      const st = r.status || "IDLE";
      console.log(`[VERIFY] ${action} round=${rid} status=${st} start=${r.start_price}`);
      if (action === "lock_round"    && st === "LOCKED")   return true;
      if (action === "resolve_round" && st === "RESOLVED") return true;
      if (action === "start_round"   && st === "OPEN" && rid === expectedRoundId) return true;
    } catch (e) { console.log(`[VERIFY] read error: ${e.message}`); }
  }
  return false;
}

// ─── Auto round manager ────────────────────────────────────────────
async function startCron() {
  let lastActionRound = 0;
  let lastActionType  = "";
  let lastActionTime  = 0;
  let resolveFailures = 0;
  let resolveBackoffUntil = 0;
  let pendingAction   = null; // blocks cron while verifying state

  // Bootstrap: read chain state so we don't re-send actions after restart
  try {
    const boot = await handleRead("get_round", []);
    const bootRound  = Number(boot.round_id || 0);
    const bootStatus = boot.status || "IDLE";
    const now0 = Math.floor(Date.now() / 1000);
    if (bootStatus === "LOCKED") {
      lastActionType = "lock"; lastActionRound = bootRound; lastActionTime = now0 - 60;
      console.log(`[BOOT] Round #${bootRound} already LOCKED — skip re-lock`);
    } else if (bootStatus === "RESOLVED") {
      lastActionType = "resolve"; lastActionRound = bootRound; lastActionTime = now0 - 60;
      console.log(`[BOOT] Round #${bootRound} already RESOLVED`);
    } else if (bootStatus === "OPEN") {
      const bootStart   = Number(boot.round_start_time || 0);
      const bootBetting = Number(boot.betting_seconds  || 300);
      if (now0 >= bootStart + bootBetting + 10) {
        // Betting already ended — allow lock on next tick, but don't spam
        lastActionType = "start"; lastActionRound = bootRound; lastActionTime = now0 - 130;
        console.log(`[BOOT] Round #${bootRound} OPEN betting ended — will lock next tick`);
      } else {
        console.log(`[BOOT] Round #${bootRound} OPEN betting active`);
      }
    } else {
      console.log(`[BOOT] Contract: ${bootStatus}`);
    }
  } catch (e) { console.log("[BOOT] Could not read chain state:", e.message); }

  setInterval(async () => {
    if (pendingAction) {
      console.log(`[CRON] Waiting for ${pendingAction} to confirm on-chain...`);
      return;
    }

    let inFlight = false;
    if (inFlight) return;
    inFlight = true;
    try {
      const round = await handleRead("get_round", []);
      cachedRound = round;
      const now      = Math.floor(Date.now() / 1000);
      const roundId  = Number(round.round_id || 0);
      const status   = round.status || "IDLE";
      const roundStart = Number(round.round_start_time || 0);
      const bettingSec = Number(round.betting_seconds  || 300);
      const lockSec    = Number(round.lock_seconds     || 300);

      if (lastActionRound === roundId && lastActionType !== "start") {
        if ((now - lastActionTime) < 120) return;
      }

      // ── START ──────────────────────────────────────────
      if (status === "IDLE" || status === "RESOLVED") {
        if (lastActionType === "start" && (now - lastActionTime) < 60) return;
        const nextId = roundId + 1;
        console.log(`[CRON] ▶ Starting round ${nextId}...`);
        const tx = await handleWrite("start_round", []);
        console.log(`[CRON]   TX: ${tx.txHash}`);
        logTx("start_round", tx.txHash, nextId);
        lastActionTime = now; lastActionType = "start"; lastActionRound = nextId;
        resolveFailures = 0; resolveBackoffUntil = 0;
        pendingAction = "start_round";
        waitAndVerifyState("start_round", nextId).then(ok => {
          pendingAction = null;
          if (!ok) console.error(`[STATE ERROR] start_round #${nextId}: state did not become OPEN`);
        });
        return;
      }

      // ── LOCK ───────────────────────────────────────────
      if (status === "OPEN") {
        const bettingEnd = roundStart + bettingSec;
        if (now >= bettingEnd + 10) {
          if (lastActionType === "lock" && (now - lastActionTime) < 120) return;
          console.log(`[CRON] 🔒 Locking round ${roundId}...`);
          const price = await fetchBTCPrice();
          if (!price) { console.error(`[CRON] Cannot lock: price unavailable`); return; }
          const tx = await handleWrite("lock_round", [price]);
          console.log(`[CRON]   TX: ${tx.txHash}`);
          logTx("lock_round", tx.txHash, roundId);
          lastActionTime = now; lastActionType = "lock"; lastActionRound = roundId;
          pendingAction = "lock_round";
          waitAndVerifyState("lock_round", roundId).then(ok => {
            pendingAction = null;
            if (!ok) {
              console.error(`[STATE ERROR] lock_round #${roundId}: TX finalized but status still OPEN. Oracle may have failed.`);
              // Reset debounce so it retries after guard
              lastActionType = ""; lastActionRound = 0;
            }
          });
        }
        return;
      }

      // ── RESOLVE ────────────────────────────────────────
      if (status === "LOCKED") {
        const lockEnd = roundStart + bettingSec + lockSec;
        if (now >= lockEnd + 10) {
          if (resolveBackoffUntil > 0 && now < resolveBackoffUntil) return;
          if (lastActionType === "resolve" && (now - lastActionTime) < 120) return;
          console.log(`[CRON] ✅ Resolving round ${roundId}...`);
          const price = await fetchBTCPrice();
          if (!price) { console.error(`[CRON] Cannot resolve: price unavailable`); return; }
          const tx = await handleWrite("resolve_round", [price]);
          console.log(`[CRON]   TX: ${tx.txHash}`);
          logTx("resolve_round", tx.txHash, roundId);
          lastActionTime = now; lastActionType = "resolve"; lastActionRound = roundId;
          resolveFailures = 0; resolveBackoffUntil = 0;
          pendingAction = "resolve_round";
          waitAndVerifyState("resolve_round", roundId).then(ok => {
            pendingAction = null;
            if (!ok) {
              resolveFailures++;
              const delay = Math.min(300, 30 * Math.pow(2, resolveFailures));
              resolveBackoffUntil = Math.floor(Date.now() / 1000) + delay;
              console.error(`[STATE ERROR] resolve_round #${roundId} failed. Backoff ${delay}s`);
              lastActionType = ""; lastActionRound = 0;
            }
          });
        }
        return;
      }
    } catch (e) {
      console.error(`[CRON] Error: ${e.message}`);
    } finally {
      inFlight = false;
    }
  }, 5000);
}

server.listen(PORT, () => {
  console.log(`🔌 Backend proxy running at http://localhost:${PORT}`);
  console.log(`   Account: ${account.address}`);
  console.log(`   Contract: ${CONTRACT_ADDRESS}`);
  console.log(`   Auto-round cron started (5s interval)`);
  startCron();
});

