import { createClient } from "genlayer-js";
import * as fs from "fs";
import * as path from "path";

// Manually parse .env to avoid dotenv v17 corruption with non-ASCII chars
function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    process.env[key] = val;
  }
}
loadEnv();

async function main() {
  const { privateKeyToAccount } = require("viem/accounts");
  const { localnet } = require("genlayer-js/chains");

  // GenLayer Studio chain
  const rpcUrl = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";

  // Load private key from .env (supports both with and without 0x prefix)
  const rawPk = process.env.PRIVATE_KEY || "";
  const privateKey = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`;
  if (!privateKey || privateKey.length < 66) {
    throw new Error("PRIVATE_KEY not set in .env");
  }

  const account = privateKeyToAccount(privateKey);
  console.log(`🔑 Using account: ${account.address}`);

  // Get current nonce from node
  const nonceRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_getTransactionCount",
      params: [account.address, "latest"],
      id: 1,
    }),
  });
  const nonceData: any = await nonceRes.json();
  const currentNonce = parseInt(nonceData.result, 16);
  console.log(`   Current nonce on-chain: ${currentNonce}`);

  // GenLayer Studio chain ID = 61999 (0xF22F)
  const studioChain = { ...localnet, id: 61999 };

  const client = createClient({
    chain: studioChain,
    endpoint: rpcUrl,
    account: account,
  });

  const contractPath = path.resolve(
    __dirname,
    "../contracts/btc_updown_market.py"
  );
  const contractCode = fs.readFileSync(contractPath, "utf-8").replace(/\r\n/g, "\n");

  console.log("🚀 Deploying BTC Up/Down Market contract...");
  console.log(`   RPC: ${rpcUrl}`);

  const hash = await client.deployContract({
    code: contractCode,
    args: [],
    nonce: currentNonce,
    gas: 3000000n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 1000000000n,
  } as any);

  console.log(`   TX Hash: ${hash}`);
  console.log("   Polling for finalization (up to 5 min)...");

  let receipt: any = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const statusRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getTransactionReceipt",
          params: [hash],
          id: 1,
        }),
      });
      const data: any = await statusRes.json();
      const status = data?.result?.status;
      console.log(`   [${i + 1}/60] TX status: ${status ?? "pending"}`);
      if (status === "0x1") {
        receipt = data.result;
        break;
      }
    } catch (e) {
      console.log(`   [${i + 1}/60] Polling error, retrying...`);
    }
  }

  if (!receipt) {
    throw new Error("Transaction did not finalize within 5 minutes");
  }

  const contractAddress = receipt.contract_address || receipt.to;
  console.log("\n✅ Contract deployed successfully!");
  console.log(`   Contract Address: ${contractAddress}`);
  console.log("\n📋 Add this to your .env:");
  console.log(`   CONTRACT_ADDRESS=${contractAddress}`);
}

main().catch((err) => {
  console.error("❌ Deployment failed:", err.message ?? err);
  process.exit(1);
});
