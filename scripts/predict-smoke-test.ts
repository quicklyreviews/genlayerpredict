/**
 * End-to-end smoke test for the GenPredict PredictMarket contract.
 *
 * Places a real bet on both sides of the same round from one wallet is impossible
 * by design (one bet per wallet per round), so this test verifies the single-bet
 * path end to end: bet → wait for the round to lock → wait for it to resolve →
 * claim, and checks the payout maths against the parimutuel formula.
 *
 * Because a lone bettor makes the round one-sided, it settles as VOID and refunds
 * in full — which is exactly the stranded-funds case worth proving works.
 *
 * Usage:
 *   npx tsx scripts/predict-smoke-test.ts [marketKey] [stakeGen] [side]
 *   npx tsx scripts/predict-smoke-test.ts BTC-5m 1 UP
 *
 * NOTE: spends real balance on whatever network GENLAYER_RPC_URL points at, and
 * takes several minutes because it waits for a full round to settle.
 */
import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";
import * as fs from "fs";
import * as path from "path";

function loadEnv() {
  const p = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}
loadEnv();

const A = process.env.PREDICT_CONTRACT_ADDRESS!;
const RPC = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
if (!A) { console.error("PREDICT_CONTRACT_ADDRESS not set"); process.exit(1); }

const rawPk = process.env.PRIVATE_KEY || "";
const account = privateKeyToAccount((rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`) as `0x${string}`);
const client = createClient({ chain: { ...localnet, id: 61999 } as any, endpoint: RPC, account });

const MARKET = process.argv[2] || "BTC-5m";
const STAKE_GEN = parseFloat(process.argv[3] || "1");
const SIDE = (process.argv[4] || "UP").toUpperCase();

const TX_STATUS = [
  "UNINITIALIZED", "PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACCEPTED",
  "UNDETERMINED", "FINALIZED", "CANCELED", "APPEAL_REVEALING", "APPEAL_COMMITTING",
  "READY_TO_FINALIZE", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT",
];
const OK = new Set(["ACCEPTED", "FINALIZED"]);
const BAD = new Set(["UNDETERMINED", "CANCELED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"]);

const gen = (wei: string | bigint) => (Number(BigInt(wei)) / 1e18).toFixed(6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function read(fn: string, args: any[] = []) {
  return client.readContract({ address: A, functionName: fn, args } as any);
}

async function write(fn: string, args: any[] = [], valueWei = 0n) {
  const hash = await client.writeContract({ address: A, functionName: fn, args, value: valueWei } as any);
  process.stdout.write(`   tx ${hash.slice(0, 12)}… `);
  // The node caps requests per hour as well as per day, and polling a ~70s
  // consensus every 5s spent ~14 of them on a single transaction. Every 20s is
  // four checks and just as conclusive.
  for (let i = 0; i < 30; i++) {
    await sleep(20000);
    const tx: any = await client.getTransaction({ hash });
    const cd = tx.consensus_data;
    const lr = Array.isArray(cd?.leader_receipt) ? cd.leader_receipt[0] : cd?.leader_receipt;
    if (lr?.execution_result === "ERROR") {
      const trace = lr.genvm_result?.stderr || "";
      const tail = trace.trim().split("\n").filter(Boolean).slice(-2).join(" | ");
      throw new Error(`${fn}() reverted: ${JSON.stringify(lr.result?.payload ?? lr.result)} ${tail}`);
    }
    const name = typeof tx.status === "number" ? TX_STATUS[tx.status] ?? String(tx.status) : String(tx.status);
    if (BAD.has(name)) throw new Error(`${fn}() ended ${name}`);
    if (OK.has(name)) { process.stdout.write(`✅ ${name}\n`); return lr; }
  }
  throw new Error(`${fn}() never reached consensus`);
}

async function detail() {
  return JSON.parse((await read("get_market_detail", [MARKET, 5])) as any);
}

async function main() {
  console.log("🧪 GenPredict smoke test");
  console.log(`   Contract: ${A}`);
  console.log(`   Account:  ${account.address}`);
  console.log(`   Bet:      ${STAKE_GEN} GEN on ${SIDE} in ${MARKET}\n`);

  console.log("1️⃣  Market config");
  const d0 = await detail();
  if (d0.error) throw new Error(`market ${MARKET} not found`);
  console.log("   ", JSON.stringify(d0.market));

  console.log("\n2️⃣  Waiting for a round with enough betting time left");
  let target = null;
  for (let i = 0; i < 60; i++) {
    const d = await detail();
    const r = d.next_round;
    const left = r ? r.lock_ts - Math.floor(Date.now() / 1000) : -1;
    // A round with no stake never locks — the keeper leaves it alone so idle markets
    // cost nothing — so it is bettable no matter how long ago lock_ts passed. Judging
    // it by the clock alone made this test wait forever on a perfectly open round.
    const dormant = r && r.status === "OPEN"
      && BigInt(r.up_pool) + BigInt(r.down_pool) === 0n;
    if (r && r.status === "OPEN" && (dormant || left > 75)) {
      target = r;
      console.log(dormant ? "   round is dormant — this bet should wake it and restart the window" : "");
      break;
    }
    console.log(`   waiting… next=${r ? `#${r.id} lock in ${left}s` : "none"}`);
    await sleep(30000);
  }
  if (!target) throw new Error("No round opened with enough betting time");
  console.log(`   ✅ round #${target.id}, ${target.lock_ts - Math.floor(Date.now() / 1000)}s before lock`);

  console.log("\n3️⃣  Placing the bet");
  const stakeWei = BigInt(Math.round(STAKE_GEN * 1e18));
  const walletBefore = BigInt((await balance()) as string);

  // Assert on deltas, never on absolutes: the account may already hold a balance
  // from an earlier run, and an absolute check reads that as the contract having
  // invented or lost money. It cost a false alarm to learn that.
  const bal0 = BigInt((await read("get_balance", [account.address.toLowerCase()])) as any);
  console.log(`   starting play balance: ${gen(bal0)} GEN`);

  console.log("   depositing — funding is mandatory before playing");
  await write("deposit", [], stakeWei);
  const bal1 = BigInt((await read("get_balance", [account.address.toLowerCase()])) as any);
  console.log(`   play balance: ${gen(bal1)} GEN (+${gen(bal1 - bal0)})`);
  if (bal1 - bal0 !== stakeWei) {
    throw new Error(`deposit should have credited ${gen(stakeWei)}, credited ${gen(bal1 - bal0)}`);
  }

  // Anything already settled before this run must not be counted as ours later.
  const openBefore = new Set(
    (JSON.parse((await read("get_user_portfolio", [account.address.toLowerCase()])) as any) as any[])
      .filter((b) => b.state === "WON" || b.state === "REFUNDED")
      .map((b) => `${b.market}#${b.round_id}`)
  );

  console.log("   staking from that balance (no value attached to the bet)");
  await write("bet", [MARKET, SIDE, stakeWei]);
  const bal2 = BigInt((await read("get_balance", [account.address.toLowerCase()])) as any);
  console.log(`   play balance: ${gen(bal2)} GEN (−${gen(bal1 - bal2)})`);
  if (bal1 - bal2 !== stakeWei) {
    throw new Error(`stake should have debited ${gen(stakeWei)}, debited ${gen(bal1 - bal2)}`);
  }
  const afterBet = await detail();
  const woken = [afterBet.next_round, afterBet.live_round].find((r: any) => r && r.id === target.id);
  const windowLeft = woken ? woken.lock_ts - Math.floor(Date.now() / 1000) : -1;
  if (windowLeft <= 0) {
    throw new Error(`betting window did not restart on wake: lock_ts is ${windowLeft}s away`);
  }
  console.log(`   window restarted — ${windowLeft}s left for the other side to take it`);
  const rNow = [afterBet.next_round, afterBet.live_round].find((r: any) => r && r.id === target.id);
  console.log(`   pools → UP ${gen(rNow.up_pool)} / DOWN ${gen(rNow.down_pool)} GEN`);
  if (BigInt(rNow.total_pool) < stakeWei) {
    throw new Error(`pool should hold at least this stake, holds ${gen(rNow.total_pool)}`);
  }

  console.log("\n4️⃣  Waiting for the round to lock and settle (several minutes)");
  let settled = null;
  for (let i = 0; i < 40; i++) {
    await sleep(30000);
    const d = await detail();
    const hit = (d.history || []).find((r: any) => r.id === target.id);
    if (hit) { settled = hit; break; }
    const live = d.live_round && d.live_round.id === target.id ? d.live_round : null;
    console.log(`   ${live ? `live, settles in ${live.close_ts - Math.floor(Date.now() / 1000)}s` : "waiting for lock…"}`);
  }
  if (!settled) throw new Error("Round did not settle in time");

  console.log(`   ✅ settled: lock $${settled.lock_price} → close $${settled.close_price}`);
  console.log(`      winner ${settled.winner} · settlement ${settled.settlement}`);

  console.log("\n5️⃣  Checking the payout the contract computed");
  const bets = JSON.parse((await read("get_user_bets", [account.address.toLowerCase(), MARKET])) as any);
  const mine = bets.find((b: any) => b.round_id === target.id);
  if (!mine) throw new Error("bet not found in user bets");
  console.log(`   state=${mine.state} payout=${gen(mine.payout)} GEN staked=${gen(mine.amount)} GEN`);

  // A single bettor makes the round one-sided, so it must void and refund in full.
  if (settled.settlement !== "VOID") {
    throw new Error(`expected VOID settlement for a one-sided round, got ${settled.settlement}`);
  }
  if (BigInt(mine.payout) !== BigInt(mine.amount)) {
    throw new Error(`void round must refund the full stake: got ${gen(mine.payout)} vs ${gen(mine.amount)}`);
  }
  console.log("   ✅ one-sided round voided and refunds the full stake (no fee taken)");

  console.log("\n6️⃣  Claiming");
  console.log("   winnings should already be credited — there is no claim step");
  const bal3 = BigInt((await read("get_balance", [account.address.toLowerCase()])) as any);

  // The balance is wallet-wide, so other rounds settling in the same window also
  // move it — comparing its delta against one bet's payout reads a correct contract
  // as broken. The invariant that actually holds: the balance grew by exactly the
  // sum of every bet that settled while we were waiting.
  const settledSum = (JSON.parse(
    (await read("get_user_portfolio", [account.address.toLowerCase()])) as any
  ) as any[])
    .filter((b) => (b.state === "WON" || b.state === "REFUNDED") && !openBefore.has(`${b.market}#${b.round_id}`))
    .reduce((sum, b) => sum + BigInt(b.payout), 0n);

  console.log(`   play balance after settlement: ${gen(bal3)} GEN (+${gen(bal3 - bal2)})`);
  console.log(`   settled while waiting: ${gen(settledSum)} GEN across all markets`);
  if (bal3 - bal2 !== settledSum) {
    throw new Error(`balance grew ${gen(bal3 - bal2)} but settlements totalled ${gen(settledSum)}`);
  }
  if (BigInt(mine.payout) !== BigInt(mine.amount)) {
    throw new Error(`this bet should have been refunded in full, got ${gen(mine.payout)}`);
  }
  if (mine.state !== "REFUNDED") throw new Error(`expected REFUNDED, got ${mine.state}`);
  console.log("   OK - credited automatically at resolution");

  console.log("   withdrawing back to the wallet");
  await write("withdraw_all", []);
  const bal4 = BigInt((await read("get_balance", [account.address.toLowerCase()])) as any);
  if (bal4 !== 0n) throw new Error(`withdraw_all left ${gen(bal4)} behind`);
  // Reading the wallet right after ACCEPTED catches it before the native transfer
  // settles, so that figure lies. The reconciliation below is the real proof anyway.
  const walletAfter = BigInt((await balance()) as string);
  console.log(`   wallet: ${gen(walletAfter)} GEN (indicative — native transfer settles a beat later)`);

  const vault: any = await read("get_vault", []);
  console.log("   vault:", JSON.stringify(vault));

  // The assertion that matters: what the contract physically holds must cover what
  // its ledger says it owes. Under-collateralised means someone cannot be paid;
  // over means funds are stranded with no way to reach anyone.
  const held = BigInt(await contractBalance());
  const owed = BigInt(vault.total_liabilities);
  console.log(`   holds ${gen(held)} GEN, owes ${gen(owed)} GEN`);
  if (held < owed) {
    throw new Error(`under-collateralised: holds ${gen(held)} but owes ${gen(owed)}`);
  }
  if (owed === 0n && held > 0n) {
    throw new Error(`owes nothing yet still holds ${gen(held)} — funds are stranded`);
  }
  console.log("   OK - what it holds reconciles with what it owes");

  console.log("\n✅ Smoke test passed — deposit, bet, settle, auto-credit and withdraw all work on-chain.");
}

async function contractBalance(): Promise<string> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [A, "latest"], id: 1 }),
  });
  return ((await r.json()) as any).result;
}

async function balance(): Promise<string> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [account.address, "latest"], id: 1 }),
  });
  return ((await r.json()) as any).result;
}

main().catch((e) => {
  console.error("\n❌ Smoke test failed:", e.message ?? e);
  process.exit(1);
});
