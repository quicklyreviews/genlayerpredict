/**
 * Funds the prediction market's house backstop — the capital that takes the empty
 * side of a one-sided round.
 *
 * Without it, a round nobody opposed has nothing to pay from and settles as a full
 * refund: correct for a parimutuel, and a poor experience for someone who called
 * the direction right. This capital is what lets those rounds pay out instead.
 *
 * Deliberately separate from the liquidity pool. Providers there are promised no
 * exposure to outcomes, so their capital must never end up backing directional
 * risk — this comes from the operator instead, and only the owner can take it back.
 *
 * Usage:
 *   npx tsx scripts/fund-house.ts 5          # add 5 GEN
 *   npx tsx scripts/fund-house.ts 5 0.25     # add 5 GEN, cap 0.25 GEN per round
 *
 * Environment:
 *   PREDICT_CONTRACT_ADDRESS  — deployed PredictMarket address (required)
 *   GENLAYER_RPC_URL          — RPC endpoint (default: Studionet)
 *   PRIVATE_KEY               — the owner's key; must be the contract owner to set
 *                               the per-round cap, though anyone may add capital
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
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}
loadEnv();

const gen = (wei: bigint | string) => (Number(BigInt(wei)) / 1e18).toFixed(6);

async function main() {
  const amountGen = parseFloat(process.argv[2] || "");
  if (!amountGen || amountGen <= 0) {
    console.error("Usage: npx tsx scripts/fund-house.ts <amount-in-GEN> [cap-per-round-in-GEN]");
    process.exit(1);
  }
  const capGen = process.argv[3] ? parseFloat(process.argv[3]) : null;

  const ADDRESS = process.env.PREDICT_CONTRACT_ADDRESS!;
  if (!ADDRESS) throw new Error("PREDICT_CONTRACT_ADDRESS not set in .env");

  const RPC_URL = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
  const rawPk = process.env.PRIVATE_KEY || "";
  const account = privateKeyToAccount(
    (rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`) as `0x${string}`
  );
  const client = createClient({ chain: studionet as any, endpoint: RPC_URL, account });

  const read = (fn: string, args: any[] = []) =>
    (client as any).readContract({ address: ADDRESS, functionName: fn, args });

  const before: any = await read("get_mm");
  console.log(`🏦 House backstop on ${ADDRESS}`);
  console.log(`   before: ${gen(before.total)} GEN total, ${gen(before.free)} free, ` +
              `cap ${gen(before.max_per_round)} per round`);

  const amountWei = BigInt(Math.round(amountGen * 1e18));
  console.log(`   adding ${amountGen} GEN from ${account.address}`);
  const hash = await (client as any).writeContract({
    address: ADDRESS,
    functionName: "fund_mm",
    args: [],
    value: amountWei,
  });
  console.log(`   TX: ${hash}`);
  await (client as any).waitForTransactionReceipt({
    hash, status: "FINALIZED", interval: 5000, retries: 60,
  });

  if (capGen !== null) {
    if (!(capGen >= 0)) throw new Error("cap must be zero or positive");
    const capWei = BigInt(Math.round(capGen * 1e18));
    console.log(`   setting the per-round cap to ${capGen} GEN`);
    const capHash = await (client as any).writeContract({
      address: ADDRESS,
      functionName: "set_mm_max_per_round",
      args: [capWei],
      value: 0n,
    });
    console.log(`   TX: ${capHash}`);
    await (client as any).waitForTransactionReceipt({
      hash: capHash, status: "FINALIZED", interval: 5000, retries: 60,
    });
  }

  const after: any = await read("get_mm");
  console.log(`   after:  ${gen(after.total)} GEN total, ${gen(after.free)} free, ` +
              `cap ${gen(after.max_per_round)} per round`);

  // The cap is what actually decides whether a one-sided round gets covered, so a
  // funded backstop with a zero cap is a silent no-op worth calling out.
  if (BigInt(after.max_per_round) === 0n) {
    console.log(`   ⚠ the per-round cap is zero, so one-sided rounds will still refund.`);
    console.log(`     Set one: npx tsx scripts/fund-house.ts 0.000001 <cap>`);
  } else if (Number(after.enabled) !== 1) {
    console.log(`   ⚠ backstop reports disabled — check that free capital is above zero.`);
  } else {
    console.log(`   ✅ one-sided rounds will now be covered, up to ${gen(after.max_per_round)} GEN each.`);
  }
}

main().catch((e) => {
  console.error("❌", e.message || e);
  process.exit(1);
});
