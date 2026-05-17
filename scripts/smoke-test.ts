require("dotenv").config();

import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";

async function main() {
  const rpcUrl = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
  const contractAddress = process.env.CONTRACT_ADDRESS || "0x78b6235724Ad29b39Ba162096f0ded4201426189";

  const rawPk = process.env.PRIVATE_KEY || "";
  const privateKey = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`;
  const account = privateKeyToAccount(privateKey);

  const studioChain = { ...localnet, id: 61999 };
  const client = createClient({
    chain: studioChain,
    endpoint: rpcUrl,
    account: account,
  });

  console.log("🔍 Calling get_round()...");
  const result = await client.readContract({
    address: contractAddress,
    functionName: "get_round",
    args: [],
  });
  console.log("✅ get_round result:", JSON.stringify(result, null, 2));

  console.log("\n🔍 Calling get_my_vote()...");
  const vote = await client.readContract({
    address: contractAddress,
    functionName: "get_my_vote",
    args: [account.address],
  });
  console.log("✅ get_my_vote result:", vote);
}

main().catch((err) => {
  console.error("❌ Smoke test failed:", err.message ?? err);
  process.exit(1);
});
