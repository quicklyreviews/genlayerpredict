import "dotenv/config";
import fs from "fs";
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
  console.log("Deploying new BTC Up/Down Market Contract...");
  const code = fs.readFileSync("contracts/btc_updown_market.py", "utf-8");
  
  try {
    const hash = await client.deployContract({
      code,
      args: [],
    });
    console.log(`Contract deploy tx sent: ${hash}`);
    
    const receipt = await client.waitForTransactionReceipt({
      hash,
      status: "FINALIZED",
      interval: 5000,
      retries: 120,
    });
    
    // GenLayer SDK returns contractAddress=null, address is in receipt.to or logs[0].address
    const addr = receipt.contractAddress || receipt.to || (receipt.logs && receipt.logs[0] && receipt.logs[0].address);
    console.log(`Deployed! Contract address: ${addr}`);
    
    if (!addr) {
      console.error("Could not determine contract address from receipt!");
      console.log("Full receipt:", JSON.stringify(receipt, (k,v) => typeof v === 'bigint' ? v.toString() : v, 2));
      return;
    }
    
    // Update .env (both CONTRACT_ADDRESS and VITE_CONTRACT_ADDRESS)
    const envPath = ".env";
    let envData = fs.readFileSync(envPath, "utf-8");
    envData = envData.replace(/^CONTRACT_ADDRESS=.*/m, `CONTRACT_ADDRESS=${addr}`);
    envData = envData.replace(/^VITE_CONTRACT_ADDRESS=.*/m, `VITE_CONTRACT_ADDRESS=${addr}`);
    fs.writeFileSync(envPath, envData);
    console.log("Updated .env");
    
    // Update frontend app.js
    const appJsPath = "frontend/app.js";
    let appJsData = fs.readFileSync(appJsPath, "utf-8");
    appJsData = appJsData.replace(/contractAddress: "0x[a-fA-F0-9]+"/, `contractAddress: "${addr}"`);
    fs.writeFileSync(appJsPath, appJsData);
    console.log("Updated frontend/app.js");
    
    // Update backend-proxy.js
    const proxyPath = "scripts/backend-proxy.js";
    let proxyData = fs.readFileSync(proxyPath, "utf-8");
    proxyData = proxyData.replace(/process\.env\.CONTRACT_ADDRESS \|\| "0x[a-fA-F0-9]+"/, `process.env.CONTRACT_ADDRESS || "${addr}"`);
    fs.writeFileSync(proxyPath, proxyData);
    console.log("Updated backend-proxy.js");
    
  } catch (err) {
    console.error("Deploy failed:", err);
  }
}

main();
