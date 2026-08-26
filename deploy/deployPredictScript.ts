import { createClient } from "genlayer-js";
import * as fs from "fs";
import * as path from "path";

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}
loadEnv();

async function main() {
  const { privateKeyToAccount } = require("viem/accounts");
  const { studionet } = require("genlayer-js/chains");

  const rpcUrl = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";
  const rawPk = process.env.PRIVATE_KEY || "";
  const privateKey = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`;
  if (!privateKey || privateKey.length < 66) throw new Error("PRIVATE_KEY not set in .env");

  const account = privateKeyToAccount(privateKey);
  console.log(`🔑 Using account: ${account.address}`);

  const nonceRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionCount", params: [account.address, "latest"], id: 1 }),
  });
  const currentNonce = parseInt(((await nonceRes.json()) as any).result, 16);
  console.log(`   Current nonce on-chain: ${currentNonce}`);

  const client = createClient({ chain: studionet, endpoint: rpcUrl, account });

  const contractPath = path.resolve(__dirname, "../contracts/predict_market.py");
  const contractCode = fs.readFileSync(contractPath, "utf-8").replace(/\r\n/g, "\n");

  console.log("🚀 Deploying PredictMarket (GenPredict) contract...");
  console.log(`   RPC: ${rpcUrl}`);
  console.log(`   Source size: ${contractCode.length} bytes`);

  // Validate in GenVM BEFORE spending gas: a deploy of an unloadable contract still
  // reports EVM status 0x1, burns the fee, and leaves nothing at the address.
  console.log("   🔍 Validating contract schema in GenVM...");
  const schemaRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "gen_getContractSchemaForCode", params: [contractCode], id: 1 }),
  });
  const schemaData: any = await schemaRes.json();
  if (schemaData.error) {
    const err = schemaData.error;
    const raw = String(err.message || "");
    // A quota rejection is not a contract problem, and reporting it as one sends
    // you hunting through the source for a syntax error that is not there. This
    // cost a real debugging detour once already.
    if (err.code === -32029 || /rate limit/i.test(raw)) {
      const wait = err.data?.retry_after_seconds;
      throw new Error(
        `The node refused the request: ${raw}\n` +
          `   The contract was never validated — this is a quota limit, not a code problem.` +
          (wait ? `\n   Retry in about ${Math.ceil(wait / 60)} minute(s).` : "")
      );
    }
    const m = raw.match(/"message": "([^"]*)"/);
    throw new Error(
      `GenVM rejected the contract: ${m ? m[1] : raw || "unknown validation error"}\n` +
        `   Hint: line 1 must start with a version token, the { "Depends": ... } comment\n` +
        `   must be line 2, and no comment may follow it.`
    );
  }
  console.log(`   ✅ Schema valid — ${Object.keys(schemaData.result?.methods || {}).length} public methods`);

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
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionReceipt", params: [hash], id: 1 }),
      });
      const data: any = await statusRes.json();
      const status = data?.result?.status;
      console.log(`   [${i + 1}/60] TX status: ${status ?? "pending"}`);
      if (status === "0x1") { receipt = data.result; break; }
    } catch (e) {
      console.log(`   [${i + 1}/60] Polling error, retrying...`);
    }
  }
  if (!receipt) throw new Error("Transaction did not finalize within 5 minutes");

  const contractAddress = receipt.contract_address || receipt.to;

  console.log("   🔍 Verifying the contract responds on-chain...");
  // get_owner alone is too weak a check: it reads one field set in the constructor
  // and passes even when the rest of storage is unreadable. A field assigned in
  // __init__ but never declared at class level does exactly that — a deploy reported
  // success while get_vault threw on every call. So probe views that walk real
  // state, and treat any of them failing as a failed deploy.
  const PROBES = ["get_owner", "get_vault", "get_mm", "get_stats"];
  let verified = false;
  for (let i = 0; i < 12 && !verified; i++) {
    try {
      const results: Record<string, unknown> = {};
      for (const fn of PROBES) {
        results[fn] = await client.readContract({ address: contractAddress, functionName: fn, args: [] } as any);
      }
      console.log(`   ✅ Contract live — owner: ${results.get_owner}`);
      console.log(`   ✅ State readable — ${PROBES.length} views answered`);
      verified = true;
    } catch (e: any) {
      if (i === 11) {
        throw new Error(
          `Contract deployed at ${contractAddress} but its state is not readable: ${e.message}\n` +
            `   A storage field assigned in __init__ must also be declared at class level.`
        );
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  console.log("\n✅ PredictMarket deployed successfully!");
  console.log(`   Contract Address: ${contractAddress}`);
  console.log("\n📋 Add this to your .env:");
  console.log(`   PREDICT_CONTRACT_ADDRESS=${contractAddress}`);
  console.log("\n▶️  Then start the keeper so rounds begin running:");
  console.log(`   npm run backend`);
}

main().catch((err) => {
  console.error("❌ Deployment failed:", err.message ?? err);
  process.exit(1);
});
