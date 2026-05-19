import "dotenv/config";
import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";

const rawPk = process.env.PRIVATE_KEY || "";
const privateKey = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}` as `0x${string}`;
const account = privateKeyToAccount(privateKey as `0x${string}`);

const client = createClient({
  chain: { ...localnet, id: 61999 },
  endpoint: "https://studio.genlayer.com/api",
  account,
});

async function main() {
  const hash = await client.writeContract({
    address: "0xf514F6F64e61b0a7fc2E919E177dCD3e136dC241" as any,
    functionName: "resolve_round",
    args: ["76435"],
  });
  console.log(`TX sent: ${hash}`);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: "FINALIZED",
    interval: 2000,
    retries: 100,
  });
  console.log(receipt);
}

main().catch(console.error);
