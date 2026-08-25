/**
 * Proves the session-wallet flow end to end, on-chain.
 *
 * The browser's "instant play" generates a throwaway key and signs with it. This
 * test does exactly the same thing from Node — generate a key, fund it from the
 * main wallet, then have that key deposit and bet entirely on its own — because
 * the claim being made is a strong one: after a single approval, no further
 * signature from the user's real wallet is ever needed.
 *
 *   npx tsx scripts/session-smoke-test.ts [marketKey] [fundGen]
 */
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as fs from "fs";
import * as path from "path";

for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const MARKET = process.argv[2] || "BTC-5m";
const FUND_GEN = parseFloat(process.argv[3] || "1.5");
const A = process.env.PREDICT_CONTRACT_ADDRESS!;
const RPC = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";

const main = privateKeyToAccount(
  (process.env.PRIVATE_KEY!.startsWith("0x") ? process.env.PRIVATE_KEY! : `0x${process.env.PRIVATE_KEY}`) as `0x${string}`
);
// The session key. Generated fresh, exactly as the browser does.
const sessionKey = generatePrivateKey();
const sessionAcct = privateKeyToAccount(sessionKey);

const mainClient = createClient({ chain: studionet as any, endpoint: RPC, account: main });
const sessionClient = createClient({ chain: studionet as any, endpoint: RPC, account: sessionAcct });

const TX = ["UNINITIALIZED","PENDING","PROPOSING","COMMITTING","REVEALING","ACCEPTED",
  "UNDETERMINED","FINALIZED","CANCELED","APPEAL_REVEALING","APPEAL_COMMITTING",
  "READY_TO_FINALIZE","VALIDATORS_TIMEOUT","LEADER_TIMEOUT"];
const OK = new Set(["ACCEPTED", "FINALIZED"]);
const BAD = new Set(["UNDETERMINED", "CANCELED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"]);
const gen = (w: string | bigint) => (Number(BigInt(w)) / 1e18).toFixed(6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function nativeBalance(addr: string) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [addr, "latest"], id: 1 }),
  });
  return BigInt(((await r.json()) as any).result);
}

async function settle(client: any, hash: string, label: string) {
  process.stdout.write(`   ${label} ${hash.slice(0, 10)}… `);
  for (let i = 0; i < 30; i++) {
    await sleep(20000);
    const tx: any = await client.getTransaction({ hash });
    const cd = tx.consensus_data;
    const lr = Array.isArray(cd?.leader_receipt) ? cd.leader_receipt[0] : cd?.leader_receipt;
    if (lr?.execution_result === "ERROR") {
      const trace = (lr.genvm_result?.stderr || "").trim().split("\n").filter(Boolean).slice(-2).join(" | ");
      throw new Error(`${label} reverted: ${JSON.stringify(lr.result?.payload ?? lr.result)} ${trace}`);
    }
    const name = typeof tx.status === "number" ? TX[tx.status] ?? String(tx.status) : String(tx.status);
    if (BAD.has(name)) throw new Error(`${label} ended ${name}`);
    if (OK.has(name)) { process.stdout.write(`${name}\n`); return; }
  }
  throw new Error(`${label} never reached consensus`);
}

async function main_() {
  console.log("⚡ Session wallet test");
  console.log(`   Main wallet:    ${main.address}`);
  console.log(`   Session wallet: ${sessionAcct.address}  (generated just now)\n`);

  console.log("1. The one and only approval from the main wallet");
  const fundWei = BigInt(Math.round(FUND_GEN * 1e18));
  const fundHash = await mainClient.sendTransaction({ to: sessionAcct.address, value: fundWei });
  console.log(`   sent ${gen(fundWei)} GEN to the session wallet`);
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    if ((await nativeBalance(sessionAcct.address)) > 0n) break;
  }
  const funded = await nativeBalance(sessionAcct.address);
  console.log(`   session wallet holds ${gen(funded)} GEN`);
  if (funded === 0n) throw new Error("funding never arrived");

  console.log("\n2. From here on, only the session key signs");
  const stakeWei = fundWei / 3n;
  const depositHash = await sessionClient.writeContract({
    address: A, functionName: "deposit", args: [], value: stakeWei,
  });
  await settle(sessionClient, depositHash, "deposit");

  const bal = BigInt((await sessionClient.readContract({
    address: A, functionName: "get_balance", args: [sessionAcct.address.toLowerCase()],
  } as any)) as any);
  console.log(`   play balance of the session wallet: ${gen(bal)} GEN`);
  if (bal !== stakeWei) throw new Error(`deposit credited ${gen(bal)}, expected ${gen(stakeWei)}`);

  console.log("\n3. Betting — no wallet prompt, no main-wallet signature");
  const betHash = await sessionClient.writeContract({
    address: A, functionName: "bet", args: [MARKET, "UP", bal], value: 0n,
  });
  await settle(sessionClient, betHash, "bet");

  const after = BigInt((await sessionClient.readContract({
    address: A, functionName: "get_balance", args: [sessionAcct.address.toLowerCase()],
  } as any)) as any);
  console.log(`   play balance after staking: ${gen(after)} GEN`);
  if (after !== 0n) throw new Error(`stake was not debited, ${gen(after)} left`);

  const bets = JSON.parse((await sessionClient.readContract({
    address: A, functionName: "get_user_bets", args: [sessionAcct.address.toLowerCase(), MARKET],
  } as any)) as any);
  console.log(`   bets recorded against the session wallet: ${bets.length}`);
  if (bets.length === 0) throw new Error("the bet was not recorded");

  console.log("\n4. Cashing out what is left of the fee budget");
  const left = await nativeBalance(sessionAcct.address);
  const reserve = BigInt(2e16);
  if (left > reserve) {
    const sweep = await sessionClient.sendTransaction({ to: main.address, value: left - reserve });
    console.log(`   returned ${gen(left - reserve)} GEN to the main wallet (${sweep.slice(0, 10)}…)`);
  } else {
    console.log(`   only ${gen(left)} GEN left, not worth the transfer fee`);
  }

  console.log("\n✅ Session test passed — one approval, then deposit and bet signed entirely by the session key.");
}

main_().catch((e) => { console.error("\n❌ Session test failed:", e.message ?? e); process.exit(1); });
