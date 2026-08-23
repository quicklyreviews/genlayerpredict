/**
 * Keeper for the GenPredict PredictMarket contract.
 *
 * GenLayer contracts only run when a transaction calls them, so rounds need an
 * outside heartbeat to advance: start the first round, lock it when the betting
 * window ends (which also opens the following round), and resolve it once the
 * horizon elapses.
 *
 * All three actions are permissionless — anyone can run this. The contract itself
 * decides what is due via get_pending_actions(), so this process holds no schedule
 * of its own and recovers correctly after a restart or a missed window.
 *
 * Exported as a module so backend-proxy.js can run it in-process, and runnable
 * standalone with: node scripts/predict-keeper.js
 */
const { createClient } = require("genlayer-js");
const { privateKeyToAccount } = require("viem/accounts");
const { localnet } = require("genlayer-js/chains");

// Numeric tx.status values, in the order genlayer-js declares TransactionStatus.
const TX_STATUS = [
  "UNINITIALIZED", "PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACCEPTED",
  "UNDETERMINED", "FINALIZED", "CANCELED", "APPEAL_REVEALING", "APPEAL_COMMITTING",
  "READY_TO_FINALIZE", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT",
];
const TERMINAL_OK = new Set(["ACCEPTED", "FINALIZED"]);
const TERMINAL_BAD = new Set(["UNDETERMINED", "CANCELED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"]);

function statusName(status) {
  return typeof status === "number" ? TX_STATUS[status] ?? String(status) : String(status);
}

class PredictKeeper {
  constructor({ rpcUrl, privateKey, contractAddress, log = console.log }) {
    this.contractAddress = contractAddress;
    this.log = log;
    const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    this.account = privateKeyToAccount(pk);
    this.client = createClient({
      chain: { ...localnet, id: 61999 },
      endpoint: rpcUrl,
      account: this.account,
    });
    // Actions already sent and still working through consensus. Without this the
    // keeper re-sends the same lock/resolve every tick, because contract state does
    // not change until the transaction is accepted ~1 minute later.
    this.inFlight = new Map();
    this.running = false;
  }

  key(action) {
    return `${action.action}:${action.market}:${action.round_id}`;
  }

  /** Never await an RPC call unbounded. A hung request would otherwise sit inside
   *  sweep() forever, and because sweeps are serialised to avoid double-sending,
   *  one hang would silently wedge every market for good. */
  withTimeout(promise, ms, what) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
      ),
    ]);
  }

  async read(fn, args = []) {
    return this.withTimeout(
      this.client.readContract({ address: this.contractAddress, functionName: fn, args }),
      25000,
      `read ${fn}`
    );
  }

  async send(fn, args = []) {
    return this.withTimeout(
      this.client.writeContract({
        address: this.contractAddress,
        functionName: fn,
        args,
        value: 0n,
      }),
      45000,
      `send ${fn}`
    );
  }

  /** Watch a submitted transaction to completion without blocking the sweep loop. */
  async track(k, hash, label) {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      let tx;
      try {
        tx = await this.withTimeout(this.client.getTransaction({ hash }), 20000, "getTransaction");
      } catch (e) {
        continue;
      }
      const cd = tx.consensus_data;
      const lr = Array.isArray(cd?.leader_receipt) ? cd.leader_receipt[0] : cd?.leader_receipt;
      if (lr?.execution_result === "ERROR") {
        const payload = lr.result?.payload ?? lr.result;
        this.log(`[PREDICT] ✗ ${label} reverted: ${JSON.stringify(payload)}`);
        this.inFlight.delete(k);
        return;
      }
      const name = statusName(tx.status);
      if (TERMINAL_BAD.has(name)) {
        this.log(`[PREDICT] ✗ ${label} ended ${name}`);
        this.inFlight.delete(k);
        return;
      }
      if (TERMINAL_OK.has(name)) {
        this.log(`[PREDICT] ✓ ${label} ${name}`);
        this.inFlight.delete(k);
        return;
      }
    }
    this.log(`[PREDICT] ⚠ ${label} still unconfirmed after 7.5min, releasing`);
    this.inFlight.delete(k);
  }

  async sweep() {
    let actions;
    try {
      const raw = await this.read("get_pending_actions", []);
      actions = JSON.parse(raw || "[]");
    } catch (e) {
      this.log(`[PREDICT] pending actions read failed: ${e.message}`);
      return;
    }

    // Expire stale in-flight entries so a lost transaction cannot wedge a market.
    const now = Date.now();
    for (const [k, startedAt] of this.inFlight) {
      if (now - startedAt > 8 * 60 * 1000) this.inFlight.delete(k);
    }

    for (const action of actions) {
      const k = this.key(action);
      if (this.inFlight.has(k)) continue;
      const label = `${action.action}(${action.market}${action.round_id ? ` #${action.round_id}` : ""})`;
      this.inFlight.set(k, Date.now());
      try {
        const args =
          action.action === "resolve_round" ? [action.market, action.round_id] : [action.market];
        const hash = await this.send(action.action, args);
        this.log(`[PREDICT] → ${label} tx ${hash.slice(0, 12)}…`);
        this.track(k, hash, label);
      } catch (e) {
        this.log(`[PREDICT] ✗ ${label} send failed: ${e.message}`);
        this.inFlight.delete(k);
      }
    }
  }

  start(intervalMs) {
    if (this.running) return;
    this.running = true;
    this.log(`[PREDICT] keeper started — contract ${this.contractAddress}, every ${intervalMs}ms`);
    let sweeping = false;
    let sweepStarted = 0;
    this.timer = setInterval(async () => {
      // Belt and braces alongside the per-call timeouts: if a sweep somehow overruns
      // by a wide margin, let the next one through rather than stalling forever.
      if (sweeping && Date.now() - sweepStarted < 3 * 60 * 1000) return;
      if (sweeping) this.log(`[PREDICT] previous sweep overran — starting a new one`);
      sweeping = true;
      sweepStarted = Date.now();
      try {
        await this.sweep();
      } catch (e) {
        this.log(`[PREDICT] sweep error: ${e.message}`);
      } finally {
        sweeping = false;
      }
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.running = false;
  }
}

module.exports = { PredictKeeper };

// Standalone mode
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  try {
    for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch (e) { /* env optional */ }

  const address = process.env.PREDICT_CONTRACT_ADDRESS;
  if (!address) {
    console.error("PREDICT_CONTRACT_ADDRESS not set");
    process.exit(1);
  }
  const keeper = new PredictKeeper({
    rpcUrl: process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api",
    privateKey: process.env.PRIVATE_KEY || "",
    contractAddress: address,
  });
  keeper.start(parseInt(process.env.PREDICT_KEEPER_INTERVAL_MS || "20000", 10));
}
