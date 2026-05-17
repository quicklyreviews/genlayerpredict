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

  console.log("Testing gen_getContractSchema...");
  const schema = await (client as any).request({
    method: "gen_getContractSchema",
    params: [contractAddress],
  });
  console.log("Schema methods:", Object.keys(schema.methods));

  console.log("\nTesting readContract...");
  const result = await client.readContract({
    address: contractAddress as `0x${string}`,
    functionName: "get_round",
    args: [],
  });
  console.log("Result:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("❌ Failed:", err.message ?? err);
  process.exit(1);
});
