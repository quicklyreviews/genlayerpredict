require("dotenv").config();

import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";

async function main() {
  const rpcUrl = "https://studio.genlayer.com/api";
  const contractAddress = process.env.CONTRACT_ADDRESS;
  if (!contractAddress) throw new Error("Missing CONTRACT_ADDRESS in .env");
  const rawPk = process.env.PRIVATE_KEY || "";
  const privateKey = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`;
  const account = privateKeyToAccount(privateKey);

  const studioChain = { ...localnet, id: 61999 };
  const client = createClient({
    chain: studioChain,
    endpoint: rpcUrl,
    account: account,
  });

  console.log("🚀 Calling start_round()...");
  const hash = await client.writeContract({
    address: contractAddress as `0x${string}`,
    functionName: "start_round",
    args: [],
    value: 0n,
  } as any);
  console.log("TX Hash:", hash);

  // Poll for finalization
  console.log("Waiting for finalization...");
  const receipt = await client.waitForTransactionReceipt({
    hash: hash as `0x${string}`,
    status: "FINALIZED",
    interval: 5000,
    retries: 60,
  });
  console.log("\n✅ start_round finalized!");

  // Read state after
  console.log("\n🔍 Reading round state...");
  const round = await client.readContract({
    address: contractAddress as `0x${string}`,
    functionName: "get_round",
    args: [],
  });
  console.log("Round:", JSON.stringify(round, null, 2));
}

main().catch((err) => {
  console.error("❌ Failed:", err.message ?? err);
  process.exit(1);
});
