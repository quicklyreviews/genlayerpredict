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
const { studionet } = require("./chain");

// How long to consider a sent action "in flight" before allowing a retry. Sized to
// comfortably exceed GenLayer consensus (~70s) so we never double-send.
const CONSENSUS_GRACE_MS = 150000;

/**
 * Most actions one sweep will send.
 *
 * The contract reports everything that is due at once, and the keeper used to send
 * all of it. On a freshly deployed contract that means ten markets needing their
 * first round in the same tick — forty RPC calls in a few seconds, against a node
 * that allows five hundred an hour. The meter read 828/hour and warned it was near
 * the cap, and while the node is throttling, ordinary reads fail too: the play
 * balance in the header cannot load and shows "retry". Restarting the backend was
 * enough to trigger it, which is exactly when a user is looking at the page.
 *
 * Four per sweep, once a minute, drains any backlog within a few minutes while
 * leaving the hourly budget intact. Nothing is lost by waiting: the contract still
 * reports the rest as pending, and the next sweep picks them up.
 */
const MAX_ACTIONS_PER_SWEEP = 4;

/**
 * Lower sorts first. When the cap defers work, it must defer the least urgent:
 * resolving a round is holding somebody's money, locking one has bettors waiting on
 * it, and starting one only opens a market nobody has staked on yet.
 */
const ACTION_PRIORITY = { resolve_round: 0, lock_round: 1, start_round: 2 };

class PredictKeeper {
  constructor({ rpcUrl, privateKey, contractAddress, log = console.log }) {
    this.contractAddress = contractAddress;
    this.log = log;
    const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    this.account = privateKeyToAccount(pk);
    this.client = createClient({
      chain: studionet,
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

  /**
   * Deliberately does NOT poll the transaction to completion.
   *
   * Polling every 5s for a ~70s consensus cost ~14 extra RPC calls per action, and
   * with two actions per round across every market that alone was ~19k requests a
   * day — nearly 4x the node's entire 5000/day budget, which is exactly how the
   * quota got exhausted. The contract already knows what is outstanding: a
   * successful action disappears from get_pending_actions, and a failed one is
   * still listed and simply gets retried on a later sweep. So we send and let the
   * next sweep observe the result for free.
   *
   * The in-flight entry is just a debounce so the same action is not re-sent while
   * consensus is still running.
   */
  release(k, after = CONSENSUS_GRACE_MS) {
    setTimeout(() => this.inFlight.delete(k), after);
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

    // Urgent work first, then cap the burst. The contract lists actions grouped by
    // market, so without sorting a cap would strand the last markets' resolutions
    // behind the first markets' round openings.
    const ready = actions
      .filter((a) => !this.inFlight.has(this.key(a)))
      .sort((a, b) => (ACTION_PRIORITY[a.action] ?? 9) - (ACTION_PRIORITY[b.action] ?? 9));
    const due = ready.slice(0, MAX_ACTIONS_PER_SWEEP);
    if (ready.length > due.length) {
      // Say what was held back rather than letting a cap look like completion.
      this.log(`[PREDICT] ${ready.length} actions due, sending ${due.length} this sweep ` +
               `(${ready.length - due.length} deferred to stay inside the RPC budget)`);
    }

    for (const action of due) {
      const k = this.key(action);
      const label = `${action.action}(${action.market}${action.round_id ? ` #${action.round_id}` : ""})`;
      this.inFlight.set(k, Date.now());
      try {
        const args =
          action.action === "resolve_round" ? [action.market, action.round_id] : [action.market];
        const hash = await this.send(action.action, args);
        this.log(`[PREDICT] → ${label} tx ${hash.slice(0, 12)}…`);
        this.release(k);
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
  keeper.start(parseInt(process.env.PREDICT_KEEPER_INTERVAL_MS || "60000", 10));
}
