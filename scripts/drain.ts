/**
 * Returns every player's money from a prediction contract to their own wallets.
 *
 * Run this before replacing a contract. Deploying does not migrate anything: the
 * new contract starts empty and the old one keeps every deposit, so unless the
 * balances are pushed home first they are stranded at an address the app no longer
 * reads. That has already cost a real user their balance more than once.
 *
 * It cannot be done from the outside — withdraw_all pays whoever calls it, so the
 * operator calling it would only withdraw their own balance. refund_all() on the
 * contract is the push equivalent: owner-triggered, but it pays each balance to the
 * address that owns it and nowhere else.
 *
 * Usage:
 *   npx tsx scripts/drain.ts                       # drain the current contract
 *   npx tsx scripts/drain.ts 0xOldContractAddress  # drain a specific one
 *
 * Environment:
 *   PREDICT_CONTRACT_ADDRESS  — default target
 *   PRIVATE_KEY               — must be the contract owner
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
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}
loadEnv();

const gen = (w: any) => (Number(BigInt(w || 0)) / 1e18).toFixed(6);

export async function drain(address: string, log = console.log): Promise<boolean> {
  const rawPk = process.env.PRIVATE_KEY || "";
  const account = privateKeyToAccount(
    (rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`) as `0x${string}`
  );
  const client = createClient({
    chain: studionet as any,
    endpoint: process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api",
    account,
  });

  const vault: any = await (client as any).readContract({
    address, functionName: "get_vault", args: [],
  });
  const owed =
    BigInt(vault.player_balances || 0) +
    BigInt(vault.unclaimed_winnings || 0);
  log(`   owes players ${gen(owed)} GEN across ${vault.accounts ?? "?"} account(s)`);

  if (owed === 0n) {
    log(`   nothing to return`);
  }

  // Batched, because one transaction cannot pay an unbounded number of accounts.
  for (let round = 0; round < 20; round++) {
    const before: any = await (client as any).readContract({
      address, functionName: "get_vault", args: [],
    });
    const left = BigInt(before.player_balances || 0) + BigInt(before.unclaimed_winnings || 0);
    if (left === 0n) break;

    log(`   returning a batch (${gen(left)} GEN outstanding)…`);
    const hash = await (client as any).writeContract({
      address, functionName: "refund_all", args: [25], value: 0n,
    });
    await (client as any).waitForTransactionReceipt({
      hash, status: "FINALIZED", interval: 5000, retries: 60,
    });
  }

  const after: any = await (client as any).readContract({
    address, functionName: "get_vault", args: [],
  });
  const stillOwed = BigInt(after.player_balances || 0) + BigInt(after.unclaimed_winnings || 0);
  const staked = BigInt(after.at_risk_in_rounds || 0);
  const lp = BigInt(after.staked_principal || 0);

  if (stillOwed > 0n) log(`   ⚠ ${gen(stillOwed)} GEN still owed — run again`);
  else log(`   ✅ every spendable balance is back in its owner's wallet`);

  // These cannot be pushed: a stake is only decided when its round resolves, and LP
  // principal has to be unstaked by its owner so interest settles correctly. Say so,
  // because abandoning a contract that still holds them repeats the original mistake.
  if (staked > 0n) log(`   ⚠ ${gen(staked)} GEN is staked on rounds that have not resolved`);
  if (lp > 0n) log(`   ⚠ ${gen(lp)} GEN of liquidity-pool principal remains — providers must unstake`);

  return stillOwed === 0n && staked === 0n && lp === 0n;
}

async function main() {
  const address = process.argv[2] || process.env.PREDICT_CONTRACT_ADDRESS;
  if (!address) throw new Error("No contract address given and PREDICT_CONTRACT_ADDRESS is not set");
  console.log(`💸 Returning player funds from ${address}`);
  const clean = await drain(address);
  if (!clean) {
    console.log(`\n   The contract is not empty. Do not stop pointing at it yet.`);
    process.exit(2);
  }
}

// Only run when invoked directly, so the deploy script can import drain().
if (require.main === module) {
  main().catch((e) => {
    console.error("❌", e.message || e);
    process.exit(1);
  });
}
