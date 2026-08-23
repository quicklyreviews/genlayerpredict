/**
 * Off-chain keeper bot for the GenPerp PerpExchange contract.
 *
 * GenPerp has no cron/automation on-chain (GenLayer contracts only run when
 * a transaction calls them), so a keeper is required to:
 *   1. touch_price(symbol)      — refresh the cached mark price for each enabled market
 *   2. liquidate_position(id)   — permissionlessly liquidate any under-margined position
 *                                  (estimated client-side from the mark price just fetched,
 *                                   then confirmed on-chain by the contract itself)
 *   3. settle_funding(symbol)   — apply the long/short funding payment once the market's
 *                                  funding_interval_seconds has elapsed
 *
 * Anyone can run this (liquidations pay a bounty to the caller), but the project
 * typically runs one instance as a reliability backstop.
 *
 * Usage:
 *   CONTRACT_ADDRESS=0x... npx tsx scripts/perp-keeper.ts
 *
 * Environment variables:
 *   CONTRACT_ADDRESS   — deployed PerpExchange address (required)
 *   GENLAYER_RPC_URL   — RPC endpoint (default: https://studio.genlayer.com/api)
 *   PRIVATE_KEY        — wallet that submits keeper transactions
 *   KEEPER_INTERVAL_MS — how often to sweep (default: 20000)
 */

import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";
import * as fs from "fs";
import * as path from "path";

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    process.env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
}
loadEnv();

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS!;
if (!CONTRACT_ADDRESS) {
  console.error("❌ CONTRACT_ADDRESS environment variable is required");
  process.exit(1);
}

const RPC_URL = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
// One touch_price transaction per market per sweep — this interval is a direct gas cost.
const INTERVAL_MS = parseInt(process.env.KEEPER_INTERVAL_MS || "60000", 10);

const rawPk = process.env.PRIVATE_KEY || "";
const privateKey = (rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`) as `0x${string}`;
const account = privateKeyToAccount(privateKey);
const studioChain = { ...localnet, id: 61999 };
const client = createClient({ chain: studioChain, endpoint: RPC_URL, account });

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function read(fn: string, args: any[] = []) {
  return client.readContract({ address: CONTRACT_ADDRESS, functionName: fn, args });
}

async function write(fn: string, args: any[] = []) {
  const hash = await client.writeContract({ address: CONTRACT_ADDRESS, functionName: fn, args });
  try {
    await client.waitForTransactionReceipt({ hash, status: "ACCEPTED", interval: 3000, retries: 40 });
  } catch (e: any) {
    console.warn(`   ⚠️  ${fn} ACCEPTED wait timed out (may still land): ${e.message}`);
  }
  return hash;
}

// PnL formula mirrored from the contract so we know WHICH positions are worth
// paying gas to liquidate — the contract re-checks and is the source of truth.
function priceChangePct(entry: number, current: number, direction: string): number {
  if (entry === 0) return 0;
  return direction === "LONG" ? (current - entry) / entry : (entry - current) / entry;
}

async function sweepMarket(symbol: string, market: any) {
  if (!market.enabled) return;

  // 1) Refresh mark price
  let markPrice = 0;
  try {
    const priceStr = await write("touch_price", [symbol]);
    markPrice = parseFloat(priceStr as unknown as string);
    console.log(`  💲 ${symbol} mark price: $${markPrice}`);
  } catch (e: any) {
    console.error(`  ❌ touch_price(${symbol}) failed: ${e.message}`);
    return;
  }

  // 2) Scan open positions for liquidation candidates
  try {
    const raw = await read("get_open_positions_for_symbol", [symbol]);
    const positions = JSON.parse((raw as unknown as string) || "[]");
    for (const p of positions) {
      const entry = parseFloat(p.entry_price);
      const margin = Number(BigInt(p.margin));
      const notional = Number(BigInt(p.notional));
      const pct = priceChangePct(entry, markPrice, p.direction);
      const pnl = notional * pct;
      const equity = margin + pnl;
      const maintenance = margin * (Number(market.maintenance_margin_bps) / 10000);
      if (equity <= maintenance) {
        console.log(`  ⚠️  Position #${p.id} (${symbol} ${p.direction}) looks liquidatable — equity ${equity.toFixed(0)} <= maintenance ${maintenance.toFixed(0)}`);
        try {
          const hash = await write("liquidate_position", [p.id]);
          console.log(`     ✅ liquidate_position(${p.id}) TX: ${hash}`);
        } catch (e: any) {
          console.log(`     (skip) liquidate_position(${p.id}) reverted: ${e.message}`);
        }
      }
    }
  } catch (e: any) {
    console.error(`  ❌ scanning ${symbol} positions failed: ${e.message}`);
  }

  // 3) Settle funding if due
  try {
    const finfo: any = await read("get_funding_info", [symbol]);
    const now = Math.floor(Date.now() / 1000);
    const interval = Number(market.funding_interval_seconds);
    const elapsed = now - Number(finfo.last_ts || 0);
    if (elapsed >= interval) {
      const hash = await write("settle_funding", [symbol]);
      console.log(`  🔁 settle_funding(${symbol}) TX: ${hash}`);
    }
  } catch (e: any) {
    console.log(`  (skip) settle_funding(${symbol}): ${e.message}`);
  }
}

async function main() {
  console.log("🤖 GenPerp Keeper — price refresh · liquidations · funding");
  console.log(`   Contract: ${CONTRACT_ADDRESS}`);
  console.log(`   RPC:      ${RPC_URL}`);
  console.log(`   Account:  ${account.address}`);
  console.log(`   Interval: ${INTERVAL_MS}ms`);

  while (true) {
    try {
      const marketsRaw = await read("get_all_markets", []);
      const markets = JSON.parse(marketsRaw as unknown as string);
      console.log(`\n═══ Sweep @ ${new Date().toLocaleTimeString()} ═══`);
      for (const [symbol, market] of Object.entries(markets)) {
        await sweepMarket(symbol, market);
      }
    } catch (e: any) {
      console.error(`❌ Keeper loop error: ${e.message}`);
    }
    await sleep(INTERVAL_MS);
  }
}

main();
