/**
 * End-to-end test of the liquidity pool, against whichever contract you name.
 *
 *   npx tsx scripts/pool-smoke-test.ts predict 2
 *   npx tsx scripts/pool-smoke-test.ts perp 2
 *
 * Proves the promise the pool makes: anyone can stake, interest accrues per second
 * at the advertised APY, and both principal and interest come back on demand.
 *
 * The interest check is the interesting one. Rather than trusting the figure the
 * contract reports, it recomputes what the APY *should* have produced over the
 * observed elapsed time and compares. A yield feature that quietly pays the wrong
 * rate would otherwise look perfectly healthy.
 */
import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { studionet } from "genlayer-js/chains";
import * as fs from "fs";
import * as path from "path";

for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const WHICH = (process.argv[2] || "predict").toLowerCase();
const STAKE_GEN = parseFloat(process.argv[3] || "2");
const A = WHICH === "perp" ? process.env.CONTRACT_ADDRESS! : process.env.PREDICT_CONTRACT_ADDRESS!;
const RPC = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
if (!A) { console.error(`no address configured for "${WHICH}"`); process.exit(1); }

const rawPk = process.env.PRIVATE_KEY || "";
const account = privateKeyToAccount((rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`) as `0x${string}`);
const client = createClient({ chain: studionet as any, endpoint: RPC, account });

const TX = ["UNINITIALIZED","PENDING","PROPOSING","COMMITTING","REVEALING","ACCEPTED",
  "UNDETERMINED","FINALIZED","CANCELED","APPEAL_REVEALING","APPEAL_COMMITTING",
  "READY_TO_FINALIZE","VALIDATORS_TIMEOUT","LEADER_TIMEOUT"];
const OK = new Set(["ACCEPTED", "FINALIZED"]);
const BAD = new Set(["UNDETERMINED", "CANCELED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"]);

const gen = (wei: string | bigint) => (Number(BigInt(wei)) / 1e18).toFixed(9);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function read(fn: string, args: any[] = []) {
  return client.readContract({ address: A, functionName: fn, args } as any);
}

async function write(fn: string, args: any[] = [], valueWei = 0n) {
  const hash = await client.writeContract({ address: A, functionName: fn, args, value: valueWei } as any);
  process.stdout.write(`   ${fn} tx ${hash.slice(0, 10)}… `);
  for (let i = 0; i < 30; i++) {
    await sleep(20000);
    const tx: any = await client.getTransaction({ hash });
    const cd = tx.consensus_data;
    const lr = Array.isArray(cd?.leader_receipt) ? cd.leader_receipt[0] : cd?.leader_receipt;
    if (lr?.execution_result === "ERROR") {
      const trace = (lr.genvm_result?.stderr || "").trim().split("\n").filter(Boolean).slice(-2).join(" | ");
      throw new Error(`${fn}() reverted: ${JSON.stringify(lr.result?.payload ?? lr.result)} ${trace}`);
    }
    const name = typeof tx.status === "number" ? TX[tx.status] ?? String(tx.status) : String(tx.status);
    if (BAD.has(name)) throw new Error(`${fn}() ended ${name}`);
    if (OK.has(name)) { process.stdout.write(`${name}\n`); return lr; }
  }
  throw new Error(`${fn}() never reached consensus`);
}

async function main() {
  console.log(`🏦 Liquidity pool test — ${WHICH}`);
  console.log(`   Contract: ${A}`);
  console.log(`   Staking:  ${STAKE_GEN} GEN\n`);

  const pool0: any = await read("get_pool", []);
  const apyBps = Number(pool0.apy_bps);
  console.log(`1. Pool before: APY ${apyBps / 100}%, staked ${gen(pool0.staked_principal)}, subsidy ${gen(pool0.rewards_pool)}`);

  // Fund the subsidy first. The yield is paid from here, so staking without it
  // would accrue interest the contract could not hand over.
  const subsidy = BigInt(Math.round(STAKE_GEN * 1e18)) / 2n;
  console.log(`\n2. Funding the reward subsidy with ${gen(subsidy)} GEN`);
  await write("fund_rewards", [], subsidy);

  console.log(`\n3. Staking ${STAKE_GEN} GEN`);
  const stakeWei = BigInt(Math.round(STAKE_GEN * 1e18));
  const before: any = await read("get_stake", [account.address.toLowerCase()]);
  await write("stake", [], stakeWei);
  const after: any = await read("get_stake", [account.address.toLowerCase()]);
  const added = BigInt(after.principal) - BigInt(before.principal);
  console.log(`   principal ${gen(before.principal)} → ${gen(after.principal)} (+${gen(added)})`);
  if (added !== stakeWei) throw new Error(`stake credited ${gen(added)}, expected ${gen(stakeWei)}`);

  const pool1: any = await read("get_pool", []);
  const runwayDays = Number(pool1.runway_seconds) / 86400;
  console.log(`   subsidy runway: ${Number(pool1.runway_seconds).toLocaleString()}s (~${runwayDays.toFixed(0)} days at this size)`);

  console.log("\n4. Letting interest accrue");
  const t0 = Math.floor(Date.now() / 1000);
  const i0 = BigInt((await read("get_stake", [account.address.toLowerCase()]) as any).interest);
  await sleep(90000);
  const snap: any = await read("get_stake", [account.address.toLowerCase()]);
  const t1 = Math.floor(Date.now() / 1000);
  const grew = BigInt(snap.interest) - i0;

  // What the advertised APY should have produced over the same window. Compared
  // rather than trusted: a pool paying the wrong rate still looks fine otherwise.
  const principal = BigInt(snap.principal);
  const expected = (principal * BigInt(apyBps) * BigInt(t1 - t0)) / (10000n * 31536000n);
  console.log(`   after ~${t1 - t0}s: interest grew ${gen(grew)} GEN`);
  console.log(`   ${apyBps / 100}% APY over that window predicts ${gen(expected)} GEN`);
  if (grew === 0n) throw new Error("no interest accrued at all");
  // Timestamps are per-block, so allow a couple of seconds of slack either way.
  const slack = (principal * BigInt(apyBps) * 5n) / (10000n * 31536000n);
  const diff = grew > expected ? grew - expected : expected - grew;
  if (diff > slack) {
    throw new Error(`accrual is off: ${gen(grew)} vs predicted ${gen(expected)}`);
  }
  console.log("   OK — accrual matches the advertised rate");

  console.log("\n5. Unstaking everything, principal + interest");
  const owed = BigInt(snap.principal) + BigInt(snap.interest);
  console.log(`   position is worth about ${gen(owed)} GEN`);
  const res = await write("unstake", [snap.principal]);
  const st: any = await read("get_stake", [account.address.toLowerCase()]);
  console.log(`   principal left: ${gen(st.principal)} GEN`);
  if (BigInt(st.principal) !== 0n) throw new Error(`unstake left ${gen(st.principal)} behind`);

  const pool2: any = await read("get_pool", []);
  console.log(`   pool now: staked ${gen(pool2.staked_principal)}, subsidy ${gen(pool2.rewards_pool)}, paid out ${gen(pool2.rewards_paid)}`);
  if (BigInt(pool2.rewards_paid) <= 0n) throw new Error("no interest was actually paid");

  console.log("\n6. Solvency");
  const held = BigInt(await contractBalance());
  console.log(`   contract holds ${gen(held)} GEN`);
  const owedNow = WHICH === "perp"
    ? BigInt(pool2.staked_principal) + BigInt(pool2.rewards_pool)
    : BigInt(pool2.staked_principal) + BigInt(pool2.rewards_pool) +
      BigInt(pool2.player_balances) + BigInt(pool2.at_risk_in_rounds);
  console.log(`   owes ${gen(owedNow)} GEN`);
  if (held < owedNow) throw new Error(`under-collateralised: holds ${gen(held)}, owes ${gen(owedNow)}`);
  console.log("   OK — holdings cover liabilities");

  console.log("\n✅ Pool test passed — stake, accrue, and withdraw principal + interest all work.");
}

async function contractBalance(): Promise<string> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [A, "latest"], id: 1 }),
  });
  return ((await r.json()) as any).result;
}

main().catch((e) => { console.error("\n❌ Pool test failed:", e.message ?? e); process.exit(1); });
