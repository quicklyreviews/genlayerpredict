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

  const rpcUrl = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";

  const rawPk = process.env.PRIVATE_KEY || "";
  const privateKey = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`;
  if (!privateKey || privateKey.length < 66) {
    throw new Error("PRIVATE_KEY not set in .env");
  }

  const account = privateKeyToAccount(privateKey);
  console.log(`🔑 Using account: ${account.address}`);

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

  const contractPath = path.resolve(__dirname, "../contracts/perp_exchange.py");
  const contractCode = fs.readFileSync(contractPath, "utf-8").replace(/\r\n/g, "\n");

  console.log("🚀 Deploying PerpExchange (GenPerp) contract...");
  console.log(`   RPC: ${rpcUrl}`);
  console.log(`   Source size: ${contractCode.length} bytes`);

  // Validate the contract in GenVM BEFORE spending gas. A deploy transaction for
  // an unloadable contract still reports EVM status 0x1 and burns the fee, then
  // silently leaves no contract at the address — so check the schema first.
  console.log("   🔍 Validating contract schema in GenVM...");
  const schemaRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "gen_getContractSchemaForCode",
      params: [contractCode],
      id: 1,
    }),
  });
  const schemaData: any = await schemaRes.json();
  if (schemaData.error) {
    const m = String(schemaData.error.message || "").match(/"message": "([^"]*)"/);
    const reason = m ? m[1] : "unknown validation error";
    throw new Error(
      `GenVM rejected the contract: ${reason}\n` +
        `   Hint: line 1 must start with a version token (e.g. "# v1.0.0 — ..."), the\n` +
        `   { "Depends": ... } runner comment must be line 2, and no comment may follow it.`
    );
  }
  const methodNames = Object.keys(schemaData.result?.methods || {});
  console.log(`   ✅ Schema valid — ${methodNames.length} public methods`);

  // Contract source is sent as calldata — bigger contracts need a large gas
  // limit (see GenLayer_Project_Context.md: genlayer-js's own fallback limit
  // is far too low for anything beyond a toy contract).
  const hash = await client.deployContract({
    code: contractCode,
    args: [],
    nonce: currentNonce,
    gas: 20000000n,
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

  // An EVM status of 0x1 only means the outer transaction landed — GenVM can still
  // have rejected the contract, leaving nothing deployed. Confirm by actually
  // calling a view method before declaring success.
  console.log("   🔍 Verifying the contract responds on-chain...");
  let verified = false;
  for (let i = 0; i < 12; i++) {
    try {
      const owner = await client.readContract({
        address: contractAddress,
        functionName: "get_owner",
        args: [],
      } as any);
      console.log(`   ✅ Contract live — owner: ${owner}`);
      verified = true;
      break;
    } catch (e: any) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!verified) {
    throw new Error(
      `Transaction landed but no contract responds at ${contractAddress}.\n` +
        `   Inspect the GenVM result with: client.getTransaction({ hash: "${hash}" })`
    );
  }

  console.log("\n✅ PerpExchange deployed successfully!");
  console.log(`   Contract Address: ${contractAddress}`);
  console.log("\n📋 Add this to your .env:");
  console.log(`   CONTRACT_ADDRESS=${contractAddress}`);
  console.log("\n💰 Next step — fund the vault so it can pay out winning traders:");
  console.log(`   npx tsx scripts/fund-vault.ts <amount-in-GEN>`);
}

main().catch((err) => {
  console.error("❌ Deployment failed:", err.message ?? err);
  process.exit(1);
});
