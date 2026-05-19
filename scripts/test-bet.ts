import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";
import "dotenv/config";

async function testBet() {
  const CONTRACT = process.env.CONTRACT_ADDRESS;
  const pk = process.env.PRIVATE_KEY;
  const account = privateKeyToAccount(`0x${pk}`);
  
  const client = createClient({
    chain: localnet,
    endpoint: "https://studio.genlayer.com/api",
    account: account
  });

  try {
    console.log("Calling bet_up...");
    const txHash = await client.writeContract({
      address: CONTRACT,
      functionName: "bet_up",
      args: [],
      value: 1000000000000000000n, // 1 GEN
    });
    console.log("TX Hash:", txHash);
    
    console.log("Waiting for receipt...");
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, status: "FINALIZED" });
    console.log("Receipt status:", receipt.status);
    console.log("Receipt:", JSON.stringify(receipt, null, 2));
  } catch (e) {
    console.error("Error:", e);
  }
}

testBet();
