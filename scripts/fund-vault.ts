/**
 * One-off helper to deposit GEN into the PerpExchange vault (backs trader payouts).
 *
 * Usage:
 *   npx tsx scripts/fund-vault.ts 50
 *
 * Environment variables:
 *   CONTRACT_ADDRESS  — deployed PerpExchange address (required)
 *   GENLAYER_RPC_URL  — RPC endpoint (default: https://studio.genlayer.com/api)
 *   PRIVATE_KEY       — wallet that will send the funding transaction
 */
import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { studionet } from "genlayer-js/chains";
import * as fs from "fs";
import * as path from "path";

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    process.env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
}
loadEnv();

async function main() {
  const amountGen = parseFloat(process.argv[2] || "");
  if (!amountGen || amountGen <= 0) {
    console.error("Usage: npx tsx scripts/fund-vault.ts <amount-in-GEN>");
    process.exit(1);
  }

  const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS!;
  if (!CONTRACT_ADDRESS) throw new Error("CONTRACT_ADDRESS not set in .env");

  const RPC_URL = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
  const rawPk = process.env.PRIVATE_KEY || "";
  const privateKey = (rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`) as `0x${string}`;
  const account = privateKeyToAccount(privateKey);

  const studioChain = studionet;
  const client = createClient({ chain: studioChain, endpoint: RPC_URL, account });

  const amountWei = BigInt(Math.round(amountGen * 1e18));
  console.log(`💰 Funding vault with ${amountGen} GEN (${amountWei} wei) from ${account.address}...`);

  const hash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    functionName: "fund_vault",
    args: [],
    value: amountWei,
  });
  console.log(`   TX: ${hash}`);

  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: "FINALIZED",
    interval: 5000,
    retries: 60,
  });
  console.log(`   ✅ Finalized:`, receipt.status);

  const status = await client.readContract({
    address: CONTRACT_ADDRESS,
    functionName: "get_vault_status",
    args: [],
  });
  console.log("   Vault status:", status);
}

main().catch((err) => {
  console.error("❌ fund-vault failed:", err.message ?? err);
  process.exit(1);
});
