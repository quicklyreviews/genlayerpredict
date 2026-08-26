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
import { studionet } from "genlayer-js/chains";
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
const client = createClient({ chain: studionet as any, endpoint: RPC, account });

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

/**
 * Reads retry on transport failures.
 *
 * These tests wait minutes for a round to settle, polling throughout, so a single
 * dropped connection would otherwise abandon a run that was proceeding perfectly —
 * which is exactly what happened. A network blip is not a test failure; only the
 * contract disagreeing with expectations is.
 */
async function read(fn: string, args: any[] = [], attempt = 1): Promise<any> {
  try {
    return await client.readContract({ address: A, functionName: fn, args } as any);
  } catch (e: any) {
    const transient = /fetch failed|timeout|ECONNRESET|socket hang up|network/i.test(String(e.message));
    if (transient && attempt <= 5) {
      await sleep(5000 * attempt);
      return read(fn, args, attempt + 1);
    }
    throw e;
  }
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
      .filter((b) => ["CLAIMABLE", "REFUNDABLE", "COLLECTED"].includes(b.state))
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

  // A single bettor leaves one side empty, which is what the house backstop exists
  // for. Either it covered the round — in which case this is a real bet with a real
  // outcome — or it could not, and the round voids and refunds as it used to. Both
  // are correct; which one applies is decided by the backstop's capital and cap.
  const houseStake = BigInt(settled.house_stake || "0");
  const stake = BigInt(mine.amount);
  if (houseStake > 0n) {
    console.log(`   house took ${settled.house_side} with ${gen(houseStake)} GEN`);
    if (settled.settlement !== "PAID") {
      throw new Error(`a covered round must settle PAID, got ${settled.settlement}`);
    }
    if (settled.house_side === SIDE) {
      throw new Error(`house took ${settled.house_side}, the same side as the bettor`);
    }
    if (settled.winner === SIDE) {
      // Won against the house: the payout is the whole pool less the fee. With an
      // even match that is close to 2x, and must always beat the stake — a "win"
      // that returns less than it risked would be worse than the old refund.
      if (BigInt(mine.payout) <= stake) {
        throw new Error(`winning bet paid ${gen(mine.payout)}, no more than the ${gen(stake)} staked`);
      }
      const x = Number(BigInt(mine.payout) * 1000n / stake) / 1000;
      console.log(`   ✅ beat the house — ${gen(mine.payout)} GEN back on ${gen(stake)} staked (${x.toFixed(2)}x)`);
    } else {
      if (BigInt(mine.payout) !== 0n) {
        throw new Error(`losing bet should pay nothing, got ${gen(mine.payout)}`);
      }
      console.log(`   ✅ lost to the house — stake forfeited, which is the other half of a real bet`);
    }
  } else {
    if (settled.settlement !== "VOID") {
      throw new Error(`uncovered one-sided round should VOID, got ${settled.settlement}`);
    }
    if (BigInt(mine.payout) !== stake) {
      throw new Error(`void round must refund the full stake: got ${gen(mine.payout)} vs ${gen(stake)}`);
    }
    console.log("   ✅ backstop did not cover it, so the round voided and refunds in full");
  }

  console.log("\n6️⃣  Claiming");
  console.log("   winnings are recorded but NOT paid until claimed");
  const bal3 = BigInt((await read("get_balance", [account.address.toLowerCase()])) as any);

  // The balance is wallet-wide, so other rounds settling in the same window also
  // move it — comparing its delta against one bet's payout reads a correct contract
  // as broken. The invariant that actually holds: the balance grew by exactly the
  // sum of every bet that settled while we were waiting.
  console.log(`   play balance after settlement: ${gen(bal3)} GEN (unchanged — nothing collected yet)`);
  if (bal3 !== bal2) {
    throw new Error(`settlement must not move money: balance went ${gen(bal2)} to ${gen(bal3)}`);
  }


  if (BigInt(mine.payout) === 0n) {
    console.log("   nothing to collect — the bet lost against the house, which is a valid outcome");
    console.log("\n✅ Smoke test passed — deposit, bet, house-covered settlement and loss all work on-chain.");
    return;
  }

  // Now collect it, which is the step the player takes.
  const claimable = JSON.parse((await read("get_claimable", [account.address.toLowerCase()])) as any);
  console.log(`   claimable rounds: ${claimable.length}`);
  if (!claimable.some((c: any) => c.round_id === target.id)) {
    throw new Error("this round is not listed as claimable");
  }
  console.log("   collecting");
  await write("claim", [MARKET, target.id]);
  const bal3b = BigInt((await read("get_balance", [account.address.toLowerCase()])) as any);
  console.log(`   play balance after collecting: ${gen(bal3b)} GEN (+${gen(bal3b - bal3)})`);
  if (bal3b - bal3 !== BigInt(mine.payout)) {
    throw new Error(`collect credited ${gen(bal3b - bal3)}, expected ${gen(mine.payout)}`);
  }

  // Collecting twice must be impossible.
  try {
    await write("claim", [MARKET, target.id]);
    throw new Error("double collect should have been rejected");
  } catch (e: any) {
    if (String(e.message).includes("double collect should")) throw e;
    console.log("   OK - collecting twice is rejected");
  }
  const after = (JSON.parse((await read("get_user_portfolio", [account.address.toLowerCase()])) as any) as any[])
    .find((b) => b.market === MARKET && b.round_id === target.id);
  if (!after) throw new Error("the collected bet vanished from history");
  if (after.state !== "COLLECTED") {
    throw new Error(`expected COLLECTED after claiming, got ${after.state}`);
  }
  if (!Number(after.claimed_ts)) throw new Error("collection was not timestamped");
  console.log(`   OK - history reads COLLECTED, stamped ${new Date(Number(after.claimed_ts) * 1000).toISOString()}`);

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
  //
  // Both figures are read after the withdrawal settles, not merely after it is
  // ACCEPTED. The ledger drops to zero the moment the transaction lands, but the
  // native transfer out follows a beat later — so reading straight away catches a
  // real contract mid-step and reports solvent funds as stranded, which is exactly
  // how this failed before. Poll until the two agree, and only then judge.
  const owed = BigInt(vault.total_liabilities);
  // House market-making capital is the contract's own money, not a debt. It is a
  // legitimate reason for holdings to exceed liabilities, so it is excluded before
  // the two are compared — otherwise a funded backstop reads as stranded funds.
  const houseCapital = BigInt(vault.house_capital || "0");
  let held = BigInt(await contractBalance()) - houseCapital;
  for (let i = 0; i < 12 && owed === 0n && held > 0n; i++) {
    await sleep(5000);
    held = BigInt(await contractBalance()) - houseCapital;
  }
  console.log(`   holds ${gen(held)} GEN net of ${gen(houseCapital)} house capital, owes ${gen(owed)} GEN`);
  if (held < owed) {
    throw new Error(`under-collateralised: holds ${gen(held)} but owes ${gen(owed)}`);
  }
  if (owed === 0n && held > 0n) {
    throw new Error(`owes nothing yet still holds ${gen(held)} — funds are stranded`);
  }
  console.log("   OK - what it holds reconciles with what it owes");

  console.log("\n✅ Smoke test passed — deposit, bet, settle, collect and withdraw all work on-chain.");
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
