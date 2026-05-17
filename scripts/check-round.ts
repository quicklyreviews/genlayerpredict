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
  const client = createClient({ chain: studioChain, endpoint: rpcUrl, account });

  const round = await client.readContract({
    address: contractAddress as `0x${string}`,
    functionName: "get_round",
    args: [],
  });
  console.log(JSON.stringify(round, null, 2));
}
main().catch(e => { console.error(e.message); process.exit(1); });
