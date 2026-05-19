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
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";
import * as fs from "fs";
import * as path from "path";

import "dotenv/config";

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS!;
if (!CONTRACT_ADDRESS) {
  console.error("❌ CONTRACT_ADDRESS environment variable is required");
  process.exit(1);
}

const RPC_URL =
  process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
const ROUND_PAUSE_MS = parseInt(
  process.env.ROUND_PAUSE_MS || "5000",
  10
);


const rawPk = process.env.PRIVATE_KEY || "";
const privateKey = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}` as `0x${string}`;
const account = privateKeyToAccount(privateKey as `0x${string}`);

const studioChain = { ...localnet, id: 61999 };

const client = createClient({
  chain: studioChain,
  endpoint: RPC_URL,
  account,
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function write(
  functionName: string,
  args: any[] = [],
  expectedStatus?: string
): Promise<void> {
  console.log(`  📝 Calling ${functionName}(${args.join(", ")})...`);

  const hash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
  });

  console.log(`     TX: ${hash}`);
  console.log(`     ⏳ Waiting for FINALIZED (this may take 1-3 minutes)...`);

  // Must wait for FINALIZED — state only updates after consensus completes
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: "FINALIZED",
    interval: 5000,
    retries: 120, // 120 * 5s = 10 minutes max
  });

  console.log(`     ✅ ${functionName}() FINALIZED on-chain`);

  // Verify state actually changed
  if (expectedStatus) {
    await sleep(2000);
    const state = await readRound();
    if (state.status !== expectedStatus) {
      console.warn(`     ⚠️  Expected status "${expectedStatus}" but got "${state.status}"`);
    } else {
      console.log(`     ✔️  State verified: ${state.status}`);
    }
  }
}

async function readRound(): Promise<any> {
  return client.readContract({
    address: CONTRACT_ADDRESS,
    functionName: "get_round",
    args: [],
  });
}

// Fetch current BTC price from Binance
async function fetchBTCPrice(): Promise<string> {
  const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
  const data = await res.json() as any;
  const price = Math.round(parseFloat(data.price));
  console.log(`  💲 BTC price from Binance: $${price}`);
  return String(price);
}

async function main(): Promise<void> {
  console.log("🎮 BTC Up/Down Prediction Market — Cron Bot");
  console.log(`   Contract: ${CONTRACT_ADDRESS}`);
  console.log(`   RPC:      ${RPC_URL}`);
  console.log(`   Pause:    ${ROUND_PAUSE_MS}ms between rounds`);

  while (true) {
    try {
      // Read current state to decide what to do next
      const state = await readRound();
      const status = state.status;
      const roundId = state.round_id;
      const roundStart = Number(state.round_start_time);
      const bettingSecs = Number(state.betting_seconds || 60);
      const lockSecs = Number(state.lock_seconds || 60);
      const now = Math.floor(Date.now() / 1000);

      console.log(`\n═══════════════════════════════════════`);
      console.log(`  📋 Round #${roundId} — Status: ${status}`);
      console.log(`═══════════════════════════════════════`);

      if (status === "IDLE" || status === "RESOLVED") {
        // Need to start a new round
        console.log(`  🆕 Starting new round...`);
        await write("start_round", [], "OPEN");
        const newState = await readRound();
        console.log(`  💰 Opening BTC price: $${newState.start_price}`);
        console.log(`  ⏳ Betting window: ${bettingSecs}s`);
        // Poll every 10s instead of blocking sleep
        const betEnd = Math.floor(Date.now() / 1000) + bettingSecs;
        while (Math.floor(Date.now() / 1000) < betEnd) {
          const left = betEnd - Math.floor(Date.now() / 1000);
          if (left % 30 === 0 || left <= 10) console.log(`  ⏳ Betting open, ${left}s remaining...`);
          await sleep(10000);
        }

      } else if (status === "OPEN") {
        // Round is open, check if betting window has expired
        const bettingEnd = roundStart + bettingSecs;
        const remaining = bettingEnd - now;

        if (remaining > 0) {
          console.log(`  ⏳ Betting still open, waiting ${remaining}s...`);
          // Poll every 10s instead of blocking sleep
          const target = Math.floor(Date.now() / 1000) + remaining;
          while (Math.floor(Date.now() / 1000) < target) {
            await sleep(10000);
          }
        }

        // Fetch BTC price and lock
        const lockPrice = await fetchBTCPrice();
        console.log(`  🔒 Locking round with price $${lockPrice}...`);
        await write("lock_round", [lockPrice], "LOCKED");
        const lockedState = await readRound();
        console.log(`  🔒 Locked — UP: ${lockedState.up_count}, DOWN: ${lockedState.down_count}`);
        console.log(`  ⏳ Waiting ${lockSecs}s for resolve...`);
        const lockEnd = Math.floor(Date.now() / 1000) + lockSecs;
        while (Math.floor(Date.now() / 1000) < lockEnd) {
          const left = lockEnd - Math.floor(Date.now() / 1000);
          if (left % 30 === 0 || left <= 10) console.log(`  ⏳ Locked, ${left}s until resolve...`);
          await sleep(10000);
        }

      } else if (status === "LOCKED") {
        // Round is locked, check if resolve window has expired
        const bettingEnd = roundStart + bettingSecs;
        const resolveEnd = bettingEnd + lockSecs;
        const remaining = resolveEnd - now;

        if (remaining > 0) {
          console.log(`  ⏳ Locked, waiting ${remaining}s to resolve...`);
          const target = Math.floor(Date.now() / 1000) + remaining;
          while (Math.floor(Date.now() / 1000) < target) {
            await sleep(10000);
          }
        }

        // Fetch BTC price and resolve
        const closePrice = await fetchBTCPrice();
        console.log(`  📊 Resolving round with close price $${closePrice}...`);
        await write("resolve_round", [closePrice], "RESOLVED");
        const resolved = await readRound();
        console.log(`  📊 Results:`);
        console.log(`     Open:   $${resolved.start_price}`);
        console.log(`     Close:  $${resolved.end_price}`);
        console.log(`     Winner: ${resolved.winner}`);
        console.log(`     UP:     ${resolved.up_count} votes`);
        console.log(`     DOWN:   ${resolved.down_count} votes`);

      } else {
        console.log(`  ⚠️  Unknown status: ${status}, waiting...`);
      }

    } catch (err: any) {
      console.error(`\n❌ Round error: ${err.message || err}`);
      console.error("   Retrying after pause...");
    }

    await sleep(ROUND_PAUSE_MS);
  }
}

main();
