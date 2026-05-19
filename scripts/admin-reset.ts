/**
 * Emergency: call admin_reset_to_idle on the deployed contract.
 * Use when a round is stuck at LOCKED with corrupt prices (e.g., "NaN").
 *
 * Usage: npx tsx scripts/admin-reset.ts
 * Requires .env at repo root with PRIVATE_KEY of the deployer.
 */
import * as fs from "fs";
import * as path from "path";

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}
loadEnv();

async function main() {
  const { createClient } = require("genlayer-js");
  const { privateKeyToAccount } = require("viem/accounts");
  const { localnet } = require("genlayer-js/chains");
  const { TransactionStatus } = require("genlayer-js/types");

  const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xdb2cba7397856b17d2A141BBE4A8Fa47c85Cf029";
  const RPC_URL = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";

  const rawPk = process.env.PRIVATE_KEY || "";
  const privateKey = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`;
  if (!privateKey || privateKey.length < 66) throw new Error("PRIVATE_KEY missing");

  const account = privateKeyToAccount(privateKey);
  const studioChain = { ...localnet, id: 61999 };
  const client = createClient({ chain: studioChain, endpoint: RPC_URL, account });

  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`Account:  ${account.address}`);

  const before: any = await client.readContract({
    address: CONTRACT_ADDRESS,
    functionName: "get_round",
    args: [],
  });
  console.log(`Before: round=${before.round_id} status=${before.status} start=${before.start_price}`);

  console.log("Calling admin_reset_to_idle()...");
  const hash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    functionName: "admin_reset_to_idle",
    args: [],
    value: 0n,
  });
  console.log(`TX: ${hash}`);

  await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.ACCEPTED,
    interval: 3000,
    retries: 60,
  });
  console.log("Accepted. Verifying...");

  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const after: any = await client.readContract({
      address: CONTRACT_ADDRESS,
      functionName: "get_round",
      args: [],
    });
    console.log(`[${i + 1}/12] status=${after.status}`);
    if (after.status === "IDLE") {
      console.log("Done. Cron will start a fresh round.");
      return;
    }
  }
  console.error("Status did not flip to IDLE — check explorer for the TX");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
