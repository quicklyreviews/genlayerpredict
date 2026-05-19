import "dotenv/config";
import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";

const CONTRACT = "0x79e61a2163Cdfe0AC499136b768Cd40d0E401caB";
const rawPk = process.env.PRIVATE_KEY || "";
const privateKey = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}` as `0x${string}`;
const account = privateKeyToAccount(privateKey as `0x${string}`);

const client = createClient({
  chain: { ...localnet, id: 61999 },
  endpoint: "https://studio.genlayer.com/api",
  account,
});

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function callWrite(fn: string, args: any[] = []) {
  console.log(`\n>>> Calling ${fn}(${args.join(", ")})...`);
  const hash = await client.writeContract({ address: CONTRACT as any, functionName: fn, args });
  console.log(`    TX: ${hash}`);
  console.log(`    Waiting FINALIZED...`);
  await client.waitForTransactionReceipt({ hash, status: "FINALIZED", interval: 3000, retries: 100 });
  console.log(`    ✅ FINALIZED`);
  await sleep(2000);
}

async function readState() {
  const s = await client.readContract({ address: CONTRACT as any, functionName: "get_round", args: [] }) as any;
  console.log(`    State: status=${s.status} round=${s.round_id} start_price=${s.start_price} end_price=${s.end_price} winner=${s.winner}`);
  return s;
}

async function main() {
  console.log("=== FULL LIFECYCLE TEST ===");
  console.log(`Contract: ${CONTRACT}`);
  
  // Step 1: Read initial state
  console.log("\n--- Step 0: Initial state ---");
  await readState();
  
  // Step 1: start_round
  console.log("\n--- Step 1: start_round ---");
  await callWrite("start_round");
  await readState();
  
  // Step 2: lock_round with price "80000"
  console.log("\n--- Step 2: lock_round(80000) ---");
  await callWrite("lock_round", ["80000"]);
  const locked = await readState();
  
  // Step 3: resolve_round with price "81000" (should be UP)
  console.log("\n--- Step 3: resolve_round(81000) ---");
  await callWrite("resolve_round", ["81000"]);
  const resolved = await readState();
  
  if (resolved.status === "RESOLVED") {
    console.log("\n🎉🎉🎉 SUCCESS! resolve_round WORKS! 🎉🎉🎉");
    console.log(`Winner: ${resolved.winner} (expected: UP)`);
  } else {
    console.log("\n❌❌❌ FAILED! State is still:", resolved.status);
  }
}

main().catch(console.error);
