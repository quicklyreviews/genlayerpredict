/**
 * Off-chain round cron bot for BTC Up/Down Prediction Market.
 *
 * This bot runs in a loop and manages the round lifecycle:
 *   1. start_round()   — opens a new round
 *   2. wait 5 minutes
 *   3. lock_round()    — locks the round (no more bets)
 *   4. wait 5 minutes
 *   5. resolve_round() — fetches closing price and determines winner
 *   6. repeat
 *
 * Usage:
 *   CONTRACT_ADDRESS=0x... npx tsx scripts/round-cron.ts
 *
 * Environment variables:
 *   CONTRACT_ADDRESS  — deployed contract address (required)
 *   GENLAYER_RPC_URL  — RPC endpoint (default: http://localhost:4000/api)
 *   ROUND_PAUSE_MS    — pause between rounds in ms (default: 5000)
 */

import { createClient } from "genlayer-js";

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS!;
if (!CONTRACT_ADDRESS) {
  console.error("❌ CONTRACT_ADDRESS environment variable is required");
  process.exit(1);
}

const RPC_URL =
  process.env.GENLAYER_RPC_URL || "http://localhost:4000/api";
const ROUND_PAUSE_MS = parseInt(
  process.env.ROUND_PAUSE_MS || "5000",
  10
);

const BETTING_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RESOLVE_WAIT_MS = 5 * 60 * 1000;   // 5 minutes

const client = createClient({
  endpoint: RPC_URL,
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function write(
  functionName: string,
  args: any[] = []
): Promise<void> {
  console.log(`  📝 Calling ${functionName}()...`);

  const hash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
  });

  console.log(`     TX: ${hash}`);

  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: "FINALIZED",
  });

  console.log(`     ✅ ${functionName}() finalized`);
}

async function readRound(): Promise<any> {
  return client.readContract({
    address: CONTRACT_ADDRESS,
    functionName: "get_round",
    args: [],
  });
}

async function runRound(roundNumber: number): Promise<void> {
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  🔄 Round #${roundNumber}`);
  console.log(`═══════════════════════════════════════`);

  // Phase 1: Start
  await write("start_round");
  let state = await readRound();
  console.log(
    `  💰 Opening BTC price: $${state.start_price}`
  );
  console.log(
    `  ⏳ Betting window: ${BETTING_WINDOW_MS / 1000}s`
  );

  // Phase 2: Wait for betting window
  await sleep(BETTING_WINDOW_MS);

  // Phase 3: Lock
  await write("lock_round");
  state = await readRound();
  console.log(
    `  🔒 Round locked — UP: ${state.up_count}, DOWN: ${state.down_count}`
  );

  // Phase 4: Wait for resolve window
  console.log(
    `  ⏳ Waiting ${RESOLVE_WAIT_MS / 1000}s for resolve...`
  );
  await sleep(RESOLVE_WAIT_MS);

  // Phase 5: Resolve
  await write("resolve_round");
  state = await readRound();
  console.log(`  📊 Results:`);
  console.log(`     Open:   $${state.start_price}`);
  console.log(`     Close:  $${state.end_price}`);
  console.log(`     Winner: ${state.winner}`);
  console.log(`     UP:     ${state.up_count} votes`);
  console.log(`     DOWN:   ${state.down_count} votes`);
}

async function main(): Promise<void> {
  console.log("🎮 BTC Up/Down Prediction Market — Cron Bot");
  console.log(`   Contract: ${CONTRACT_ADDRESS}`);
  console.log(`   RPC:      ${RPC_URL}`);
  console.log(`   Pause:    ${ROUND_PAUSE_MS}ms between rounds`);

  let roundNumber = 1;

  while (true) {
    try {
      await runRound(roundNumber);
      roundNumber++;
    } catch (err: any) {
      console.error(`\n❌ Round error: ${err.message || err}`);
      console.error("   Retrying after pause...");
    }

    await sleep(ROUND_PAUSE_MS);
  }
}

main();
