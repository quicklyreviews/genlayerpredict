import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";
import * as fs from "fs";

async function testVal() {
  const account = privateKeyToAccount(`0x5b651aa4ebedc9e472dc9824879d9a202ee9381332eee02c8cd1c3ed22e38162`);
  const client = createClient({ chain: localnet, endpoint: "https://studio.genlayer.com/api", account });
  
  const code = fs.readFileSync("contracts/test_value.py", "utf-8");
  try {
    const txHash = await client.deployContract({ code, args: [] });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, status: "FINALIZED" });
    const addr = receipt.contractAddress || receipt.to || (receipt.logs && receipt.logs[0] && receipt.logs[0].address);
    console.log("Deployed at", addr);
    
    const payTx = await client.writeContract({ address: addr, functionName: "pay", args: [], value: 12345n });
    await client.waitForTransactionReceipt({ hash: payTx, status: "FINALIZED" });
    
    const val = await client.readContract({ address: addr, functionName: "get_val", args: [] });
    console.log("Value recorded:", val);
  } catch(e) { console.error("Err:", e); }
}
testVal();
