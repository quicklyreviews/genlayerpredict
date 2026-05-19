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
  console.dir(schema, { depth: null });

  console.log("\nTesting readContract...");
  const round: any = await client.readContract({
    address: contractAddress as `0x${string}`,
    functionName: "get_round",
    args: [],
  });
  console.log("Round:", round.round_id);

  const parts: any = await client.readContract({
    address: contractAddress as `0x${string}`,
    functionName: "get_round_participants",
    args: [round.round_id],
  });
  console.log("Participants:", parts);

  if (parts && parts.length > 0) {
    for (let p of JSON.parse(parts)) {
      const hist: any = await client.readContract({
        address: contractAddress as `0x${string}`,
        functionName: "get_user_history",
        args: [p],
      });
      console.log(`History for ${p}:`, hist);
    }
  }
}

main().catch((err) => {
  console.error("❌ Failed:", err.message ?? err);
  process.exit(1);
});
