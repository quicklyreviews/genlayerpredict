require("dotenv").config();

import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";

async function main() {
  const rpcUrl = "https://studio.genlayer.com/api";
  const rawPk = process.env.PRIVATE_KEY || "";
  const privateKey = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`;
  const account = privateKeyToAccount(privateKey);

  const studioChain = { ...localnet, id: 61999 };
  const client = createClient({
    chain: studioChain,
    endpoint: rpcUrl,
    account: account,
  });

  console.log("Testing chain ID...");
  const chainId = await client.getChainId();
  console.log("Chain ID:", chainId);

  console.log("Testing block number...");
  const blockNumber = await client.getBlockNumber();
  console.log("Block number:", blockNumber);
}

main().catch((err) => {
  console.error("❌ Failed:", err.message ?? err);
  process.exit(1);
});
