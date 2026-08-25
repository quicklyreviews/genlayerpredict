/**
 * End-to-end smoke test for the GenPerp PerpExchange contract.
 *
 * Exercises the full lifecycle against a live GenLayer node:
 *   1. view methods respond
 *   2. touch_price  — the Equivalence Principle price fetch actually reaches consensus
 *   3. fund_vault   — vault accounting
 *   4. open_position — payable trade entry
 *   5. estimate_position — unrealized PnL maths
 *   6. close_position — payout + vault settlement
 *
 * Usage:
 *   npx tsx scripts/perp-smoke-test.ts [marginGen] [leverage]
 *
 * Requires CONTRACT_ADDRESS, PRIVATE_KEY, GENLAYER_RPC_URL in .env.
 * NOTE: this spends real balance on whichever network GENLAYER_RPC_URL points at.
 */
import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { studionet } from "genlayer-js/chains";
import * as fs from "fs";
import * as path from "path";

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}
loadEnv();

const A = process.env.CONTRACT_ADDRESS!;
const RPC = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
if (!A) { console.error("CONTRACT_ADDRESS not set"); process.exit(1); }

const rawPk = process.env.PRIVATE_KEY || "";
const account = privateKeyToAccount((rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`) as `0x${string}`);
const client = createClient({ chain: studionet as any, endpoint: RPC, account });

const MARGIN_GEN = parseFloat(process.argv[2] || "1");
const LEVERAGE = parseInt(process.argv[3] || "5", 10);
const SYMBOL = "BTC";

function gen(wei: string | bigint) { return (Number(BigInt(wei)) / 1e18).toFixed(6); }

async function read(fn: string, args: any[] = []) {
  return client.readContract({ address: A, functionName: fn, args } as any);
}

// Numeric tx.status values, in the order genlayer-js declares TransactionStatus.
const TX_STATUS = [
  "UNINITIALIZED", "PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACCEPTED",
  "UNDETERMINED", "FINALIZED", "CANCELED", "APPEAL_REVEALING", "APPEAL_COMMITTING",
  "READY_TO_FINALIZE", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT",
];
const TERMINAL_OK = new Set(["ACCEPTED", "FINALIZED"]);
const TERMINAL_BAD = new Set(["UNDETERMINED", "CANCELED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"]);

/**
 * Submit a write and wait until consensus actually applies it.
 *
 * Two separate things can go wrong and both must be checked: the leader receipt
 * reports whether the contract code executed, while tx.status reports whether the
 * network accepted the result. Contract state is only readable once the status
 * reaches ACCEPTED — a SUCCESS leader receipt mid-consensus (PROPOSING/COMMITTING)
 * still reads back as stale state.
 */
async function write(fn: string, args: any[] = [], valueWei: bigint = 0n): Promise<any> {
  const hash = await client.writeContract({ address: A, functionName: fn, args, value: valueWei } as any);
  process.stdout.write(`   tx ${hash.slice(0, 12)}… `);
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const tx: any = await client.getTransaction({ hash });
    const cd = tx.consensus_data;
    const lr = Array.isArray(cd?.leader_receipt) ? cd.leader_receipt[0] : cd?.leader_receipt;
    if (lr?.execution_result === "ERROR") {
      const trace = lr.genvm_result?.stderr || "";
      const lastLine = trace.trim().split("\n").filter(Boolean).slice(-2).join(" | ");
      throw new Error(`${fn}() reverted: ${JSON.stringify(lr.result?.payload ?? lr.result)} ${lastLine}`);
    }
    const name = typeof tx.status === "number" ? TX_STATUS[tx.status] ?? String(tx.status) : String(tx.status);
    if (TERMINAL_BAD.has(name)) throw new Error(`${fn}() ended in ${name} — validators did not agree`);
    if (TERMINAL_OK.has(name)) {
      process.stdout.write(`✅ ${name}\n`);
      return lr;
    }
  }
  throw new Error(`${fn}() did not reach consensus within 7.5 minutes`);
}

async function main() {
  console.log("🧪 GenPerp smoke test");
  console.log(`   Contract: ${A}`);
  console.log(`   Account:  ${account.address}`);
  console.log(`   Trade:    ${MARGIN_GEN} GEN margin @ ${LEVERAGE}x ${SYMBOL}\n`);

  console.log("1️⃣  Views");
  console.log("   owner:", await read("get_owner"));
  const market: any = await read("get_market", [SYMBOL]);
  console.log("   market:", JSON.stringify(market));
  console.log("   vault:", JSON.stringify(await read("get_vault_status")));

  console.log("\n2️⃣  touch_price — Equivalence Principle price fetch");
  await write("touch_price", [SYMBOL]);
  const mark: any = await read("get_mark_price", [SYMBOL]);
  console.log("   mark price:", JSON.stringify(mark));
  if (!mark.price || mark.price === "0") throw new Error("mark price not cached — consensus failed");

  console.log("\n3️⃣  fund_vault");
  const fundWei = BigInt(Math.round(MARGIN_GEN * LEVERAGE * 2 * 1e18));
  console.log(`   funding ${gen(fundWei)} GEN so the vault can cover payouts`);
  await write("fund_vault", [], fundWei);
  console.log("   vault:", JSON.stringify(await read("get_vault_status")));

  console.log("\n4️⃣  open_position");
  const marginWei = BigInt(Math.round(MARGIN_GEN * 1e18));
  await write("open_position", [SYMBOL, "LONG", LEVERAGE], marginWei);
  const positions: any = JSON.parse((await read("get_user_positions", [account.address.toLowerCase()])) as any);
  const pos = positions[positions.length - 1];
  console.log(`   position #${pos.id}: ${pos.direction} ${pos.leverage}x`);
  console.log(`   margin ${gen(pos.margin)} GEN · notional ${gen(pos.notional)} GEN`);
  console.log(`   entry $${pos.entry_price} · est. liq $${pos.liq_price_estimate}`);
  console.log("   open interest:", JSON.stringify(await read("get_open_interest", [SYMBOL])));

  console.log("\n5️⃣  estimate_position");
  console.log("   ", JSON.stringify(await read("estimate_position", [pos.id])));

  console.log("\n6️⃣  close_position");
  const before = BigInt(await getBalance());
  await write("close_position", [pos.id]);
  const closed: any = await read("get_position", [pos.id]);
  console.log(`   status ${closed.status} · close $${closed.close_price} · realized PnL ${gen(closed.realized_pnl || "0")} GEN`);
  const after = BigInt(await getBalance());
  console.log(`   wallet delta: ${(Number(after - before) / 1e18).toFixed(6)} GEN (incl. gas)`);
  console.log("   vault:", JSON.stringify(await read("get_vault_status")));
  console.log("   open interest:", JSON.stringify(await read("get_open_interest", [SYMBOL])));

  console.log("\n✅ Smoke test passed — full trade lifecycle works on-chain.");
}

async function getBalance(): Promise<string> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [account.address, "latest"], id: 1 }),
  });
  return (await r.json() as any).result;
}

main().catch((e) => {
  console.error("\n❌ Smoke test failed:", e.message ?? e);
  process.exit(1);
});
